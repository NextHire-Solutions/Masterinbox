/*
 * Copied from BrokerStaffer OS, deliberately.
 *
 * Both apps read the same database and must run the reply agent by the same
 * rules, so this file is kept in step with
 * `src/lib/tools/master-inbox/ai/safety.ts` in the workspace. If one changes,
 * change the other. There is no shared package between the two deployments.
 */
/*
 * The gate every automatic send passes through.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 *
 * Everywhere else in this app an email leaves because a person clicked send.
 * Live mode removes the person. Plan §12 is the price of that: one gate, and
 * anything that fails it HOLDS and FLAGS rather than sending. The requirements
 * record calls the same thing out as open question Q8 — hostile replies,
 * unsubscribes and complaints were never discussed on the call, and they are
 * the reputational exposure that auto-send creates.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE: FACTS IN, VERDICT OUT
 *
 * `evaluate` is pure. Everything it needs has already been looked up by
 * safety-facts.ts, so the decision can be tested exhaustively — including the
 * combinations nobody wants to reproduce against a live inbox — and so that
 * the reason a reply was held is a value, not a log line.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER OF THE CHECKS IS NOT ARBITRARY
 *
 * The first failure is the reason reported, so the checks run cheapest-and-
 * most-absolute first:
 *
 *   1. live_disabled          the server gate. Nothing can send, full stop.
 *   2. not_live_mode          this agent is paused or in shadow.
 *   3. do_not_contact         this person must never be emailed again.
 *   4. unsubscribe_requested  they asked us to stop, in this thread.
 *   5. hostile_reply          the classifier already judged this thread.
 *   6. needs_human_review     something in the reply is above the agent's pay grade.
 *   7. send_cap_reached       this thread has had enough automated replies.
 *   8. rate_limited           the workspace is sending too fast.
 *   9. outside_send_window    the schedule says draft now, send later.
 *
 * Nine is last on purpose. It is the only failure that is expected, temporary
 * and self-resolving: the release job retries it when the window opens. The
 * eight above it are reasons a person should look, and one of them turning into
 * "held until 6pm" would bury it.
 */

import type { SendWindow } from "./schedule";

export type BlockReason =
  | "live_disabled"
  | "not_live_mode"
  | "do_not_contact"
  | "unsubscribe_requested"
  | "hostile_reply"
  | "needs_human_review"
  | "send_cap_reached"
  | "rate_limited"
  | "outside_send_window"
  | "schedule_unreadable"
  | "no_recipient";

export interface SafetyFacts {
  /** The server-side env gate. False today and in every environment. */
  liveSendingEnabled: boolean;
  /** The agent's own mode. Only "live" can ever send. */
  runMode: "pause" | "shadow" | "live";
  /** The lead's address is on a client's DNC list, or the thread is blocklisted. */
  doNotContact: boolean;
  /** The lead asked to be removed, in words, in this thread. */
  unsubscribeRequested: boolean;
  /** The thread carries the Hostile label (which also triggers the DNC push). */
  hostileReply: boolean;
  /** Something in the last reply needs a person — see HUMAN_REVIEW_SIGNALS. */
  needsHumanReview: boolean;
  /** Automated sends already made on this thread. */
  sendsMadeOnThread: number;
  /** Automated sends made across the workspace inside the pacing window. */
  sendsInRateWindow: number;
  /** Does this thread have somewhere to send to? */
  hasRecipient: boolean;
  /** Result of ai/schedule.ts for this agent, at this moment. */
  window: SendWindow;
}

export interface SafetyLimits {
  /** Automated replies allowed on one thread, ever. Plan §12's per-thread cap. */
  maxSendsPerThread: number;
  /** Automated sends allowed across the workspace inside the pacing window. */
  maxSendsPerWindow: number;
  rateWindowMinutes: number;
}

/*
 * The defaults, and why these numbers.
 *
 * FOUR PER THREAD. The manual flow being reproduced is: ask the qualification
 * question, confirm contact information, confirm availability, forward. That is
 * three replies and a handover. Four lets the script complete exactly once; a
 * fifth automated reply to the same person means something has gone wrong.
 *
 * THIRTY PER TEN MINUTES. Pacing exists so that a sync backlog — a webhook
 * replay, a re-import, a provider catching up after an outage — cannot turn
 * into a hundred emails in a minute. It is a blast radius, not a throughput
 * target: real positive replies arrive at a handful an hour.
 */
export const DEFAULT_LIMITS: SafetyLimits = {
  maxSendsPerThread: 4,
  maxSendsPerWindow: 30,
  rateWindowMinutes: 10,
};

export type SafetyVerdict =
  | { allowed: true }
  | { allowed: false; reason: BlockReason; detail: string; retryable: boolean };

export function evaluate(facts: SafetyFacts, limits: SafetyLimits = DEFAULT_LIMITS): SafetyVerdict {
  const no = (reason: BlockReason, detail: string, retryable = false): SafetyVerdict => ({
    allowed: false,
    reason,
    detail,
    retryable,
  });

  if (!facts.liveSendingEnabled) {
    return no(
      "live_disabled",
      "Live sending is disabled on this server. The reply was written and held.",
    );
  }
  if (facts.runMode !== "live") {
    return no("not_live_mode", `Agent is in ${facts.runMode} mode.`);
  }
  if (facts.doNotContact) {
    return no("do_not_contact", "This lead is on a do-not-contact list.");
  }
  if (facts.unsubscribeRequested) {
    return no("unsubscribe_requested", "The lead asked to be removed from our list.");
  }
  if (facts.hostileReply) {
    return no("hostile_reply", "The thread is labelled Hostile.");
  }
  if (facts.needsHumanReview) {
    return no("needs_human_review", "The reply raises something a person should answer.");
  }
  if (!facts.hasRecipient) {
    return no("no_recipient", "No inbound message on this thread to reply to.");
  }
  if (facts.sendsMadeOnThread >= limits.maxSendsPerThread) {
    return no(
      "send_cap_reached",
      `${facts.sendsMadeOnThread} automated replies already sent on this thread (cap ${limits.maxSendsPerThread}).`,
    );
  }
  if (facts.sendsInRateWindow >= limits.maxSendsPerWindow) {
    // Retryable: the window slides, and the release job will pick it up.
    return no(
      "rate_limited",
      `${facts.sendsInRateWindow} automated sends in the last ${limits.rateWindowMinutes} minutes (cap ${limits.maxSendsPerWindow}).`,
      true,
    );
  }
  if (!facts.window.open) {
    return facts.window.reason === "schedule_unreadable"
      ? no("schedule_unreadable", "The agent's schedule could not be read; holding.", true)
      : no("outside_send_window", "Inside business hours; held until the window opens.", true);
  }
  return { allowed: true };
}

/* ===========================================================================
   TEXT SIGNALS
   ---------------------------------------------------------------------------
   Two lists of phrases. They are blunt instruments and they are meant to be:
   every one of them errs towards holding a reply that could have been sent,
   which costs a few minutes of somebody's attention, rather than sending one
   that should not have been, which costs a client.
   =========================================================================== */

/** "Take me off your list." A hold, and a person should action the removal. */
const UNSUBSCRIBE_SIGNALS = [
  "unsubscribe",
  "remove me",
  "take me off",
  "opt out",
  "opt-out",
  "stop emailing",
  "stop contacting",
  "do not contact",
  "don't contact",
  "no longer wish",
  "delete my",
];

/**
 * Above the agent's pay grade. Legal threats, regulators, and anything that
 * says the person on the other end thinks they are talking to a human with
 * authority. Also covers the case the plan calls "needs human review" and the
 * requirements record leaves open as Q8.
 */
const HUMAN_REVIEW_SIGNALS = [
  "lawyer",
  "attorney",
  "legal action",
  "sue you",
  "lawsuit",
  "gdpr",
  "ccpa",
  "can-spam",
  "spam complaint",
  "report you",
  "fraud",
  "scam",
  "harass",
  "cease and desist",
  "who gave you my",
  "where did you get my",
  "speak to your manager",
  "is this a bot",
  "are you a bot",
  "are you a real person",
  "ai generated",
];

function containsAny(text: string, needles: string[]): boolean {
  const hay = text.toLowerCase();
  return needles.some((n) => hay.includes(n));
}

export function looksLikeUnsubscribe(text: string | null | undefined): boolean {
  return containsAny(text ?? "", UNSUBSCRIBE_SIGNALS);
}

export function looksLikeNeedsHumanReview(text: string | null | undefined): boolean {
  return containsAny(text ?? "", HUMAN_REVIEW_SIGNALS);
}
