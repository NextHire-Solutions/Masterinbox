import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/workspace";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { updateAgentContact } from "@/lib/agents/contact";
import {
  LICENSE_KEYS,
  PHONE_KEYS,
  pickFirstString,
} from "@/components/portals/custom-field-helpers";

// /api/threads/[threadId]/agent-phone  (staff-only)
//
// POST  { phone } — add a phone number for the thread's agent:
//   1) push it to the EXTERNAL agents DB (matched by license → email), and
//   2) store it on the lead (leads.custom_fields.phones) so it can be picked as
//      the preferred number. Never silently changes which number is preferred.
//
// PATCH { phone } — mark an already-listed number as PREFERRED (portal display
// only; does NOT touch the external agents DB):
//   1) set leads.custom_fields.preferred_phone (used by the intro trigger for
//      FUTURE introductions — migration 0072), and
//   2) update EXISTING client_pipeline_entries.lead_phone for this lead so
//      already-introduced client portals show it immediately (same write the
//      portal Edit dialog performs).
// The number is pushed to the agents DB only when it is first ADDED (POST), so a
// preferred change never re-appends it there.
//
// All lead identity is resolved server-side from the thread (never trusted from
// the client), scoped to the caller's workspace. Lead writes are JSONB merges
// (read-modify-write) of two dedicated keys — `phones` and `preferred_phone` —
// so a re-sync (which merge-overwrites custom_fields) can't clobber them.

export const dynamic = "force-dynamic";

const MAX_PHONES = 10;

const bodySchema = z.object({
  phone: z.string().trim().min(1, "Phone is required").max(80),
});

// Digits-only key for de-duplication / membership (formatting is preserved in
// the stored/displayed value).
function normPhone(s: string): string {
  return s.replace(/\D/g, "");
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())
    : [];
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of list) {
    const k = normPhone(p) || p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

// The existing displayed phone, derived to MATCH the inbox Agent card
// (components/inbox/prospect-panel.tsx): exact PHONE_KEYS first (portal-consistent),
// then a normalized key match over the same candidates the card's find() uses, so
// a number stored under e.g. "Mobile Phone" is still seeded into the list.
const PHONE_NKEYS = ["phone", "phonenumber", "mobile", "cell", "mobilephone", "cellphone"];
function deriveDisplayPhone(cf: Record<string, unknown>): string | null {
  const exact = pickFirstString(cf, PHONE_KEYS);
  if (exact) return exact;
  for (const [k, v] of Object.entries(cf)) {
    if (v == null || String(v).trim() === "") continue;
    const nk = k.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (PHONE_NKEYS.includes(nk)) return String(v).trim();
  }
  return null;
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

// POST — add a phone (external push + store on the lead).
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
  const phone = parsed.data.phone;

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
  const seed = deriveDisplayPhone(cf); // existing displayed phone, if any

  // Build the phone list: existing list, else seed with the current display
  // phone, then append the new number. Preserve order, dedupe, cap.
  const prior = stringArray(cf.phones);
  const base = prior.length ? prior : seed ? [seed] : [];
  const phones = dedupe([...base, phone]).slice(0, MAX_PHONES);

  // Preferred: keep whatever is already preferred; else default to the existing
  // display phone; else the only number we have. NEVER silently switch to the
  // number just added when a preferred/display already exists.
  const priorPreferred =
    typeof cf.preferred_phone === "string" && cf.preferred_phone.trim() !== ""
      ? cf.preferred_phone.trim()
      : null;
  let preferred = priorPreferred ?? seed ?? phones[0] ?? null;
  if (preferred && !phones.some((p) => normPhone(p) === normPhone(preferred as string))) {
    preferred = phones[0] ?? null;
  }

  const merged: Record<string, unknown> = { ...cf, phones };
  if (preferred) merged.preferred_phone = preferred;
  const { error: upErr } = await admin
    .from("leads")
    .update({ custom_fields: merged })
    .eq("id", lead.lead_id);
  if (upErr) {
    return NextResponse.json({ ok: false, error: upErr.message }, { status: 400 });
  }

  // Append the new phone to the agent's PROVIDED values in the external agents
  // DB (never overwrites Courted; max_matches:1 refuses ambiguous keys rather
  // than fanning out to many agents). Match by license → email. Bounded, never
  // throws — a miss/timeout just means the number is stored locally only.
  const ext = await updateAgentContact({
    matchLicense: license_number,
    matchEmail: lead.email,
    phone,
  });

  return NextResponse.json({
    ok: true,
    matched: ext.ok ? ext.matched : 0,
    added: ext.ok ? ext.phoneUpdated : 0,
    external: ext.ok ? null : ext.error,
    phones,
    preferred,
  });
}

// PATCH — mark an existing number as preferred.
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
  const phone = parsed.data.phone;

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
  const seed = deriveDisplayPhone(cf);
  const prior = stringArray(cf.phones);
  const base = prior.length ? prior : seed ? [seed] : [];
  // The preferred must be one of the known numbers; add it if the client sent a
  // number we haven't stored yet (defensive — the UI only offers listed ones).
  const phones = dedupe([...base, phone]).slice(0, MAX_PHONES);
  const preferred =
    phones.find((p) => normPhone(p) === normPhone(phone)) ?? phone;

  // 1) Lead: set the dedicated preferred_phone key (future intros; migration 0072).
  const merged: Record<string, unknown> = { ...cf, phones, preferred_phone: preferred };
  const { error: upErr } = await admin
    .from("leads")
    .update({ custom_fields: merged })
    .eq("id", lead.lead_id);
  if (upErr) {
    return NextResponse.json({ ok: false, error: upErr.message }, { status: 400 });
  }

  // 2) Existing portal snapshots: update lead_phone for this lead's entries so
  //    already-introduced client portals reflect the preferred immediately.
  //    Same operation as the portal Edit dialog; scoped to this lead. Guarded —
  //    a failure here must not fail the whole action.
  let entriesUpdated = 0;
  try {
    const { data: rows, error: entErr } = await admin
      .from("client_pipeline_entries")
      .update({ lead_phone: preferred, updated_at: new Date().toISOString() })
      .eq("lead_id", lead.lead_id)
      .select("id");
    if (!entErr && Array.isArray(rows)) entriesUpdated = rows.length;
  } catch {
    // ignore — lead preferred is already saved; portals catch up on next intro.
  }

  // NOTE: no external agents-DB call here. The number was already appended to
  // the agent's provided values when it was ADDED (POST); marking it preferred
  // only changes what the client portal displays, so we never re-append it.

  return NextResponse.json({ ok: true, phones, preferred, entriesUpdated });
}
