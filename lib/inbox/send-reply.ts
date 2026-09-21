import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";
import { createEmailBisonClient } from "@/lib/emailbison/client";
import { createInstantlyClient, InstantlyError } from "@/lib/instantly/client";
import { recordSendFeedback, type RecordSendResult } from "@/lib/ai/feedback";

/*
 * Sending one reply on one thread — the core of the reply route, lifted out
 * so that a caller WITHOUT a request can use it.
 *
 * Kept in step with the workspace's copy in
 * `src/lib/tools/master-inbox/inbox/send-reply.ts`; the one difference is the
 * Instantly send, which here is exactly what this app's route did before the
 * extraction: a `plain` body goes to Instantly as `{ text }` and the request's
 * subject is used as given. The OS's route converts text to HTML and falls
 * back to the thread's subject; that fix has not been brought here, so this
 * app's route keeps its behaviour byte for byte.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * The reply route (threads/[threadId]/reply/route.ts) was the only place a
 * reply could leave with all of its consequences intact: the provider call,
 * the outbound `messages` row, the thread's list state, the feedback verdict,
 * the drafts marked sent, the composer auto-save removed. It needs a session.
 * The reply agent's live send has none — and the plan (§10) says its send must
 * be "extracted to a shared function, with CC added", because a second copy
 * of this logic is how the bookkeeping drifts: an agent send that the inbox
 * list, the drafts view or the learning loop sees differently from a person's.
 *
 * This function IS the route's logic, moved. The route parses and
 * authenticates exactly as before and calls it with `actor: { kind: "user" }`;
 * the agent's transport (ai/send-transport.ts) calls it with
 * `actor: { kind: "agent" }`. Same provider calls, same rows, same order.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES, IN ORDER (all of it the route's, verbatim in effect)
 *
 *   · resolves the sender override (`senderChannelId`) into provider ids
 *   · Instantly threads: picks the reply target (source message or latest
 *     inbound), detects a forward, sends via /emails/reply or /emails/forward
 *   · EmailBison threads: resolves the team from the channel, the reply to
 *     hang off, the sender_email_id from the inbound envelope; defaults `to`
 *     to the lead; sends via /replies/{id}/reply, or /replies/new when the
 *     subject was changed, multipart when there are attachments
 *   · records the outbound `messages` row with the provider's id
 *   · advances the thread (needs_reply, seen, last_message_at, preview)
 *   · `recordSendFeedback` — BEFORE the drafts are marked sent, AFTER the
 *     message is stored (see ai/feedback.ts for why that order matters)
 *   · marks the thread's pending `reply_drafts` sent
 *   · deletes the composer auto-save, best-effort
 *
 * Failures come back as `{ ok: false, status, body }` carrying exactly the
 * HTTP status and JSON body the route returned before, so the route can hand
 * them to the client unchanged and a person sees what they always saw.
 *
 * ---------------------------------------------------------------------------
 * THE BODY IS TYPED, NOT FLAGGED
 *
 * The route's request carries `body` plus `content_type`. Here the two are one
 * discriminated value: `{ kind: "html", html }` or `{ kind: "plain", text }`.
 * The reason is the single most likely defect in an automated send: an agent
 * draft is PLAIN TEXT with real newlines, and the composer converts it to
 * HTML (`plainTextToHtml`) before it sends. Forwarding that text as HTML
 * delivers an introduction as one run-on block with every paragraph break
 * gone. A bare string with a flag lets that happen silently; a tagged value
 * makes the caller say which it is, and the compiler refuses the mistake.
 *
 * `plain` keeps the route's exact `content_type: "text"` behaviour: EmailBison
 * receives a text body and so does Instantly (`{ text }`).
 */

export type Recipient = { name?: string | null; email_address: string };

export type OutboundBody =
  /** Already HTML — what the composer sends. Passed through untouched. */
  | { kind: "html"; html: string }
  /** Plain text with real newlines — the route's `content_type: "text"`. */
  | { kind: "plain"; text: string };

export type SendActor =
  /** A signed-in person. `userId` is null in the OS, which has no auth.users rows. */
  | { kind: "user"; userId: string | null }
  /** A reply agent sending its own draft. */
  | { kind: "agent"; agentId: string };

export interface SendOutboundReplyInput {
  /** The service-role client the route used for every write. */
  admin: SupabaseClient<Database>;
  workspaceId: string;
  threadId: string;
  body: OutboundBody;
  /** Absent means the request carried none — the stored row gets null. */
  subject?: string;
  /** The composer's flag: the operator edited the Subject. EmailBison only. */
  subjectChanged?: boolean;
  to?: Recipient[];
  cc?: Recipient[];
  bcc?: Recipient[];
  /** Route default: false. */
  replyAll?: boolean;
  /** Route default: true. */
  injectPreviousEmailBody?: boolean;
  /** messages.id of the message being replied to; latest inbound when absent. */
  sourceMessageId?: string;
  /** channels.id overriding the sender mailbox for this send. */
  senderChannelId?: string;
  /** Files already parsed and size-checked by the route. Never for the agent. */
  attachments?: Array<{ name: string; blob: Blob }>;
  actor: SendActor;
}

export type SendOutboundReplyResult =
  | {
      ok: true;
      provider: "emailbison" | "instantly";
      /** The provider's id for what went out, when it returned one. */
      providerMessageId: string | null;
      /** What the `messages` row carries as external_message_id. */
      externalMessageId: string;
      /** The learning-loop verdict, null when there was no draft to grade. */
      feedback: RecordSendResult | null;
    }
  | {
      ok: false;
      /** The HTTP status the route returned for this failure. */
      status: number;
      /** The JSON body the route returned for this failure, unchanged. */
      body: { error: string; status?: number | null; detail?: string };
    };

type ThreadRow = {
  id: string;
  workspace_id: string;
  lead_id: string | null;
  channel_id: string | null;
  outbound_sender_email: string | null;
  source_provider: string | null;
  instantly_thread_id: string | null;
};

/** The route's view of the body: the string it sent and the content_type it named. */
function flatten(body: OutboundBody): { text: string; contentType: "html" | "text" } {
  return body.kind === "html"
    ? { text: body.html, contentType: "html" }
    : { text: body.text, contentType: "text" };
}

export async function sendOutboundReply(input: SendOutboundReplyInput): Promise<SendOutboundReplyResult> {
  const { admin, threadId, actor } = input;
  const attachments = input.attachments ?? [];
  const payload = {
    ...flatten(input.body),
    subject: input.subject,
    subject_changed: input.subjectChanged,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    reply_all: input.replyAll ?? false,
    inject_previous_email_body: input.injectPreviousEmailBody ?? true,
    source_message_id: input.sourceMessageId,
    sender_channel_id: input.senderChannelId,
  };

  // The route read the thread through the caller's session as its membership
  // check and then wrote through the admin client. Here the thread is read
  // again through the admin client, scoped to the workspace the caller named:
  // the route's check has already happened, and the agent has no session.
  const { data: threadRow } = await admin
    .from("threads")
    .select("id, workspace_id, lead_id, channel_id, outbound_sender_email, source_provider, instantly_thread_id")
    .eq("id", threadId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();
  if (!threadRow) return { ok: false, status: 404, body: { error: "Thread not found" } };
  const thread = threadRow as unknown as ThreadRow;

  // Resolve the sender override (if supplied) into provider-specific
  // identifiers. The composer's From-dropdown sends sender_channel_id;
  // we look it up here so the downstream send calls don't have to know
  // about the channel layer.
  let senderOverride:
    | {
        emailbisonSenderEmailId: number | null;
        instantlyEaccount: string | null;
        emailbisonTeamId: number | null;
      }
    | null = null;
  if (payload.sender_channel_id) {
    const { data: ch } = await admin
      .from("channels")
      .select(
        "id, workspace_id, provider, display_name, emailbison_sender_email_id, instantly_account_id, emailbison_team_id",
      )
      .eq("id", payload.sender_channel_id)
      .eq("workspace_id", thread.workspace_id)
      .maybeSingle();
    if (!ch) {
      return {
        ok: false,
        status: 400,
        body: { error: "Selected sender channel not found in this workspace." },
      };
    }
    const ebId = ch.emailbison_sender_email_id as string | null;
    senderOverride = {
      emailbisonSenderEmailId: ebId ? Number(ebId) : null,
      instantlyEaccount:
        (ch.instantly_account_id as string | null) ??
        (ch.display_name as string | null),
      emailbisonTeamId: (ch.emailbison_team_id as number | null) ?? null,
    };
  }

  // Instantly threads use a completely different send API. Dispatch early so
  // the rest of this function can stay EmailBison-specific.
  if (thread.source_provider === "instantly") {
    return sendInstantlyReply({
      admin,
      threadId,
      workspaceId: thread.workspace_id,
      outboundSenderEmail:
        senderOverride?.instantlyEaccount ?? thread.outbound_sender_email,
      payload,
      attachments,
      actor,
    });
  }

  // EmailBison team_id is pinned on the channel (one per sender_email)
  // — workspaces don't carry a team_id anymore in single-tenant BrokerStaffer
  // because brokerstaffer.com has multiple teams feeding one workspace.
  // When the user picks a sender override, use its team instead of the
  // thread's original channel team.
  let ebTeamId: number | null = senderOverride?.emailbisonTeamId ?? null;
  if (ebTeamId === null && thread.channel_id) {
    const { data: ch } = await admin
      .from("channels")
      .select("emailbison_team_id")
      .eq("id", thread.channel_id)
      .maybeSingle();
    ebTeamId = (ch?.emailbison_team_id as number | null) ?? null;
  }
  if (ebTeamId === null) {
    return {
      ok: false,
      status: 400,
      body: {
        error:
          "This thread's channel isn't linked to an EmailBison team yet. Wait for the next inbound reply on this sender, or re-register the webhook.",
      },
    };
  }

  // Pick the EmailBison reply to hang our response off of. Same logic as
  // the Instantly path: prefer the user-clicked source message (so the
  // outbound's In-Reply-To header points at the right ancestor for Gmail
  // threading), fall back to the latest inbound for the bottom Reply
  // button which doesn't carry a source_message_id.
  let lastInbound: { id: string; emailbison_reply_id: string | null; raw_payload: unknown } | null = null;
  if (payload.source_message_id) {
    const { data } = await admin
      .from("messages")
      .select("id, emailbison_reply_id, raw_payload")
      .eq("id", payload.source_message_id)
      .eq("thread_id", threadId)
      .maybeSingle();
    lastInbound = data ?? null;
  }
  if (!lastInbound?.emailbison_reply_id) {
    const { data } = await admin
      .from("messages")
      .select("id, emailbison_reply_id, raw_payload")
      .eq("thread_id", threadId)
      .eq("direction", "inbound")
      .not("emailbison_reply_id", "is", null)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    lastInbound = data ?? null;
  }
  if (!lastInbound?.emailbison_reply_id) {
    return {
      ok: false,
      status: 400,
      body: { error: "No inbound EmailBison reply found to reply to." },
    };
  }

  // EmailBison requires sender_email_id when reply_all=false. Pulled from
  // the canonical location in the webhook envelope:
  //   raw_payload.data.sender_email.id
  // This is always present on LEAD_REPLIED — it's OUR connected account
  // that received the reply.
  const inboundPayload = (lastInbound.raw_payload ?? {}) as Record<string, unknown>;
  const dataBlock = inboundPayload.data as Record<string, unknown> | undefined;
  const senderEmailId =
    (dataBlock?.sender_email as { id?: number } | undefined)?.id ?? null;
  if (!senderEmailId) {
    return {
      ok: false,
      status: 500,
      body: { error: "sender_email.id missing from inbound payload — cannot reply." },
    };
  }

  // Default `to` to the lead when none supplied + reply_all is false.
  let toEmails = payload.to;
  if (!payload.reply_all && (!toEmails || toEmails.length === 0)) {
    const { data: lead } = await admin
      .from("leads")
      .select("email, full_name")
      .eq("id", thread.lead_id)
      .maybeSingle();
    if (lead?.email) {
      toEmails = [{ name: lead.full_name ?? null, email_address: lead.email }];
    }
  }

  // Send via EmailBison.
  //
  // When the operator changes the Subject in the composer
  // (payload.subject_changed === true), route through
  // /api/replies/new instead of /api/replies/{id}/reply because the
  // reply endpoint silently drops the subject. /replies/new starts
  // a fresh thread on EmailBison's side — recipient still receives
  // the new subject, which is the whole point. The unchanged-subject
  // case keeps using /reply so EmailBison-side threading is
  // preserved for the common path.
  //
  // The new endpoint requires a non-null sender_email_id. Reply-all
  // sends with a changed subject still need one (the reply endpoint
  // could pass null because EmailBison inferred the sender from
  // the parent reply; /replies/new has no parent to infer from), so
  // we fall back to senderEmailId from the inbound webhook envelope.
  //
  // Constructed outside the try, as the route did: a missing API key is a
  // configuration error that throws to the caller, not a 502 from EmailBison.
  const eb = createEmailBisonClient();
  let newReplyId: number | null = null;
  const effectiveSenderEmailId =
    senderOverride?.emailbisonSenderEmailId ?? senderEmailId;
  const subjectChanged = payload.subject_changed === true;
  try {
    await eb.switchWorkspace(ebTeamId);
    if (subjectChanged) {
      // /api/replies/new — subject-honouring path. Requires a subject
      // (zod-checked in the route via the optional schema; we coerce empty to
      // the original thread subject as a safety net) and a sender_email_id.
      const subjectForNew =
        (payload.subject ?? "").trim() || "(no subject)";
      if (attachments.length > 0) {
        const res = await eb.composeNewEmailMultipart({
          subject: subjectForNew,
          message: payload.text,
          sender_email_id: effectiveSenderEmailId,
          content_type: payload.contentType,
          to_emails: toEmails,
          cc_emails: payload.cc && payload.cc.length > 0 ? payload.cc : undefined,
          bcc_emails: payload.bcc && payload.bcc.length > 0 ? payload.bcc : undefined,
          attachments,
        });
        newReplyId = res?.data?.reply?.id ?? null;
      } else {
        const res = await eb.composeNewEmail({
          subject: subjectForNew,
          message: payload.text,
          sender_email_id: effectiveSenderEmailId,
          content_type: payload.contentType,
          to_emails: toEmails,
          cc_emails: payload.cc && payload.cc.length > 0 ? payload.cc : undefined,
          bcc_emails: payload.bcc && payload.bcc.length > 0 ? payload.bcc : undefined,
        });
        newReplyId = res?.data?.reply?.id ?? null;
      }
    } else if (attachments.length > 0) {
      const res = await eb.sendReplyMultipart(Number(lastInbound.emailbison_reply_id), {
        message: payload.text,
        content_type: payload.contentType,
        to_emails: toEmails,
        cc_emails: payload.cc && payload.cc.length > 0 ? payload.cc : undefined,
        bcc_emails: payload.bcc && payload.bcc.length > 0 ? payload.bcc : undefined,
        reply_all: payload.reply_all,
        inject_previous_email_body: payload.inject_previous_email_body,
        sender_email_id: payload.reply_all ? null : effectiveSenderEmailId,
        attachments,
      });
      // Response shape: { data: { success, reply: { id } } }
      newReplyId = res?.data?.reply?.id ?? null;
    } else {
      const res = await eb.sendReply(Number(lastInbound.emailbison_reply_id), {
        message: payload.text,
        content_type: payload.contentType,
        to_emails: toEmails,
        cc_emails: payload.cc && payload.cc.length > 0 ? payload.cc : undefined,
        bcc_emails: payload.bcc && payload.bcc.length > 0 ? payload.bcc : undefined,
        reply_all: payload.reply_all,
        inject_previous_email_body: payload.inject_previous_email_body,
        sender_email_id: payload.reply_all ? null : effectiveSenderEmailId,
      });
      // Response shape: { data: { success, reply: { id } } }
      newReplyId = res?.data?.reply?.id ?? null;
    }
  } catch (err) {
    // EmailBisonError carries the response body. Surface it so the UI shows
    // what EmailBison actually rejected (422 etc) rather than a vague 502.
    type EBError = { message?: string; status?: number; body?: unknown };
    const e = err as EBError;
    const eBody = e?.body;
    console.error("[reply] EmailBison error:", {
      status: e?.status,
      message: e?.message,
      body: eBody,
    });
    const detail =
      typeof eBody === "string"
        ? eBody.slice(0, 500)
        : eBody
          ? JSON.stringify(eBody).slice(0, 500)
          : undefined;
    return {
      ok: false,
      status: 502,
      body: {
        error: e?.message ?? "EmailBison send failed",
        status: e?.status ?? null,
        detail,
      },
    };
  }

  // Record the outbound message immediately so the UI updates without
  // waiting for the webhook echo. external_message_id MUST match the id
  // the conversation-thread backfill will compute later, otherwise we end
  // up with a duplicate row. We use the new reply id returned from
  // EmailBison's send response — the backfill uses the same `eb:reply:<id>`
  // scheme so the second write becomes an idempotent update.
  const outboundId = newReplyId
    ? `eb:reply:${newReplyId}`
    : `eb-out:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const recipientsPayload = {
    to: toEmails?.map((r) => r.email_address) ?? [],
    cc: payload.cc?.map((r) => r.email_address) ?? [],
    bcc: payload.bcc?.map((r) => r.email_address) ?? [],
  };
  // Compute once so the stored message and the thread's list-preview
  // agree exactly. The thread list shows last_message_preview /
  // last_message_at as the conversation's most-recent activity — so
  // an outbound send must advance them too, otherwise the list keeps
  // showing the lead's last inbound message even after we reply.
  const ebSentAt = new Date().toISOString();
  const ebOutboundText =
    payload.contentType === "text"
      ? payload.text
      : payload.text.replace(/<[^>]+>/g, "");
  await admin.from("messages").insert({
    workspace_id: thread.workspace_id,
    thread_id: threadId,
    direction: "outbound",
    // Sender is the EmailBison sender account that actually sent the
    // message — NOT the logged-in user. They differ when a teammate hits
    // Send on a workspace where someone else owns the sender account.
    sender: thread.outbound_sender_email,
    recipients: recipientsPayload,
    subject: payload.subject ?? null,
    body_html: payload.contentType === "html" ? payload.text : null,
    body_text: ebOutboundText,
    sent_at: ebSentAt,
    external_message_id: outboundId,
    emailbison_reply_id: newReplyId ? String(newReplyId) : null,
  });
  await admin
    .from("threads")
    .update({
      needs_reply: false,
      seen: true,
      last_message_at: ebSentAt,
      last_message_preview: ebOutboundText.slice(0, 200),
    })
    .eq("id", threadId);

  /*
   * THE AGENT LEARNS FROM WHAT YOU DID TO ITS DRAFT.
   *
   * Taken here, and here specifically, for two reasons. It must run BEFORE the
   * update below — that marks the pending draft 'sent', and the comparison
   * finds the draft by being pending. And it must run AFTER the outbound
   * message is stored, so a reply somebody rewrote can be filed as a
   * correction against the message it became.
   *
   * Best-effort by construction: `recordSendFeedback` catches everything and
   * returns null rather than throwing. The email has already gone to a real
   * person; our bookkeeping about how well the model wrote it is not a reason
   * to hand back an error. See lib/tools/master-inbox/ai/feedback.ts.
   *
   * An agent sending its own draft grades as `as_written`. That is correct:
   * the draft went out unchanged, and the corpus records exactly that.
   */
  const feedback = await recordSendFeedback({
    workspaceId: thread.workspace_id,
    threadId,
    sentBody: payload.text,
    sentIsHtml: payload.contentType === "html",
  });

  // Mark any pending drafts on this thread as sent — the user has acted on
  // the conversation and we don't want stale "review me" drafts hanging
  // around in the composer.
  await admin
    .from("reply_drafts")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("thread_id", threadId)
    .eq("status", "pending");

  // Delete any composer auto-save on this thread — the operator
  // just sent, so the typed body is no longer "in progress".
  // Best-effort: a failure here MUST NOT fail the user-visible
  // send, the row will simply linger until the next save / discard.
  try {
    await admin
      .from("composer_drafts")
      .delete()
      .eq("workspace_id", thread.workspace_id)
      .eq("thread_id", threadId);
  } catch (err) {
    console.error("[reply] composer_drafts cleanup failed", err);
  }

  return {
    ok: true,
    provider: "emailbison",
    providerMessageId: newReplyId ? String(newReplyId) : null,
    externalMessageId: outboundId,
    feedback,
  };
}

// ---------------------------------------------------------------------------
// Instantly send dispatch.
// Instantly's POST /emails/reply takes the inbound email's UUID as
// `reply_to_uuid` and a single `eaccount` (the mailbox to send from).
// Attachments aren't documented on this endpoint, so we reject them
// explicitly and ask the user to send unattached for now.
// ---------------------------------------------------------------------------
async function sendInstantlyReply(args: {
  admin: SupabaseClient<Database>;
  threadId: string;
  workspaceId: string;
  outboundSenderEmail: string | null;
  payload: {
    text: string;
    contentType: "html" | "text";
    subject?: string;
    to?: Recipient[];
    cc?: Recipient[];
    bcc?: Recipient[];
    inject_previous_email_body: boolean;
    source_message_id?: string;
  };
  attachments: Array<{ name: string; blob: Blob }>;
  actor: SendActor;
}): Promise<SendOutboundReplyResult> {
  const { admin, threadId, workspaceId, outboundSenderEmail, payload, attachments } = args;

  if (attachments.length > 0) {
    return {
      ok: false,
      status: 400,
      body: { error: "Attachments are not supported on Instantly threads yet." },
    };
  }

  // Pick the message Instantly should reply to. Preference order:
  //   1. The specific source message the user clicked Reply on
  //      (payload.source_message_id) — required for correct Gmail threading
  //      when the user replies to an older message in the conversation.
  //   2. Latest inbound on the thread — used by the bottom floating Reply
  //      button (source_message_id will be undefined).
  let replyTarget: { id: string; instantly_email_id: string | null; sender: string | null } | null = null;
  if (payload.source_message_id) {
    const { data } = await admin
      .from("messages")
      .select("id, instantly_email_id, sender")
      .eq("id", payload.source_message_id)
      .eq("thread_id", threadId)
      .maybeSingle();
    replyTarget = data ?? null;
  }
  if (!replyTarget?.instantly_email_id) {
    const { data: lastInbound } = await admin
      .from("messages")
      .select("id, instantly_email_id, sender")
      .eq("thread_id", threadId)
      .eq("direction", "inbound")
      .not("instantly_email_id", "is", null)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    replyTarget = lastInbound ?? null;
  }
  if (!replyTarget?.instantly_email_id) {
    return {
      ok: false,
      status: 400,
      body: { error: "No inbound Instantly reply found to reply to." },
    };
  }

  const recipientsCsv = (rows?: Array<{ email_address: string }>): string | undefined => {
    if (!rows || rows.length === 0) return undefined;
    return rows.map((r) => r.email_address).join(",");
  };

  // Forward detection: TO is set AND none of its addresses match the
  // original sender of the inbound being "replied" to. Instantly's
  // /emails/reply silently ignores TO (always returns to the original
  // sender), so for forwards we route through /emails/forward which
  // accepts an arbitrary to_address_email_list while still threading
  // off the source email via reply_to_uuid.
  const originalSenderLower = replyTarget.sender?.toLowerCase() ?? "";
  const toCsv = recipientsCsv(payload.to);
  const isForward =
    Boolean(toCsv) &&
    payload.to !== undefined &&
    payload.to.length > 0 &&
    !payload.to.some(
      (r) => r.email_address.toLowerCase() === originalSenderLower,
    );

  let newEmailId: string | null = null;
  try {
    const instantly = createInstantlyClient();
    if (isForward) {
      if (!outboundSenderEmail) {
        return {
          ok: false,
          status: 400,
          body: {
            error:
              "Forwarding from this Instantly thread needs a sender mailbox; none on file.",
          },
        };
      }
      const res = await instantly.forwardEmail({
        eaccount: outboundSenderEmail,
        reply_to_uuid: replyTarget.instantly_email_id,
        to_address_email_list: toCsv!,
        subject: payload.subject ?? "(forward)",
        body:
          payload.contentType === "html"
            ? { html: payload.text }
            : { text: payload.text },
        cc_address_email_list: recipientsCsv(payload.cc),
        bcc_address_email_list: recipientsCsv(payload.bcc),
        include_original_body: payload.inject_previous_email_body,
      });
      newEmailId = res?.id ?? null;
    } else {
      const res = await instantly.sendReply({
        reply_to_uuid: replyTarget.instantly_email_id,
        subject: payload.subject,
        body:
          payload.contentType === "html"
            ? { html: payload.text }
            : { text: payload.text },
        eaccount: outboundSenderEmail ?? undefined,
        cc_address_email_list: recipientsCsv(payload.cc),
        bcc_address_email_list: recipientsCsv(payload.bcc),
        include_original_body: payload.inject_previous_email_body,
      });
      newEmailId = res?.id ?? null;
    }
  } catch (err) {
    if (err instanceof InstantlyError) {
      console.error("[reply] Instantly error:", {
        status: err.status,
        message: err.message,
        body: err.body,
      });
      const detail =
        typeof err.body === "string"
          ? err.body.slice(0, 500)
          : err.body
            ? JSON.stringify(err.body).slice(0, 500)
            : undefined;
      return {
        ok: false,
        status: 502,
        body: { error: err.message, status: err.status, detail },
      };
    }
    console.error("[reply] Instantly send failed", err);
    return {
      ok: false,
      status: 502,
      body: { error: err instanceof Error ? err.message : "Instantly send failed" },
    };
  }

  // Record the outbound message immediately so the UI updates without
  // waiting for the webhook echo. The eventual `email_sent` webhook (if
  // subscribed) — or the thread backfill on the next inbound — will
  // converge on this row via the matching external_message_id.
  const outboundId = newEmailId
    ? `in:email:${newEmailId}`
    : `in-out:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const recipientsPayload = {
    to: payload.to?.map((r) => r.email_address) ?? [],
    cc: payload.cc?.map((r) => r.email_address) ?? [],
    bcc: payload.bcc?.map((r) => r.email_address) ?? [],
  };
  // Compute once so the stored message and the thread's list-preview
  // agree — an outbound send advances last_message_at / preview so the
  // list reflects our reply as the most-recent activity (mirrors the
  // EmailBison path above).
  const instSentAt = new Date().toISOString();
  const instOutboundText =
    payload.contentType === "text"
      ? payload.text
      : payload.text.replace(/<[^>]+>/g, "");
  await admin.from("messages").insert({
    workspace_id: workspaceId,
    thread_id: threadId,
    direction: "outbound",
    source_provider: "instantly",
    sender: outboundSenderEmail,
    recipients: recipientsPayload,
    subject: payload.subject ?? null,
    body_html: payload.contentType === "html" ? payload.text : null,
    body_text: instOutboundText,
    sent_at: instSentAt,
    external_message_id: outboundId,
    instantly_email_id: newEmailId,
  });
  await admin
    .from("threads")
    .update({
      needs_reply: false,
      seen: true,
      last_message_at: instSentAt,
      last_message_preview: instOutboundText.slice(0, 200),
    })
    .eq("id", threadId);

  // See the EmailBison path above for why this runs here: after the message
  // is stored, before the drafts are marked sent.
  const feedback = await recordSendFeedback({
    workspaceId,
    threadId,
    sentBody: payload.text,
    sentIsHtml: payload.contentType === "html",
  });

  await admin
    .from("reply_drafts")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("thread_id", threadId)
    .eq("status", "pending");

  // Same cleanup as the EmailBison path — delete the composer
  // auto-save row best-effort. See the corresponding block above
  // for the rationale.
  try {
    await admin
      .from("composer_drafts")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("thread_id", threadId);
  } catch (err) {
    console.error("[reply] composer_drafts cleanup failed", err);
  }

  return {
    ok: true,
    provider: "instantly",
    providerMessageId: newEmailId,
    externalMessageId: outboundId,
    feedback,
  };
}
