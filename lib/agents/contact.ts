import { env } from "@/lib/env";

// Client for the EXTERNAL agents-contact database (a separate app; MasterInbox
// does not own this data).
//
// The endpoint ADDS a phone and/or email ALONGSIDE the agent's existing Courted
// (MLS) values — it writes to `source_ids.agent_provided` and NEVER overwrites
// Courted. The provided value wins when a lead is sent to a campaign.
//
//   PATCH {AGENTS_CONTACT_URL}/api/agents/contact
//   x-ingest-token: <AGENTS_CONTACT_TOKEN>
//   { "match": { "<one key>": "..." }, "phone"?: "...", "email"?: "...", "max_matches": 1 }
//   -> { ok, totals: { matched, updated, phone, email }, results: [{ status, ... }] }
//
// Contract details we honour:
//  - `match` accepts ONE key, tried in priority order: agent_id > license_number
//    > email > phone. We send the single strongest key we have.
//  - `max_matches` is the control, and the provided value always wins. With 1, a
//    key that matches several agents is REFUSED (status "too_many_matches")
//    instead of appending the value to every one of them. We ALWAYS send 1 — a
//    single staff action must never fan out to many agents (an email/license that
//    resolves to one agent applies; an ambiguous one safely refuses).
//  - Email can be appended with ANY match key, including an email match (an
//    email-keyed email update is capped by max_matches, not refused). So phone
//    and/or email can be set regardless of which key identified the agent.
//
// Bounded + NEVER THROWS: a slow/unreachable endpoint, a missing token, or a
// non-2xx all resolve to a tagged result, never an exception, so this can never
// hang or break the inbox.

const TIMEOUT_MS = 6000;

export type AgentContactResult =
  | {
      ok: true;
      matched: number;
      updated: number;
      phoneUpdated: number;
      emailUpdated: number;
      status: string | null;
    }
  | { ok: false; error: string; status?: string };

// Friendly messages for the per-result statuses the endpoint can return.
function messageForStatus(status: string): string {
  switch (status) {
    case "not_found":
      return "No matching agent found in the agents database";
    case "too_many_matches":
      return "This agent's key matches several records, so it wasn't added to the agents database";
    case "email_needs_precise_key":
      return "Adding an email needs a license number to identify the agent";
    case "nothing_to_set":
      return "Nothing to add";
    case "no_match_key":
      return "No license number or email to identify this agent";
    default:
      return `Agents API returned "${status}"`;
  }
}

export async function updateAgentContact(input: {
  // Match keys — the strongest present is used (agent_id > license > email).
  matchAgentId?: string | null;
  matchLicense?: string | null;
  matchEmail?: string | null;
  // Values to ADD (append) to the agent. At least one required.
  phone?: string | null;
  email?: string | null;
  maxMatches?: number;
}): Promise<AgentContactResult> {
  const token = env.AGENTS_CONTACT_TOKEN;
  const base = env.AGENTS_CONTACT_URL;
  if (!token || !base) {
    return { ok: false, error: "Agents API not configured" };
  }

  // One match key, by priority.
  const match: Record<string, string> = {};
  if (input.matchAgentId) {
    match.agent_id = input.matchAgentId;
  } else if (input.matchLicense) {
    match.license_number = input.matchLicense;
  } else if (input.matchEmail) {
    match.email = input.matchEmail;
  }
  if (Object.keys(match).length === 0) {
    return { ok: false, error: "No license number or email to identify this agent" };
  }

  // Phone and/or email can be appended with any match key; max_matches (always 1)
  // caps ambiguous matches rather than refusing the email outright.
  const phone = input.phone?.trim() || null;
  const email = input.email?.trim() || null;
  if (!phone && !email) {
    return { ok: false, error: "Nothing to add", status: "nothing_to_set" };
  }

  const payload: Record<string, unknown> = { match, max_matches: input.maxMatches ?? 1 };
  if (phone) payload.phone = phone;
  if (email) payload.email = email;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/agents/contact`, {
      method: "PATCH",
      headers: {
        "x-ingest-token": token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const msg =
        (data as { error?: string } | null)?.error ??
        `Agents API returned ${res.status}`;
      return { ok: false, error: msg };
    }

    const obj = (data as {
      totals?: { matched?: number; updated?: number; phone?: number; email?: number };
      results?: Array<{ status?: string }>;
    } | null) ?? {};
    const totals = obj.totals;
    const status = obj.results?.[0]?.status ?? null;

    // A non-"ok" per-result status means nothing was applied for this agent —
    // surface it so the caller can message it, but it's not a transport error.
    if (status && status !== "ok") {
      return { ok: false, error: messageForStatus(status), status };
    }

    return {
      ok: true,
      matched: Number(totals?.matched ?? 0),
      updated: Number(totals?.updated ?? 0),
      phoneUpdated: Number(totals?.phone ?? 0),
      emailUpdated: Number(totals?.email ?? 0),
      status,
    };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      error: aborted ? "Agents API timed out" : "Couldn't reach the agents API",
    };
  } finally {
    clearTimeout(timer);
  }
}
