// Per-member SMS alerts for Introductions: "who on the team gets a text".
//
// Gated per client by the `team_sms_notifications` feature flag (Demo
// Portal only until it is rolled out; see lib/portals/feature-flags.ts for
// THE RULE). For a client WITHOUT the flag nothing here runs: the Team page
// renders exactly as before and the SMS notifier receives today's payload.
//
// The choice lives in client_team_members.receives_sms (migration 0077,
// default true). It is read ONLY through the separate, error-checked
// queries below, never added to the shared selects in loadTeamMembers
// (lib/portals/portal-data.ts) or lib/webhooks/n8n-introduction.ts. Those
// swallow errors, so a column missing from them would quietly empty every
// client's roster or stop every intro webhook.
//
// receives_sms is not consent: the SMS notifier still asks each person to
// reply YES before their first alert.

import { createAdminSupabase } from "@/lib/supabase/admin";
import { chunkedRun } from "@/lib/db/chunked-in";
import { clientHasFeature } from "@/lib/portals/feature-flags";

export const TEAM_SMS_FLAG = "team_sms_notifications";

type Admin = ReturnType<typeof createAdminSupabase>;

export type SmsMember = { name: string; mobile: string };

// For one client in a batch: who the SMS notifier should text, or ok:false
// when the client is flagged but its switches couldn't be read.
export type SmsRecipients = { ok: true; team: SmsMember[] } | { ok: false };

/**
 * Team page: member id -> SMS switch, for one client. Null when the read
 * fails (for example before migration 0077 is applied), so the page hides
 * the SMS column instead of showing switches that can't be saved.
 */
export async function loadTeamSmsSettings(
  clientId: string,
): Promise<Record<string, boolean> | null> {
  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from("client_team_members")
    .select("id, receives_sms")
    .eq("client_id", clientId);
  if (error) {
    console.error("[team-sms] settings read failed:", error.message);
    return null;
  }
  const settings: Record<string, boolean> = {};
  for (const row of (data ?? []) as { id: string; receives_sms: boolean | null }[]) {
    settings[row.id] = row.receives_sms !== false;
  }
  return settings;
}

/**
 * Intro webhook: the SMS recipients for every FLAGGED client in a batch.
 *
 *   - client not flagged      -> absent from the map; the caller sends
 *                                today's payload unchanged
 *   - flagged, read succeeded -> { ok: true, team } (active, has a phone,
 *                                SMS switched on)
 *   - flagged, read failed    -> { ok: false }; the caller texts no one for
 *                                that client, because it can't see who was
 *                                switched off
 *
 * If the feature flags themselves can't be read, returns null, which the
 * caller treats as "no client flagged": today's behaviour for everyone.
 */
export async function loadSmsRecipients(
  admin: Admin,
  clientIds: string[],
): Promise<Map<string, SmsRecipients> | null> {
  const flagChunks = await chunkedRun(clientIds, (slice) =>
    admin.from("clients").select("id, feature_flags").in("id", slice),
  );
  const flagError = flagChunks.find((c) => c.error)?.error;
  if (flagError) {
    console.error("[team-sms] feature flag read failed:", flagError.message);
    return null;
  }
  const flagged = flagChunks
    .flatMap(
      (c) => (c.data ?? []) as { id: string; feature_flags: Record<string, unknown> | null }[],
    )
    .filter((c) => clientHasFeature(c, TEAM_SMS_FLAG))
    .map((c) => c.id);

  const recipients = new Map<string, SmsRecipients>();
  if (flagged.length === 0) return recipients;

  const teamChunks = await chunkedRun(flagged, (slice) =>
    admin
      .from("client_team_members")
      .select("client_id, name, phone")
      .in("client_id", slice)
      .eq("active", true)
      .not("phone", "is", null)
      .eq("receives_sms", true),
  );
  const teamError = teamChunks.find((c) => c.error)?.error;
  if (teamError) {
    console.error("[team-sms] SMS switches read failed:", teamError.message);
    for (const id of flagged) recipients.set(id, { ok: false });
    return recipients;
  }

  const teams = new Map<string, SmsMember[]>(flagged.map((id) => [id, []]));
  for (const chunk of teamChunks) {
    for (const m of (chunk.data ?? []) as { client_id: string; name: string; phone: string }[]) {
      teams.get(m.client_id)?.push({ name: m.name, mobile: m.phone });
    }
  }
  for (const [id, team] of teams) recipients.set(id, { ok: true, team });
  return recipients;
}

/**
 * The body to POST to the SMS notifier for one entry, or null for "don't
 * POST". Unflagged clients get `payload` itself, untouched.
 */
export function smsBodyFor<T extends { team: SmsMember[] }>(
  payload: T,
  clientId: string,
  recipients: Map<string, SmsRecipients> | null,
): T | null {
  const r = recipients?.get(clientId);
  if (!r) return payload;
  if (!r.ok || r.team.length === 0) return null;
  return { ...payload, team: r.team };
}
