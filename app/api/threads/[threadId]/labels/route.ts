import { NextResponse, after } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/workspace";
import { createServerSupabase } from "@/lib/supabase/server";
import { isInterestedLabel, markEmailBisonReplyInterested } from "@/lib/inbox/interest";
import { applyLabelToThread } from "@/lib/inbox/apply-label";

export const dynamic = "force-dynamic";

const postSchema = z.object({ label_id: z.string().uuid() });
const deleteSchema = z.object({ label_id: z.string().uuid() });

/*
 * Applying a label is not bookkeeping — see lib/inbox/apply-label.ts, which
 * holds everything this handler used to: the already-carries guard, the notes
 * snapshot, single-label semantics, Hostile → do-not-contact, the three
 * Introduction announcements (n8n, Follow Up Boss, Slack) and the EmailBison
 * interested round trip. It was lifted out so the reply agent can label its
 * own introduction through the same guarded path without a session. This
 * handler resolves the session and hands over; its responses are exactly what
 * they were.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  const session = await requireSession();
  const body = await request.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const supabase = await createServerSupabase();
  const result = await applyLabelToThread({
    supabase,
    workspaceId: session.activeWorkspace.id,
    threadId,
    labelId: parsed.data.label_id,
    actor: { kind: "user", userId: session.user.id },
    // Request scoped: the side effects run after the response, as before.
    defer: after,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  await requireSession();
  const body = await request.json().catch(() => null);
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const supabase = await createServerSupabase();
  const { error } = await supabase
    .from("label_assignments")
    .delete()
    .eq("label_id", parsed.data.label_id)
    .eq("target_type", "thread")
    .eq("target_id", threadId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // If the operator just removed the "Interested" label entirely
  // (vs. replacing it via POST), clear the corresponding EmailBison
  // interested flag so the lead drops off the Health Dashboard.
  const { data: removedLabel } = await supabase
    .from("labels")
    .select("name")
    .eq("id", parsed.data.label_id)
    .maybeSingle();
  if (isInterestedLabel((removedLabel?.name as string | null) ?? null)) {
    after(() => markEmailBisonReplyInterested(threadId, false));
  }

  return NextResponse.json({ ok: true });
}
