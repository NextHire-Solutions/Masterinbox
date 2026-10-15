// Where an old portal link goes now (migration 0079).
//
// When a portal's URL (its token) changes, the old token is kept in
// portal_token_aliases, and a visit to the old link is forwarded to the
// portal's current one — so the links a client already has (bookmarks, the
// introduction emails and texts sent before) keep working.
//
// Forwarded only where the current link would itself open: a portal that is
// switched off, or the Unknown fallback, answers "not found" on its old links
// exactly as on its current one. Pure, so it is tested; token.ts reads.

export function forwardTokenFor(
  oldToken: string,
  portal: { portal_token: string | null; slug: string | null; portal_enabled: boolean | null } | null,
): string | null {
  if (!portal) return null;
  if (portal.slug === "unknown" || portal.portal_enabled === false) return null;
  const current = portal.portal_token;
  if (!current || current === oldToken || current.length < 4) return null;
  return current;
}
