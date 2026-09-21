/*
 * Copied from BrokerStaffer OS, deliberately.
 *
 * Both apps read the same database and must run the reply agent by the same
 * rules, so this file is kept in step with
 * `src/lib/tools/master-inbox/ai/safety-facts.ts` in the workspace. If one changes,
 * change the other. There is no shared package between the two deployments.
 */
import { createAdminSupabase } from "@/lib/supabase/admin";

import { liveSendingEnabled } from "./live-gate";
import { sendWindow } from "./schedule";
import {
  DEFAULT_LIMITS,
  looksLikeNeedsHumanReview,
  looksLikeUnsubscribe,
  type SafetyFacts,
  type SafetyLimits,
} from "./safety";
import type { AgentSchedule, RunMode } from "./agent-config";

/*
 * Looking up what the safety gate needs to know.
 *
 * ---------------------------------------------------------------------------
 * SPLIT FROM safety.ts ON PURPOSE
 *
 * safety.ts decides; this file reads. Keeping the decision pure means the
 * dangerous half — "is this person on a do-not-contact list" — can be
 * exhaustively tested, and this half can be read in one sitting to check that
 * every question is actually being asked.
 *
 * ---------------------------------------------------------------------------
 * EVERY READ IS A READ
 *
 * Nothing in this file writes. It touches `leads`, `label_assignments`,
 * `labels`, `client_dnc_entries` and `agent_thread_state`, and only ever
 * selects.
 *
 * ---------------------------------------------------------------------------
 * A FAILED LOOKUP IS A BLOCKED SEND
 *
 * If Supabase errors, we do not "assume fine and carry on" — an unreadable DNC
 * list is indistinguishable from a DNC list with this lead on it. Every
 * fallback below is the pessimistic one, and the one deliberate exception is
 * documented where it sits.
 */

export interface GatherFactsInput {
  workspaceId: string;
  threadId: string;
  agentId: string;
  runMode: RunMode;
  schedule: AgentSchedule;
  /** The text of the reply we are responding to. */
  lastInboundText: string | null;
  /** Whether the thread has an inbound message we can reply to. */
  hasRecipient: boolean;
  now: Date;
  limits?: SafetyLimits;
}

export async function gatherSafetyFacts(input: GatherFactsInput): Promise<SafetyFacts> {
  const limits = input.limits ?? DEFAULT_LIMITS;
  const admin = createAdminSupabase();

  // ---- the thread's labels, which carry two of the checks ------------------
  // Hostile is the label that also triggers the provider-side DNC push
  // (lib/inbox/dnc.ts), so its presence means this lead is already blocked
  // upstream. "Needs human review" is matched by name so an operator can create
  // that label and have the agent respect it without a code change.
  let hostileReply = true;
  let needsReviewLabel = true;
  try {
    const { data, error } = await admin
      .from("label_assignments")
      .select("labels:label_id(name)")
      .eq("target_type", "thread")
      .eq("target_id", input.threadId);
    if (error) throw new Error(error.message);
    const names = (data ?? [])
      .map((r) => {
        const l = Array.isArray(r.labels) ? r.labels[0] : r.labels;
        return ((l as { name?: string } | null)?.name ?? "").trim().toLowerCase();
      })
      .filter(Boolean);
    hostileReply = names.includes("hostile");
    needsReviewLabel = names.some((n) => n.includes("needs human review") || n === "escalate");
  } catch (err) {
    console.error("[agent-safety] label lookup failed; holding", err);
  }

  // ---- the lead, and whether anyone has asked us never to contact them -----
  let doNotContact = true;
  try {
    const { data: thread, error: tErr } = await admin
      .from("threads")
      .select("lead_id, client_id")
      .eq("id", input.threadId)
      .maybeSingle();
    if (tErr) throw new Error(tErr.message);

    let email: string | null = null;
    if (thread?.lead_id) {
      const { data: lead, error: lErr } = await admin
        .from("leads")
        .select("email")
        .eq("id", thread.lead_id)
        .maybeSingle();
      if (lErr) throw new Error(lErr.message);
      email = ((lead?.email as string | null) ?? "").trim().toLowerCase() || null;
    }

    if (!email) {
      // No address means nothing to check AND nothing to send to. The
      // no_recipient check downstream is the one that reports this properly;
      // treating it as "on the DNC list" here would report the wrong reason.
      doNotContact = false;
    } else {
      /*
       * client_dnc_entries is the clients' own do-not-contact list, kept per
       * client but checked GLOBALLY here: if any client has told us never to
       * email this person, an automated reply from any agent is the wrong
       * thing to send. A person replying by hand still can — this gate binds
       * the agent, not the operator.
       */
      const { data: dnc, error: dErr } = await admin
        .from("client_dnc_entries")
        .select("id")
        .ilike("email", email)
        .limit(1);
      if (dErr) throw new Error(dErr.message);
      doNotContact = (dnc ?? []).length > 0;
    }
  } catch (err) {
    console.error("[agent-safety] do-not-contact lookup failed; holding", err);
  }

  // ---- how much this agent has already sent -------------------------------
  let sendsMadeOnThread = Number.MAX_SAFE_INTEGER;
  try {
    const { data, error } = await admin
      .from("agent_thread_state")
      .select("sends_made")
      .eq("thread_id", input.threadId)
      .eq("agent_id", input.agentId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    sendsMadeOnThread = Number(data?.sends_made ?? 0);
  } catch (err) {
    console.error("[agent-safety] per-thread send count failed; holding", err);
  }

  /*
   * Pacing, across the whole workspace.
   *
   * This SUMS sends_made over every thread-state touched inside the window,
   * rather than counting the sends that happened inside it. That over-counts —
   * a thread that sent three replies yesterday and one today contributes four —
   * and over-counting is the direction a blast-radius control should err in.
   * An exact count would need a per-send log table, which plan §9 does not ask
   * for and which would be a second set of books against `reply_drafts`.
   */
  let sendsInRateWindow = Number.MAX_SAFE_INTEGER;
  try {
    const cutoff = new Date(input.now.getTime() - limits.rateWindowMinutes * 60_000).toISOString();
    const { data, error } = await admin
      .from("agent_thread_state")
      .select("sends_made")
      .eq("workspace_id", input.workspaceId)
      .gte("last_action_at", cutoff)
      .gt("sends_made", 0);
    if (error) throw new Error(error.message);
    sendsInRateWindow = (data ?? []).reduce((n, r) => n + Number(r.sends_made ?? 0), 0);
  } catch (err) {
    console.error("[agent-safety] pacing lookup failed; holding", err);
  }

  return {
    liveSendingEnabled: liveSendingEnabled(),
    runMode: input.runMode,
    doNotContact,
    unsubscribeRequested: looksLikeUnsubscribe(input.lastInboundText),
    hostileReply,
    needsHumanReview: needsReviewLabel || looksLikeNeedsHumanReview(input.lastInboundText),
    sendsMadeOnThread,
    sendsInRateWindow,
    hasRecipient: input.hasRecipient,
    window: sendWindow(input.schedule, input.now),
  };
}
