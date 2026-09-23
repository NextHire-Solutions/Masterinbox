import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { isSuperAdmin } from "@/lib/auth/super-admin";
import { syncPortalStatus } from "@/lib/portals/status-sync";

// Cron endpoint — reconciles each client's portal on/off switch
// (clients.portal_enabled) to the external Client Health status feed:
//   active -> portal ON, paused/churned(hidden) -> portal OFF.
//
// Schedule it like the other crons (Railway cron service, crontab, etc.):
//   curl -X POST 'https://<host>/api/cron/sync-portal-status?token=<service-role-key>&apply=1'
//
// SAFETY:
//   * DRY-RUN BY DEFAULT. Without ?apply=1 it only reports what WOULD change
//     and writes nothing — so the scheduled job can be pointed at it in
//     report-only mode first, then flipped to apply=1 once confirmed.
//   * All fail-safe rules live in syncPortalStatus (feed down / empty -> no-op;
//     only matched clients touched; idempotent writes).
//
// Auth: super-admin session OR ?token= / x-cron-token, where the token is
// either the Supabase service-role key OR the dedicated, low-privilege
// PORTAL_STATUS_SYNC_TOKEN (preferred for the Client Health dashboard push,
// so the master key never leaves MasterInbox). GET and POST both work so
// simple schedulers / webhooks can use either.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Constant-time-ish equality so a valid non-empty token can't be probed by
// timing. (Both are opaque high-entropy secrets, but cheap to be careful.)
function tokenMatches(supplied: string, expected: string | undefined): boolean {
  if (!expected || !supplied) return false;
  if (supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < supplied.length; i++) diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function authorized(request: Request): Promise<boolean> {
  const url = new URL(request.url);
  const supplied = url.searchParams.get("token") ?? request.headers.get("x-cron-token");
  if (supplied) {
    if (tokenMatches(supplied, process.env.SUPABASE_SERVICE_ROLE_KEY)) return true;
    if (tokenMatches(supplied, process.env.PORTAL_STATUS_SYNC_TOKEN)) return true;
  }
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
  // Report-only unless ?apply=1 is explicitly passed.
  const apply = new URL(request.url).searchParams.get("apply") === "1";
  try {
    const result = await syncPortalStatus({ apply });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "sync failed" },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}
