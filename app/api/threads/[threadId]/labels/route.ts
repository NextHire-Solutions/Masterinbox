import { NextResponse, after } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/workspace";
import { createServerSupabase } from "@/lib/supabase/server";
import { isHostileLabel, markThreadLeadDoNotContact } from "@/lib/inbox/dnc";
import {
  isInterestedLabel,
  isNotInterestedLabel,
  markEmailBisonReplyInterested,
} from "@/lib/inbox/interest";
import { notifyIntroductionForThreads } from "@/lib/webhooks/n8n-introduction";
import { pushIntroPipelineEntriesForThreadsToFub } from "@/lib/integrations/push-pipeline-entry";
import { notifyPortalIntroductionForThreads } from "@/lib/webhooks/slack-portal";
import { createAdminSupabase } from "@/lib/supabase/admin";
import {
  snapshotPipelineNotes,
  restorePipelineNotes,
  type PipelineNotesSnapshot,
} from "@/lib/inbox/preserve-pipeline-notes";

export const dynamic = "force-dynamic";

const postSchema = z.object({ label_id: z.string().uuid() });
const deleteSchema = z.object({ label_id: z.string().uuid() });

export async function POST(
  request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  const session = await requireSession();
  const body = await request.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const supabase = await createServerSupabase();

  // Snapshot the prior label name BEFORE we wipe it. Needed to detect
  // "transitioning AWAY from Interested" so we can clear the
  // corresponding interested flag on EmailBison's side — otherwise a
  // thread that was Interested and is now Hostile / Keep Warm /
  // anything else would stay interested=true on EmailBison and inflate
  // the Health Dashboard interest count.
  let priorLabelName: string | null = null;
  const { data: priorAssignments } = await supabase
    .from("label_assignments")
    .select("labels:label_id (name)")
    .eq("target_type", "thread")
    .eq("target_id", threadId)
    .neq("label_id", parsed.data.label_id);
  if (priorAssignments && priorAssignments.length > 0) {
    // Single-label semantics → at most one row, but tolerate the
    // pre-May-2026 case where multiple labels existed (we just look
    // for any prior Interested).
    for (const row of priorAssignments) {
      const lbl = Array.isArray(row.labels) ? row.labels[0] : row.labels;
      const name = (lbl as { name?: string | null } | null)?.name ?? null;
      if (isInterestedLabel(name)) {
        priorLabelName = name;
        break;
      }
    }
  }

  // Resolve the label name up front — needed both for the Hostile /
  // Introduction side-effects below AND to preserve pipeline notes across
  // the relabel. When this is an Introduction (re-)tag, snapshot the
  // thread's pipeline notes BEFORE the wipe: the zero-label window lets the
  // 0033 trigger cascade-delete the entry (and its notes), and the
  // re-inserted Introduction label then rebuilds a fresh, note-less entry.
  // We copy the notes back onto the rebuilt entry after the upsert.
  const { data: label } = await supabase
    .from("labels")
    .select("name")
    .eq("id", parsed.data.label_id)
    .maybeSingle();
  const isIntroLabel =
    (label?.name as string | null)?.trim().toLowerCase() === "introduction";
  let notesSnapshot: PipelineNotesSnapshot | null = null;
  if (isIntroLabel) {
    notesSnapshot = await snapshotPipelineNotes(createAdminSupabase(), [
      threadId,
    ]);
  }

  // Single-label-per-thread semantics (May 2026 client decision):
  // applying any label wipes every existing label on the thread first,
  // including AI-assigned guesses. The chip in the inbox row always
  // reflects the latest classification. Done as a delete-then-upsert
  // pair — Supabase REST has no transaction primitive, so we accept a
  // brief window where the thread has zero labels; failure of the
  // upsert below leaves the thread unlabeled rather than double-tagged.
  const deleteOthers = await supabase
    .from("label_assignments")
    .delete()
    .eq("target_type", "thread")
    .eq("target_id", threadId)
    .neq("label_id", parsed.data.label_id);
  if (deleteOthers.error) {
    return NextResponse.json({ error: deleteOthers.error.message }, { status: 400 });
  }

  const { error } = await supabase.from("label_assignments").upsert(
    {
      workspace_id: session.activeWorkspace.id,
      label_id: parsed.data.label_id,
      target_type: "thread",
      target_id: threadId,
      assigned_by: "user",
      assigned_user_id: session.user.id,
    },
    { onConflict: "label_id,target_type,target_id" },
  );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // Hostile → auto Do-Not-Contact. Uses the label name resolved above; if
  // it's "Hostile", blacklist the lead on the source platform.
  if (isHostileLabel(label?.name as string | null)) {
    await markThreadLeadDoNotContact(threadId);
  }

  // Introduction → notify n8n + Bison orchestrator + auto-push to
  // Follow Up Boss (if the receiving client has FUB connected). The
  // 0023 DB trigger has already created the pipeline row inside the
  // upsert above; both helpers resolve it post-response.
  //
  // The FUB push is idempotent (skips entries with fub_pushed_at
  // already set) and non-fatal (any error lands on fub_last_error,
  // never bubbles back to the labeling request).
  if (isIntroLabel) {
    after(() => notifyIntroductionForThreads([threadId], "inbox_label"));
    after(() => pushIntroPipelineEntriesForThreadsToFub([threadId]));
    after(() => notifyPortalIntroductionForThreads([threadId]));
    // Copy the pre-relabel notes onto the rebuilt pipeline entry (no-op if
    // the entry survived or already carries notes).
    if (notesSnapshot) {
      const snap = notesSnapshot;
      after(() => restorePipelineNotes(createAdminSupabase(), snap));
    }
  }

  // Interested / Not Interested → round-trip the decision back to
  // EmailBison so the reply's interested flag matches what the
  // operator just set. EmailBison-only; the helper bails for
  // Instantly threads.
  //
  // Three transition cases handled together:
  //   • new = Interested      → set EB interested=true
  //   • new = Not Interested  → set EB interested=false
  //   • new = anything else BUT old was Interested → set EB
  //     interested=false (clears the flag so the lead doesn't keep
  //     showing as Interested on EmailBison's smart lists / our
  //     Health Dashboard after the operator moved them elsewhere).
  const newLabelName = (label?.name as string | null) ?? null;
  const priorWasInterested = isInterestedLabel(priorLabelName);
  if (isInterestedLabel(newLabelName)) {
    after(() => markEmailBisonReplyInterested(threadId, true));
  } else if (isNotInterestedLabel(newLabelName) || priorWasInterested) {
    after(() => markEmailBisonReplyInterested(threadId, false));
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  await requireSession();
  const body = await request.json().catch(() => null);
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const supabase = await createServerSupabase();
  const { error } = await supabase
    .from("label_assignments")
    .delete()
    .eq("label_id", parsed.data.label_id)
    .eq("target_type", "thread")
    .eq("target_id", threadId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // If the operator just removed the "Interested" label entirely
  // (vs. replacing it via POST), clear the corresponding EmailBison
  // interested flag so the lead drops off the Health Dashboard.
  const { data: removedLabel } = await supabase
    .from("labels")
    .select("name")
    .eq("id", parsed.data.label_id)
    .maybeSingle();
  if (isInterestedLabel((removedLabel?.name as string | null) ?? null)) {
    after(() => markEmailBisonReplyInterested(threadId, false));
  }

  return NextResponse.json({ ok: true });
}
