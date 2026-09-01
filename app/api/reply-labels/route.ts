import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { ttlCache } from "@/lib/cache/ttl";
import { env } from "@/lib/env";

// GET /api/reply-labels  — one row per THREAD with its current label + reply
// ids, for the downstream attribution tool. Same shape + Bearer auth as
// /api/outcomes (reuses OUTCOMES_API_TOKEN — same consumer).
//
//   Authorization: Bearer <OUTCOMES_API_TOKEN>
//   ?updated_since=2026-08-01T00:00:00Z   (optional ISO cursor)
//   &page=1&per_page=200                   (per_page capped at 200)
//
// A thread carries at most one label (app-enforced). Unlabelled threads are
// emitted with null label fields so "not labelled yet" is distinguishable from
// "labelled neutral". `updated_at` bumps on label add / change / REMOVE and on
// soft-delete (Trash); `deleted` is true for Trash or a hard-deleted thread
// (tombstone) — see migration 0067. Both providers are included; the consumer
// excludes Instantly from campaign math via `source_provider`.
//
//   { "data": [ { thread_id, source_provider, emailbison_reply_ids,
//                 first_emailbison_reply_id, label_name, label_sentiment,
//                 assigned_by, labelled_at, campaign_id, lead_email,
//                 emailbison_lead_id, updated_at, deleted } ],
//     "meta": { current_page, last_page, per_page, total } }

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const DEFAULT_PER_PAGE = 100;
const MAX_PER_PAGE = 200;
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

type Row = {
  thread_id: string;
  source_provider: string | null;
  emailbison_reply_ids: unknown;
  first_emailbison_reply_id: string | null;
  label_name: string | null;
  label_sentiment: string | null;
  assigned_by: string | null;
  labelled_at: string | null;
  campaign_id: string | null;
  lead_email: string | null;
  emailbison_lead_id: string | null;
  updated_at: string;
  deleted: boolean;
};

function bearerMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// emailbison_reply_id is a numeric string in our schema; the consumer wants
// numbers. Drop anything non-numeric defensively.
function toNum(v: unknown): number | null {
  if (v == null) return null;
  return /^\d+$/.test(String(v)) ? Number(v) : null;
}
function toNumArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.map(toNum).filter((n): n is number => n !== null);
}

const loadReplyLabels = ttlCache(
  async (updatedSince: string | null, page: number, perPage: number) => {
    const admin = createAdminSupabase();
    const from = (page - 1) * perPage;
    const to = from + perPage - 1;
    let query = admin
      .from("v_reply_labels")
      .select("*", { count: "exact" })
      // Stable cursor: (updated_at, thread_id).
      .order("updated_at", { ascending: true })
      .order("thread_id", { ascending: true })
      .range(from, to);
    if (updatedSince) query = query.gte("updated_at", updatedSince);
    const { data, error, count } = await query;
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as Row[], total: count ?? 0 };
  },
  { ttlMs: 60_000 },
);

export async function GET(request: Request) {
  const expected = env.OUTCOMES_API_TOKEN;
  if (!expected) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const authHeader = request.headers.get("authorization") ?? "";
  const supplied = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!supplied || !bearerMatches(supplied, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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
    const { rows, total } = await loadReplyLabels(updatedSince, page, perPage);
    const lastPage = Math.max(1, Math.ceil(total / perPage));
    return NextResponse.json({
      data: rows.map((r) => ({
        thread_id: r.thread_id,
        source_provider: r.source_provider,
        emailbison_reply_ids: toNumArray(r.emailbison_reply_ids),
        first_emailbison_reply_id: toNum(r.first_emailbison_reply_id),
        label_name: r.label_name,
        label_sentiment: r.label_sentiment,
        assigned_by: r.assigned_by,
        labelled_at: r.labelled_at,
        campaign_id: r.campaign_id,
        lead_email: r.lead_email,
        emailbison_lead_id: r.emailbison_lead_id,
        updated_at: r.updated_at,
        deleted: r.deleted,
      })),
      meta: {
        current_page: page,
        last_page: lastPage,
        per_page: perPage,
        total,
      },
    });
  } catch (e) {
    console.error("[reply-labels] query failed", e);
    return NextResponse.json({ error: "reply-labels unavailable" }, { status: 500 });
  }
}
