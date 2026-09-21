import { NextResponse } from "next/server";

import { liveSendingEnabled, LIVE_SEND_ENV_VAR } from "@/lib/ai/live-gate";
import { releaseHeldReplies } from "@/lib/ai/release";
import { LIVE_TRANSPORT_WIRED } from "@/lib/ai/send-transport";
import { loadHeldStates } from "@/lib/ai/thread-state";
import { resolveWorkspace } from "@/lib/auth/service-or-session";

/*
 * The off-hours release sweep — plan §5's "background job [that] releases the
 * held replies when the window opens".
 *
 *   GET  what is waiting, and whether anything could be sent if it were due
 *   POST run the sweep
 *
 * Kept in step with the OS's reply-agents/release route.
 *
 * ---------------------------------------------------------------------------
 * HOW THIS GETS CALLED
 *
 * This is the handle for a person (or a script) with a session. The scheduled
 * run is app/api/cron/release-held-replies, which an external scheduler hits
 * every five minutes with the service-role token — the same arrangement as
 * cron/sync-external-intros. Until that schedule exists, held replies stay
 * held and this endpoint is the manual handle. That is a safe failure: holding
 * is what the whole gate does.
 *
 * ---------------------------------------------------------------------------
 * SAFE TO CALL AT ANY TIME
 *
 * A release is a full send attempt — every safety check re-run from scratch on
 * a reply that may be hours old (see ai/release.ts). Today every one of them
 * stops at the live gate, so this endpoint reports what WOULD be attempted and
 * sends nothing.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  const auth = await resolveWorkspace(request);
  if (!auth.ok) return auth.response;
  const held = await loadHeldStates(auth.workspaceId, 200);
  return NextResponse.json({
    held: held.length,
    live_sending_enabled: liveSendingEnabled(),
    transport_wired: LIVE_TRANSPORT_WIRED,
    env_var: LIVE_SEND_ENV_VAR,
    oldest_held_at: held[0]?.heldAt ?? null,
    by_reason: held.reduce<Record<string, number>>((acc, s) => {
      const key = s.holdReason ?? "unknown";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  });
}

export async function POST(request: Request) {
  const auth = await resolveWorkspace(request);
  if (!auth.ok) return auth.response;
  const report = await releaseHeldReplies(auth.workspaceId, new Date());
  return NextResponse.json({
    ...report,
    live_sending_enabled: liveSendingEnabled(),
    transport_wired: LIVE_TRANSPORT_WIRED,
  });
}
