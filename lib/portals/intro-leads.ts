import { cache } from "react";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/db/paginated-select";
import { env } from "@/lib/env";
import { loadExternalIntrosByClient } from "@/lib/portals/external-intros";
import { countIntroductions, type LabelledIntro, type PortalEntryRow } from "./intro-counts";

// Shared "Introduction"-label data layer for the client portals.
//
// Both the internal admin page and the PUBLIC per-client portal read from
// here. The public portal has no logged-in user, so RLS (which is
// workspace-member gated) cannot enforce the per-client boundary — this
// module uses the service-role admin client and filters by client_id in
// code. Treat the client_id argument as the security boundary.
//
// Resolution path mirrors app/api/clients/intros/route.ts:
//   Introduction label → label_assignments (thread targets) → threads →
//   leads. Threads are chunked through `in()` to stay under PostgREST's
//   URL-length cap.

// PostgREST URL length cap (~16 KB) means an `id=in.(<uuid×N>)` clause
// tips over at roughly 407 ids for a full-select query. At that point
// undici raises "HTTP headers exceeded server limits" and supabase-js
// surfaces it as `data: null`, silently dropping every id in the batch.
// 200 keeps the URL comfortably under ~8 KB. Same size / same reason
// as /api/clients/intros — see the 2026-07-07 fix on that endpoint.
const CHUNK = 200;
const INTRO_LABEL_NAME = "Introduction";

export interface IntroLead {
  thread_id: string;
  assigned_at: string; // ISO 8601 UTC — when the Introduction label landed
  lead_name: string | null;
  lead_email: string | null;
  company: string | null;
  title: string | null;
  campaign_name: string | null;
  source_provider: string | null; // "emailbison" | "instantly" | null
  subject: string | null;
  // Webhook custom variables / enrichment carried on the lead.
  custom_fields: Record<string, unknown>;
}

export interface IntroSummary {
  count: number;
  lastAt: string | null;
  /** Of `count`, in the client's portal / made but never in it (intro-counts.ts). Absent when the portal could not be read. */
  inPortal?: number;
  notInPortal?: number;
  /** Every candidate in the portal, the client's own too — the portal's own "N of N candidates". */
  candidates?: number;
}

// Resolve the Introduction label id for the BrokerStaffer workspace.
// Returns null if the label doesn't exist yet (portal then shows an
// empty state).
async function resolveIntroLabelId(
  admin: ReturnType<typeof createAdminSupabase>,
): Promise<string | null> {
  const workspaceId = env.WORKSPACE_ID;
  if (!workspaceId) return null;
  const { data } = await admin
    .from("labels")
    .select("id")
    .eq("workspace_id", workspaceId)
    .ilike("name", INTRO_LABEL_NAME)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

// Every Introduction assignment across all clients, as raw (thread, when)
// pairs. Internal helper — callers below shape it per their need.
async function loadAllIntroAssignments(
  admin: ReturnType<typeof createAdminSupabase>,
): Promise<Array<{ target_id: string; assigned_at: string }>> {
  const labelId = await resolveIntroLabelId(admin);
  if (!labelId) return [];
  const workspaceId = env.WORKSPACE_ID;
  // Page past db-max-rows=1000 — see lib/db/paginated-select.ts. The
  // Intro label routinely sits at thousands of assignments.
  return await fetchAllRows<{ target_id: string; assigned_at: string }>(
    ({ from, to }) =>
      admin
        .from("label_assignments")
        .select("target_id, assigned_at")
        .eq("workspace_id", workspaceId)
        .eq("target_type", "thread")
        .eq("label_id", labelId)
        .order("assigned_at", { ascending: false })
        .range(from, to),
  );
}

// Our Supabase Introduction leads for EVERY client in one pass, grouped
// by client_id (each list newest-first). This is the single shared scan
// behind the per-client loader and the admin roll-up — wrapped in
// cache() so one render runs it once no matter how many callers ask.
export const loadOurIntroLeadsByClient = cache(
  async function loadOurIntroLeadsByClient(): Promise<Map<string, IntroLead[]>> {
    const admin = createAdminSupabase();
    const assignments = await loadAllIntroAssignments(admin);
    if (assignments.length === 0) return new Map();

    // thread_id → meta
    const threadIds = Array.from(new Set(assignments.map((a) => a.target_id)));
    const threadMeta = new Map<
      string,
      {
        client_id: string | null;
        lead_id: string | null;
        campaign_name: string | null;
        source_provider: string | null;
        subject: string | null;
      }
    >();
    for (let i = 0; i < threadIds.length; i += CHUNK) {
      const slice = threadIds.slice(i, i + CHUNK);
      const { data } = await admin
        .from("threads")
        .select("id, client_id, lead_id, campaign_name, source_provider, subject")
        .in("id", slice);
      for (const t of (data ?? []) as Array<{
        id: string;
        client_id: string | null;
        lead_id: string | null;
        campaign_name: string | null;
        source_provider: string | null;
        subject: string | null;
      }>) {
        threadMeta.set(t.id, {
          client_id: t.client_id,
          lead_id: t.lead_id,
          campaign_name: t.campaign_name,
          source_provider: t.source_provider,
          subject: t.subject,
        });
      }
    }

    // lead_id → lead details
    const leadIds = new Set<string>();
    for (const a of assignments) {
      const lid = threadMeta.get(a.target_id)?.lead_id;
      if (lid) leadIds.add(lid);
    }
    const leadById = new Map<
      string,
      {
        full_name: string | null;
        email: string | null;
        company: string | null;
        title: string | null;
        custom_fields: Record<string, unknown>;
      }
    >();
    const leadIdList = Array.from(leadIds);
    for (let i = 0; i < leadIdList.length; i += CHUNK) {
      const slice = leadIdList.slice(i, i + CHUNK);
      const { data } = await admin
        .from("leads")
        .select("id, full_name, email, company, title, custom_fields")
        .in("id", slice);
      for (const l of (data ?? []) as Array<{
        id: string;
        full_name: string | null;
        email: string | null;
        company: string | null;
        title: string | null;
        custom_fields: Record<string, unknown> | null;
      }>) {
        leadById.set(l.id, {
          full_name: l.full_name,
          email: l.email,
          company: l.company,
          title: l.title,
          custom_fields: l.custom_fields ?? {},
        });
      }
    }

    // assignments came back newest-first → each per-client list inherits
    // that order.
    const byClient = new Map<string, IntroLead[]>();
    for (const a of assignments) {
      const meta = threadMeta.get(a.target_id);
      if (!meta || !meta.client_id) continue;
      const lead = meta.lead_id ? leadById.get(meta.lead_id) : null;
      const intro: IntroLead = {
        thread_id: a.target_id,
        assigned_at: a.assigned_at,
        lead_name: lead?.full_name ?? null,
        lead_email: lead?.email ?? null,
        company: lead?.company ?? null,
        title: lead?.title ?? null,
        campaign_name: meta.campaign_name,
        source_provider: meta.source_provider,
        subject: meta.subject,
        custom_fields: lead?.custom_fields ?? {},
      };
      const arr = byClient.get(meta.client_id) ?? [];
      arr.push(intro);
      byClient.set(meta.client_id, arr);
    }
    return byClient;
  },
);

// Every Introduction lead for ONE client (our Supabase data only),
// newest-first. The clientId argument is the hard per-client boundary.
export async function loadClientIntroLeads(clientId: string): Promise<IntroLead[]> {
  return (await loadOurIntroLeadsByClient()).get(clientId) ?? [];
}

// Dedup key — the same person introduced in the same campaign is ONE
// introduction, regardless of which MasterInbox reported it.
function introKey(l: IntroLead): string {
  return `${(l.lead_email ?? "").toLowerCase().trim()}|${(l.campaign_name ?? "")
    .toLowerCase()
    .trim()}`;
}

// Merge our Supabase intros with the legacy feed for one client. Ours
// win on a collision (they carry richer fields — company, title, custom
// variables). Result is deduped and newest-first.
function mergeIntros(ours: IntroLead[], external: IntroLead[]): IntroLead[] {
  const seen = new Set<string>();
  const merged: IntroLead[] = [];
  for (const l of [...ours, ...external]) {
    const k = introKey(l);
    if (k === "|") {
      // No email AND no campaign — can't dedup it; keep as-is.
      merged.push(l);
      continue;
    }
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(l);
  }
  merged.sort((a, b) => (b.assigned_at ?? "").localeCompare(a.assigned_at ?? ""));
  return merged;
}

// THE portal payload for one client. Originally merged our Supabase
// Introduction leads with the legacy MasterInbox feed; the legacy feed
// was disconnected in 2026-05 per client request, so this now reads
// ONLY our own data. Kept as a named export so existing callers stay
// untouched while the legacy loader becomes effectively dead code.
export async function loadCombinedClientIntroLeads(clientId: string): Promise<IntroLead[]> {
  const ourByClient = await loadOurIntroLeadsByClient();
  return ourByClient.get(clientId) ?? [];
}

/*
 * Every portal entry, for the introductions count (15 Oct) — four columns,
 * paged: there are ~1,850 and a select stops at 1,000 without saying so.
 * Null when they cannot be read, so the count falls back rather than drops.
 */
const loadPortalEntriesForCounts = cache(async (): Promise<PortalEntryRow[] | null> => {
  try {
    const admin = createAdminSupabase();
    return await fetchAllRows<PortalEntryRow>(({ from, to }) =>
      admin
        .from("client_pipeline_entries")
        .select("client_id, thread_id, source, introduced_at")
        .order("id", { ascending: true })
        .range(from, to),
    );
  } catch (e) {
    console.error("[intro-leads] portal entries for counts:", e instanceof Error ? e.message : e);
    return null;
  }
});

// Combined per-client roll-up for the admin grid — count + most recent.
// Since 15 Oct: the client's introductions as intro-counts.ts defines them
// (our portal entries + labelled conversations missing from the portal), so
// the grid agrees with each portal and shows what never reached it. The same
// change as the OS (NextHire-Solutions/OS, intro-counts.ts).
export async function loadCombinedIntroSummaryByClient(): Promise<Map<string, IntroSummary>> {
  const [ourByClient, entries] = await Promise.all([loadOurIntroLeadsByClient(), loadPortalEntriesForCounts()]);
  if (entries) {
    const labelled: LabelledIntro[] = [];
    for (const [client_id, leads] of ourByClient) {
      for (const l of leads) labelled.push({ client_id, thread_id: l.thread_id, assigned_at: l.assigned_at });
    }
    return countIntroductions(entries, labelled);
  }
  // The portal could not be read: the labelled conversations alone, as before 15 Oct.
  const out = new Map<string, IntroSummary>();
  for (const [id, leads] of ourByClient) {
    let lastAt: string | null = null;
    for (const l of leads) {
      if (!lastAt || l.assigned_at > lastAt) lastAt = l.assigned_at;
    }
    out.set(id, { count: leads.length, lastAt });
  }
  return out;
}

export interface TrendBucket {
  weekStart: string; // ISO date (Monday) of the week
  label: string; // e.g. "May 19"
  count: number;
}

// Buckets intro events into the last `weeks` ISO weeks (Monday-start) for
// the portal's trend bar chart. Always returns exactly `weeks` buckets,
// oldest → newest, so the chart has a stable shape even with sparse data.
export function weeklyTrend(leads: IntroLead[], weeks = 12): TrendBucket[] {
  const mondayOf = (d: Date): Date => {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = x.getUTCDay(); // 0 Sun … 6 Sat
    const diff = day === 0 ? 6 : day - 1; // days since Monday
    x.setUTCDate(x.getUTCDate() - diff);
    return x;
  };

  const now = new Date();
  const thisMonday = mondayOf(now);

  const buckets: TrendBucket[] = [];
  const indexByKey = new Map<string, number>();
  for (let i = weeks - 1; i >= 0; i--) {
    const ws = new Date(thisMonday);
    ws.setUTCDate(ws.getUTCDate() - i * 7);
    const key = ws.toISOString().slice(0, 10);
    indexByKey.set(key, buckets.length);
    buckets.push({
      weekStart: key,
      label: ws.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
      count: 0,
    });
  }

  for (const lead of leads) {
    const d = new Date(lead.assigned_at);
    if (Number.isNaN(d.getTime())) continue;
    const key = mondayOf(d).toISOString().slice(0, 10);
    const idx = indexByKey.get(key);
    if (idx !== undefined) buckets[idx].count += 1;
  }
  return buckets;
}
