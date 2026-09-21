import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { isSuperAdmin } from "@/lib/auth/super-admin";
import { liveSendingEnabled } from "@/lib/ai/live-gate";
import { releaseHeldReplies } from "@/lib/ai/release";
import { LIVE_TRANSPORT_WIRED } from "@/lib/ai/send-transport";
import { env } from "@/lib/env";

/*
 * Cron endpoint — the reply agent's off-hours release sweep (plan §5).
 *
 * This is where the release job is REGISTERED in this app: recurring work
 * here is a route under /api/cron hit by an external scheduler, exactly as
 * sync-external-intros is. The OS registers the same job in its in-process
 * scheduler (sync/cron.ts, every five minutes); this route is that entry.
 *
 * Schedule it every five minutes, the cadence the OS uses:
 *   curl -X POST 'https://<host>/api/cron/release-held-replies?token=<service-role-key>'
 *
 * Auth: super-admin session OR ?token=<service-role> / x-cron-token — the
 * same rule as the sibling cron route. GET and POST both work so simple
 * schedulers can use either.
 *
 * What a run does today: reads every held reply, re-runs the whole safety
 * gate on each, and is refused at the first check because live sending is
 * off on this server. It sends nothing and reports so. Harmless to schedule
 * early; essential once live is on.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function authorized(request: Request): Promise<boolean> {
  const url = new URL(request.url);
  const supplied = url.searchParams.get("token") ?? request.headers.get("x-cron-token");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supplied && serviceKey && supplied === serviceKey) return true;
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return Boolean(user && isSuperAdmin(user.email));
}

async function run(request: Request) {
  if (!(await authorized(request))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspace") ?? env.WORKSPACE_ID ?? "";
  if (!workspaceId) {
    return NextResponse.json(
      { ok: false, error: "WORKSPACE_ID is not set and no ?workspace= was given" },
      { status: 400 },
    );
  }
  try {
    const report = await releaseHeldReplies(workspaceId, new Date());
    return NextResponse.json({
      ok: true,
      ...report,
      live_sending_enabled: liveSendingEnabled(),
      transport_wired: LIVE_TRANSPORT_WIRED,
    });
  } catch (err) {
    console.error("[cron] release-held-replies failed", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "release failed" },
      { status: 502 },
    );
  }
}

export const GET = run;
export const POST = run;
