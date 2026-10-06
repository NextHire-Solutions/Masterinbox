import { cache } from "react";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { CLIENT_PORTALS_ENABLED } from "@/lib/portals/flag";
import { portalBillingHold } from "@/lib/portals/billing-hold";

// Resolves a /portal/<token> token to a client. The token IS the
// credential — every public portal page and edit API uses this to gate
// access. Returns null when the feature is flagged off, the token
// doesn't match, the matching client is the "unknown" fallback, or the
// portal is disabled (portal_enabled=false).

export interface PortalClient {
  id: string;
  name: string;
  slug: string;
  // Raw jsonb map of per-stage label overrides. Use
  // resolveStageLabels() from lib/portals/portal-data.ts to merge
  // these with the defaults before rendering.
  stage_label_overrides: Record<string, unknown>;
  // True when a Follow Up Boss API key has been saved for this
  // client. We never ship the raw key to the browser — the boolean
  // is enough for the manual "Push to FUB" button to know whether
  // to enable itself. The actual key stays server-side, read inline
  // when a push is requested.
  fub_api_key_set: boolean;
  // ISO timestamp of the last successful Connect against FUB. Lets
  // the Settings card render "Connected on …". Null when not set.
  fub_connected_at: string | null;
  // Per-client feature-flag map. Empty {} (the default) means
  // "behave like every other client" — no new behaviour. A non-empty
  // map opts THIS client into specific in-flight features; see
  // lib/portals/feature-flags.ts for the read pattern. Backed by
  // clients.feature_flags (added in migration 0053). The loader
  // below reads the column DEFENSIVELY so a pre-migration deploy
  // still resolves portals normally with empty flags.
  feature_flags: Record<string, unknown>;
  // Brokerage's answers for the "Define Your Ideal Agent Profile"
  // form (production range, MLS list, target markets, etc.). Empty
  // {} means "not yet filled in" — the UI renders empty placeholders
  // rather than treating it as an error. Backed by
  // clients.ideal_agent_profile (added in migration 0056). Same
  // defensive-read contract as feature_flags above.
  ideal_agent_profile: Record<string, unknown>;
}

/*
 * The portal behind a token, whether or not it is held for an unpaid invoice.
 * Only the portal layout uses this directly — to show the "paused" page.
 * Everything else uses resolvePortalClient below, which refuses a held one.
 */
export const resolvePortalRow = cache(
  async function resolvePortalRow(
    token: string,
  ): Promise<PortalClient | null> {
    if (!CLIENT_PORTALS_ENABLED) return null;
    if (!token || token.length < 4) return null;

    const admin = createAdminSupabase();

    // Defensive read: try first with feature_flags included. If the
    // column doesn't exist yet (migration 0053 not applied to this
    // environment), retry with the original column set. This means
    // the WRONG deploy order — code before migration — degrades to
    // "feature flags are empty for everyone" rather than 404-ing
    // every portal page like the FUB-columns regression did.
    // Two new-ish nullable columns: feature_flags (0053) and
    // ideal_agent_profile (0056). Either may be missing in a
    // pre-migration environment. Try the full list first; on a
    // missing-column error, drop to the base list and zero-fill
    // both. Order: code deploy AFTER migration; this fallback exists
    // so the wrong order is a graceful no-op rather than an outage.
    const SELECT_WITH_NEW =
      "id, name, slug, portal_enabled, stage_label_overrides, fub_api_key, fub_connected_at, feature_flags, ideal_agent_profile";
    const SELECT_BASE =
      "id, name, slug, portal_enabled, stage_label_overrides, fub_api_key, fub_connected_at";

    let { data, error } = await admin
      .from("clients")
      .select(SELECT_WITH_NEW)
      .eq("portal_token", token)
      .maybeSingle();

    if (
      error &&
      (isMissingColumnError(error, "feature_flags") ||
        isMissingColumnError(error, "ideal_agent_profile"))
    ) {
      const retry = await admin
        .from("clients")
        .select(SELECT_BASE)
        .eq("portal_token", token)
        .maybeSingle();
      data = retry.data
        ? // Re-shape the retry row so the rest of the function reads
          // the same field set regardless of which branch ran.
          ({
            ...retry.data,
            feature_flags: {},
            ideal_agent_profile: {},
          } as typeof data)
        : null;
      error = retry.error;
    }

    if (!data) return null;
    if (data.slug === "unknown") return null;
    if (data.portal_enabled === false) return null;

    const rawOverrides = data.stage_label_overrides;
    const rawKey = data.fub_api_key as string | null | undefined;
    const rawFlags = (data as { feature_flags?: unknown }).feature_flags;
    const rawIdeal = (data as { ideal_agent_profile?: unknown })
      .ideal_agent_profile;
    return {
      id: data.id as string,
      name: data.name as string,
      slug: data.slug as string,
      stage_label_overrides:
        rawOverrides && typeof rawOverrides === "object"
          ? (rawOverrides as Record<string, unknown>)
          : {},
      fub_api_key_set: typeof rawKey === "string" && rawKey.trim().length > 0,
      fub_connected_at: (data.fub_connected_at as string | null) ?? null,
      feature_flags:
        rawFlags && typeof rawFlags === "object" && !Array.isArray(rawFlags)
          ? (rawFlags as Record<string, unknown>)
          : {},
      ideal_agent_profile:
        rawIdeal && typeof rawIdeal === "object" && !Array.isArray(rawIdeal)
          ? (rawIdeal as Record<string, unknown>)
          : {},
    };
  },
);

/**
 * The portal for a token — null when there is none, it is switched off, or it
 * is held for an unpaid invoice (os_portal_blocks, mode 'blocked'; see
 * billing-hold.ts, which fails open). Every portal page and API gates on this,
 * so a held portal serves no data.
 */
export const resolvePortalClient = cache(
  async function resolvePortalClient(token: string): Promise<PortalClient | null> {
    const client = await resolvePortalRow(token);
    if (!client) return null;
    if (await portalBillingHold(client.id)) return null;
    return client;
  },
);

// supabase-js error shapes vary by version; check both the PG code
// (42703 = undefined_column) and the human message text. Either
// signal triggers the fallback path that omits the column.
function isMissingColumnError(
  error: { code?: string; message?: string } | null | undefined,
  columnName: string,
): boolean {
  if (!error) return false;
  if (error.code === "42703") return true;
  const msg = (error.message ?? "").toLowerCase();
  return (
    msg.includes(`column "${columnName}"`) ||
    msg.includes(`column ${columnName}`) ||
    (msg.includes(columnName) && msg.includes("does not exist"))
  );
}
