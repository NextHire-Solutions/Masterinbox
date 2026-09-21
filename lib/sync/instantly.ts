import { createAdminSupabase } from "@/lib/supabase/admin";
import { createInstantlyClient } from "@/lib/instantly/client";
import { labelInboundMessage } from "@/lib/ai/run";
import { runReplyAgentForThread } from "@/lib/ai/runtime";
import { deriveClientIdFromCampaign } from "@/lib/clients/derive";
import type { InstantlyEmail, InstantlyWebhookEnvelope } from "@/lib/instantly/types";

// Inbound-only sync for Instantly's `reply_received` event.
//
// Real envelope shape (verified live, NOT what the public docs claim):
// flat fields — `email_id`, `lead_email`, `campaign_id`, `campaign_name`,
// `reply_subject`, `reply_text`, `reply_html`, `email_account`, plus
// arbitrary lead custom variables at the top level (firstName, companyName,
// LicenseNumber, ...). See InstantlyWebhookEnvelope.
//
// Threading: Instantly doesn't put `thread_id` directly on the webhook —
// only in `unibox_url`. We use the same `(lead, campaign)` synthetic key
// as EmailBison's threading model so the inbox UX behaves the same way
// regardless of source: one thread per (lead_email, campaign_id).
//
// Outbound channels are auto-created the first time we see a new
// `email_account` (the OUR-side mailbox). The user never sets these up.

interface SyncContext {
  workspaceId: string;
  channelId: string | null;
}

async function resolveContext(eaccount: string | null | undefined): Promise<SyncContext | null> {
  const supabase = createAdminSupabase();

  const { data: ws } = await supabase
    .from("workspaces")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!ws) return null;

  let channelId: string | null = null;
  if (eaccount) {
    const { data: existing } = await supabase
      .from("channels")
      .select("id")
      .eq("workspace_id", ws.id)
      .eq("provider", "instantly")
      .eq("instantly_account_id", eaccount)
      .maybeSingle();
    if (existing) {
      channelId = existing.id;
    } else {
      const { data: created } = await supabase
        .from("channels")
        .insert({
          workspace_id: ws.id,
          type: "email",
          provider: "instantly",
          display_name: eaccount,
          instantly_account_id: eaccount,
          status: "connected",
          last_synced_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      channelId = created?.id ?? null;
    }
  }

  return { workspaceId: ws.id, channelId };
}

// Build the lead.custom_fields jsonb from every field on the envelope that
// isn't part of the canonical message/metadata set. Instantly enriches leads
// with phone, jobTitle, license number, GCI, etc. — we want all
// of that preserved on the lead row.
function deriveCustomFields(envelope: InstantlyWebhookEnvelope): Record<string, unknown> {
  const RESERVED = new Set([
    "event_type", "timestamp", "workspace", "unibox_url",
    "email_id", "reply_subject", "reply_text", "reply_text_snippet", "reply_html",
    "email_account", "campaign_id", "campaign_name", "is_first", "step", "variant",
    "lead_email", "email", "firstName", "lastName", "companyName",
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(envelope)) {
    if (RESERVED.has(k)) continue;
    if (v === null || v === undefined || v === "") continue;
    out[k] = v;
  }
  return out;
}

async function upsertLead(
  ctx: SyncContext,
  envelope: InstantlyWebhookEnvelope,
): Promise<string | null> {
  const leadEmail = envelope.lead_email ?? envelope.email ?? null;
  if (!leadEmail) return null;

  const supabase = createAdminSupabase();
  const now = new Date().toISOString();
  const fullName =
    [envelope.firstName, envelope.lastName].filter(Boolean).join(" ") || null;
  const customFields = deriveCustomFields(envelope);

  // Lookup by (workspace, email) — Instantly doesn't ship a stable lead UUID
  // on the webhook payload, so email is the canonical identity. We scope the
  // match to leads that DON'T already belong to EmailBison so that the same
  // address appearing in both providers gets two separate lead rows (one per
  // provider) instead of being merged into a single EB-origin lead.
  const { data: existing } = await supabase
    .from("leads")
    .select("id, custom_fields")
    .eq("workspace_id", ctx.workspaceId)
    .eq("email", leadEmail)
    .is("emailbison_lead_id", null)
    .maybeSingle();

  if (existing) {
    // Merge custom_fields rather than overwrite — different webhooks might
    // carry different subsets of enrichment data.
    const merged = { ...(existing.custom_fields as Record<string, unknown> ?? {}), ...customFields };
    await supabase
      .from("leads")
      .update({
        full_name: fullName ?? undefined,
        company: envelope.companyName ?? undefined,
        title: envelope.jobTitle ?? undefined,
        custom_fields: merged,
        last_activity_at: now,
      })
      .eq("id", existing.id);
    return existing.id;
  }

  const { data: inserted, error } = await supabase
    .from("leads")
    .insert({
      workspace_id: ctx.workspaceId,
      email: leadEmail,
      full_name: fullName,
      company: envelope.companyName ?? null,
      title: envelope.jobTitle ?? null,
      custom_fields: customFields,
      source_campaign_id: envelope.campaign_id ?? null,
      first_seen_at: now,
      last_activity_at: now,
    })
    .select("id")
    .single();
  if (error) {
    console.error("[instantly] lead insert failed", error);
    return null;
  }
  return inserted?.id ?? null;
}

function threadExternalId(leadEmail: string, campaignId: string | null | undefined): string {
  // Mirror of EmailBison's `eb:lead:X:campaign:Y` scheme so threading
  // behaves identically across providers.
  return `in:lead:${leadEmail}:campaign:${campaignId ?? "none"}`;
}

async function upsertThread(
  ctx: SyncContext,
  ourLeadId: string,
  externalThreadId: string,
  defaults: {
    subject?: string | null;
    last_message_at: string;
    last_message_preview?: string | null;
    needs_reply: boolean;
    seen: boolean;
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
    .eq("instantly_thread_id", externalThreadId)
    .maybeSingle();

  const update: Record<string, unknown> = {
    lead_id: ourLeadId,
    channel_id: ctx.channelId,
    source_provider: "instantly",
    last_message_at: defaults.last_message_at,
    needs_reply: defaults.needs_reply,
    seen: defaults.seen,
  };
  if (defaults.subject) update.subject = defaults.subject;
  if (defaults.last_message_preview !== undefined) {
    update.last_message_preview = defaults.last_message_preview?.slice(0, 200) ?? null;
  }
  if (defaults.outbound_sender_email !== undefined) {
    update.outbound_sender_email = defaults.outbound_sender_email;
  }
  if (defaults.client_id !== undefined) update.client_id = defaults.client_id;
  if (defaults.campaign_id !== undefined) update.campaign_id = defaults.campaign_id;
  if (defaults.campaign_name !== undefined) update.campaign_name = defaults.campaign_name;

  if (existing) {
    if (existing.subject) delete update.subject;
    if (existing.client_id) delete update.client_id;
    if (existing.campaign_name) {
      // First-set wins on campaign_name (and campaign_id together).
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
      instantly_thread_id: externalThreadId,
    })
    .select("id")
    .single();
  if (error) {
    console.error("[instantly] thread insert failed", error);
    return null;
  }
  return inserted?.id ?? null;
}

async function upsertMessage(args: {
  ctx: SyncContext;
  threadId: string;
  emailId: string;
  envelope: InstantlyWebhookEnvelope;
  bodyText: string | null;
}): Promise<void> {
  const supabase = createAdminSupabase();
  const { ctx, threadId, emailId, envelope, bodyText } = args;
  const externalMessageId = `in:email:${emailId}`;

  const { data: existing } = await supabase
    .from("messages")
    .select("id")
    .eq("workspace_id", ctx.workspaceId)
    .eq("external_message_id", externalMessageId)
    .maybeSingle();

  const row = {
    workspace_id: ctx.workspaceId,
    thread_id: threadId,
    channel_id: ctx.channelId,
    source_provider: "instantly" as const,
    direction: "inbound" as const,
    sender: envelope.lead_email ?? envelope.email ?? null,
    recipients: envelope.email_account ? { to: [envelope.email_account] } : {},
    subject: envelope.reply_subject ?? null,
    body_html: envelope.reply_html ?? null,
    body_text: bodyText,
    sent_at: envelope.timestamp ?? new Date().toISOString(),
    external_message_id: externalMessageId,
    instantly_email_id: emailId,
  };

  if (existing) {
    await supabase.from("messages").update(row).eq("id", existing.id);
  } else {
    const { error } = await supabase.from("messages").insert({
      ...row,
      raw_payload: envelope as object,
    });
    if (error) console.error("[instantly] message insert failed", error);
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

// Parse Instantly's recipient fields into our normalised JSONB shape. The
// API ships two parallel representations — `to_address_email_list` (CSV)
// and `to_address_json` (typed array). Prefer the JSON form when present.
function parseRecipients(email: InstantlyEmail): Record<string, unknown> {
  const split = (csv: string | null | undefined): string[] =>
    csv ? csv.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const json = (rows: { address?: string }[] | undefined): string[] =>
    rows ? rows.map((r) => r.address ?? "").filter(Boolean) : [];
  return {
    to: email.to_address_json ? json(email.to_address_json) : split(email.to_address_email_list),
    cc: email.cc_address_json ? json(email.cc_address_json) : split(email.cc_address_email_list),
    bcc: email.bcc_address_json ? json(email.bcc_address_json) : split(email.bcc_address_email_list),
  };
}

// Direction by mailbox identity, NOT ue_type. Live shows Instantly's
// ue_type takes at least three values: 1 = sent (initial), 3 = sent
// (reply/manual?), 2 = received. Treating only 1 as outbound misroutes
// ue_type=3 rows into inbound. The from-address vs eaccount comparison
// catches every case and degrades cleanly when ue_type is missing.
function directionForEmail(email: InstantlyEmail): "inbound" | "outbound" {
  const from = email.from_address_email?.toLowerCase();
  const mailbox = email.eaccount?.toLowerCase();
  if (from && mailbox && from === mailbox) return "outbound";
  if (email.ue_type === 1 || email.ue_type === 3) return "outbound";
  if (email.ue_type === 2) return "inbound";
  return "inbound";
}

// Upserts one historical email row (sent or received) by external_message_id.
// First write wins on raw_payload so we never clobber the original webhook
// envelope with the slimmer /emails listing record.
async function upsertHistoricalEmail(
  ctx: SyncContext,
  threadId: string,
  email: InstantlyEmail,
): Promise<void> {
  const supabase = createAdminSupabase();
  const externalMessageId = `in:email:${email.id}`;
  const direction = directionForEmail(email);
  const html = email.body?.html ?? null;
  const text = email.body?.text ?? (html ? stripHtml(html) : null);

  const { data: existing } = await supabase
    .from("messages")
    .select("id")
    .eq("workspace_id", ctx.workspaceId)
    .eq("external_message_id", externalMessageId)
    .maybeSingle();

  // `from_address_json` is the structured From header from
  // /emails/{id} — first entry's `name` is the display name we want
  // ("Howe Realty Growth" for growth@howerealtygroup.com, etc.).
  // Trim + length-cap so a wild header doesn't blow up the column.
  const fromJsonName = email.from_address_json?.[0]?.name;
  const senderName =
    typeof fromJsonName === "string" && fromJsonName.trim().length > 0
      ? fromJsonName.trim().slice(0, 200)
      : null;
  const row = {
    workspace_id: ctx.workspaceId,
    thread_id: threadId,
    channel_id: ctx.channelId,
    source_provider: "instantly" as const,
    direction,
    sender: email.from_address_email ?? null,
    sender_name: senderName,
    recipients: parseRecipients(email),
    subject: email.subject ?? null,
    body_html: html,
    body_text: text,
    sent_at: email.timestamp_email ?? email.timestamp_created ?? new Date().toISOString(),
    external_message_id: externalMessageId,
    instantly_email_id: email.id,
  };

  if (existing) {
    // Preserve raw_payload (first write wins). Update everything else so
    // body/subject corrections from the canonical /emails row land.
    await supabase.from("messages").update(row).eq("id", existing.id);
  } else {
    const { error } = await supabase.from("messages").insert({
      ...row,
      raw_payload: email as object,
    });
    if (error) console.error("[instantly] historical email insert failed", error);
  }
}

// Pulls the full per-(lead, campaign) conversation from Instantly and
// upserts every email. Idempotent via the unique
// (workspace_id, external_message_id) index on messages.
//
// We DO NOT use the `thread_id` filter on /emails — verified live that it
// is broken (ignored; returns the full mailbox). The `lead + campaign_id`
// pair is the correct precision: it returns the exact 3-or-so emails of
// the back-and-forth and shares Instantly's per-conversation thread_id.
async function backfillInstantlyConversation(
  ctx: SyncContext,
  ourThreadId: string,
  leadEmail: string,
  campaignId: string | null | undefined,
): Promise<void> {
  if (!campaignId) return;
  try {
    const client = createInstantlyClient();
    const res = await client.listEmails({
      lead: leadEmail,
      campaign_id: campaignId,
      limit: 100,
    });
    for (const email of res.items ?? []) {
      await upsertHistoricalEmail(ctx, ourThreadId, email);
    }
  } catch (err) {
    console.error("[instantly] backfill conversation failed", err);
  }
}

// All early-return failures in handleInstantlyEvent flow through this
// helper. They were previously silent — only a console.log of the raw
// envelope, no labelled drop event — which made it impossible to grep
// Railway for "what happened to this reply". Now every drop emits a
// single `[instantly drop]` line tagged with reason + identifiers.
function dropReply(
  reason: string,
  envelope: InstantlyWebhookEnvelope,
  extra: Record<string, unknown> = {},
): { ok: false; reason: string } {
  console.warn(
    "[instantly drop]",
    JSON.stringify({
      reason,
      email_id: envelope.email_id ?? null,
      lead: envelope.lead_email ?? envelope.email ?? null,
      campaign_id: envelope.campaign_id ?? null,
      campaign_name: envelope.campaign_name ?? null,
      eaccount: envelope.email_account ?? null,
      timestamp: envelope.timestamp ?? null,
      ...extra,
    }),
  );
  return { ok: false, reason };
}

export async function handleInstantlyEvent(envelope: InstantlyWebhookEnvelope): Promise<{
  ok: boolean;
  reason?: string;
}> {
  // Receipt marker — one line per webhook so we can correlate against
  // Instantly's send log when a reply goes missing.
  console.log(
    "[instantly recv]",
    JSON.stringify({
      email_id: envelope.email_id ?? null,
      lead: envelope.lead_email ?? envelope.email ?? null,
      campaign_id: envelope.campaign_id ?? null,
      event: envelope.event_type ?? null,
      timestamp: envelope.timestamp ?? null,
    }),
  );

  const eventType = envelope.event_type;
  if (!eventType) return dropReply("missing event_type", envelope);
  if (eventType !== "reply_received") {
    return { ok: true, reason: `ignored event type: ${eventType}` };
  }

  const emailId = envelope.email_id;
  const leadEmail = envelope.lead_email ?? envelope.email ?? null;
  if (!emailId || !leadEmail) {
    return dropReply("missing email_id or lead_email", envelope);
  }

  const ctx = await resolveContext(envelope.email_account ?? null);
  if (!ctx) return dropReply("no workspace mapping", envelope);

  const ourLeadId = await upsertLead(ctx, envelope);
  if (!ourLeadId) return dropReply("lead upsert failed", envelope);

  const externalThreadId = threadExternalId(leadEmail, envelope.campaign_id);

  // Body: prefer reply_text (already plain text), fall back to stripped HTML,
  // then to the snippet Instantly provides for previews.
  const bodyText =
    envelope.reply_text ??
    (envelope.reply_html ? stripHtml(envelope.reply_html) : null) ??
    envelope.reply_text_snippet ??
    null;

  // Client tag from campaign name (Instantly conveniently includes the name
  // directly in the envelope — no extra /campaigns/{id} call needed).
  const clientId = await deriveClientIdFromCampaign(envelope.campaign_name ?? null);

  const threadId = await upsertThread(ctx, ourLeadId, externalThreadId, {
    subject: envelope.reply_subject ?? null,
    last_message_at: envelope.timestamp ?? new Date().toISOString(),
    last_message_preview: bodyText,
    needs_reply: true,
    seen: false,
    outbound_sender_email: envelope.email_account ?? null,
    client_id: clientId,
    campaign_id: envelope.campaign_id ?? null,
    campaign_name: envelope.campaign_name ?? null,
  });
  if (!threadId) return dropReply("thread upsert failed", envelope, { lead_id: ourLeadId });

  await upsertMessage({ ctx, threadId, emailId, envelope, bodyText });

  // Background pipeline — the webhook response returns the moment the
  // lead / thread / message rows are committed. Backfill of the full
  // conversation history from Instantly, AI labeling and agent-draft
  // generation all continue asynchronously and write their results
  // when ready. The realtime channel surfaces those writes to any
  // open inbox tab on its own debounce.
  //
  // Previously these steps awaited inline, holding the webhook
  // response on ~1-2 s of Instantly API + OpenAI latency. Concurrent
  // user navigation contended for the same Node worker / DB pool and
  // surfaced as the multi-second UI freeze operators reported.
  void (async () => {
    try {
      await backfillInstantlyConversation(ctx, threadId, leadEmail, envelope.campaign_id);
    } catch (err) {
      console.error("[instantly] async backfill failed", err);
    }
    try {
      await labelInboundMessage({
        workspaceId: ctx.workspaceId,
        threadId,
        messageId: `in:email:${emailId}`,
        subject: envelope.reply_subject ?? null,
        bodyText,
        bodyHtml: envelope.reply_html ?? null,
      });
    } catch (err) {
      console.error("[ai] labelInboundMessage (instantly) failed", err);
    }
    try {
      /*
       * The reply-agent engine (lib/ai/runtime.ts): which agent owns this
       * client's thread, its pause/shadow/live mode, the qualification script
       * and the safety gate. It reads the thread, its messages and its lead
       * from the rows committed above, so it runs AFTER the backfill. Never
       * throws; every outcome is a value.
       */
      const outcome = await runReplyAgentForThread(ctx.workspaceId, threadId);
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
      console.error("[agents] instantly draft generation failed", err);
    }
  })();

  return { ok: true };
}
