import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminSupabase } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";
import { isHostileLabel, markThreadLeadDoNotContact } from "@/lib/inbox/dnc";
import {
  isInterestedLabel,
  isNotInterestedLabel,
  markEmailBisonReplyInterested,
} from "@/lib/inbox/interest";
import { notifyIntroductionForThreads } from "@/lib/webhooks/n8n-introduction";
import { pushIntroPipelineEntriesForThreadsToFub } from "@/lib/integrations/push-pipeline-entry";
import { notifyPortalIntroductionForThreads } from "@/lib/webhooks/slack-portal";
import {
  snapshotPipelineNotes,
  restorePipelineNotes,
  type PipelineNotesSnapshot,
} from "@/lib/inbox/preserve-pipeline-notes";

/*
 * Applying one label to one thread — the core of the labels route, lifted out
 * so that a caller WITHOUT a request can use it.
 *
 * Kept in step with the workspace's copy in
 * `src/lib/tools/master-inbox/inbox/apply-label.ts`; the one difference is
 * that the OS routes the introduction side effects through its durable outbox
 * (`enqueueIntroduction`), while this app fires the three notifiers directly,
 * exactly as its labels route always has.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * The labels route (app/api/threads/[threadId]/labels/route.ts) was the only
 * place a label could be applied with all of its consequences intact, and it
 * needs a signed-in session. The reply agent's live handover has none: after
 * it sends an introduction it must label the thread Introduction, and for a
 * long time it refused to, because the alternative was a second, unreviewed
 * copy of the route's logic. This function IS the route's logic. The route now
 * calls it with `actor: { kind: "user" }` and the agent with
 * `actor: { kind: "agent" }`, and both get exactly the same behaviour.
 *
 * ---------------------------------------------------------------------------
 * WHAT APPLYING A LABEL DOES (all of it preserved here, verbatim in effect)
 *
 *   · resolves the label's name; "introduction" (case-insensitive) is special
 *   · checks whether the thread ALREADY carries this label — the mandatory
 *     guard: applying Introduction announces it to the client (n8n, Slack, the
 *     portal pipeline, Follow Up Boss) and must never announce twice
 *   · if Introduction, snapshots pipeline notes BEFORE the wipe (the zero-label
 *     window lets the 0033 trigger cascade-delete the entry and its notes)
 *   · single-label semantics: deletes every other label, then upserts this one
 *   · Hostile → do-not-contact on the source platform
 *   · Introduction AND not already carried → the three announcements; then the
 *     notes snapshot is restored
 *   · Interested / Not Interested / away-from-Interested → the EmailBison
 *     interested-flag round trip
 *
 * ---------------------------------------------------------------------------
 * `defer`: INSIDE A REQUEST OR NOT
 *
 * The route runs the side effects with Next's `after()`, which is request
 * scoped. Pass it as `defer` from a route handler. Leave it out from anywhere
 * else (the agent's send path, a job) and the same side effects run here,
 * in the same order, awaited one by one and each wrapped so that a failing
 * webhook can never throw back into the caller — the label is already written
 * by then, and for the agent the introduction has already been sent.
 *
 * ---------------------------------------------------------------------------
 * `supabase`: WHOSE CLIENT
 *
 * The caller supplies the client so the route keeps writing through the same
 * session-scoped client it always did (RLS as the signed-in user), and the
 * agent writes through the admin client it always uses. This function does
 * not choose; it must not widen a user's access, and it must not narrow the
 * agent's.
 */

export type LabelActor =
  /** A signed-in person. */
  | { kind: "user"; userId: string | null }
  /** A reply agent labelling after its own introduction send. */
  | { kind: "agent"; agentId: string };

export type Defer = (task: () => Promise<unknown>) => void;

export interface ApplyLabelInput {
  supabase: SupabaseClient<Database>;
  workspaceId: string;
  threadId: string;
  labelId: string;
  actor: LabelActor;
  /** `after` from next/server inside a request; omit elsewhere. */
  defer?: Defer;
}

export type ApplyLabelResult =
  | {
      ok: true;
      labelName: string | null;
      isIntroduction: boolean;
      /** The thread had this exact label before the call. */
      alreadyCarriedThisLabel: boolean;
      /** True only when the introduction side effects were fired by this call. */
      announced: boolean;
    }
  | { ok: false; error: string };

/**
 * `assigned_by` is a Postgres enum: user | ai | webhook | system.
 *
 * The agent writes `system`, not `ai`. `ai` is the AI labeller's own value
 * and marks a guess the labeller may replace; `system` is what pinned labels
 * such as Introduction already carry (see migration 0070 and ai/run.ts, which
 * never re-classifies a `system` row). The agent's Introduction is a record of
 * something that happened, not a classification.
 */
function assignedBy(actor: LabelActor): "user" | "system" {
  return actor.kind === "user" ? "user" : "system";
}

export async function applyLabelToThread(input: ApplyLabelInput): Promise<ApplyLabelResult> {
  const { supabase, workspaceId, threadId, labelId, actor } = input;

  // Side effects: registered at the same points the route registered them.
  // With `defer` they go to `after()`; without it they are collected and run
  // inline at the end, in order, each on its own try/catch.
  const inline: Array<() => Promise<unknown>> = [];
  const defer: Defer = input.defer ?? ((task) => { inline.push(task); });

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
    .neq("label_id", labelId);
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
    .eq("id", labelId)
    .maybeSingle();
  const isIntroLabel =
    (label?.name as string | null)?.trim().toLowerCase() === "introduction";
  /*
   * IS THIS THREAD ALREADY AN INTRODUCTION?
   *
   * Applying the Introduction label announces it: a webhook to n8n, a Slack
   * post to the introductions channel, and a push to Follow Up Boss. None of
   * that was guarded, because until now the label was only ever applied once,
   * by hand.
   *
   * The Introduce button in the composer now applies it automatically when the
   * introduction is sent — and the person who sent it still applies it by
   * hand a few seconds later, out of long habit. Two applications, two Slack
   * messages, for one introduction. Nine of them on 16 September alone. The
   * reply agent's handover is a third applier, and the same guard covers it.
   *
   * The prior-label lookup above cannot answer this: it deliberately EXCLUDES
   * the label being applied, because it exists to find the label being
   * replaced. So ask directly.
   *
   * Note this is about re-announcing, not re-labelling. Applying Introduction
   * over Interested still announces, exactly as before. Only applying it to a
   * thread that already carries it is silent — because nothing changed, and
   * the client should hear about an introduction once.
   */
  const { data: sameLabelAlready } = await supabase
    .from("label_assignments")
    .select("id")
    .eq("target_type", "thread")
    .eq("target_id", threadId)
    .eq("label_id", labelId)
    .maybeSingle();
  const alreadyCarriedThisLabel = !!sameLabelAlready;

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
    .neq("label_id", labelId);
  if (deleteOthers.error) {
    return { ok: false, error: deleteOthers.error.message };
  }

  const { error } = await supabase.from("label_assignments").upsert(
    {
      workspace_id: workspaceId,
      label_id: labelId,
      target_type: "thread",
      target_id: threadId,
      assigned_by: assignedBy(actor),
      assigned_user_id: actor.kind === "user" ? actor.userId : null,
    },
    { onConflict: "label_id,target_type,target_id" },
  );
  if (error) {
    return { ok: false, error: error.message };
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
  let announced = false;
  if (isIntroLabel) {
    // Announce only when this label is NEW to the thread. See the note above
    // `alreadyCarriedThisLabel` for what was going wrong.
    if (!alreadyCarriedThisLabel) {
      announced = true;
      defer(() => notifyIntroductionForThreads([threadId], "inbox_label"));
      defer(() => pushIntroPipelineEntriesForThreadsToFub([threadId]));
      defer(() => notifyPortalIntroductionForThreads([threadId]));
    }
    // Copy the pre-relabel notes onto the rebuilt pipeline entry (no-op if
    // the entry survived or already carries notes).
    if (notesSnapshot) {
      const snap = notesSnapshot;
      defer(() => restorePipelineNotes(createAdminSupabase(), snap));
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
    defer(() => markEmailBisonReplyInterested(threadId, true));
  } else if (isNotInterestedLabel(newLabelName) || priorWasInterested) {
    defer(() => markEmailBisonReplyInterested(threadId, false));
  }

  // No request scope: run what the route would have run after its response.
  // Best-effort, in order, never thrown — the label is already written.
  for (const task of inline) {
    try {
      await task();
    } catch (err) {
      console.error(
        `[apply-label] side effect failed for thread=${threadId} label=${labelId} actor=${actor.kind}`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return {
    ok: true,
    labelName: newLabelName,
    isIntroduction: isIntroLabel,
    alreadyCarriedThisLabel,
    announced,
  };
}
