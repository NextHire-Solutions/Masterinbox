import { NextResponse } from "next/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { ttlCache } from "@/lib/cache/ttl";
import { env } from "@/lib/env";

// GET /api/metrics/follow-up-time  (PUBLIC — no auth, no headers)
//
// "How fast does the team reply?" For every inbound lead message, we pair
// it with the team's NEXT outbound message in the same thread and measure
// the gap in BUSINESS time only (Mon–Fri 09:00–17:00 America/New_York,
// DST-aware — see the team_follow_up_by_day / business_seconds RPCs in
// migration 0063). Returns one row per ET calendar day (bucketed by the
// inbound message's date) with that day's MEDIAN business-seconds and the
// sample size. The caller slices custom date ranges on their end.
//
// Never-replied inbounds are excluded; days with no replied inbounds are
// absent. median_seconds: 0 means replies landed within/after off-hours
// (0 business time elapsed), not "no data".

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type DayRow = { day: string; median_seconds: number | string; sample_size: number | string };

function humanize(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Module scope so the TTL Map persists across requests — this endpoint is
// public, so the cache shields the DB from repeated heavy scans. Keyed by
// workspaceId (the sole argument).
const loadFollowUpByDay = ttlCache(
  async (workspaceId: string) => {
    const admin = createAdminSupabase();
    const { data, error } = await admin.rpc("team_follow_up_by_day", {
      p_ws: workspaceId,
    });
    if (error) throw new Error(error.message);
    return ((data ?? []) as DayRow[]).map((r) => {
      const med = Math.round(Number(r.median_seconds) || 0);
      return {
        date: r.day,
        median_seconds: med,
        median_human: humanize(med),
        sample_size: Number(r.sample_size) || 0,
      };
    });
  },
  { ttlMs: 900_000 }, // 15 min
);

export async function GET() {
  const workspaceId = env.WORKSPACE_ID;
  if (!workspaceId) {
    return NextResponse.json(
      { ok: false, error: "WORKSPACE_ID not configured" },
      { status: 500 },
    );
  }
  try {
    const days = await loadFollowUpByDay(workspaceId);
    return NextResponse.json({
      ok: true,
      timezone: "America/New_York",
      business_hours: "Mon–Fri 09:00–17:00",
      days,
    });
  } catch (e) {
    console.error("[follow-up-time] rpc failed", e);
    return NextResponse.json(
      { ok: false, error: "metric unavailable" },
      { status: 500 },
    );
  }
}
