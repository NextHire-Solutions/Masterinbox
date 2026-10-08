// SMS alerts for Introductions: which clients get them, and who on each
// client's team.
//
// Per client: the `team_sms_notifications` feature flag, switched on and off
// by staff with the "SMS" switch on the Client Portals page (or by SQL; see
// lib/portals/feature-flags.ts). Off: the portal Team page is exactly as
// before and NOTHING is sent to the SMS notifier for that client. On: the
// Team page shows a per-member SMS switch, and Introductions go to the
// notifier with only the members switched on, marked approved.
//
// The approval mark (SMS_APPROVED_FIELD) is the contract with the notifier:
// it texts only Introductions that carry it. Anything else that posts to the
// notifier, such as BrokerStaffer OS's own copy of this webhook, is ignored
// there, so these switches can't be bypassed.
//
// The per-member choice lives in client_team_members.receives_sms (migration
// 0077, default true). It is read ONLY through the separate, error-checked
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

// Field on the notifier payload saying "Masterinbox approved this for SMS".
// The notifier (services/loopmessage-notifier) requires it to be true.
export const SMS_APPROVED_FIELD = "sms_enabled";

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
 * Intro webhook: the SMS recipients for every client in a batch that has
 * SMS alerts on.
 *
 *   - SMS alerts off           -> absent from the map; nothing is sent to
 *                                 the notifier for that client
 *   - on, read succeeded       -> { ok: true, team } (active, has a phone,
 *                                 SMS switched on)
 *   - on, switches unreadable  -> { ok: false }; no texts for that client,
 *                                 because it can't see who was switched off
 *
 * If the feature flags themselves can't be read, returns null: no texts for
 * anyone in the batch, since it can't tell which clients have SMS on.
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
 * POST": SMS alerts off, nobody switched on, or the settings unreadable.
 * Always a new object, so the caller's payload (which Bison's is built
 * from) is never changed.
 */
export function smsBodyFor<T extends { team: SmsMember[] }>(
  payload: T,
  clientId: string,
  recipients: Map<string, SmsRecipients> | null,
): (T & { [SMS_APPROVED_FIELD]: true }) | null {
  const r = recipients?.get(clientId);
  if (!r || !r.ok || r.team.length === 0) return null;
  return { ...payload, team: r.team, [SMS_APPROVED_FIELD]: true as const };
}
