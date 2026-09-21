/*
 * Copied from BrokerStaffer OS, deliberately.
 *
 * Both apps read the same database and must run the reply agent by the same
 * rules, so this file is kept in step with
 * `src/lib/tools/master-inbox/ai/send-transport.ts` in the workspace. If one changes,
 * change the other. There is no shared package between the two deployments.
 */
import { createAdminSupabase } from "@/lib/supabase/admin";
import { plainTextToHtml } from "@/lib/inbox/plain-text-html";
import { sendOutboundReply } from "@/lib/inbox/send-reply";

import { LIVE_SEND_ENV_VAR, liveSendingEnabled } from "./live-gate";

/*
 * The last inch: handing a composed reply to EmailBison or Instantly.
 *
 * ---------------------------------------------------------------------------
 * ONE SEND PATH, THE COMPOSER'S
 *
 * There is no provider call in this file. `dispatch` builds the request a
 * person's composer would have built for the same draft and hands it to
 * `sendOutboundReply` (lib .../inbox/send-reply.ts) — the reply route's own
 * send core, lifted out so it can be called without a session. Provider
 * resolution, the EmailBison /reply-or-/new choice, Instantly's forward
 * detection, the outbound `messages` row, the thread update, the feedback
 * verdict, the drafts marked sent, the composer auto-save cleanup: all of it
 * is the same code a person's send runs, with `actor: { kind: "agent" }`.
 *
 * A second path here would be the way the bookkeeping drifts: an agent send
 * the inbox list, the drafts view or the learning loop sees differently from
 * a person's. So there is none, and the plan (§10) — "extracted to a shared
 * function, with CC added" — is what this file is.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE COMPOSER DOES TO A DRAFT BEFORE IT SENDS, REPRODUCED HERE
 *
 * The composer does NOT send what the draft holds. Read its `onSend`:
 *
 *   · The body it sends is HTML, always (`content_type: "html"`). An agent
 *     draft — `reply_drafts.generated_body` — is PLAIN TEXT with real
 *     newlines, and so is the introduction macro. The composer converts on
 *     the way in with `plainTextToHtml` (single newline → <br>, blank line →
 *     paragraph). Send the text as HTML without that step and every paragraph
 *     break is gone: the introduction arrives as one run-on block, "Best,"
 *     glued to the sentence before it. `agentBodyHtml` below is that
 *     conversion, done once, and it leaves a body that is already HTML alone
 *     so nothing is escaped twice.
 *
 *   · The subject is the source message's, normalised to exactly one "Re: "
 *     prefix (thread-view.tsx). `agentSubject` is that rule. `subject_changed`
 *     is false — reply mode locks the field — so EmailBison keeps threading
 *     through /replies/{id}/reply.
 *
 *   · The signature is appended only when the operator ticked "add signature",
 *     and that box defaults to OFF (`composerDraft?.add_signature ?? false`).
 *     A person's default send carries no signature, so neither does the
 *     agent's. Deliberate, and stated so nobody wonders.
 *
 *   · `reply_all` is "0" and `inject_previous_email_body` is "1" — the route's
 *     defaults, left as they are.
 *
 *   · The composer's CC field is pre-filled with the workspace's always-CC
 *     address. That is a composer concern, not a route one (the route sends
 *     `cc` verbatim). The agent's CC is the handover plan's list — the
 *     client's introduction contacts and the agent's extras — and nothing on
 *     an ordinary reply. Plan §4.
 *
 * ---------------------------------------------------------------------------
 * THE GATE IS CHECKED HERE TOO
 *
 * The safety gate (ai/safety.ts, via attemptLiveSend) checks the env gate
 * first and holds with `live_disabled`. This function checks it AGAIN before
 * anything else, so that a caller which forgot the gate — or a future one
 * written in a hurry — still cannot send. With the variable unset, `dispatch`
 * returns `gated` having touched nothing: no database read, no provider
 * client, no request.
 */

export interface OutboundAgentReply {
  workspaceId: string;
  threadId: string;
  agentId: string;
  /** The reply_drafts row this body came from; the bookkeeping keys off it. */
  draftId: string;
  to: string[];
  /** The lead's name for the To header, as the composer pairs it with a single address. */
  toName?: string | null;
  /** The handover CC — the client being introduced into the thread. Plan §4. */
  cc: string[];
  subject: string | null;
  /** The draft as stored: plain text with real newlines. */
  body: string;
  /** True when this is the qualifying reply that hands the lead over. */
  isHandover: boolean;
}

export type TransportResult =
  /** The env gate is off. Nothing was called. */
  | { status: "gated"; detail: string }
  /** The send path ran and refused or the provider rejected it. Nothing left. */
  | { status: "failed"; detail: string; retryable: boolean }
  | { status: "sent"; providerMessageId: string | null };

/**
 * Whether a provider call is reachable from this file.
 *
 * A constant rather than a check of the code, so that "is the transport wired"
 * is greppable and shows up in the status the API reports. True since the
 * reply route's send core was extracted and `dispatch` began calling it.
 */
export const LIVE_TRANSPORT_WIRED = true;

/**
 * Plain text → the HTML the composer would have sent for it.
 *
 * `reply_drafts.generated_body` is stored plain: the model returns text, and
 * the handover macro is rendered as text. A body that already carries block
 * markup is passed through untouched — converting it would escape its tags
 * into literal `&lt;p&gt;` and the lead would read the markup.
 */
export function agentBodyHtml(body: string): string {
  return looksLikeHtml(body) ? body : plainTextToHtml(body);
}

/** Markup at the start is the only reliable sign of an HTML body. */
export function looksLikeHtml(body: string): boolean {
  return /^\s*<(p|div|br|html|body|table|ul|ol|h[1-6]|blockquote|span|b|i|strong|em)\b[^>]*>/i.test(body);
}

/**
 * The composer's subject rule: the source message's subject, with exactly one
 * "Re: " in front. Undefined when there is nothing to reply to, which the
 * send core treats as "none supplied" — EmailBison's /reply inherits the
 * conversation's, and Instantly falls back to the thread's.
 */
export function agentSubject(subject: string | null): string | undefined {
  const base = (subject ?? "").trim();
  if (!base) return undefined;
  return /^re:\s/i.test(base) ? base : `Re: ${base}`;
}

/**
 * Hand a composed reply to the provider through the composer's send path.
 *
 * The caller records the outcome on the thread state and flags it, exactly as
 * it would for any other reason a send did not happen.
 */
export async function dispatch(reply: OutboundAgentReply): Promise<TransportResult> {
  if (!liveSendingEnabled()) {
    return {
      status: "gated",
      detail: `${LIVE_SEND_ENV_VAR} is not set; the reply was written and held.`,
    };
  }

  const to = reply.to
    .map((e) => e.trim())
    .filter(Boolean)
    .map((email_address, i) =>
      // The composer pairs the name with a single recipient only.
      i === 0 && reply.to.length === 1 && reply.toName
        ? { email_address, name: reply.toName }
        : { email_address },
    );
  const cc = reply.cc
    .map((e) => e.trim())
    .filter(Boolean)
    .map((email_address) => ({ email_address }));

  try {
    const result = await sendOutboundReply({
      admin: createAdminSupabase(),
      workspaceId: reply.workspaceId,
      threadId: reply.threadId,
      body: { kind: "html", html: agentBodyHtml(reply.body) },
      subject: agentSubject(reply.subject),
      subjectChanged: false,
      to,
      cc,
      bcc: undefined,
      replyAll: false,
      injectPreviousEmailBody: true,
      actor: { kind: "agent", agentId: reply.agentId },
    });

    if (!result.ok) {
      const detail =
        `${result.body.error}` +
        (result.body.status ? ` (provider ${result.body.status})` : "") +
        (result.body.detail ? `: ${result.body.detail}` : "");
      console.error(
        `[agent-send] send refused thread=${reply.threadId} agent=${reply.agentId} draft=${reply.draftId} ` +
          `http=${result.status} — ${detail}`,
      );
      // 502 is the provider saying no, which a later attempt may not hear.
      // Everything else is a precondition — no reply to hang off, no team on
      // the channel — that waiting will not change.
      return { status: "failed", detail, retryable: result.status === 502 };
    }

    console.info(
      `[agent-send] sent thread=${reply.threadId} agent=${reply.agentId} draft=${reply.draftId} ` +
        `via=${result.provider} id=${result.providerMessageId ?? "none"}` +
        (cc.length > 0 ? ` cc=${cc.map((c) => c.email_address).join(",")}` : "") +
        (result.feedback ? ` verdict=${result.feedback.verdict}` : ""),
    );
    return { status: "sent", providerMessageId: result.providerMessageId };
  } catch (err) {
    // A thrown error here is configuration (no API key) or infrastructure;
    // the send core returns provider rejections rather than throwing them.
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[agent-send] send threw thread=${reply.threadId} agent=${reply.agentId} draft=${reply.draftId} — ${detail}`,
    );
    return { status: "failed", detail, retryable: true };
  }
}
