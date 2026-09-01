import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Hostname routing: portal.brokerstaffer.com serves client portals
// ONLY. MasterInbox + admin tooling stays on the canonical Railway
// URL — and disallowed paths on the portal subdomain must NEVER
// expose MasterInbox.
//
// Previous implementation 302'd disallowed paths to the Railway URL,
// which leaked the staff app to anyone hitting portal.brokerstaffer.com/
// (the root then bounced to /inbox/all-email via the auth redirect).
// Fixed by REWRITING (internal serve, URL unchanged in the address
// bar) to a branded /portal-locked page that explains the user needs
// their unique link.
const PORTAL_HOSTS = new Set(["portal.brokerstaffer.com"]);
// Paths the portal subdomain is allowed to serve. Anything outside
// this list silently rewrites to /portal-locked.
const PORTAL_ALLOWED_PREFIXES = [
  "/portal", // /portal/<token>/*
  "/api/portal", // /api/portal/<token>/*
  "/api/metrics", // public read-only aggregate metrics (no per-user data) —
  //               served on the portal host too so a plain public GET works
  //               there without hitting the /portal-locked fail-close.
  "/_next", // Next.js bundle + static assets
  "/favicon", // /favicon.ico, /favicon-*
  "/portal-logo", // public portal assets
  "/portal-locked", // the fail-closed landing page itself
];

// Next.js 16 — the request "proxy" (formerly middleware). Refreshes the
// Supabase session cookie and gates the (app) tree behind authentication.
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = request.headers.get("host")?.toLowerCase() ?? "";

  // Portal subdomain: every non-portal path REWRITES to the branded
  // /portal-locked page so the URL bar stays on portal.brokerstaffer.com
  // and MasterInbox is never reachable from this host. Runs BEFORE
  // auth so unauthenticated requests don't leak the login surface
  // either.
  if (PORTAL_HOSTS.has(host)) {
    const allowed = PORTAL_ALLOWED_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`),
    );
    if (!allowed) {
      // Service-role escape hatch for /api/* only: automation
      // callers (n8n, scripts) may hit portal.brokerstaffer.com/api/…
      // with x-admin-token / ?token=<SUPABASE_SERVICE_ROLE_KEY>.
      // Without this carve-out the host gate rewrites them to
      // /portal-locked and the route handler never sees the request.
      // Non-/api/* paths still fail-closed to /portal-locked.
      if (pathname.startsWith("/api/")) {
        const supplied =
          request.nextUrl.searchParams.get("token") ??
          request.headers.get("x-admin-token");
        const expected = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (supplied && expected && supplied === expected) {
          return NextResponse.next();
        }
      }
      const url = request.nextUrl.clone();
      url.pathname = "/portal-locked";
      url.search = "";
      return NextResponse.rewrite(url);
    }
    // Allowed path — fall through to the rest of the proxy. The /portal
    // bypass below already short-circuits auth for these routes.
  }

  // Public API endpoints — webhook receivers and bootstrap helpers — must be
  // reachable without a session. They have their own auth (provider tokens /
  // service-role checks).
  // /api/admin/* endpoints check super-admin session OR ?token=<service-role>
  // themselves, so they can also bypass the proxy auth gate.
  if (
    pathname.startsWith("/api/webhooks") ||
    pathname.startsWith("/api/health") ||
    pathname.startsWith("/api/admin") ||
    // /api/metrics/* — intentionally public read-only aggregate metrics
    // (e.g. follow-up-time). No per-user data; safe to serve without a
    // session, so it must bypass the auth-redirect gate below.
    pathname.startsWith("/api/metrics") ||
    // /api/outcomes — the attribution-tool feed. Bypasses the SESSION gate
    // here; the route handler enforces its own `Authorization: Bearer
    // <OUTCOMES_API_TOKEN>` check (it exposes candidate emails, so it is NOT
    // open — it just doesn't use a Supabase login).
    pathname.startsWith("/api/outcomes") ||
    // /api/reply-labels — same attribution consumer, same Bearer-token auth
    // in the route handler (reuses OUTCOMES_API_TOKEN). Session-gate bypass
    // only; not open.
    pathname.startsWith("/api/reply-labels") ||
    // /api/portal/<token>/... — token in the path IS the credential; the
    // route handlers validate it via lib/portals/token.ts.
    pathname.startsWith("/api/portal/")
  ) {
    return NextResponse.next();
  }

  // /portal/<token>/* — the public brokerage portal. Token in the URL is
  // the credential; no Supabase session involved at all. Bypass the
  // auth.getUser() round-trip below — it adds latency, can hang under
  // a flaky connection (which was producing "this page couldn't load"
  // errors in Chrome on portal navigations), and the result isn't used
  // for portal pages anyway.
  if (pathname === "/portal" || pathname.startsWith("/portal/")) {
    return NextResponse.next();
  }

  // Any /api/* request that carries `?token=<SUPABASE_SERVICE_ROLE_KEY>`
  // (or the equivalent x-admin-token header) is treated as service-role:
  // skip the proxy auth gate and let the route handler verify the token
  // itself. Used for diagnostic CLI calls against endpoints (e.g.
  // /api/clients/intro-stats) that normally rely on a user session.
  if (pathname.startsWith("/api/")) {
    const supplied =
      request.nextUrl.searchParams.get("token") ??
      request.headers.get("x-admin-token");
    const expected = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (supplied && expected && supplied === expected) {
      return NextResponse.next();
    }
  }

  // Demo mode: skip auth entirely so the UI shell is publicly visible while
  // Supabase isn't configured yet.
  if (process.env.DEMO_MODE === "true") {
    if (pathname === "/" || pathname === "/login") {
      const url = request.nextUrl.clone();
      url.pathname = "/inbox";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  // If Supabase env vars are missing, don't crash — just pass the request
  // through. Auth-gated pages will surface a clearer error than the proxy.
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isAuthRoute = pathname.startsWith("/login") || pathname.startsWith("/auth");
  // Public client portals — /portal/<token> — are reached by external
  // brokerages with no BrokerStaffer login. The token in the path IS the
  // credential. Note: the admin page lives at /portals (plural) and does
  // NOT match "/portal/", so it stays auth-gated.
  const isPortalRoute = pathname === "/portal" || pathname.startsWith("/portal/");
  // /portal-locked is the fail-closed landing the host gate above
  // rewrites disallowed paths to. Reachable by anyone — must not
  // trigger the auth redirect, otherwise the portal subdomain
  // would bounce between /login and /portal-locked forever.
  const isPortalLocked = pathname === "/portal-locked";
  const isPublicRoute =
    isAuthRoute || isPortalRoute || isPortalLocked || pathname === "/";

  if (!user && !isPublicRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (user && (pathname === "/" || pathname === "/login")) {
    const url = request.nextUrl.clone();
    url.pathname = "/inbox";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
