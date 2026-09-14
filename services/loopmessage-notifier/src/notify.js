// lead.introduction payload -> one LoopMessage per active team member.
//
// The payload contract is produced by lib/webhooks/n8n-introduction.ts in
// the Masterinbox app: one POST per client_pipeline_entries row, with
// team[] already filtered to active members that have a phone.
//
// That sender swallows every error and never retries (a failed POST only
// writes a console line), so durability has to live on this side: retries
// happen in the LoopMessage client, and dedupe happens here so a repeated
// delivery doesn't double-text an agent.

import { normalizePhone } from "./phone.js";
import { sendMessage } from "./loopmessage.js";

// Keyed on (pipeline_entry_id, e164). An agent legitimately gets a second
// text for a *different* lead, so the entry id has to be part of the key.
export class DedupeStore {
  constructor({ ttlMs = 6 * 60 * 60 * 1000, maxEntries = 50_000 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.seen = new Map();
  }

  // Returns true when this is the first time we've seen the key.
  claim(key, now = Date.now()) {
    this.sweep(now);
    const existing = this.seen.get(key);
    if (existing !== undefined && existing > now) return false;
    this.seen.set(key, now + this.ttlMs);
    return true;
  }

  sweep(now = Date.now()) {
    if (this.seen.size === 0) return;
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key);
    }
    // Hard bound in case of a flood within one TTL window: drop oldest
    // insertions first (Map preserves insertion order).
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
  }
}

// Which clients may be notified, from NOTIFY_CLIENTS.
//
// Entries are client names or client ids, comma-separated, matched
// case-insensitively. "*" enables every client. An empty list enables
// none: rollout is opt-in per client, so a missing variable must fail
// closed rather than text every agent in the install.
export function parseClientList(raw) {
  const entries = String(raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const all = entries.includes("*");
  const allowed = new Set(entries.filter((e) => e !== "*"));
  return {
    all,
    size: allowed.size,
    matches(client) {
      if (all) return true;
      const id = client?.id ? String(client.id).trim().toLowerCase() : "";
      const name = client?.name ? String(client.name).trim().toLowerCase() : "";
      return (id !== "" && allowed.has(id)) || (name !== "" && allowed.has(name));
    },
  };
}

// Mirrors the copy the n8n Twilio node was sending, minus the stray
// trailing spaces. Fields that are null upstream are omitted rather than
// rendered as "null" — portal-added leads often have no company.
export function buildText(teamMemberName, lead = {}) {
  const greetingName = teamMemberName?.trim() || "there";
  const lines = [
    `Hi ${greetingName}, we received a new lead in the Introduction stage.`,
    "",
  ];
  if (lead.name) lines.push(`Lead name: ${lead.name}`);
  if (lead.email) lines.push(`Email: ${lead.email}`);
  if (lead.company) lines.push(`Company: ${lead.company}`);
  return lines.join("\n");
}

/**
 * Validate the webhook body without sending anything. Split out from
 * process() so the server can reject a malformed payload synchronously and
 * still hand back a useful reason.
 */
export function planNotifications(
  payload,
  { defaultCountryCode = "1", clientFilter = null, testRecipientOverride = null } = {},
) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "body_not_an_object" };
  }
  if (payload.event !== "lead.introduction") {
    return { ok: false, reason: `unsupported_event_${payload.event ?? "missing"}` };
  }

  const entryId = payload.pipeline_entry_id;
  if (!entryId || typeof entryId !== "string") {
    return { ok: false, reason: "missing_pipeline_entry_id" };
  }

  const team = Array.isArray(payload.team) ? payload.team : [];
  const lead = payload.lead ?? {};
  const client = payload.client ?? {};

  const base = {
    ok: true,
    entryId,
    clientId: client?.id ?? null,
    clientName: client?.name ?? null,
    source: payload.source ?? null,
  };

  if (clientFilter && !clientFilter.matches(client)) {
    return { ...base, ignored: "client_not_enabled", recipients: [], skipped: [] };
  }

  // Test mode: one text per lead, to the override number only, whatever
  // the team looks like. Greets the team member who owns that number when
  // they're on the team, so the test text reads like the real one.
  if (testRecipientOverride) {
    const normalized = normalizePhone(testRecipientOverride, { defaultCountryCode });
    if (!normalized.ok) {
      return { ok: false, reason: `invalid_test_recipient_override_${normalized.reason}` };
    }
    const owner =
      team.find(
        (m) => normalizePhone(m?.mobile, { defaultCountryCode }).e164 === normalized.e164,
      ) ?? team.find((m) => m?.name);
    const name = owner?.name ?? null;
    return {
      ...base,
      testOverride: true,
      recipients: [
        {
          name,
          mobile: testRecipientOverride,
          contact: normalized.e164,
          text: buildText(name, lead),
        },
      ],
      skipped: [],
    };
  }

  const recipients = [];
  const skipped = [];

  for (const member of team) {
    const name = member?.name ?? null;
    const normalized = normalizePhone(member?.mobile, { defaultCountryCode });
    if (!normalized.ok) {
      skipped.push({ name, mobile: member?.mobile ?? null, reason: normalized.reason });
      continue;
    }
    recipients.push({
      name,
      mobile: member?.mobile ?? null,
      contact: normalized.e164,
      text: buildText(name, lead),
    });
  }

  return { ...base, recipients, skipped };
}

/**
 * Send the planned messages. Team lists are small (one client's agents), so
 * the fan-out runs in parallel.
 */
export async function processIntroduction(payload, deps) {
  const {
    apiKey,
    baseUrl,
    sender,
    channel,
    defaultCountryCode = "1",
    clientFilter = null,
    testRecipientOverride = null,
    dedupe,
    logger = console,
    dryRun = false,
    fetchImpl = fetch,
  } = deps;

  const plan = planNotifications(payload, {
    defaultCountryCode,
    clientFilter,
    testRecipientOverride,
  });
  if (!plan.ok) return { ok: false, reason: plan.reason };

  if (plan.ignored) {
    // Logged with id as well as name so the exact value to put in
    // NOTIFY_CLIENTS can be copied straight from the logs.
    logger.log(
      JSON.stringify({
        level: "info",
        msg: "client_not_enabled",
        entry_id: plan.entryId,
        client: plan.clientName,
        client_id: plan.clientId,
        source: plan.source,
      }),
    );
    return {
      ok: true,
      ignored: plan.ignored,
      entryId: plan.entryId,
      client: plan.clientName,
      clientId: plan.clientId,
      results: [],
    };
  }

  for (const skip of plan.skipped) {
    logger.warn(
      JSON.stringify({
        level: "warn",
        msg: "team_member_skipped",
        entry_id: plan.entryId,
        client: plan.clientName,
        team_member: skip.name,
        mobile: skip.mobile,
        reason: skip.reason,
      }),
    );
  }

  const passthrough = JSON.stringify({
    pipeline_entry_id: plan.entryId,
    client_id: plan.clientId,
    source: plan.source,
  }).slice(0, 1000);

  const results = await Promise.all(
    plan.recipients.map(async (recipient) => {
      // Before the dedupe claim: a dry run must not reserve the key, or
      // the real delivery of the same lead would be suppressed for the
      // whole TTL.
      if (dryRun) {
        return { ...recipient, status: "dry_run" };
      }

      const key = `${plan.entryId}:${recipient.contact}`;
      if (dedupe && !dedupe.claim(key)) {
        logger.log(
          JSON.stringify({
            level: "info",
            msg: "duplicate_suppressed",
            entry_id: plan.entryId,
            contact: recipient.contact,
            team_member: recipient.name,
          }),
        );
        return { ...recipient, status: "duplicate_suppressed" };
      }

      const sent = await sendMessage({
        baseUrl,
        apiKey,
        contact: recipient.contact,
        text: recipient.text,
        sender,
        channel,
        passthrough,
        fetchImpl,
      });

      if (!sent.ok) {
        // Release the dedupe claim so a genuine retry can get through —
        // holding it would turn a transient failure into a silent drop.
        if (dedupe) dedupe.seen.delete(key);
        logger.error(
          JSON.stringify({
            level: "error",
            msg: "send_failed",
            entry_id: plan.entryId,
            contact: recipient.contact,
            team_member: recipient.name,
            attempts: sent.attempts,
            status: sent.status,
            error: sent.error,
          }),
        );
        return { ...recipient, status: "failed", error: sent.error, httpStatus: sent.status };
      }

      logger.log(
        JSON.stringify({
          level: "info",
          msg: "queued",
          entry_id: plan.entryId,
          contact: recipient.contact,
          team_member: recipient.name,
          message_id: sent.messageId,
          attempts: sent.attempts,
        }),
      );
      return { ...recipient, status: "queued", messageId: sent.messageId };
    }),
  );

  return {
    ok: true,
    entryId: plan.entryId,
    client: plan.clientName,
    testOverride: Boolean(plan.testOverride),
    skipped: plan.skipped,
    results: results.map(({ text, ...rest }) => rest),
  };
}
