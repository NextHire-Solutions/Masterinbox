import { NextResponse, after } from "next/server";
import { z } from "zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { resolvePortalClient } from "@/lib/portals/token";
import { clientHasFeature } from "@/lib/portals/feature-flags";
import { TEAM_SMS_FLAG } from "@/lib/portals/team-sms";
import { notifyPortalTeamChange } from "@/lib/webhooks/slack-portal";

// PATCH / DELETE /api/portal/[token]/team/[id]

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  title: z.string().trim().max(120).nullable().optional(),
  // email kept editable now that the row no longer drives blocklist push.
  email: z.string().trim().email().max(160).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  active: z.boolean().optional(),
  // Team-page SMS switch. Only accepted for clients with the
  // team_sms_notifications flag (404 otherwise); see lib/portals/team-sms.ts.
  receives_sms: z.boolean().optional(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ token: string; id: string }> },
) {
  const { token, id } = await context.params;
  const client = await resolvePortalClient(token);
  if (!client) {
    return NextResponse.json({ error: "Portal not found" }, { status: 404 });
  }
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }
  if (
    parsed.data.receives_sms !== undefined &&
    !clientHasFeature(client, TEAM_SMS_FLAG)
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from("client_team_members")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("client_id", client.id)
    .select("id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!data) return NextResponse.json({ error: "Member not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ token: string; id: string }> },
) {
  const { token, id } = await context.params;
  const client = await resolvePortalClient(token);
  if (!client) {
    return NextResponse.json({ error: "Portal not found" }, { status: 404 });
  }
  const admin = createAdminSupabase();
  // Read name + email BEFORE the delete so the Slack message has
  // something to say about who was removed.
  const { data: existing } = await admin
    .from("client_team_members")
    .select("name, email")
    .eq("id", id)
    .eq("client_id", client.id)
    .maybeSingle();
  const { error } = await admin
    .from("client_team_members")
    .delete()
    .eq("id", id)
    .eq("client_id", client.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (existing) {
    const clientId = client.id;
    after(() =>
      notifyPortalTeamChange({
        clientId,
        name: (existing.name as string | null) ?? null,
        email: (existing.email as string | null) ?? null,
        op: "removed",
      }),
    );
  }
  return NextResponse.json({ ok: true });
}
