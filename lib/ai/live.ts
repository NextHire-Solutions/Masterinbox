/*
 * Copied from BrokerStaffer OS, deliberately.
 *
 * Both apps read the same database and must run the reply agent by the same
 * rules, so this file is kept in step with
 * `src/lib/tools/master-inbox/ai/live.ts` in the workspace. If one changes,
 * change the other. There is no shared package between the two deployments.
 */
import { createAdminSupabase } from "@/lib/supabase/admin";
import { applyLabelToThread } from "@/lib/inbox/apply-label";

import type { ReplyAgent } from "./agent";
import { gatherSafetyFacts } from "./safety-facts";
import { evaluate, type BlockReason } from "./safety";
import { dispatch, type OutboundAgentReply } from "./send-transport";
import { upsertThreadState, type StoredThreadState } from "./thread-state";

/*
 * The live path: what happens between "the reply is written" and "the reply
 * has gone" — including the part where it is not allowed to go.
 *
 * ---------------------------------------------------------------------------
 * ONE FUNCTION, ONE DECISION
 *
 * Every automatic send in this feature goes through `attemptLiveSend`. Not
 * because it is tidy, but because a second path is how a safety gate gets
 * bypassed: the first time someone needs to send "just the handover" from
 * somewhere else, the checks are not there. The release job (ai/release.ts)
 * calls this same function for a held reply rather than re-implementing the
 * shortened version of it that it could get away with.
 *
 * ---------------------------------------------------------------------------
 * A REFUSAL IS A RECORD, NOT A LOG LINE
 *
 * Plan §12: "Anything that fails holds and flags instead of sending." So a
 * refusal writes `hold_reason`, `held_draft_id` and `held_at` onto the thread
 * state, which is what the screen reads to show a person that a live agent
 * wanted to send and was not allowed, and what the release job reads to try
 * again when the reason was temporary.
 */

export interface LiveSendInput {
  agent: ReplyAgent;
  workspaceId: string;
  threadId: string;
  /** The reply_drafts row holding the body we would send. */
  draftId: string;
  body: string;
  subject: string | null;
  /** The lead's address. Absent means there is nobody to reply to. */
  toEmail: string | null;
  /** The text we are replying to, which several safety checks read. */
  lastInboundText: string | null;
  /** True when this reply is the handover — the introduction, with the client on CC. */
  isHandover: boolean;
  /**
   * Who is copied in. Built by runtime.ts from `planHandover`: the client's
   * introduction contacts first, then the agent's extra addresses, no address
   * twice. Empty for anything that is not the handover — CC'ing the client on
   * a qualifying question would introduce them to a conversation that has not
   * happened yet.
   *
   * Optional because the release job (ai/release.ts) re-attempts a held draft
   * from the `reply_drafts` row, which has no CC column; it resolves the list
   * the way runtime.ts does before calling here. Absent means none.
   */
  cc?: string[];
  /** The lead's name, paired with the address in the To header as the composer does. */
  leadName?: string | null;
  /** Current persisted state, for the per-thread send cap. */
  state: StoredThreadState | null;
  now: Date;
}

/**
 * `send_failed` is the transport's answer when the composer's send path ran
 * and did not send: a precondition the route would have refused (no inbound
 * reply to hang off, no EmailBison team on the channel) or the provider
 * rejecting the request. The detail says which; `retryable` says whether the
 * release job should try again.
 */
export type HoldReason = BlockReason | "send_failed";

export type LiveSendResult =
  | { status: "sent"; providerMessageId: string | null }
  | { status: "held"; reason: HoldReason; detail: string; retryable: boolean };

export async function attemptLiveSend(input: LiveSendInput): Promise<LiveSendResult> {
  const { agent, threadId, workspaceId, now } = input;

  const facts = await gatherSafetyFacts({
    workspaceId,
    threadId,
    agentId: agent.id,
    runMode: agent.run_mode,
    schedule: agent.schedule,
    lastInboundText: input.lastInboundText,
    hasRecipient: Boolean(input.toEmail && input.toEmail.trim().length > 0),
    now,
  });

  const verdict = evaluate(facts);
  if (!verdict.allowed) {
    await hold(input, verdict.reason, verdict.detail);
    return { status: "held", reason: verdict.reason, detail: verdict.detail, retryable: verdict.retryable };
  }

  /*
   * The gate said yes. `sends_attempted` is incremented BEFORE the dispatch,
   * not after: if the process dies mid-call we want the record to say we tried,
   * because the alternative — a send that happened and a counter that says it
   * did not — is how a per-thread cap gets quietly exceeded.
   */
  const attempted = (input.state?.sendsAttempted ?? 0) + 1;
  await upsertThreadState({
    workspaceId,
    threadId,
    agentId: agent.id,
    sendsAttempted: attempted,
    lastActionAt: now.toISOString(),
  });

  const payload: OutboundAgentReply = {
    workspaceId,
    threadId,
    agentId: agent.id,
    draftId: input.draftId,
    to: input.toEmail ? [input.toEmail] : [],
    toName: input.leadName ?? null,
    // The handover CC — the whole mechanism of plan §4. Resolved from the
    // client record by the runtime, not read off the agent: the agent's own
    // list is only ever extra addresses. See `planHandover`.
    cc: input.isHandover ? (input.cc ?? []) : [],
    subject: input.subject,
    body: input.body,
    isHandover: input.isHandover,
  };

  const result = await dispatch(payload);

  if (result.status === "sent") {
    await upsertThreadState({
      workspaceId,
      threadId,
      agentId: agent.id,
      sendsMade: (input.state?.sendsMade ?? 0) + 1,
      lastActionAt: now.toISOString(),
      holdReason: null,
      heldDraftId: null,
      heldAt: null,
      ...(input.isHandover ? { status: "handed_over" as const, handoverAt: now.toISOString() } : {}),
    });
    if (input.isHandover) {
      // The introduction has gone; label it, and record it if that could not
      // be done. Nothing in here can fail or repeat the send.
      await labelIntroductionAfterSend({ workspaceId, threadId, agentId: agent.id });
    }
    return { status: "sent", providerMessageId: result.providerMessageId };
  }

  // gated / failed: nothing left, and the reply is parked with its reason.
  if (result.status === "gated") {
    await hold(input, "live_disabled", result.detail);
    return { status: "held", reason: "live_disabled", detail: result.detail, retryable: true };
  }
  await hold(input, "send_failed", result.detail, !result.retryable);
  return { status: "held", reason: "send_failed", detail: result.detail, retryable: result.retryable };
}

async function hold(
  input: LiveSendInput,
  reason: HoldReason,
  detail: string,
  /** A send failure that waiting will not fix ends the conversation like the terminal reasons do. */
  permanent = false,
): Promise<void> {
  await upsertThreadState({
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    agentId: input.agent.id,
    holdReason: reason,
    heldDraftId: input.draftId,
    heldAt: input.now.toISOString(),
    lastActionAt: input.now.toISOString(),
    /*
     * Some refusals end the conversation rather than pause it. A lead who
     * asked to be removed, a hostile thread or one that needs a person will
     * never become sendable by waiting, so the state says `stopped` with the
     * reason on it — which is what the stats view counts and what the screen
     * shows. The temporary ones (window, pacing) leave the status alone.
     */
    ...(TERMINAL_REASONS.has(reason) || permanent
      ? { status: "stopped" as const, stopReason: reason }
      : {}),
  });
  console.warn(
    `[agent-live] held thread=${input.threadId} agent=${input.agent.id} reason=${reason} — ${detail}`,
  );
}

/*
 * A live introduction is always labelled Introduction.
 *
 * ---------------------------------------------------------------------------
 * THROUGH THE GUARDED PATH, NOT AROUND IT
 *
 * Applying the Introduction label is not bookkeeping. It notifies the client
 * over n8n, posts to Slack, opens a pipeline entry in that client's portal and
 * pushes it to Follow Up Boss. For a long time this function did only the
 * checks and refused the write, because the only place that applied the label
 * with all of that intact was the labels route, and the route needs a session.
 *
 * The route's core is now `applyLabelToThread` (lib .../inbox/apply-label.ts),
 * and this calls it with `actor: { kind: "agent" }`. Same guard, same wipe,
 * same notes snapshot, same announcements — with no request scope, so the
 * side effects run inline, best-effort, and never throw back here.
 *
 * ---------------------------------------------------------------------------
 * THE GUARD THE ROUTE INSISTS ON
 *
 * A thread that already carries the Introduction label must NOT be announced
 * again: the route's `alreadyCarriedThisLabel` check exists because one
 * introduction was producing two Slack posts. It is checked here first — so a
 * human's earlier label is not rewritten — and checked again inside
 * `applyLabelToThread`, which is the check that decides whether to announce.
 * "Already carries it" and "there is no such label" are both silent, correct
 * outcomes for the label; only a failed write is a problem, and it is recorded
 * rather than thrown.
 */
export type MarkIntroductionOutcome =
  | { status: "applied"; labelId: string }
  | { status: "no_label" }
  | { status: "already_introduced"; labelId: string }
  | { status: "failed"; labelId: string; error: string };

export async function markIntroduction(
  workspaceId: string,
  threadId: string,
  agentId: string,
): Promise<MarkIntroductionOutcome> {
  const admin = createAdminSupabase();

  const { data: label } = await admin
    .from("labels")
    .select("id")
    .eq("workspace_id", workspaceId)
    .ilike("name", "Introduction")
    .maybeSingle();
  const labelId = (label?.id as string | undefined) ?? null;
  if (!labelId) {
    // The workspace has not set the label up. Never invent one: that would
    // start the pipeline and Follow Up Boss machinery on a workspace that has
    // deliberately not enabled it.
    return { status: "no_label" };
  }

  const { data: carried } = await admin
    .from("label_assignments")
    .select("id")
    .eq("target_type", "thread")
    .eq("target_id", threadId)
    .eq("label_id", labelId)
    .maybeSingle();
  if (carried) {
    // The route's guard: nothing changed, so the client hears nothing new.
    return { status: "already_introduced", labelId };
  }

  const result = await applyLabelToThread({
    supabase: admin,
    workspaceId,
    threadId,
    labelId,
    actor: { kind: "agent", agentId },
    // No `defer`: there is no request here. The side effects run inline.
  });
  if (!result.ok) return { status: "failed", labelId, error: result.error };
  // The function re-checks the guard itself; if the label landed between the
  // two reads it will have declined to announce, and that is still success.
  return result.alreadyCarriedThisLabel
    ? { status: "already_introduced", labelId }
    : { status: "applied", labelId };
}

/**
 * The post-send hook: label the introduction, and leave a record when that
 * was not possible.
 *
 * Written to `stop_reason` and NOT to `hold_reason`, deliberately: hold_reason
 * is what the release job reads to re-attempt a held draft, and this reply has
 * already gone. The thread stays `handed_over`; the stats view groups every
 * non-null stop_reason, so the screen shows it. Nothing here throws.
 */
export const INTRODUCTION_LABEL_MISSING = "introduction_label_missing";
export const INTRODUCTION_LABEL_FAILED = "introduction_label_failed";

export async function labelIntroductionAfterSend(input: {
  workspaceId: string;
  threadId: string;
  agentId: string;
}): Promise<MarkIntroductionOutcome> {
  let outcome: MarkIntroductionOutcome;
  try {
    outcome = await markIntroduction(input.workspaceId, input.threadId, input.agentId);
  } catch (error) {
    outcome = {
      status: "failed",
      labelId: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await recordIntroductionOutcome(input, outcome);
  return outcome;
}

export async function recordIntroductionOutcome(
  input: { workspaceId: string; threadId: string; agentId: string },
  outcome: MarkIntroductionOutcome,
): Promise<void> {
  if (outcome.status === "applied" || outcome.status === "already_introduced") return;
  const stopReason =
    outcome.status === "no_label"
      ? INTRODUCTION_LABEL_MISSING
      : `${INTRODUCTION_LABEL_FAILED}: ${outcome.error.slice(0, 200)}`;
  console.error(
    `[agent-live] introduction sent but NOT labelled thread=${input.threadId} agent=${input.agentId} — ${stopReason}`,
  );
  try {
    await upsertThreadState({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      agentId: input.agentId,
      stopReason,
      lastActionAt: new Date().toISOString(),
    });
  } catch {
    /* The console line above is the record of last resort. */
  }
}

/** Refusals that will never resolve on their own. */
const TERMINAL_REASONS = new Set<string>([
  "do_not_contact",
  "unsubscribe_requested",
  "hostile_reply",
  "needs_human_review",
  "send_cap_reached",
]);
