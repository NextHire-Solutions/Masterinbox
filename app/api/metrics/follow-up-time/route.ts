import { NextResponse } from "next/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { ttlCache } from "@/lib/cache/ttl";
import { env } from "@/lib/env";

// GET /api/metrics/follow-up-time  (PUBLIC — no auth, no headers)
//   optional ?from=YYYY-MM-DD&to=YYYY-MM-DD   (inclusive ET calendar dates)
//
// "How fast does the team reply?" For every inbound lead message, we pair
// it with the team's NEXT outbound message in the same thread and measure
// the gap in BUSINESS time only (Mon–Fri 09:00–17:00 America/New_York,
// DST-aware — see business_seconds / team_follow_up_by_day in migrations
// 0063/0064).
//
// Returns:
//   overall — the EXACT median business-seconds across every reply in the
//             range (compute it here, don't average daily medians: a median
//             cannot be recovered from per-day medians).
//   days    — per-ET-day breakdown (median + sample size) within the range.
//
// from/to are optional; omit both for the whole history. Never-replied
// inbounds are excluded; median_seconds: 0 means replies landed within/after
// off-hours (0 business time), not "no data".

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type Row = { day: string | null; median_seconds: number | string; sample_size: number | string };

function humanize(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Module scope so the TTL Map persists across requests — this endpoint is
// public, so the cache shields the DB from repeated heavy scans. Keyed by
// (workspaceId, from, to) via the default JSON.stringify(args).
type CampaignRow = {
  campaign_id: string;
  median_seconds: number | string;
  sample_size: number | string;
};

const loadFollowUp = ttlCache(
  async (workspaceId: string, from: string | null, to: string | null) => {
    const admin = createAdminSupabase();
    const fmt = (r: { median_seconds: number | string; sample_size: number | string }) => {
      const med = Math.round(Number(r.median_seconds) || 0);
      return {
        median_seconds: med,
        median_human: humanize(med),
        sample_size: Number(r.sample_size) || 0,
      };
    };

    // overall + per-day (existing RPC)
    const { data, error } = await admin.rpc("team_follow_up_by_day", {
      p_ws: workspaceId,
      p_from: from,
      p_to: to,
    });
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Row[];
    const overallRow = rows.find((r) => r.day === null);
    const overall = overallRow
      ? fmt(overallRow)
      : { median_seconds: 0, median_human: "0m", sample_size: 0 };
    const days = rows
      .filter((r): r is Row & { day: string } => r.day !== null)
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((r) => ({ date: r.day, ...fmt(r) }));

    // per-campaign (EmailBison campaigns only — see migration 0066)
    const { data: campData, error: campError } = await admin.rpc(
      "team_follow_up_by_campaign",
      { p_ws: workspaceId, p_from: from, p_to: to },
    );
    if (campError) throw new Error(campError.message);
    const by_campaign = ((campData ?? []) as CampaignRow[])
      .map((r) => ({
        // EmailBison campaign ids are numeric — emit as an integer so the
        // consumer can join directly (never a UUID: the RPC filters to
        // EmailBison threads).
        campaign_id: /^\d+$/.test(String(r.campaign_id))
          ? Number(r.campaign_id)
          : r.campaign_id,
        ...fmt(r),
      }))
      // Busiest campaigns first; a tiny-sample row (median over < 3 replies)
      // isn't meaningful, so the consumer shows a dash — sample_size lets them.
      .sort((a, b) => b.sample_size - a.sample_size);

    return { overall, days, by_campaign };
  },
  { ttlMs: 900_000 }, // 15 min
);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  // Validate loosely — a malformed date is a client error, not a silent
  // full-history fallback (that would hide the mistake).
  if ((fromRaw && !DATE_RE.test(fromRaw)) || (toRaw && !DATE_RE.test(toRaw))) {
    return NextResponse.json(
      { ok: false, error: "from/to must be YYYY-MM-DD" },
      { status: 400 },
    );
  }
  const from = fromRaw || null;
  const to = toRaw || null;

  const workspaceId = env.WORKSPACE_ID;
  if (!workspaceId) {
    return NextResponse.json(
      { ok: false, error: "WORKSPACE_ID not configured" },
      { status: 500 },
    );
  }
  try {
    const { overall, days, by_campaign } = await loadFollowUp(workspaceId, from, to);
    return NextResponse.json({
      ok: true,
      timezone: "America/New_York",
      business_hours: "Mon–Fri 09:00–17:00",
      from,
      to,
      overall,
      days,
      // Per EmailBison campaign (integer campaign_id). EmailBison replies only;
      // Instantly replies still count in overall/days but not here.
      by_campaign,
    });
  } catch (e) {
    console.error("[follow-up-time] rpc failed", e);
    return NextResponse.json(
      { ok: false, error: "metric unavailable" },
      { status: 500 },
    );
  }
}
