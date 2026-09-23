import { createAdminSupabase } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { normalizeClientName } from "@/lib/inbox/lists-shared";

// Portal on/off, driven by the external Client Health status feed.
//
// The Health dashboard is the authority for whether a client is engaged.
// Its statuses map to the portal kill-switch (`clients.portal_enabled`,
// read by resolvePortalClient — false = portal fully off):
//
//   active           -> portal ON
//   paused           -> portal OFF
//   churned (hidden) -> portal OFF   (the dashboard labels churned "hidden")
//
// Health is authoritative: every run reconciles portal_enabled back to the
// health status, so a manual toggle in the Portals admin is re-aligned on
// the next sync.
//
// FAIL-SAFE (non-negotiable — portals are live):
//   * feed env unset / down / timeout / non-200 / unparseable -> DO NOTHING.
//   * feed returns 0 clients                                  -> DO NOTHING
//     (an empty feed must never disable every portal at once).
//   * only clients confidently matched to a feed entry are touched; a client
//     absent from the feed is NEVER changed.
//   * writes are idempotent — only portals whose value actually flips.

type FeedStatus = "active" | "paused" | "churned";

// Feed names whose normalized form doesn't line up with the MasterInbox
// client name. Hand-verified; keyed normalized-feed-name -> normalized-MI-name.
//
// NOTE: an alias is a liability if either side is later renamed (a stale
// alias turns a would-be direct match into a miss). Add one only when the
// names genuinely can't be reconciled, and re-verify on client renames.
const NAME_ALIASES: Record<string, string> = {
  // (none currently — "Discover Phx Team" now matches directly after the
  // MasterInbox client was renamed from "The Discover Phx Team".)
};

const FEED_TIMEOUT_MS = 8000;

export interface StatusSyncChange {
  clientId: string;
  clientName: string;
  status: FeedStatus;
  from: boolean; // previous portal_enabled
  to: boolean; // new portal_enabled
  error?: string; // set only if the write failed during an apply run
}

export interface StatusSyncResult {
  ok: boolean;
  applied: boolean; // false = dry-run (report only)
  reason?: string; // populated when ok=false / skipped
  feedCount: number;
  matched: number;
  unmatchedFeed: string[]; // feed clients with no MI match (need an alias?)
  untouchedMi: string[]; // MI clients with no feed status (never changed)
  changes: StatusSyncChange[]; // portals that (would) flip
}

export async function syncPortalStatus(opts: {
  apply: boolean;
}): Promise<StatusSyncResult> {
  const skip = (reason: string): StatusSyncResult => ({
    ok: false,
    applied: false,
    reason,
    feedCount: 0,
    matched: 0,
    unmatchedFeed: [],
    untouchedMi: [],
    changes: [],
  });

  const feedUrl = env.CLIENT_STATUS_URL;
  const feedToken = env.CLIENT_STATUS_TOKEN;
  if (!feedUrl || !feedToken) return skip("feed env not configured");

  // 1. Pull the feed. Any problem -> fail safe, do nothing.
  let feedClients: Array<{ name?: string; status?: string }> = [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(feedUrl, {
        headers: { "x-admin-token": feedToken },
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return skip(`feed http ${res.status}`);
    const data = (await res.json()) as {
      clients?: Array<{ name?: string; status?: string }>;
    };
    feedClients = data.clients ?? [];
  } catch {
    return skip("feed fetch failed");
  }

  // NON-NEGOTIABLE: an empty feed must never disable every portal.
  if (feedClients.length === 0) return skip("feed returned 0 clients");

  // normalized-name -> desired status (valid statuses only).
  const desiredByNorm = new Map<string, { status: FeedStatus; name: string }>();
  for (const c of feedClients) {
    const name = (c.name ?? "").trim();
    const status = c.status as FeedStatus;
    if (!name) continue;
    if (status !== "active" && status !== "paused" && status !== "churned") continue;
    const norm = NAME_ALIASES[normalizeClientName(name)] ?? normalizeClientName(name);
    desiredByNorm.set(norm, { status, name });
  }

  // 2. Load MasterInbox clients.
  const admin = createAdminSupabase();
  const { data: clients, error } = await admin
    .from("clients")
    .select("id, name, slug, portal_enabled");
  if (error) return skip(`clients query failed: ${error.message}`);

  const changes: StatusSyncChange[] = [];
  const untouchedMi: string[] = [];
  const seen = new Set<string>();
  let matched = 0;

  for (const c of (clients ?? []) as Array<{
    id: string;
    name: string;
    slug: string;
    portal_enabled: boolean | null;
  }>) {
    // The "Unknown" fallback bucket is never a real portal.
    if (c.slug === "unknown") {
      untouchedMi.push(c.name);
      continue;
    }
    const norm = normalizeClientName(c.name);
    const desired = desiredByNorm.get(norm);
    if (!desired) {
      untouchedMi.push(c.name); // no health status -> leave exactly as-is
      continue;
    }
    matched++;
    seen.add(norm);
    const want = desired.status === "active"; // active -> ON, else OFF
    const cur = c.portal_enabled !== false; // default true
    if (want !== cur) {
      changes.push({
        clientId: c.id,
        clientName: c.name,
        status: desired.status,
        from: cur,
        to: want,
      });
    }
  }

  // Feed names that matched no MI client — surfaced so a missing alias is visible.
  const unmatchedFeed: string[] = [];
  for (const [norm, v] of desiredByNorm) {
    if (!seen.has(norm)) unmatchedFeed.push(v.name);
  }

  // 3. Apply — only when asked, only the flips above (idempotent).
  if (opts.apply && changes.length > 0) {
    let workspaceId: string | null = null;
    const { data: ws } = await admin
      .from("workspaces")
      .select("id")
      .limit(1)
      .maybeSingle();
    workspaceId = (ws?.id as string | null) ?? null;

    for (const ch of changes) {
      const { error: upErr } = await admin
        .from("clients")
        .update({ portal_enabled: ch.to })
        .eq("id", ch.clientId);
      if (upErr) {
        // One failure must not abort the run — record it and continue.
        ch.error = upErr.message;
        continue;
      }
      // Best-effort audit trail so every portal on/off is explainable later.
      if (workspaceId) {
        await admin
          .from("audit_log")
          .insert({
            workspace_id: workspaceId,
            actor_user_id: null,
            action: "portal_status_sync",
            target_type: "client",
            target_id: ch.clientId,
            payload: {
              client: ch.clientName,
              status: ch.status,
              portal_enabled_from: ch.from,
              portal_enabled_to: ch.to,
            },
          })
          .then(
            () => {},
            () => {},
          );
      }
    }
  }

  return {
    ok: true,
    applied: opts.apply,
    feedCount: feedClients.length,
    matched,
    unmatchedFeed,
    untouchedMi,
    changes,
  };
}
