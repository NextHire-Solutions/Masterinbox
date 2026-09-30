import { cache } from "react";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/db/paginated-select";
import { createInstantlyClient } from "@/lib/instantly/client";
import { deriveClientIdFromCampaign } from "@/lib/clients/derive";
import type { IntroLead } from "@/lib/portals/intro-leads";

// Legacy MasterInbox Introduction feed.
//
// A separate MasterInbox deployment exposes its booked introductions at
// the URL below — but it takes ~30s to respond, far too slow to call on
// a portal render. So we mirror it into the `external_intros` table:
//
//   syncExternalIntros()         — the slow fetch + upsert, then enrich a
//                                  batch of rows. Driven by the cron at
//                                  POST /api/cron/sync-external-intros.
//   enrichExternalIntros()       — fills lead_detail from the Instantly
//                                  API (company, title, custom variables).
//   loadExternalIntrosByClient() — the fast read the portal uses.
//
// The portal then folds this together with our own Introduction data —
// see loadCombinedClientIntroLeads in intro-leads.ts.

const EXTERNAL_INTROS_URL =
  "https://web-production-d18b09.up.railway.app/api/masterinbox/intros";

// Payload keys already shown on their own row of the lead card — kept out
// of the custom-variable dump so they don't appear twice.
const REDUNDANT_PAYLOAD_KEYS = new Set([
  "firstName",
  "lastName",
  "first_name",
  "last_name",
  "companyName",
  "company_name",
  "jobTitle",
  "job_title",
  "email",
]);

interface ExternalIntro {
  email?: string;
  name?: string;
  campaign_id?: string;
  campaign_name?: string;
  intro_at?: string;
  created_at?: string;
  updated_at?: string;
}

export interface SyncResult {
  fetched: number; // rows the upstream returned
  upserted: number; // rows written to external_intros
  skipped: number; // rows dropped (missing email/campaign_id, or feed dupes)
  clientsMatched: number; // distinct clients the rows resolved to
  enriched: number; // rows given full lead detail this run
}

// Pull the legacy feed, upsert it, then enrich a batch of rows with full
// lead detail. Slow (~30s upstream + ~1.5s per enriched lead) — only ever
// called by the cron route, never on a render. Upsert is keyed on
// (email, campaign_id) so re-runs never duplicate.
export async function syncExternalIntros(opts?: {
  enrichLimit?: number;
}): Promise<SyncResult> {
  const res = await fetch(EXTERNAL_INTROS_URL, {
    signal: AbortSignal.timeout(90_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`upstream returned ${res.status}`);
  const json = (await res.json()) as { intros?: ExternalIntro[] };
  const intros = Array.isArray(json.intros) ? json.intros : [];

  // Resolve each DISTINCT campaign name to a client once.
  const campaignToClient = new Map<string, string | null>();
  for (const x of intros) {
    const name = x.campaign_name ?? "";
    // Keyed by name AND campaign id: two campaigns with one name may be
    // sent to different portals (os_campaign_portals).
    const key = `${name}\u0000${x.campaign_id ?? ""}`;
    if (campaignToClient.has(key)) continue;
    campaignToClient.set(key, await deriveClientIdFromCampaign(name || null, { platform: "instantly", id: x.campaign_id }));
  }

  // Build rows. Require email + campaign_id (the dedup key); drop feed
  // duplicates up front so the upsert payload is already clean.
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let skipped = 0;
  const now = new Date().toISOString();
  for (const x of intros) {
    const email = x.email?.trim().toLowerCase();
    const campaignId = x.campaign_id?.trim();
    if (!email || !campaignId) {
      skipped += 1;
      continue;
    }
    const key = `${email}|${campaignId}`;
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    rows.push({
      email,
      name: x.name?.trim() || null,
      campaign_id: campaignId,
      campaign_name: x.campaign_name ?? null,
      client_id: campaignToClient.get(`${x.campaign_name ?? ""}\u0000${x.campaign_id ?? ""}`) ?? null,
      intro_at: x.intro_at ?? x.created_at ?? null,
      source_created_at: x.created_at ?? null,
      source_updated_at: x.updated_at ?? null,
      synced_at: now,
    });
  }

  const admin = createAdminSupabase();
  let upserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    // The upsert payload has no lead_detail / enriched_at keys, so the
    // ON CONFLICT update only touches the feed columns — a re-sync never
    // wipes the enrichment already on an existing row.
    const { error } = await admin
      .from("external_intros")
      .upsert(slice, { onConflict: "email,campaign_id" });
    if (error) throw new Error(`external_intros upsert failed: ${error.message}`);
    upserted += slice.length;
  }

  const clientsMatched = new Set(
    rows.map((r) => r.client_id).filter((c): c is string => Boolean(c)),
  ).size;

  const enrichLimit = opts?.enrichLimit ?? 20;
  const { enriched } =
    enrichLimit > 0
      ? await enrichExternalIntros(enrichLimit)
      : { enriched: 0 };

  return { fetched: intros.length, upserted, skipped, clientsMatched, enriched };
}

// Fill lead_detail for up to `limit` not-yet-enriched rows, from the
// Instantly API (POST /leads/list resolves the full lead by email).
// Throttled ~1.5s/call to respect Instantly's rate limit. A row whose
// lookup throws keeps enriched_at NULL → retried next run; a genuine
// "not found" still sets enriched_at so it isn't retried forever.
export async function enrichExternalIntros(
  limit: number,
): Promise<{ enriched: number; attempted: number }> {
  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from("external_intros")
    .select("id, email")
    .is("enriched_at", null)
    .limit(limit);
  // Table not migrated yet (no enriched_at column) → nothing to do.
  if (error || !data || data.length === 0) return { enriched: 0, attempted: 0 };

  const rows = data as Array<{ id: string; email: string }>;
  const instantly = createInstantlyClient();
  let enriched = 0;

  for (const row of rows) {
    try {
      const res = await instantly.findLeadByEmail(row.email);
      const items = res.items ?? [];
      const lead =
        items.find((l) => (l.email ?? "").toLowerCase() === row.email.toLowerCase()) ??
        items[0];

      let leadDetail: Record<string, unknown> = {};
      if (lead) {
        const payload =
          lead.payload && typeof lead.payload === "object"
            ? (lead.payload as Record<string, unknown>)
            : {};
        const customFields: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(payload)) {
          if (REDUNDANT_PAYLOAD_KEYS.has(k)) continue;
          if (v === null || v === undefined || String(v).trim() === "") continue;
          customFields[k] = v;
        }
        leadDetail = {
          company: lead.company_name ?? null,
          title: lead.job_title ?? null,
          custom_fields: customFields,
        };
        enriched += 1;
      }
      await admin
        .from("external_intros")
        .update({ lead_detail: leadDetail, enriched_at: new Date().toISOString() })
        .eq("id", row.id);
    } catch (err) {
      // Transient (rate limit / network) — leave enriched_at NULL so this
      // row is retried on the next sync. Back off a little before moving on.
      console.error(`[external-intros] enrich failed for ${row.email}`, err);
      await new Promise((r) => setTimeout(r, 4000));
      continue;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { enriched, attempted: rows.length };
}

// Every mirrored external intro grouped by client_id, shaped as IntroLead
// (with enriched company / title / custom variables when available) so it
// merges cleanly with our own data. Reads only the local table — fast.
// Wrapped in cache() so one render resolves it once. If the table doesn't
// exist yet this quietly returns empty and the portal shows our own data.
export const loadExternalIntrosByClient = cache(
  async function loadExternalIntrosByClient(): Promise<Map<string, IntroLead[]>> {
    const admin = createAdminSupabase();
    // select("*") so this keeps working before migration 0020 adds
    // lead_detail — the column is simply absent until then. Page past
    // db-max-rows=1000 — see lib/db/paginated-select.ts.
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await fetchAllRows<Record<string, unknown>>(({ from, to }) =>
        admin
          .from("external_intros")
          .select("*")
          .not("client_id", "is", null)
          .order("intro_at", { ascending: false })
          .range(from, to),
      );
    } catch {
      return new Map();
    }

    const byClient = new Map<string, IntroLead[]>();
    for (const raw of rows) {
      const clientId = raw.client_id as string;
      const detail = (raw.lead_detail ?? {}) as {
        company?: string | null;
        title?: string | null;
        custom_fields?: Record<string, unknown>;
      };
      const lead: IntroLead = {
        thread_id: `ext:${raw.email}:${raw.campaign_id}`,
        assigned_at: (raw.intro_at as string) ?? new Date().toISOString(),
        lead_name: (raw.name as string | null) ?? null,
        lead_email: (raw.email as string | null) ?? null,
        company: detail.company ?? null,
        title: detail.title ?? null,
        campaign_name: (raw.campaign_name as string | null) ?? null,
        source_provider: null,
        subject: null,
        custom_fields: detail.custom_fields ?? {},
      };
      const arr = byClient.get(clientId) ?? [];
      arr.push(lead);
      byClient.set(clientId, arr);
    }
    return byClient;
  },
);
