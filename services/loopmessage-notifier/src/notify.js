// lead.introduction payload -> who should hear about it, and what it says.
//
// The payload contract is produced by lib/webhooks/n8n-introduction.ts in
// the Masterinbox app: one POST per client_pipeline_entries row, with
// team[] already filtered to active members that have a phone.
//
// This file owns the plan and all message copy. Whether and when each
// message actually goes out (consent, pacing, retries, dedupe) is the
// delivery engine's job — see engine.js.

import { normalizePhone } from "./phone.js";

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

// ---------------------------------------------------------------------------
// Copy

// The lead's phone as the client wants to read it: US numbers as
// "(665) 234-1234"; anything else exactly as entered.
export function formatLeadPhone(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const n = normalizePhone(s);
  if (n.ok && n.e164.startsWith("+1") && n.e164.length === 12) {
    const d = n.e164.slice(2);
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return s;
}

// The lead alert, in the wording the client approved (Oct 2026). The lead
// is an agent, the company is their brokerage, and the email is left out.
// Fields that are empty upstream are omitted rather than rendered as
// "null"; portal-added leads often have no phone or company.
//
// It contains the lead's phone number, which LoopMessage forbids in a FIRST
// message, so it is only ever sent to someone who has already messaged the
// sender (the engine guarantees that).
export function buildText(teamMemberName, lead = {}) {
  const first = firstNameOf(teamMemberName) || "there";
  const details = [];
  if (lead.name) details.push(`Agent: ${lead.name}`);
  const phone = formatLeadPhone(lead.phone);
  if (phone) details.push(`Phone: ${phone}`);
  if (lead.company) details.push(`Brokerage: ${lead.company}`);
  return [
    `Hi ${first}, you have a new agent in the Introduction stage.`,
    ...(details.length > 0 ? ["", ...details] : []),
    "",
    "To opt out, reply STOP.",
  ].join("\n");
}

// LoopMessage (helpdesk "send-first"): "An initial message must never
// contain ... marketing, junk, phishing, scam, links, emails, phone numbers,
// currencies, or attachments." These patterns catch the mechanical ones.
const UNSAFE_IN_FIRST_MESSAGE = [
  /@/, // emails
  /https?:\/\//i, // links
  /\bwww\./i,
  /\b[a-z0-9-]+\.(?:com|net|org|io|co|us|ai|app)\b/i, // bare domains
  /\d(?:[\s().-]*\d){6,}/, // phone-like runs of 7+ digits
  /[$€£¥₹]/, // currencies
];

export function isSafeInitialText(text) {
  const s = String(text ?? "");
  return !UNSAFE_IN_FIRST_MESSAGE.some((re) => re.test(s));
}

function firstNameOf(name) {
  const first = String(name ?? "").trim().split(/\s+/)[0] ?? "";
  if (!first || /\d/.test(first) || !isSafeInitialText(first)) return "";
  return first;
}

// Alerts held before the Oct 2026 copy change were saved as finished text
// in the old wording ("we received a new lead ... Lead name / Email /
// Company"). Recover the lead from that text so they go out in the current
// wording; the old text never carried the lead's phone.
export function leadFromLegacyAlertText(text) {
  const s = String(text ?? "");
  if (!s.includes("we received a new lead in the Introduction stage.")) return null;
  const field = (label) => s.match(new RegExp(`^${label}: (.+)$`, "m"))?.[1]?.trim() ?? null;
  return { name: field("Lead name"), phone: null, company: field("Company") };
}

// The first message a team member ever gets, in the client's wording (Oct
// 2026): no lead details, no client name, and it asks for the reply that
// LoopMessage treats as consent ("the text of the initiating message should
// contain information that your contact would respond to the message as
// consent ... or reply that they want to unsubscribe"). Anything unsafe in
// a name is dropped, never sent.
export function buildWelcomeText({ name, brand }) {
  const first = firstNameOf(name) || "there";
  return (
    `Hi ${first}, this is ${brand}. We'll text you here whenever a new agent ` +
    `is introduced to your team. Reply YES to start getting these, ` +
    `or STOP to opt out.`
  );
}

// ---------------------------------------------------------------------------
// Planning

// Just the fields the alert shows. Held and queued alerts keep these (not
// the finished text) so a copy change applies to them too.
function alertLead(lead) {
  return {
    name: lead?.name ?? null,
    phone: lead?.phone ?? null,
    company: lead?.company ?? null,
  };
}

/**
 * Validate the webhook body and work out the recipients without sending
 * anything. Split out so a malformed payload is rejected synchronously with
 * a useful reason.
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

  // Masterinbox marks every Introduction it approves for SMS: the client has
  // SMS alerts on (Client Portals page) and team[] is already only the
  // people switched on in the client's Team page (lib/portals/team-sms.ts).
  // Anything without the mark is not texted. That covers older app builds
  // and BrokerStaffer OS's own copy of this webhook, which knows nothing
  // about those switches, so the switches can't be bypassed.
  if (payload.sms_enabled !== true) {
    return { ...base, ignored: "sms_not_approved", recipients: [], skipped: [] };
  }

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
          lead: alertLead(lead),
        },
      ],
      skipped: [],
    };
  }

  const recipients = [];
  const skipped = [];
  const seen = new Set();

  for (const member of team) {
    const name = member?.name ?? null;
    const normalized = normalizePhone(member?.mobile, { defaultCountryCode });
    if (!normalized.ok) {
      skipped.push({ name, mobile: member?.mobile ?? null, reason: normalized.reason });
      continue;
    }
    // Two team rows can share a phone (a shared desk line, a duplicate
    // row). One person, one text.
    if (seen.has(normalized.e164)) {
      skipped.push({ name, mobile: member?.mobile ?? null, reason: "duplicate_phone_on_team" });
      continue;
    }
    seen.add(normalized.e164);
    recipients.push({
      name,
      mobile: member?.mobile ?? null,
      contact: normalized.e164,
      text: buildText(name, lead),
      lead: alertLead(lead),
    });
  }

  return { ...base, recipients, skipped };
}

/**
 * Plan the introduction and hand it to the delivery engine. `dryRun`
 * previews what the engine would do without changing anything.
 */
export async function processIntroduction(payload, deps) {
  const {
    engine,
    defaultCountryCode = "1",
    clientFilter = null,
    testRecipientOverride = null,
    logger = console,
    dryRun = false,
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
        msg: plan.ignored,
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

  const results = await engine.handleIntroduction(plan, { dryRun });

  return {
    ok: true,
    entryId: plan.entryId,
    client: plan.clientName,
    testOverride: Boolean(plan.testOverride),
    dryRun,
    skipped: plan.skipped,
    results,
  };
}
