import { NextResponse, after } from "next/server";
import { z } from "zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { resolvePortalClient } from "@/lib/portals/token";
import { notifyPortalTeamChange } from "@/lib/webhooks/slack-portal";

// POST /api/portal/[token]/team — add a team member to the intro
// notification roster. Team is NOT a blocklist anymore (per May 2026
// client feedback). Adding a member only stores them locally so they
// can be addressed when a warm intro is ready.

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(160),
  title: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const client = await resolvePortalClient(token);
  if (!client) {
    return NextResponse.json({ error: "Portal not found" }, { status: 404 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  const { name, email, title, phone } = parsed.data;

  const admin = createAdminSupabase();

  // Block only an EXACT (name + email) repeat — a different person on the same
  // group email is allowed. Email is citext, so the match is case-insensitive.
  const { data: dupes } = await admin
    .from("client_team_members")
    .select("id, name")
    .eq("client_id", client.id)
    .eq("email", email);
  if (
    (dupes ?? []).some(
      (d) =>
        (d.name as string | null)?.trim().toLowerCase() ===
        name.trim().toLowerCase(),
    )
  ) {
    return NextResponse.json(
      { error: "This person is already on the team." },
      { status: 409 },
    );
  }

  // `receives` is no longer collected from the UI (notification
  // delivery isn't wired up); the DB column keeps its default value
  // until/unless that feature returns.
  const { data, error } = await admin
    .from("client_team_members")
    .insert({
      client_id: client.id,
      name,
      email,
      title: title ?? null,
      phone: phone ?? null,
      active: true,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") {
      // Only reachable from the legacy (client_id, email) unique index BEFORE
      // the migration that drops it — until then a shared email is blocked.
      return NextResponse.json(
        { error: "That email is already used by another team member." },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // Slack: announce the new Team roster entry. after() so a Slack
  // hiccup can't break the user-visible Add action.
  const clientId = client.id;
  after(() =>
    notifyPortalTeamChange({
      clientId,
      name,
      email,
      op: "added",
    }),
  );

  return NextResponse.json({ ok: true, id: data.id });
}
