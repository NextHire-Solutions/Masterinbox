import { ttlCache } from "@/lib/cache/ttl";
import { env } from "@/lib/env";
import { normalizeClientName } from "@/lib/inbox/lists-shared";

// Client PLAN lookup for the portal. Plan data lives in the external dashboard
// (same app + token as the client-status feed) at /api/clients, where each row
// carries a `plan` (production | minimum | partner). MasterInbox does not own
// this data, so we read it server-side and match to our client by NAME (the
// two systems use different ids).
//
// FAIL OPEN: any problem (env unset, feed down, timeout, bad JSON) returns no
// plan, so the Team page renders exactly as before — this can never break the
// portal.

const FEED_TIMEOUT_MS = 4000;

// Module-scope TTL cache — the plan feed changes rarely; 5 min is plenty and
// shields the external app from every portal render.
const loadPlans = ttlCache(
  async (): Promise<Record<string, string>> => {
    const statusUrl = env.CLIENT_STATUS_URL;
    const token = env.CLIENT_STATUS_TOKEN;
    if (!statusUrl || !token) return {};
    // CLIENT_STATUS_URL points at .../api/clients/status; the plan list is the
    // sibling .../api/clients.
    const url = statusUrl.replace(/\/status\/?$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { "x-admin-token": token },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) return {};
      const data = (await res.json()) as {
        clients?: Array<{ name?: string; plan?: string }>;
      };
      const byName: Record<string, string> = {};
      for (const c of data.clients ?? []) {
        if (c?.name && c?.plan) byName[normalizeClientName(c.name)] = c.plan;
      }
      return byName;
    } catch {
      return {};
    } finally {
      clearTimeout(timer);
    }
  },
  { ttlMs: 300_000, key: () => "client-plans" },
);

// The client's plan, or null when unknown / feed unavailable.
export async function getClientPlan(name: string): Promise<string | null> {
  try {
    const map = await loadPlans();
    return map[normalizeClientName(name)] ?? null;
  } catch {
    return null;
  }
}
