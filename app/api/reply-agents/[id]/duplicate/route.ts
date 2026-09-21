import { NextResponse } from "next/server";
import { z } from "zod";

import { duplicateAgent } from "@/lib/ai/agent";
import { resolveWorkspace } from "@/lib/auth/service-or-session";

/*
 * POST /api/reply-agents/[id]/duplicate — plan §6.
 *
 * Kept in step with the OS's reply-agents/[id]/duplicate route.
 *
 * Clone an agent to test a different qualification script, then swap which one
 * is live. The clone comes back PAUSED and INACTIVE — see `duplicateAgent` for
 * why that is not merely a sensible default but a requirement of the A/B
 * design: two agents running on one client at once would make the comparison
 * the feature exists to produce meaningless.
 *
 * The API key is not copied. The response says so, so the screen can tell the
 * person what is left to do rather than leaving them with a clone that cannot
 * draft and no explanation.
 */

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const auth = await resolveWorkspace(request);
  if (!auth.ok) return auth.response;
  const raw = await request.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  try {
    const newId = await duplicateAgent(auth.workspaceId, id, parsed.data.name);
    return NextResponse.json({
      id: newId,
      run_mode: "pause",
      active: false,
      note: "The copy is paused and inactive, and has no API key — add one before activating it.",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Duplicate failed" },
      { status: 400 },
    );
  }
}
