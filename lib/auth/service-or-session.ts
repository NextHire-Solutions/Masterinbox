import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/workspace";
import { env } from "@/lib/env";

/*
 * The dual-auth rule several routes in this app already follow by hand —
 * /api/clients, /api/clients/intro-stats, /api/clients/portals — written once
 * for the reply-agent routes.
 *
 *   · A signed-in staff session resolves to that session's workspace.
 *   · The SUPABASE_SERVICE_ROLE_KEY presented as `x-admin-token` or `?token=`
 *     resolves to `?workspace=<uuid>`, defaulting to the pinned singleton in
 *     WORKSPACE_ID. proxy.ts already lets such requests past the session gate
 *     for every /api/* path; this is the route-side half of that arrangement.
 *
 * The token path is what lets scripts/reply-agent-workflow-test.mjs drive the
 * engine without a browser. It is not a third credential: it is the same key
 * that already reaches every table directly.
 */
export type WorkspaceResolution =
  | { ok: true; workspaceId: string; via: "session" | "service_role" }
  | { ok: false; response: NextResponse };

export async function resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
  const url = new URL(request.url);
  const supplied = url.searchParams.get("token") ?? request.headers.get("x-admin-token");
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (supplied && serviceKey && supplied === serviceKey) {
    const workspaceId = url.searchParams.get("workspace") ?? env.WORKSPACE_ID ?? "";
    if (!workspaceId) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "workspace param required when using service-role token" },
          { status: 400 },
        ),
      };
    }
    return { ok: true, workspaceId, via: "service_role" };
  }
  const session = await requireSession();
  return { ok: true, workspaceId: session.activeWorkspace.id, via: "session" };
}
