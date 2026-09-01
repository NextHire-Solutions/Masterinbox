import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/workspace";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { updateAgentContact } from "@/lib/agents/contact";
import { LICENSE_KEYS, pickFirstString } from "@/components/portals/custom-field-helpers";

// POST /api/threads/[threadId]/agent-email  (staff-only)
//
// Add an email for the thread's agent:
//   1) append it to the agent's PROVIDED values in the external agents DB
//      (match by license number → the agent's current email; max_matches:1 so a
//      single staff action never fans out to many agents), and
//   2) store it on the lead (leads.custom_fields.emails) so the Agent card can
//      show it.
//
// Mirrors the add-phone POST. It NEVER overwrites Courted (the endpoint appends),
// and it does NOT touch the client portal or the introduction path — the portal's
// email snapshot still comes from leads.email, which we don't change here.

export const dynamic = "force-dynamic";

const MAX_EMAILS = 10;

const bodySchema = z.object({
  email: z.string().trim().min(3, "Email is required").max(120).email("Enter a valid email"),
});

function normEmail(s: string): string {
  return s.trim().toLowerCase();
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())
    : [];
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of list) {
    const k = normEmail(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

type ResolvedLead = {
  lead_id: string;
  email: string | null;
  custom_fields: Record<string, unknown>;
};

async function resolveLead(
  admin: ReturnType<typeof createAdminSupabase>,
  threadId: string,
  workspaceId: string,
): Promise<{ lead: ResolvedLead | null; error: string | null }> {
  const { data: row, error } = await admin
    .from("threads")
    .select("lead_id, leads:lead_id (id, email, custom_fields)")
    .eq("id", threadId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) return { lead: null, error: error.message };
  const l = (Array.isArray(row?.leads) ? row?.leads[0] : row?.leads) as
    | { id: string; email: string | null; custom_fields: Record<string, unknown> | null }
    | null
    | undefined;
  if (!row || !l) return { lead: null, error: null };
  return {
    lead: {
      lead_id: l.id,
      email: l.email ?? null,
      custom_fields: (l.custom_fields as Record<string, unknown> | null) ?? {},
    },
    error: null,
  };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  const session = await requireSession();

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  const email = parsed.data.email;

  const admin = createAdminSupabase();
  const { lead, error } = await resolveLead(admin, threadId, session.activeWorkspace.id);
  if (error) return NextResponse.json({ ok: false, error }, { status: 400 });
  if (!lead) {
    return NextResponse.json(
      { ok: false, error: "No agent linked to this conversation" },
      { status: 404 },
    );
  }

  const cf = lead.custom_fields;
  const license_number = pickFirstString(cf, LICENSE_KEYS);

  // Store the new email on the lead (dedup against prior added emails and the
  // lead's own email). Merge-write a dedicated key so a re-sync can't clobber it.
  const prior = stringArray(cf.emails);
  const emails = dedupe([...prior, email]).slice(0, MAX_EMAILS);

  // Default the preferred email to the lead's existing email if none has been
  // chosen yet, so adding a new one NEVER silently switches which email the
  // portal shows. (Mirrors preferred_phone.)
  const priorPreferred =
    typeof cf.preferred_email === "string" && cf.preferred_email.trim() !== ""
      ? cf.preferred_email.trim()
      : null;
  const preferred = priorPreferred ?? lead.email ?? emails[0] ?? null;

  const merged: Record<string, unknown> = { ...cf, emails };
  if (preferred) merged.preferred_email = preferred;
  const { error: upErr } = await admin
    .from("leads")
    .update({ custom_fields: merged })
    .eq("id", lead.lead_id);
  if (upErr) {
    return NextResponse.json({ ok: false, error: upErr.message }, { status: 400 });
  }

  // Append the new email to the agent's provided values. Match by license →
  // the agent's current email; helper always sends max_matches:1.
  const ext = await updateAgentContact({
    matchLicense: license_number,
    matchEmail: lead.email,
    email,
  });

  return NextResponse.json({
    ok: true,
    matched: ext.ok ? ext.matched : 0,
    added: ext.ok ? ext.emailUpdated : 0,
    external: ext.ok ? null : ext.error,
    emails,
    preferred,
  });
}

// PATCH — mark an email as PREFERRED (portal display only; does NOT touch the
// external agents DB). Mirrors the agent-phone PATCH:
//   1) set leads.custom_fields.preferred_email (used by the intro trigger for
//      FUTURE introductions — migration 0073), and
//   2) update EXISTING client_pipeline_entries.lead_email for this lead so
//      already-introduced client portals show it immediately.
// The email was already pushed to the agents DB when it was ADDED (POST), so a
// preferred change never re-appends it there.
export async function PATCH(
  request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  const session = await requireSession();

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  const preferred = parsed.data.email;

  const admin = createAdminSupabase();
  const { lead, error } = await resolveLead(admin, threadId, session.activeWorkspace.id);
  if (error) return NextResponse.json({ ok: false, error }, { status: 400 });
  if (!lead) {
    return NextResponse.json(
      { ok: false, error: "No agent linked to this conversation" },
      { status: 404 },
    );
  }

  const cf = lead.custom_fields;
  const prior = stringArray(cf.emails);
  // Keep the chosen email in the stored list too (unless it's the lead's own
  // email, which the card already shows). The UI only offers known emails.
  const emails =
    lead.email && normEmail(lead.email) === normEmail(preferred)
      ? dedupe(prior).slice(0, MAX_EMAILS)
      : dedupe([...prior, preferred]).slice(0, MAX_EMAILS);

  // 1) Lead: set the dedicated preferred_email key (future intros; migration 0073).
  const merged: Record<string, unknown> = { ...cf, emails, preferred_email: preferred };
  const { error: upErr } = await admin
    .from("leads")
    .update({ custom_fields: merged })
    .eq("id", lead.lead_id);
  if (upErr) {
    return NextResponse.json({ ok: false, error: upErr.message }, { status: 400 });
  }

  // 2) Existing portal snapshots: update lead_email for this lead's entries so
  //    already-introduced client portals reflect the preferred immediately.
  //    Same operation as the portal Edit dialog; scoped to this lead. Guarded.
  let entriesUpdated = 0;
  try {
    const { data: rows, error: entErr } = await admin
      .from("client_pipeline_entries")
      .update({ lead_email: preferred, updated_at: new Date().toISOString() })
      .eq("lead_id", lead.lead_id)
      .select("id");
    if (!entErr && Array.isArray(rows)) entriesUpdated = rows.length;
  } catch {
    // ignore — lead preferred is already saved; portals catch up on next intro.
  }

  // NOTE: no external agents-DB call here (portal display only).
  return NextResponse.json({ ok: true, emails, preferred, entriesUpdated });
}
