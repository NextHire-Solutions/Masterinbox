import { NextResponse } from "next/server";
import { z } from "zod";

import { runReplyAgentForThread } from "@/lib/ai/runtime";
import { resolveWorkspace } from "@/lib/auth/service-or-session";

/*
 * POST /api/reply-agents/run — run the agent on one thread.
 *
 *   { "thread_id": "…", "dry_run": true }
 *
 * Kept in step with the OS's reply-agents/run route.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 *
 * In this app the engine already runs on every inbound reply — the two sync
 * workers call `runReplyAgentForThread` — so this is not the manual handle it
 * is in the OS. It exists for the second reason:
 *
 *   `dry_run` makes the whole thing observable without doing anything: which
 *   agent was selected and why, which question is next, what the safety gate
 *   says. That is what makes this feature testable against real conversations
 *   without drafting into an operator's composer or spending a model call —
 *   see scripts/reply-agent-workflow-test.mjs.
 *
 * ---------------------------------------------------------------------------
 * dry_run DEFAULTS TO TRUE
 *
 * Deliberately the unusual choice. A POST to this path with no body is the
 * shape of an accident — a curl someone half-remembered, a retried request —
 * and the safe reading of an accident is "tell me what you would do".
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const bodySchema = z.object({
  thread_id: z.string().uuid(),
  dry_run: z.boolean().default(true),
});

export async function POST(request: Request) {
  const auth = await resolveWorkspace(request);
  if (!auth.ok) return auth.response;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "thread_id is required" },
      { status: 400 },
    );
  }

  try {
    const outcome = await runReplyAgentForThread(auth.workspaceId, parsed.data.thread_id, {
      dryRun: parsed.data.dry_run,
    });
    return NextResponse.json({ dry_run: parsed.data.dry_run, outcome });
  } catch (err) {
    console.error("[reply-agents/run] failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Run failed" },
      { status: 500 },
    );
  }
}
