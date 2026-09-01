import { NextResponse, after } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/workspace";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { chunkedRun } from "@/lib/db/chunked-in";
import {
  isInterestedLabel,
  markEmailBisonReplyInterested,
} from "@/lib/inbox/interest";
import { notifyIntroductionForThreads } from "@/lib/webhooks/n8n-introduction";
import { pushIntroPipelineEntriesForThreadsToFub } from "@/lib/integrations/push-pipeline-entry";
import { notifyPortalIntroductionForThreads } from "@/lib/webhooks/slack-portal";
import { invalidateInboxClientsCache } from "@/lib/inbox/clients";
import {
  snapshotPipelineNotes,
  restorePipelineNotes,
  type PipelineNotesSnapshot,
} from "@/lib/inbox/preserve-pipeline-notes";

export const dynamic = "force-dynamic";

// One endpoint that dispatches across the bulk-toolbar actions. Keeping it
// in one route avoids a fan-out of POST endpoints for closely-related ops.
//
// Body shape per action:
//   seen:   { thread_ids: [], action: "seen", seen: boolean }
//   status: { thread_ids: [], action: "status", status: "open" | "archived" | "trash" | "spam" }
//   labels: { thread_ids: [], action: "labels", label_ids: [], op: "add" | "remove" }
//   list:   { thread_ids: [], action: "list", list_id: uuid, op: "add" | "remove" }
//   delete: { thread_ids: [], action: "delete" }
//   delete_permanent: { thread_ids: [], action: "delete_permanent" }
//   move_client: { thread_ids: [], action: "move_client", client_id: uuid }

const idsSchema = z.array(z.string().uuid()).min(1).max(500);

const schemas = {
  seen: z.object({
    action: z.literal("seen"),
    thread_ids: idsSchema,
    seen: z.boolean(),
  }),
  status: z.object({
    action: z.literal("status"),
    thread_ids: idsSchema,
    status: z.enum(["open", "archived", "trash", "spam", "reminder"]),
  }),
  labels: z.object({
    action: z.literal("labels"),
    thread_ids: idsSchema,
    label_ids: z.array(z.string().uuid()).min(1).max(50),
    op: z.enum(["add", "remove"]),
  }),
  list: z.object({
    action: z.literal("list"),
    thread_ids: idsSchema,
    list_id: z.string().uuid(),
    op: z.enum(["add", "remove"]),
  }),
  delete: z.object({
    action: z.literal("delete"),
    thread_ids: idsSchema,
  }),
  delete_permanent: z.object({
    action: z.literal("delete_permanent"),
    thread_ids: idsSchema,
  }),
  move_client: z.object({
    action: z.literal("move_client"),
    thread_ids: idsSchema,
    client_id: z.string().uuid(),
  }),
};

const dispatcher = z.discriminatedUnion("action", [
  schemas.seen,
  schemas.status,
  schemas.labels,
  schemas.list,
  schemas.delete,
  schemas.delete_permanent,
  schemas.move_client,
]);

export async function POST(request: Request) {
  const session = await requireSession();
  const body = await request.json().catch(() => null);
  const parsed = dispatcher.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const supabase = await createServerSupabase();
  const wsId = session.activeWorkspace.id;
  const data = parsed.data;

  // Every server-side `.in("id"|"target_id"|"thread_id", thread_ids)`
  // call below funnels through chunkedRun so the URL it builds for
  // PostgREST stays under Node's 16 KB header cap regardless of how
  // many ids the client sends. The zod schema caps at 500; without
  // chunking that translates to a ~18.5 KB URL and silent failure.
  switch (data.action) {
    case "seen": {
      const results = await chunkedRun(data.thread_ids, (slice) =>
        supabase
          .from("threads")
          .update({ seen: data.seen })
          .in("id", slice)
          .eq("workspace_id", wsId),
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) return NextResponse.json({ error: failed.error.message }, { status: 400 });
      return NextResponse.json({ ok: true });
    }
    case "status": {
      const results = await chunkedRun(data.thread_ids, (slice) =>
        supabase
          .from("threads")
          .update({ status: data.status })
          .in("id", slice)
          .eq("workspace_id", wsId),
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) return NextResponse.json({ error: failed.error.message }, { status: 400 });
      return NextResponse.json({ ok: true });
    }
    case "delete": {
      // Soft delete — move to trash. The permanent removal lives behind
      // the explicit "delete_permanent" action below (operator-confirmed,
      // bulk-select only, surfaced only in the Trash view).
      const results = await chunkedRun(data.thread_ids, (slice) =>
        supabase
          .from("threads")
          .update({ status: "trash" })
          .in("id", slice)
          .eq("workspace_id", wsId),
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) return NextResponse.json({ error: failed.error.message }, { status: 400 });
      return NextResponse.json({ ok: true });
    }
    case "delete_permanent": {
      // Hard delete. FK cascades handle messages / reminders / reply_drafts /
      // thread_list_items; client_pipeline_entries.thread_id is ON DELETE
      // SET NULL so the pipeline row keeps its history minus the back-link.
      // workspace_id scope keeps a crafted id from reaching cross-tenant rows.
      const results = await chunkedRun(data.thread_ids, (slice) =>
        supabase
          .from("threads")
          .delete()
          .in("id", slice)
          .eq("workspace_id", wsId),
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) return NextResponse.json({ error: failed.error.message }, { status: 400 });
      return NextResponse.json({ ok: true });
    }
    case "move_client": {
      // Move agent(s) to a different client. Re-tags the thread in the
      // inbox AND moves the matching portal pipeline entry so the inbox
      // and the client portal never disagree on ownership.
      //
      // Durability: the sync layer (upsertThread in lib/sync/*) does
      // "first match wins" on client_id, so a later reply on a moved
      // thread never reverts this. The move is permanent.
      const admin = createAdminSupabase();
      const targetClientId = data.client_id;

      // 1. Validate the target exists and isn't the "unknown" bucket.
      const { data: target, error: targetErr } = await admin
        .from("clients")
        .select("id, slug")
        .eq("id", targetClientId)
        .maybeSingle();
      if (targetErr) {
        return NextResponse.json({ error: targetErr.message }, { status: 400 });
      }
      if (!target) {
        return NextResponse.json({ error: "Target client not found" }, { status: 404 });
      }
      if (target.slug === "unknown") {
        return NextResponse.json(
          { error: "Agents can't be moved to the Unknown bucket." },
          { status: 400 },
        );
      }

      // 2. Move portal pipeline entries FIRST (admin — client_pipeline_entries
      //    is RLS-gated with no session policy). Only entries that belong to
      //    the caller's threads AND aren't already on the target move.
      //
      //    Collision guard for the unique (client_id, thread_id) index: if
      //    the target somehow ALREADY has an entry for one of these threads
      //    (only possible via a prior inconsistent state), delete the source
      //    entry for that thread so the UPDATE below can't hit a duplicate.
      const collisionRows = await chunkedRun(data.thread_ids, (slice) =>
        admin
          .from("client_pipeline_entries")
          .select("thread_id")
          .eq("client_id", targetClientId)
          .in("thread_id", slice),
      );
      const alreadyOnTarget = new Set<string>(
        collisionRows.flatMap((r) =>
          ((r.data ?? []) as Array<{ thread_id: string | null }>)
            .map((x) => x.thread_id)
            .filter((v): v is string => Boolean(v)),
        ),
      );
      if (alreadyOnTarget.size > 0) {
        const dupThreadIds = [...alreadyOnTarget];
        const delResults = await chunkedRun(dupThreadIds, (slice) =>
          admin
            .from("client_pipeline_entries")
            .delete()
            .neq("client_id", targetClientId)
            .in("thread_id", slice),
        );
        const delFail = delResults.find((r) => r.error);
        if (delFail?.error) {
          return NextResponse.json({ error: delFail.error.message }, { status: 400 });
        }
      }

      const pipelineResults = await chunkedRun(data.thread_ids, (slice) =>
        admin
          .from("client_pipeline_entries")
          .update({ client_id: targetClientId, updated_at: new Date().toISOString() })
          .neq("client_id", targetClientId)
          .in("thread_id", slice),
      );
      const pipelineFail = pipelineResults.find((r) => r.error);
      if (pipelineFail?.error) {
        return NextResponse.json({ error: pipelineFail.error.message }, { status: 400 });
      }

      // 3. Move the threads (session client, workspace-scoped).
      const threadResults = await chunkedRun(data.thread_ids, (slice) =>
        supabase
          .from("threads")
          .update({ client_id: targetClientId })
          .in("id", slice)
          .eq("workspace_id", wsId),
      );
      const threadFail = threadResults.find((r) => r.error);
      if (threadFail?.error) {
        return NextResponse.json({ error: threadFail.error.message }, { status: 400 });
      }

      // 4. Refresh the inbox client-filter cache (a client may have just
      //    gained or lost its last thread).
      invalidateInboxClientsCache();

      return NextResponse.json({ ok: true, moved: data.thread_ids.length });
    }
    case "labels": {
      if (data.op === "add") {
        // BEFORE the wipe, snapshot which selected threads currently
        // carry an "Interested" label. After the new labels are
        // applied, any of those threads whose new label set doesn't
        // include Interested needs its EmailBison interested flag
        // cleared so the lead drops off the Health Dashboard.
        const priorInterestedThreadIds = new Set<string>();
        {
          const { data: priors } = await supabase
            .from("label_assignments")
            .select("target_id, labels:label_id (name)")
            .eq("target_type", "thread")
            .in("target_id", data.thread_ids);
          for (const row of priors ?? []) {
            const lbl = Array.isArray(row.labels) ? row.labels[0] : row.labels;
            const name = (lbl as { name?: string | null } | null)?.name ?? null;
            if (isInterestedLabel(name)) {
              priorInterestedThreadIds.add(row.target_id as string);
            }
          }
        }

        // Resolve the label names being applied up front. When Introduction
        // is among them, snapshot the selected threads' pipeline notes BEFORE
        // the wipe below: the zero-label window lets the 0033 trigger
        // cascade-delete each entry (and its notes), and the re-inserted
        // Introduction label rebuilds fresh, note-less entries. We copy the
        // notes back onto the rebuilt entries in the introduction block below.
        const { data: applyLabels } = await supabase
          .from("labels")
          .select("id, name")
          .in("id", data.label_ids);
        const names = (applyLabels ?? []).map(
          (l) => (l.name as string | null)?.trim().toLowerCase() ?? "",
        );
        let notesSnapshot: PipelineNotesSnapshot | null = null;
        if (names.includes("introduction")) {
          notesSnapshot = await snapshotPipelineNotes(
            createAdminSupabase(),
            data.thread_ids,
          );
        }

        // Single-label-per-thread semantics (matches the single-thread
        // POST /api/threads/[id]/labels path) — wipe every existing
        // label assignment on the selected threads first, then upsert
        // the ones we're applying. Without this, bulk labeling
        // accumulated chips on top of whatever was already there and
        // operators reported the action as broken.
        //
        // The brief window where threads have zero labels is the same
        // trade-off the single-thread path makes — Supabase REST
        // doesn't support cross-statement transactions.
        const wipeResults = await chunkedRun(data.thread_ids, (slice) =>
          supabase
            .from("label_assignments")
            .delete()
            .eq("target_type", "thread")
            .in("target_id", slice),
        );
        const wipeFail = wipeResults.find((r) => r.error);
        if (wipeFail?.error) {
          return NextResponse.json({ error: wipeFail.error.message }, { status: 400 });
        }
        // Build a cross-product (thread × label) and upsert with the unique
        // constraint on (label_id, target_type, target_id).
        const rows = data.thread_ids.flatMap((tid) =>
          data.label_ids.map((lid) => ({
            workspace_id: wsId,
            label_id: lid,
            target_type: "thread" as const,
            target_id: tid,
            assigned_by: "user" as const,
            assigned_user_id: session.user.id,
          })),
        );
        // Insert in row chunks rather than thread-id chunks — the
        // payload is in the POST body, not the URL, so the cap is
        // request body size (much larger), but we still split for
        // sane request times at 5k × 50 = 250k rows.
        const insertChunkSize = 500;
        for (let i = 0; i < rows.length; i += insertChunkSize) {
          const { error } = await supabase
            .from("label_assignments")
            .upsert(rows.slice(i, i + insertChunkSize), {
              onConflict: "label_id,target_type,target_id",
            });
          if (error) return NextResponse.json({ error: error.message }, { status: 400 });
        }
        // Introduction / Interested / Not Interested among the
        // applied labels → fan out the matching side-effect for
        // every selected thread. `names` was resolved before the wipe
        // above. Done after the upsert + inside after() so the
        // user-visible response returns immediately.
        if (names.includes("introduction")) {
          const threadIds = data.thread_ids;
          after(() =>
            notifyIntroductionForThreads(threadIds, "inbox_bulk_label"),
          );
          // Auto-push each newly-introduced lead to the client's FUB
          // (if connected). Idempotent — skips entries already pushed;
          // errors land on fub_last_error and never break labeling.
          after(() => pushIntroPipelineEntriesForThreadsToFub(threadIds));
          after(() => notifyPortalIntroductionForThreads(threadIds));
          // Copy the pre-wipe notes onto the rebuilt pipeline entries
          // (no-op for entries that survived or already carry notes).
          if (notesSnapshot) {
            const snap = notesSnapshot;
            after(() => restorePipelineNotes(createAdminSupabase(), snap));
          }
        }
        if (names.includes("interested")) {
          const threadIds = data.thread_ids;
          after(async () => {
            for (const tid of threadIds) {
              await markEmailBisonReplyInterested(tid, true);
            }
          });
        }
        if (names.includes("not interested")) {
          const threadIds = data.thread_ids;
          after(async () => {
            for (const tid of threadIds) {
              await markEmailBisonReplyInterested(tid, false);
            }
          });
        }
        // Transition cleanup: any thread that WAS Interested but
        // whose new label set ISN'T Interested needs its EB flag
        // cleared. Skip when names already includes "interested"
        // (the prior-Interested-and-new-Interested case is a no-op
        // round trip we don't need to make).
        if (!names.includes("interested") && priorInterestedThreadIds.size > 0) {
          const transitioning = data.thread_ids.filter((tid) =>
            priorInterestedThreadIds.has(tid),
          );
          if (transitioning.length > 0) {
            after(async () => {
              for (const tid of transitioning) {
                await markEmailBisonReplyInterested(tid, false);
              }
            });
          }
        }
        return NextResponse.json({ ok: true });
      } else {
        // Snapshot which threads in this batch currently carry the
        // Interested label AND a label being removed in this op. We
        // need this BEFORE the delete: after the delete, we can no
        // longer tell which threads lost Interested specifically.
        const interestedThreadsLosingIt = new Set<string>();
        {
          const { data: removedLabels } = await supabase
            .from("labels")
            .select("id, name")
            .in("id", data.label_ids);
          const interestedLabelId = (removedLabels ?? []).find((l) =>
            isInterestedLabel((l.name as string | null) ?? null),
          )?.id as string | undefined;
          if (interestedLabelId) {
            const { data: priors } = await supabase
              .from("label_assignments")
              .select("target_id")
              .eq("target_type", "thread")
              .eq("label_id", interestedLabelId)
              .in("target_id", data.thread_ids);
            for (const row of priors ?? []) {
              interestedThreadsLosingIt.add(row.target_id as string);
            }
          }
        }

        const results = await chunkedRun(data.thread_ids, (slice) =>
          supabase
            .from("label_assignments")
            .delete()
            .eq("target_type", "thread")
            .in("target_id", slice)
            .in("label_id", data.label_ids),
        );
        const failed = results.find((r) => r.error);
        if (failed?.error) return NextResponse.json({ error: failed.error.message }, { status: 400 });

        // Clear EB interested flag for every thread that just lost
        // the Interested label.
        if (interestedThreadsLosingIt.size > 0) {
          const transitioning = Array.from(interestedThreadsLosingIt);
          after(async () => {
            for (const tid of transitioning) {
              await markEmailBisonReplyInterested(tid, false);
            }
          });
        }

        return NextResponse.json({ ok: true });
      }
    }
    case "list": {
      if (data.op === "add") {
        const rows = data.thread_ids.map((tid) => ({
          list_id: data.list_id,
          thread_id: tid,
          workspace_id: wsId,
          added_by: session.user.id,
        }));
        // Upsert in row chunks; payload lives in POST body.
        const insertChunkSize = 500;
        for (let i = 0; i < rows.length; i += insertChunkSize) {
          const { error } = await supabase
            .from("thread_list_items")
            .upsert(rows.slice(i, i + insertChunkSize), {
              onConflict: "list_id,thread_id",
            });
          if (error) return NextResponse.json({ error: error.message }, { status: 400 });
        }
        return NextResponse.json({ ok: true });
      } else {
        const results = await chunkedRun(data.thread_ids, (slice) =>
          supabase
            .from("thread_list_items")
            .delete()
            .eq("list_id", data.list_id)
            .in("thread_id", slice),
        );
        const failed = results.find((r) => r.error);
        if (failed?.error) return NextResponse.json({ error: failed.error.message }, { status: 400 });
        return NextResponse.json({ ok: true });
      }
    }
  }
}
