import { createAdminSupabase } from "@/lib/supabase/admin";
import { createEmailBisonClient, type ConvReply } from "@/lib/emailbison/client";
import { labelInboundMessage } from "@/lib/ai/run";
import { runReplyAgentForThread } from "@/lib/ai/runtime";
import { deriveClientIdFromCampaign } from "@/lib/clients/derive";
import type {
  EmailBisonWebhookEnvelope,
  EmailBisonLead,
  EmailBisonReply,
  EmailBisonEventBlock,
  EmailBisonDataBlock,
} from "@/lib/emailbison/types";

// Inbound-only sync. We subscribe to `lead_replied` exclusively (see
// RELEVANT_EVENTS in lib/emailbison/types.ts). Everything else is ignored.
//
// Threading: one thread per (workspace, lead, campaign).
//   external_thread_id = "eb:lead:{ebLeadId}:campaign:{campaignId or 'none'}"
// All inbound replies on the same (lead, campaign) collapse into a single
// thread row. Per-message dedup uses external_message_id = "eb:reply:{id}".

interface SyncContext {
  workspaceId: string;
  channelId: string | null;
}

// Normalise an EmailBison recipient field (to / cc / bcc) to a flat
// string[] of email addresses. Matches the canonical shape Instantly
// stores (`{to: [], cc: [], bcc: []}`) so the thread-view UI's
// recipientField helper at components/inbox/thread-view.tsx renders
// the row correctly. EmailBison ships these in several runtime shapes
// depending on event source — and the two TypeScript declarations
// for the field (EmailBisonReply at lib/emailbison/types.ts:58-60 vs
// ConvReply at lib/emailbison/client.ts:28-31) disagree on the
// element shape — so we accept `unknown` and decide at runtime:
//   • Array<{name?: string, address?: string}>  — webhook envelope + REST API
//   • Array<string>                              — already-normalised paths
//   • string (comma- or semicolon-joined)        — some legacy paths
//   • null / undefined                           — no recipients
function normalizeRecipientList(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const r of raw) {
      if (typeof r === "string") {
        if (r.includes("@")) out.push(r.trim());
        continue;
      }
      if (r && typeof r === "object") {
        const rec = r as { address?: unknown; email?: unknown };
        const addr =
          typeof rec.address === "string"
            ? rec.address
            : typeof rec.email === "string"
              ? rec.email
              : null;
        if (addr && addr.includes("@")) out.push(addr.trim());
      }
    }
    return out;
  }
  if (typeof raw === "string") {
    return raw
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter((s) => s.includes("@"));
  }
  return [];
}

async function resolveContext(
  ebTeamId: number | undefined,
  senderEmail:
    | { id?: number; email?: string; name?: string | null }
    | undefined,
): Promise<SyncContext | null> {
  const supabase = createAdminSupabase();

  // Single-tenant: always the singleton BrokerStaffer workspace.
  const { data: ws } = await supabase
    .from("workspaces")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!ws) return null;

  const senderEmailId = senderEmail?.id;
  if (senderEmailId === undefined) {
    return { workspaceId: ws.id, channelId: null };
  }

  // Channel = one sender_email account. Each is owned by exactly one
  // EmailBison team — pin the team_id here so the reply route can pass it
  // to switchWorkspace when sending. brokerstaffer.com has 2 teams, so the
  // legacy "team_id on workspace" approach can't disambiguate.
  const { data: existing } = await supabase
    .from("channels")
    .select("id, emailbison_team_id")
    .eq("workspace_id", ws.id)
    .eq("provider", "emailbison")
    .eq("emailbison_sender_email_id", String(senderEmailId))
    .limit(1)
    .maybeSingle();

  if (existing) {
    // Keep team_id fresh in case a sender_email gets re-homed to a different
    // EmailBison team. Cheap and idempotent.
    if (ebTeamId !== undefined && existing.emailbison_team_id !== ebTeamId) {
      await supabase
        .from("channels")
        .update({ emailbison_team_id: ebTeamId })
        .eq("id", existing.id);
    }
    return { workspaceId: ws.id, channelId: existing.id };
  }

  // Auto-create the channel on first sight. status='connected' because we
  // just received traffic on it, display_name falls back to the email
  // address when no name was provided in the webhook payload.
  // external_account_id stores the actual sending address so the From
  // picker can show it under display_name when EmailBison friendly
  // names collide (the "22 senders all named Nicole Collins" case).
  const display = senderEmail?.name || senderEmail?.email || `EmailBison #${senderEmailId}`;
  const { data: created, error } = await supabase
    .from("channels")
    .insert({
      workspace_id: ws.id,
      type: "email",
      provider: "emailbison",
      display_name: display,
      external_account_id: senderEmail?.email ?? null,
      emailbison_sender_email_id: String(senderEmailId),
      emailbison_team_id: ebTeamId ?? null,
      status: "connected",
      last_synced_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) {
    console.error("[emailbison] channel auto-create failed", error);
    return { workspaceId: ws.id, channelId: null };
  }
  return { workspaceId: ws.id, channelId: created?.id ?? null };
}

export async function upsertLead(ctx: SyncContext, lead: EmailBisonLead): Promise<string | null> {
  const supabase = createAdminSupabase();
  const fullName = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || null;
  const customFields = lead.custom_variables
    ? Object.fromEntries(lead.custom_variables.map((v) => [v.name, v.value]))
    : {};
  const now = new Date().toISOString();

  const { data: existing } = await supabase
    .from("leads")
    .select("id")
    .eq("workspace_id", ctx.workspaceId)
    .eq("emailbison_lead_id", String(lead.id))
    .maybeSingle();

  if (existing) {
    await supabase
      .from("leads")
      .update({
        full_name: fullName,
        email: lead.email,
        company: lead.company ?? null,
        title: lead.title ?? null,
        custom_fields: customFields,
        last_activity_at: now,
      })
      .eq("id", existing.id);
    return existing.id;
  }

  const { data: inserted, error } = await supabase
    .from("leads")
    .insert({
      workspace_id: ctx.workspaceId,
      emailbison_lead_id: String(lead.id),
      full_name: fullName,
      email: lead.email,
      company: lead.company ?? null,
      title: lead.title ?? null,
      custom_fields: customFields,
      first_seen_at: now,
      last_activity_at: now,
    })
    .select("id")
    .single();
  if (error) {
    console.error("[emailbison] lead insert failed", error);
    return null;
  }
  return inserted?.id ?? null;
}

function threadExternalId(ebLeadId: number, ebCampaignId: number | undefined): string {
  const campaign = ebCampaignId ? String(ebCampaignId) : "none";
  return `eb:lead:${ebLeadId}:campaign:${campaign}`;
}

export async function upsertThread(
  ctx: SyncContext,
  ourLeadId: string,
  externalThreadId: string,
  defaults: {
    subject?: string | null;
    last_message_at?: string;
    last_message_preview?: string | null;
    needs_reply?: boolean;
    seen?: boolean;
    outbound_sender_email?: string | null;
    client_id?: string | null;
    campaign_id?: string | null;
    campaign_name?: string | null;
  },
): Promise<string | null> {
  const supabase = createAdminSupabase();
  const { data: existing } = await supabase
    .from("threads")
    .select("id, subject, client_id, campaign_name")
    .eq("workspace_id", ctx.workspaceId)
    .eq("emailbison_thread_id", externalThreadId)
    .maybeSingle();

  const update: Record<string, unknown> = {
    lead_id: ourLeadId,
    channel_id: ctx.channelId,
    source_provider: "emailbison",
  };
  if (defaults.subject) update.subject = defaults.subject;
  if (defaults.last_message_at) update.last_message_at = defaults.last_message_at;
  if (defaults.last_message_preview !== undefined)
    update.last_message_preview = defaults.last_message_preview?.slice(0, 200) ?? null;
  if (defaults.needs_reply !== undefined) update.needs_reply = defaults.needs_reply;
  if (defaults.seen !== undefined) update.seen = defaults.seen;
  if (defaults.outbound_sender_email !== undefined)
    update.outbound_sender_email = defaults.outbound_sender_email;
  if (defaults.client_id !== undefined) update.client_id = defaults.client_id;
  if (defaults.campaign_id !== undefined) update.campaign_id = defaults.campaign_id;
  if (defaults.campaign_name !== undefined) update.campaign_name = defaults.campaign_name;

  if (existing) {
    if (existing.subject) delete update.subject;
    // Don't clobber an already-derived client_id — first match wins.
    if (existing.client_id) delete update.client_id;
    // Same for campaign — set once on first webhook touch.
    if (existing.campaign_name) {
      delete update.campaign_name;
      delete update.campaign_id;
    }
    await supabase.from("threads").update(update).eq("id", existing.id);
    return existing.id;
  }

  const { data: inserted, error } = await supabase
    .from("threads")
    .insert({
      workspace_id: ctx.workspaceId,
      ...update,
      emailbison_thread_id: externalThreadId,
    })
    .select("id")
    .single();
  if (error) {
    console.error("[emailbison] thread insert failed", error);
    return null;
  }
  return inserted?.id ?? null;
}

interface MessageUpsertInput {
  ctx: SyncContext;
  threadId: string;
  direction: "inbound" | "outbound";
  externalMessageId: string;
  sender: string | null;
  recipients: Record<string, unknown>;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  sent_at: string;
  emailbison_reply_id?: string | null;
  raw_payload: unknown;
}

export async function upsertMessage(input: MessageUpsertInput): Promise<void> {
  const supabase = createAdminSupabase();
  const { ctx, threadId, externalMessageId, raw_payload, ...rest } = input;

  const row = {
    workspace_id: ctx.workspaceId,
    thread_id: threadId,
    channel_id: ctx.channelId,
    source_provider: "emailbison",
    ...rest,
    external_message_id: externalMessageId,
    raw_payload: raw_payload as object,
  };

  const { data: existing } = await supabase
    .from("messages")
    .select("id")
    .eq("workspace_id", ctx.workspaceId)
    .eq("external_message_id", externalMessageId)
    .maybeSingle();
  if (existing) {
    // Never overwrite raw_payload on update — the first write is the
    // canonical source (webhook envelope for the triggering reply, vs
    // backfill writes that only have the reply object). Preserving lets
    // us inspect what the webhook actually delivered.
    const { raw_payload: _drop, ...preserveable } = row;
    void _drop;
    await supabase.from("messages").update(preserveable).eq("id", existing.id);
  } else {
    const { error } = await supabase.from("messages").insert(row);
    if (error) console.error("[emailbison] message insert failed", error);
  }
}

function inboundFromReply(reply: EmailBisonReply, leadEmail: string | null = null) {
  // Use the reply id directly — single canonical scheme across send-time
  // inserts and conversation-thread backfill so dedupe is reliable.
  const externalMessageId = `eb:reply:${reply.id}`;
  // TO precedence: structured reply.to[] first (preserves multiple
  // recipients when the lead sent to multiple addresses, e.g. when
  // they CC'd both us and a colleague back), with the
  // primary_to_email_address as the fallback for shapes where only
  // that scalar field is set.
  const toFromArray = normalizeRecipientList(reply.to);
  const to = toFromArray.length > 0
    ? toFromArray
    : reply.primary_to_email_address
      ? [reply.primary_to_email_address]
      : [];
  // EmailBison ships from_name on most reply payloads — store it so
  // the thread view doesn't have to fall back to titlecasing the
  // local-part of the From address.
  const senderName =
    typeof reply.from_name === "string" && reply.from_name.trim().length > 0
      ? reply.from_name.trim().slice(0, 200)
      : null;
  return {
    direction: "inbound" as const,
    externalMessageId,
    // Inbound = sent by the lead. The webhook always carries the lead's
    // address in payload.lead.email; reply.from_email_address may be a
    // different envelope (autoresponder, alias) — prefer the canonical
    // lead.email so we never end up with a null sender.
    sender: reply.from_email_address ?? leadEmail ?? reply.from_name ?? null,
    sender_name: senderName,
    recipients: {
      to,
      cc: normalizeRecipientList(reply.cc),
      bcc: normalizeRecipientList(reply.bcc),
    },
    subject: reply.email_subject ?? null,
    body_html: reply.html_body ?? null,
    body_text: reply.text_body ?? null,
    sent_at: reply.date_received ?? new Date().toISOString(),
    emailbison_reply_id: String(reply.id),
  };
}

// Backfills the full conversation context once an inbound reply has been
// stored. Pulls:
//   - all outbound scheduled emails for this (lead, campaign) via
//     /api/leads/{lead_id}/sent-emails
//   - the full reply chain (older + current + newer) via
//     /api/replies/{reply_id}/conversation-thread
// Upserts each into the messages table. Idempotent — re-runs are safe.
async function backfillConversation(
  ctx: SyncContext,
  threadId: string,
  ebLeadId: number,
  ebReplyId: number,
  campaignId: number | undefined,
  leadEmail: string | null | undefined,
  ebTeamId: number | undefined,
  seedSender: { id: number; email: string } | null = null,
): Promise<void> {
  let client;
  try {
    client = createEmailBisonClient();
  } catch (err) {
    console.error("[emailbison] cannot construct client for backfill", err);
    return;
  }

  // Switch EmailBison API context to the team this lead belongs to. Without
  // this, sent-emails / conversation-thread return empty (wrong workspace).
  if (ebTeamId !== undefined) {
    try {
      await client.switchWorkspace(ebTeamId);
    } catch (err) {
      console.error("[emailbison] switchWorkspace failed", err);
      // Continue anyway — fetches may still succeed if context already matched.
    }
  }

  // Build sender_email_id -> email map so outbound messages always carry the
  // address they were sent from. EmailBison paginates sender-emails — if the
  // workspace has more than one page's worth, we miss IDs on later pages and
  // outbound rows end up with sender=null. Walk every page until we get an
  // empty response. Pre-seed with the webhook's sender_email so we have at
  // least one guaranteed entry even if pagination fails entirely.
  const senderEmailMap = new Map<number, string>();
  if (seedSender) senderEmailMap.set(seedSender.id, seedSender.email);
  let page = 1;
  while (true) {
    try {
      const res = await client.listSenderEmails(page);
      const rows = res.data ?? [];
      if (rows.length === 0) break;
      for (const se of rows) {
        if (se.id && se.email) senderEmailMap.set(se.id, se.email);
      }
      // Safety stop — never paginate past a sensible bound. EmailBison
      // accounts shouldn't have thousands of sender emails per workspace.
      if (page >= 50) break;
      page++;
    } catch (err) {
      console.error("[emailbison] listSenderEmails page", page, "failed", err);
      break;
    }
  }
  if (senderEmailMap.size === 0) {
    console.warn("[emailbison] sender_email map is empty — outbound sender lookups will fail");
  }

  // (1) Outbound scheduled emails for this lead, filtered to this campaign.
  try {
    const res = await client.getLeadSentEmails(ebLeadId);
    const sent = (res.data ?? []).filter(
      (s) => !campaignId || s.campaign_id === campaignId,
    );
    for (const s of sent) {
      if (!s.sent_at) continue; // skip not-yet-sent
      // Prefer the nested sender_email.email (always present on scheduled
      // emails); fall back to the legacy flat sender_email_id lookup.
      const senderAddr =
        s.sender_email?.email ??
        (s.sender_email_id ? senderEmailMap.get(s.sender_email_id) ?? null : null);
      await upsertMessage({
        ctx,
        threadId,
        direction: "outbound",
        externalMessageId: `eb:sched:${s.id}`,
        sender: senderAddr,
        recipients: leadEmail ? { to: [leadEmail] } : {},
        subject: s.email_subject ?? null,
        body_html: s.email_body ?? null,
        body_text: stripHtml(s.email_body ?? ""),
        sent_at: s.sent_at,
        raw_payload: s,
      });
    }
  } catch (err) {
    console.error("[emailbison] getLeadSentEmails failed", err);
  }

  // (2) Conversation thread (other replies before/after this one).
  try {
    const res = await client.getReplyThread(ebReplyId);
    const all: ConvReply[] = [
      ...(res.data?.older_messages ?? []),
      ...(res.data?.current_reply ? [res.data.current_reply] : []),
      ...(res.data?.newer_messages ?? []),
    ];
    // Build a lowercase set of OUR sender addresses. The ONLY reliable
    // direction signal is `from_email_address` — EmailBison sets
    // `sender_email_id` on BOTH inbound and outbound (it's the id of OUR
    // account that received or sent the message, not the direction). Using
    // it for direction classification flips lead replies onto the wrong side
    // of the thread view.
    const ourSenderAddrs = new Set(
      Array.from(senderEmailMap.values()).map((s) => s.toLowerCase()),
    );

    for (const r of all) {
      const fromLower = r.from_email_address?.toLowerCase() ?? null;
      const isOurs = Boolean(fromLower && ourSenderAddrs.has(fromLower));
      const direction: "inbound" | "outbound" = isOurs ? "outbound" : "inbound";
      // Use EmailBison's reply id as the canonical external_message_id —
      // matches what the immediate send-time insert in
      // /api/threads/[threadId]/reply writes, so backfill becomes an
      // idempotent update instead of producing a duplicate row.
      const externalMessageId = `eb:reply:${r.id}`;
      const fallbackSender =
        direction === "outbound" && r.sender_email_id
          ? senderEmailMap.get(r.sender_email_id) ?? null
          : null;
      // Recipients: pull the full to/cc/bcc shape from the conversation
      // thread reply instead of just primary_to_email_address. Prior to
      // 2026-06-24 this site overwrote our send-time {to, cc, bcc}
      // snapshot with {to: [primary]} and silently dropped every CC.
      // See lib/sync/emailbison.ts normalizeRecipientList for the
      // shape normalization.
      const backfillTo = normalizeRecipientList(r.to);
      await upsertMessage({
        ctx,
        threadId,
        direction,
        externalMessageId,
        sender: r.from_email_address ?? r.from_name ?? fallbackSender,
        recipients: {
          to: backfillTo.length > 0
            ? backfillTo
            : r.primary_to_email_address
              ? [r.primary_to_email_address]
              : [],
          cc: normalizeRecipientList(r.cc),
          bcc: normalizeRecipientList(r.bcc),
        },
        subject: r.subject ?? null,
        body_html: r.html_body ?? null,
        body_text: r.text_body ?? null,
        sent_at: r.date_received ?? new Date().toISOString(),
        emailbison_reply_id: String(r.id),
        raw_payload: r,
      });
    }
  } catch (err) {
    console.error("[emailbison] getReplyThread failed", err);
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function handleEmailBisonEvent(envelope: EmailBisonWebhookEnvelope): Promise<{
  ok: boolean;
  reason?: string;
}> {
  const eventBlock = envelope?.event ?? (envelope?.data as { event?: EmailBisonEventBlock })?.event;
  const dataBlock =
    envelope?.event && envelope.data
      ? (envelope.data as EmailBisonDataBlock)
      : ((envelope?.data as { data?: EmailBisonDataBlock })?.data ?? {});

  const eventType = eventBlock?.type?.toLowerCase();
  const payload = dataBlock ?? {};
  if (!eventType) return { ok: false, reason: "missing event type" };

  if (eventType !== "lead_replied") {
    return { ok: true, reason: `ignored event type: ${eventType}` };
  }

  if (!payload.lead || !payload.reply) {
    return { ok: false, reason: "missing lead or reply" };
  }

  const ctx = await resolveContext(eventBlock?.workspace_id, payload.sender_email);
  if (!ctx) return { ok: false, reason: "no workspace mapping" };

  const ourLeadId = await upsertLead(ctx, payload.lead);
  if (!ourLeadId) return { ok: false, reason: "lead upsert failed" };

  const externalThreadId = threadExternalId(payload.lead.id, payload.campaign?.id);
  const msg = inboundFromReply(payload.reply, payload.lead.email ?? null);

  // Tag thread with the matching BrokerStaffer client (or "Unknown") based on the
  // EmailBison campaign name. Webhook payload carries it directly, so we
  // never hit the EmailBison /campaigns endpoint just for this lookup.
  const clientId = await deriveClientIdFromCampaign(payload.campaign?.name ?? null);

  const threadId = await upsertThread(ctx, ourLeadId, externalThreadId, {
    subject: msg.subject,
    last_message_at: msg.sent_at,
    last_message_preview: msg.body_text,
    needs_reply: true,
    seen: false,
    // The webhook ALWAYS carries data.sender_email — that's the canonical
    // OUR-side address for the thread. Pin it so the UI never has to guess.
    outbound_sender_email: payload.sender_email?.email ?? null,
    client_id: clientId,
    campaign_id: payload.campaign?.id != null ? String(payload.campaign.id) : null,
    campaign_name: payload.campaign?.name ?? null,
  });
  if (!threadId) return { ok: false, reason: "thread upsert failed" };

  // Always insert the triggering inbound reply first.
  await upsertMessage({
    ctx,
    threadId,
    direction: msg.direction,
    externalMessageId: msg.externalMessageId,
    sender: msg.sender,
    recipients: msg.recipients,
    subject: msg.subject,
    body_html: msg.body_html,
    body_text: msg.body_text,
    sent_at: msg.sent_at,
    emailbison_reply_id: msg.emailbison_reply_id,
    raw_payload: envelope,
  });

  // Background pipeline — webhook returns 200 the moment the lead /
  // thread / message rows are committed. Backfill of the full
  // conversation history (2-3 EmailBison API calls), AI labeling
  // and agent-draft generation all continue asynchronously and
  // write their results when ready. The realtime channel surfaces
  // those writes to any open inbox tab on its own debounce.
  //
  // Previously these steps awaited inline, holding the webhook
  // response on ~1-2 s of EmailBison + OpenAI latency. Concurrent
  // user navigation contended for the same Node worker / DB pool
  // and surfaced as the multi-second UI freeze operators reported.
  //
  // Capture the narrowed references in locals so TS knows they're
  // defined inside the closure — the IIFE is a new function scope
  // and loses the synchronous narrowing the outer guards gave us.
  const lead = payload.lead;
  const reply = payload.reply;
  const campaignId = payload.campaign?.id ?? null;
  const senderEmail =
    payload.sender_email?.id && payload.sender_email.email
      ? { id: payload.sender_email.id, email: payload.sender_email.email }
      : null;
  const senderEmailName = payload.sender_email?.name ?? null;
  const eventBlockWorkspaceId = eventBlock?.workspace_id;
  void (async () => {
    try {
      await backfillConversation(
        ctx,
        threadId,
        lead.id,
        reply.id,
        campaignId ?? undefined,
        lead.email,
        eventBlockWorkspaceId,
        senderEmail,
      );
    } catch (err) {
      console.error("[emailbison] async backfill failed", err);
    }
    try {
      const r = await labelInboundMessage({
        workspaceId: ctx.workspaceId,
        threadId,
        messageId: msg.externalMessageId,
        subject: msg.subject,
        bodyText: msg.body_text,
        bodyHtml: msg.body_html,
      });
      if (r.status === "labeled") {
        console.log(`[ai] thread ${threadId} -> ${r.label}`);
      } else if (r.status === "errored") {
        console.error(`[ai] thread ${threadId} errored: ${r.error}`);
      }
    } catch (err) {
      console.error("[ai] labelInboundMessage failed", err);
    }
    try {
      /*
       * The reply-agent engine (lib/ai/runtime.ts): which agent owns this
       * client's thread, its pause/shadow/live mode, the qualification script
       * and the safety gate. It reads the thread, its messages and its lead
       * from the rows committed above, so it runs AFTER the backfill. The
       * sender mailbox's display name is the one thing the thread row does not
       * hold, so it is handed in. Never throws; every outcome is a value.
       */
      const outcome = await runReplyAgentForThread(ctx.workspaceId, threadId, {
        ourName: senderEmailName,
      });
      if (outcome.status === "drafted") {
        console.log(
          `[agent:${outcome.agentName}] drafted ${outcome.intent} (${outcome.mode}) for thread ${threadId}`,
        );
      } else if (outcome.status === "draft_failed") {
        console.error(`[agent] draft failed for thread ${threadId}: ${outcome.error}`);
      } else {
        console.log(`[agent] thread ${threadId} -> ${outcome.status}`);
      }
    } catch (err) {
      console.error("[agents] draft generation pass failed", err);
    }
  })();

  return { ok: true };
}
