// Per-client feature flags for the Client Portal.
//
// Each client row carries a `feature_flags` jsonb map (added in
// migration 0053). Empty map (the default for every existing row)
// means "behave like every other client" — no opt-in, no surprises.
//
// =====================================================================
// THE RULE — read this before adding any new feature
// =====================================================================
//
// Real clients (SERHANT., 54 Realty, Douglas Elliman, etc.) must NEVER
// see an in-progress feature until it is explicitly rolled out to them.
// The only client allowed to see in-progress features is Demo Portal (slug
// "demo-portal"), the test portal.
//
// To honour the rule, EVERY new feature ships in two halves:
//
//   1. Wrap the NEW code path in `clientHasFeature(client, "X")`:
//        if (clientHasFeature(client, "reports_tab")) {
//          // new behaviour, only Demo Portal sees this
//        } else {
//          // existing behaviour — what real clients keep seeing
//        }
//
//   2. After the code deploys, flip the flag on for Demo Portal only:
//        update clients
//        set feature_flags = jsonb_set(feature_flags, '{reports_tab}', 'true')
//        where slug = 'demo-portal';
//
//      No other client row is touched, so `clientHasFeature(realClient,
//      "reports_tab")` returns false for them and they continue to render
//      the existing path — bit-identical to before the deploy.
//
// When the user gives the explicit "roll out reports_tab to everyone"
// approval, there are two ways to lift the gate:
//   • One-shot SQL — turn the flag on for every client row.
//   • Better: delete the `clientHasFeature` check and the old code path,
//     leave the new path as the default. Cleaner long-term; the flag
//     entry on Demo Portal becomes dead data and can stay or get cleaned.
//
// NEVER invert the check (`if (!clientHasFeature(...))`). That makes the
// new behaviour the default for everyone and the flag would have to be
// flipped on Demo Portal to HIDE the new feature — which is the exact
// opposite of the safety contract. The wrong-by-construction shape
// reads `if (clientHasFeature(...))` every time.
//
// =====================================================================
// What CAN'T be feature-flagged
// =====================================================================
//
// Some changes don't pass through `clientHasFeature` and therefore can't
// be gated this way:
//   • Schema migrations (a new column or enum value lands for every
//     client at once). Keep migrations additive + non-destructive; the
//     code that USES the new schema is still flag-able.
//   • Global CSS / theme tokens / portal shell layout edits that affect
//     all clients in one shot.
//   • API route hardening / outbound integration changes that don't
//     differentiate per client.
// For those, the safety story is "the migration is non-destructive and
// the existing behaviour keeps working even with the new column
// present" — not feature flags.
//
// =====================================================================
// Defensive read
// =====================================================================
//
// Flags are loaded server-side by resolvePortalClient (see
// lib/portals/token.ts) and ride along on PortalClient. That loader
// uses a defensive two-query pattern so pre-migration deploys still
// resolve clients cleanly (flags read as empty {}). Result: a
// deploy-before-migration accident downgrades to "nobody has any flags
// enabled" rather than 404-ing every portal. clientHasFeature() also
// returns false for any malformed flags blob, so a corrupted jsonb is a
// quiet no-op, not a crash.

import type { PortalClient } from "@/lib/portals/token";

// Returns true when the supplied flag is truthy in the client's
// feature_flags map. Anything missing, undefined, or non-truthy
// (false, 0, empty string, null) returns false — opt-in semantics.
//
// Accepts a partial shape so callers in test / staff drilldown
// contexts (where they may have only loaded part of the client row)
// can pass whatever they have without TypeScript gymnastics.
export function clientHasFeature(
  client: { feature_flags?: Record<string, unknown> | null | undefined },
  flag: string,
): boolean {
  const flags = client.feature_flags;
  if (!flags || typeof flags !== "object") return false;
  return Boolean((flags as Record<string, unknown>)[flag]);
}

// Same check but accepting the full PortalClient (named alias for
// the common case so call sites read self-documenting).
export function portalHasFeature(
  client: PortalClient,
  flag: string,
): boolean {
  return clientHasFeature(client, flag);
}

// A copy of a client's flags map with ONE flag switched on (set to true)
// or off (removed), every other flag kept exactly as it was. For the few
// flags that staff turn on from the UI instead of SQL (e.g. SMS alerts on
// the Client Portals page). A malformed map is treated as empty.
export function withFeatureFlag(
  flags: unknown,
  flag: string,
  on: boolean,
): Record<string, unknown> {
  const next: Record<string, unknown> =
    flags && typeof flags === "object" && !Array.isArray(flags)
      ? { ...(flags as Record<string, unknown>) }
      : {};
  if (on) next[flag] = true;
  else delete next[flag];
  return next;
}
