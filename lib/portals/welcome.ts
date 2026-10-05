/*
 * A portal opens on its Welcome page once per browser session (client ask,
 * 5 Oct: "it should directly send us to the welcome page").
 *
 * Before, /portal/<token> rendered the whole Recruiting Pipeline and a
 * client-side script then jumped to /welcome — the pipeline flashed up and
 * every lead was loaded for nothing. Now the decision is made on the server
 * before anything renders:
 *
 *   - /portal/<token>/welcome sets this cookie (proxy.ts) — for the browser
 *     session only, scoped to this portal's path;
 *   - /portal/<token> loaded as a page, without the cookie, redirects to
 *     /welcome (app/portal/[token]/page.tsx).
 *
 * In-portal navigation (the sidebar, the Welcome cards) is never redirected,
 * so the pipeline is always reachable — even in a browser that refuses
 * cookies. No URL changes: /portal/<token> is still the pipeline.
 */

export function welcomedCookieName(token: string): string {
  return `portal_welcomed_${token.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** The token when the path is this portal's Welcome page, else null. */
export function welcomeToken(pathname: string): string | null {
  const m = pathname.match(/^\/portal\/([^/]+)\/welcome\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** A request the app router makes while already inside the portal (RSC / prefetch), not a page load. */
export function isInAppNavigation(get: (name: string) => string | null): boolean {
  return get("rsc") === "1" || get("next-router-prefetch") !== null || get("next-router-state-tree") !== null;
}
