import { NextResponse, after } from "next/server";
import { z } from "zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { resolvePortalClient } from "@/lib/portals/token";
import { notifyPortalTeamChange } from "@/lib/webhooks/slack-portal";

// POST /api/portal/[token]/team/csv — bulk-import team-roster rows
// from the portal's CSV dialog.
//
// Dedup is on (name + email) COMBINED, not email alone, so a client whose
// members share one group inbox address can list several people under it. A
// re-uploaded file is still a no-op (same name + email is skipped), while a
// new person sharing an existing email imports cleanly. Team has no provider
// sync to fan out — a team member is purely local storage for warm-intro
// addressing.
//
// Email is required by the row schema (matches the single-row POST
// route — team is no longer a blocklist, it's an addressing list,
// and an entry without an email can't be addressed).

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const rowSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(160),
  title: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
});

const schema = z.object({
  rows: z.array(rowSchema).min(1).max(5000),
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

  const admin = createAdminSupabase();

  // Combined (name + email) dedup key — email lowercased for a stable match.
  const dedupKey = (name: string, email: string) =>
    `${name.trim().toLowerCase()}|${email.trim().toLowerCase()}`;

  // Dedup within the batch by (name + email) so exact repeats collapse but
  // different people sharing a group email are all kept.
  const seen = new Set<string>();
  const rows = parsed.data.rows
    .map((r) => ({ ...r, email: r.email.toLowerCase() }))
    .filter((r) => {
      const k = dedupKey(r.name, r.email);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  // Skip anyone already on the roster with the SAME (name, email) so a
  // re-uploaded file imports nothing new, while a new person on an existing
  // group email still comes through.
  const { data: existing } = await admin
    .from("client_team_members")
    .select("name, email")
    .eq("client_id", client.id);
  const existingKeys = new Set(
    ((existing ?? []) as Array<{ name: string | null; email: string | null }>).map(
      (e) => dedupKey(e.name ?? "", e.email ?? ""),
    ),
  );
  const insertRows = rows
    .filter((r) => !existingKeys.has(dedupKey(r.name, r.email)))
    .map((r) => ({
      client_id: client.id,
      name: r.name,
      email: r.email,
      title: r.title ?? null,
      phone: r.phone ?? null,
      active: true,
    }));

  // Plain insert — duplicate emails are allowed now that a group inbox can back
  // several members. During the brief window BEFORE the migration that drops
  // the legacy (client_id, email) unique index, a batch containing a shared
  // email would trip 23505; we fall back to per-row inserts that skip only the
  // conflicting rows so the rest still import. Team rosters are small, so the
  // row-by-row path is cheap. Once the migration is applied, the batch path
  // handles everything and this fallback never runs.
  let insertedCount = 0;
  if (insertRows.length > 0) {
    const { data: inserted, error } = await admin
      .from("client_team_members")
      .insert(insertRows)
      .select("id");
    if (error) {
      if (error.code === "23505") {
        for (const row of insertRows) {
          const { error: rowErr } = await admin
            .from("client_team_members")
            .insert(row)
            .select("id");
          if (!rowErr) insertedCount += 1;
          else if (rowErr.code !== "23505") {
            return NextResponse.json({ error: rowErr.message }, { status: 400 });
          }
        }
      } else {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    } else {
      insertedCount = inserted?.length ?? 0;
    }
  }
  if (insertedCount > 0) {
    // One summary Slack message per CSV upload so a 200-row file
    // doesn't fan out into 200 individual pings.
    const clientId = client.id;
    after(() =>
      notifyPortalTeamChange({
        clientId,
        name: null,
        email: null,
        op: "added",
        count: insertedCount,
        via: "csv",
      }),
    );
  }

  return NextResponse.json({
    ok: true,
    inserted: insertedCount,
  });
}
