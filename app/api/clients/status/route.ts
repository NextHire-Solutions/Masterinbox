import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { ttlCache } from "@/lib/cache/ttl";
import { env } from "@/lib/env";
import {
  normalizeClientName,
  type ClientStatus,
} from "@/lib/inbox/lists-shared";

// GET /api/clients/status  (internal — called by the sidebar Client List)
//
// Proxies the EXTERNAL client-status feed (a separate app; MasterInbox does
// not own this data) so the browser never sees the admin token. Returns the
// authoritative status counts plus a normalized name → status map the sidebar
// uses to stamp 🟢/🟡/🔴 on each client folder.
//
// FAIL OPEN — the sidebar is live for clients. Any problem (env unset, feed
// down, timeout, bad JSON) returns HTTP 200 { ok: false } with no status, so
// the sidebar renders exactly as it did before. This endpoint must never be
// able to break the inbox.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type StatusResponse = {
  ok: boolean;
  counts: Record<ClientStatus, number> | null;
  byName: Record<string, ClientStatus>;
};

const EMPTY: StatusResponse = { ok: false, counts: null, byName: {} };
const FEED_TIMEOUT_MS = 4000;

// Module-scope TTL cache: the feed changes rarely and every staff page load
// hits this, so cache for 5 min. Single workspace → a constant key.
const loadStatus = ttlCache(
  async (): Promise<StatusResponse> => {
    const feedUrl = env.CLIENT_STATUS_URL;
    const feedToken = env.CLIENT_STATUS_TOKEN;
    if (!feedUrl || !feedToken) return EMPTY;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
    try {
      const res = await fetch(feedUrl, {
        headers: { "x-admin-token": feedToken },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) return EMPTY;
      const data = (await res.json()) as {
        counts?: Record<string, number>;
        clients?: Array<{ name?: string; status?: string }>;
      };
      const byName: Record<string, ClientStatus> = {};
      for (const c of data.clients ?? []) {
        if (!c?.name) continue;
        if (c.status === "active" || c.status === "paused" || c.status === "churned") {
          byName[normalizeClientName(c.name)] = c.status;
        }
      }
      const counts =
        data.counts &&
        typeof data.counts.active === "number"
          ? {
              active: data.counts.active ?? 0,
              paused: data.counts.paused ?? 0,
              churned: data.counts.churned ?? 0,
            }
          : null;
      return { ok: true, counts, byName };
    } catch {
      // timeout / network / parse — swallow, fail open.
      return EMPTY;
    } finally {
      clearTimeout(timer);
    }
  },
  { ttlMs: 300_000, key: () => "client-status" },
);

export async function GET() {
  // Staff-only: this is called from the authenticated sidebar. A logged-out
  // caller simply gets ok:false (never the token or the data).
  try {
    const supabase = await createServerSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json(EMPTY);
  } catch {
    return NextResponse.json(EMPTY);
  }

  try {
    return NextResponse.json(await loadStatus());
  } catch {
    return NextResponse.json(EMPTY);
  }
}
