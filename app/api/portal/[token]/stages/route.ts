import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { resolvePortalClient } from "@/lib/portals/token";
import { clientHasFeature } from "@/lib/portals/feature-flags";
import { STAGE_ORDER, STAGE_LABEL_MAX_LEN } from "@/lib/portals/portal-data";
import { MANAGE_STAGES_FLAG, STAGE_COLOR_PALETTE } from "@/lib/portals/stage-config";

// PATCH /api/portal/[token]/stages
//
// Save a client's custom pipeline-stage configuration (create / rename / reorder /
// hide / delete). GATED to the `manage_stages` feature (Demo Portal only) — real
// clients get a 404 and their pipeline is completely unaffected.
//
// SAFETY: this writes ONLY the `client_pipeline_stages` overlay table. It never
// touches the `pipeline_stage` enum, the entries' canonical `stage`, or any
// trigger/webhook. Deleting a custom stage first clears `custom_stage_key` on its
// entries (they revert to showing at their canonical stage) — no data is lost and
// no funnel/webhook fires.

export const dynamic = "force-dynamic";

const CANONICAL = new Set<string>(STAGE_ORDER);
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const PALETTE = new Set<string>(STAGE_COLOR_PALETTE);

const stageSchema = z.object({
  key: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(STAGE_LABEL_MAX_LEN),
  color: z.string().trim().max(9).nullable().optional(),
  kind: z.enum(["canonical", "custom"]),
  canonical_stage: z.string().trim().nullable().optional(),
  hidden: z.boolean().optional().default(false),
});
const bodySchema = z.object({ stages: z.array(stageSchema).min(1).max(30) });

export async function PATCH(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const client = await resolvePortalClient(token);
  if (!client) return NextResponse.json({ error: "Portal not found" }, { status: 404 });

  // Hard gate: feature off → behave as if the route doesn't exist.
  if (!clientHasFeature(client, MANAGE_STAGES_FLAG)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  const stages = parsed.data.stages;

  // ---- Structural validation (never lose a canonical stage, no dupes) ----
  const keys = new Set<string>();
  const seenCanonical = new Set<string>();
  for (const s of stages) {
    if (keys.has(s.key)) {
      return NextResponse.json({ error: `Duplicate stage key: ${s.key}` }, { status: 400 });
    }
    keys.add(s.key);
    if (s.color != null && s.color !== "" && !HEX_RE.test(s.color) && !PALETTE.has(s.color)) {
      return NextResponse.json({ error: `Invalid color: ${s.color}` }, { status: 400 });
    }
    if (s.kind === "canonical") {
      if (!s.canonical_stage || !CANONICAL.has(s.canonical_stage)) {
        return NextResponse.json({ error: `Invalid canonical stage: ${s.key}` }, { status: 400 });
      }
      if (s.key !== s.canonical_stage) {
        return NextResponse.json({ error: `Canonical key must equal its stage: ${s.key}` }, { status: 400 });
      }
      seenCanonical.add(s.canonical_stage);
    } else {
      if (s.canonical_stage) {
        return NextResponse.json({ error: `Custom stage cannot map to an enum stage: ${s.key}` }, { status: 400 });
      }
    }
  }
  // All canonical stages must be present exactly once — they can be hidden but
  // never removed (they carry the introduction/hired/no_show side-effects).
  for (const c of STAGE_ORDER) {
    if (!seenCanonical.has(c)) {
      return NextResponse.json({ error: `Missing canonical stage: ${c}` }, { status: 400 });
    }
  }

  const admin = createAdminSupabase();
  const now = new Date().toISOString();

  // ---- Reassign entries off any custom stage being REMOVED, then delete it ----
  // (Canonical stages are never removed.) This clears the display pointer so those
  // entries fall back to their canonical stage; no enum/funnel change.
  try {
    const { data: existing } = await admin
      .from("client_pipeline_stages")
      .select("key, kind")
      .eq("client_id", client.id);
    const desired = new Set(stages.map((s) => s.key));
    const removedCustom = (existing ?? [])
      .filter((r) => r.kind === "custom" && !desired.has(r.key as string))
      .map((r) => r.key as string);
    if (removedCustom.length > 0) {
      await admin
        .from("client_pipeline_entries")
        .update({ custom_stage_key: null, updated_at: now })
        .eq("client_id", client.id)
        .in("custom_stage_key", removedCustom);
      await admin
        .from("client_pipeline_stages")
        .delete()
        .eq("client_id", client.id)
        .in("key", removedCustom);
    }
  } catch {
    // best-effort cleanup; the upsert below is the source of truth
  }

  // ---- Upsert the desired set (sort_order = array index) ----
  const rows = stages.map((s, i) => ({
    client_id: client.id,
    key: s.key,
    label: s.label,
    color: s.color && s.color !== "" ? s.color : null,
    sort_order: i,
    kind: s.kind,
    canonical_stage: s.kind === "canonical" ? s.canonical_stage : null,
    hidden: s.hidden ?? false,
    updated_at: now,
  }));
  const { error } = await admin
    .from("client_pipeline_stages")
    .upsert(rows, { onConflict: "client_id,key" });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, count: rows.length });
}
