import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { loadAgentStats } from "@/lib/ai/stats";
import { resolveWorkspace } from "@/lib/auth/service-or-session";
import { env } from "@/lib/env";

/*
 * GET /api/reply-agents/stats — the per-agent feed. Plan §8.
 *
 *   Authorization: Bearer <REPLY_AGENT_STATS_TOKEN>
 *   ?updated_since=2026-08-01T00:00:00Z     incremental cursor (optional)
 *   &page=1&per_page=100                    per_page capped at 200
 *
 *   { "data": [ { agent_id, name, run_mode, client_ids, schedule,
 *                 qualification, handover, stats: { … }, updated_at } ],
 *     "meta": { current_page, last_page, per_page, total } }
 *
 * Kept in step with the OS's reply-agents/stats route.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE IS COPIED, DELIBERATELY
 *
 * Plan §10 lists "the external-feed API pattern (auth, pagination, shape)"
 * under reuse, and this follows /api/outcomes line for line: the same
 * constant-time bearer compare, the same ISO-8601 validation that rejects
 * rather than silently starting from the beginning, the same `{data, meta}`
 * envelope and the same `updated_since` cursor. A consumer that already polls
 * outcomes can point its existing paginator at this.
 *
 * ---------------------------------------------------------------------------
 * A DEDICATED TOKEN, AND WHAT IT IS NOT
 *
 * REPLY_AGENT_STATS_TOKEN is its own secret — not the service-role key, not
 * OUTCOMES_API_TOKEN. (Unprefixed, like OUTCOMES_API_TOKEN and every other
 * variable in this app; the OS's copy carries its MASTER_INBOX_ prefix.)
 * Whoever is given this can read how every agent is configured and how it is
 * performing, and nothing else; it can be rotated without touching the
 * outcomes consumer. Unset means nobody gets in over a bearer (the endpoint
 * fails CLOSED), which is the same choice the outcomes feed makes.
 *
 * ---------------------------------------------------------------------------
 * THREE CALLERS, ONE ROUTE
 *
 * The in-app analytics panel calls this with a workspace session. A script
 * presents the service-role key as x-admin-token, which proxy.ts already lets
 * through. An external tool has neither and presents the bearer instead.
 *
 * NOTE FOR WHOEVER DEPLOYS THIS: the external bearer half does not pass the
 * front door yet. proxy.ts redirects every /api/* request without a session
 * to /login unless the path is on its allowlist, and this path is not listed
 * — adding `pathname.startsWith("/api/reply-agents/stats")` next to the
 * /api/outcomes entry is the one-line change, and proxy.ts is deliberately
 * not edited from here. Until then the bearer is validated but only reaches
 * this code when the proxy has already let the request through.
 */

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const TOKEN_ENV = "REPLY_AGENT_STATS_TOKEN";
const DEFAULT_PER_PAGE = 100;
const MAX_PER_PAGE = 200;

const ISO_RE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Constant-time compare that never throws on a length mismatch. */
function bearerMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const authHeader = request.headers.get("authorization") ?? "";
  const supplied = authHeader.replace(/^Bearer\s+/i, "").trim();

  let workspaceId: string;
  if (supplied) {
    const expected = process.env[TOKEN_ENV]?.trim();
    // Fail closed: an unconfigured token means a presented token is always
    // wrong, rather than being ignored in favour of the session path.
    if (!expected || !bearerMatches(supplied, expected)) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    workspaceId = url.searchParams.get("workspace") ?? env.WORKSPACE_ID ?? "";
    if (!workspaceId) {
      return NextResponse.json({ error: "workspace param required" }, { status: 400 });
    }
  } else {
    // No bearer: the caller is the app (session) or a script (service-role).
    const auth = await resolveWorkspace(request);
    if (!auth.ok) return auth.response;
    workspaceId = auth.workspaceId;
  }

  const updatedSinceRaw = url.searchParams.get("updated_since");
  if (updatedSinceRaw && !ISO_RE.test(updatedSinceRaw)) {
    return NextResponse.json(
      { error: "updated_since must be ISO-8601 (e.g. 2026-08-01T00:00:00Z)" },
      { status: 400 },
    );
  }

  const pageRaw = Number(url.searchParams.get("page") ?? "1");
  const perPageRaw = Number(url.searchParams.get("per_page") ?? DEFAULT_PER_PAGE);
  if (!Number.isInteger(pageRaw) || pageRaw < 1) {
    return NextResponse.json({ error: "page must be a positive integer" }, { status: 400 });
  }
  if (!Number.isInteger(perPageRaw) || perPageRaw < 1) {
    return NextResponse.json({ error: "per_page must be a positive integer" }, { status: 400 });
  }
  const perPage = Math.min(perPageRaw, MAX_PER_PAGE);

  const read = await loadAgentStats({
    workspaceId,
    updatedSince: updatedSinceRaw,
    page: pageRaw,
    perPage,
  });

  if (!read.available) {
    /*
     * 503 rather than 500: the endpoint is correct and the database has not
     * caught up with it. The reason names the migration, so a consumer seeing
     * this in a log knows the fix is not in their code.
     */
    return NextResponse.json({ error: "stats unavailable", detail: read.reason }, { status: 503 });
  }

  const lastPage = Math.max(1, Math.ceil(read.page.total / perPage));
  return NextResponse.json({
    data: read.page.rows,
    meta: {
      current_page: pageRaw,
      last_page: lastPage,
      per_page: perPage,
      total: read.page.total,
    },
  });
}
