import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { ttlCache } from "@/lib/cache/ttl";
import { env } from "@/lib/env";

// GET /api/outcomes  — recruiting-pipeline OUTCOME feed for the downstream
// attribution tool. EmailBison-shaped so the consumer reuses its paginator.
//
//   Authorization: Bearer <OUTCOMES_API_TOKEN>   (required)
//   ?updated_since=2026-08-01T00:00:00Z          (optional ISO-8601 cursor)
//   &page=1&per_page=100                          (per_page capped at 200)
//
// Each row is one stage a candidate reached (see the pipeline_outcome_events
// log + triggers in migration 0065). Events are append-only; a stage/date
// correction adds a new event and a deleted candidate flips voided=true —
// both bump updated_at, which is the incremental cursor.
//
//   { "data": [ { id, email, event_type, occurred_at, updated_at, voided,
//                 emailbison_lead_id, campaign_id } ],
//     "meta": { current_page, last_page, per_page, total } }
//
// event_type is a raw pipeline_stage value; funnel order is introduction →
// phone_screen_scheduled → phone_screen → interview_scheduled → interview →
// hired, plus side states keep_warm / we_they_rejected / no_show.
//
// NOT emitted (data doesn't exist here): attribution_status (the consumer owns
// attribution), value/currency (no deal value stored). emailbison_lead_id /
// campaign_id are best-effort — present for EmailBison-sourced leads/threads,
// null otherwise. Demo client is excluded (v_pipeline_outcomes).

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const DEFAULT_PER_PAGE = 100;
const MAX_PER_PAGE = 200;

// Accepts an ISO-8601 date or date-time (optional ms + Z/offset). A malformed
// value is a client error, not a silent "from the beginning" fallback.
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

type Row = {
  id: string;
  email: string | null;
  event_type: string;
  occurred_at: string;
  updated_at: string;
  voided: boolean;
  emailbison_lead_id: string | null;
  campaign_id: string | null;
  client_id: string | null;
  client_name: string | null;
};

// Constant-time Bearer compare that never throws on length mismatch.
function bearerMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// EmailBison-style ids arrive as text in our schema; emit as numbers when they
// are purely numeric (matches the consumer's int example) else pass through.
function coerceId(v: string | null): number | string | null {
  if (v == null) return null;
  return /^\d+$/.test(v) ? Number(v) : v;
}

// Module scope so the TTL Map survives across requests — shields the DB from a
// tight poll loop. Keyed by (updated_since, page, per_page).
const loadOutcomes = ttlCache(
  async (updatedSince: string | null, page: number, perPage: number) => {
    const admin = createAdminSupabase();
    const from = (page - 1) * perPage;
    const to = from + perPage - 1;
    let query = admin
      .from("v_pipeline_outcomes")
      .select("*", { count: "exact" })
      // Stable cursor: (updated_at, id) so paging never dupes or skips.
      .order("updated_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
    if (updatedSince) query = query.gte("updated_at", updatedSince);
    const { data, error, count } = await query;
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as Row[], total: count ?? 0 };
  },
  { ttlMs: 60_000 },
);

export async function GET(request: Request) {
  // --- auth: Authorization: Bearer <OUTCOMES_API_TOKEN> ---
  const expected = env.OUTCOMES_API_TOKEN;
  if (!expected) {
    // Fail closed: an unconfigured token means no one gets in.
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const authHeader = request.headers.get("authorization") ?? "";
  const supplied = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!supplied || !bearerMatches(supplied, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // --- query params ---
  const url = new URL(request.url);
  const updatedSinceRaw = url.searchParams.get("updated_since");
  if (updatedSinceRaw && !ISO_RE.test(updatedSinceRaw)) {
    return NextResponse.json(
      { error: "updated_since must be ISO-8601 (e.g. 2026-08-01T00:00:00Z)" },
      { status: 400 },
    );
  }
  const updatedSince = updatedSinceRaw || null;

  const pageRaw = Number(url.searchParams.get("page") ?? "1");
  const perPageRaw = Number(url.searchParams.get("per_page") ?? DEFAULT_PER_PAGE);
  if (!Number.isInteger(pageRaw) || pageRaw < 1) {
    return NextResponse.json({ error: "page must be a positive integer" }, { status: 400 });
  }
  if (!Number.isInteger(perPageRaw) || perPageRaw < 1) {
    return NextResponse.json({ error: "per_page must be a positive integer" }, { status: 400 });
  }
  const page = pageRaw;
  const perPage = Math.min(perPageRaw, MAX_PER_PAGE);

  try {
    const { rows, total } = await loadOutcomes(updatedSince, page, perPage);
    const lastPage = Math.max(1, Math.ceil(total / perPage));
    return NextResponse.json({
      data: rows.map((r) => ({
        id: r.id,
        email: r.email,
        event_type: r.event_type,
        occurred_at: r.occurred_at,
        updated_at: r.updated_at,
        voided: r.voided,
        emailbison_lead_id: coerceId(r.emailbison_lead_id),
        campaign_id: coerceId(r.campaign_id),
        // The true owning client — MasterInbox's ground truth, so the consumer
        // no longer has to guess it from first-touch campaign.
        client_id: r.client_id,
        client_name: r.client_name,
      })),
      meta: {
        current_page: page,
        last_page: lastPage,
        per_page: perPage,
        total,
      },
    });
  } catch (e) {
    console.error("[outcomes] query failed", e);
    return NextResponse.json({ error: "outcomes unavailable" }, { status: 500 });
  }
}
