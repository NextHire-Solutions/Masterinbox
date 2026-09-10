import { NextResponse, after } from "next/server";
import { z } from "zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { resolvePortalClient } from "@/lib/portals/token";
import { notifyIntroduction } from "@/lib/webhooks/n8n-introduction";
import { notifyPortalStageChange } from "@/lib/webhooks/slack-portal";
import { pushPipelineEntryToFub } from "@/lib/integrations/push-pipeline-entry";
import { clientHasFeature } from "@/lib/portals/feature-flags";
import {
  MANAGE_STAGES_FLAG,
  GLOBAL_CUSTOM_STAGE_KEYS,
} from "@/lib/portals/stage-config";

// PATCH /api/portal/[token]/pipeline/[id]
// DELETE /api/portal/[token]/pipeline/[id]
//
// The token IS the credential. We resolve it to a client_id and only
// permit reads / writes on pipeline rows that belong to that client.
// The portal expansion lets the client edit identity fields too
// (manual leads), so the schema accepts more than just stage moves.

export const dynamic = "force-dynamic";

const STAGES = [
  "introduction",
  "phone_screen_scheduled",
  "phone_screen",
  "interview_scheduled",
  "interview",
  "hired",
  "keep_warm",
  "we_they_rejected",
  "no_show",
] as const;

const schema = z.object({
  stage: z.enum(STAGES).optional(),
  // Display-only custom-stage placement (manage_stages / Demo). Ignored for real
  // clients (the handler is gated). Never written as a column for anyone else —
  // it's pulled out of columnPatch below and only used in the gated block.
  custom_stage_key: z.string().max(64).nullable().optional(),
  needs_replacement: z.boolean().optional(),
  lead_name: z.string().max(200).nullable().optional(),
  lead_email: z.string().email().max(200).nullable().optional(),
  lead_phone: z.string().max(80).nullable().optional(),
  current_brokerage: z.string().max(200).nullable().optional(),
  agent_profile_url: z.string().max(500).nullable().optional(),
  introduced_at: z.string().datetime().nullable().optional(),
  // Recruiter ownership — points at a client_team_members row.
  // null clears the assignment. FK is ON DELETE SET NULL so a deleted
  // team member unassigns automatically.
  assigned_team_member_id: z.string().uuid().nullable().optional(),
  // Client-authored overrides for the raw Bison/Instantly enrichment
  // fields (Sales Volume, MLS Affiliation, etc.). A partial map of
  // key → new string value. Merged (not replaced) into the entry's
  // custom_fields_overrides JSONB — sending {"Sales Volume": "$5M"}
  // sets only that key and leaves the rest of the map intact. Bounded
  // so a malformed payload can't bloat the row: ≤ 60 keys, keys ≤ 120
  // chars, values ≤ 2000 chars. Empty-string value blanks the field
  // (override wins → shows empty); to fully revert to the Bison
  // value a future "reset" affordance would delete the key.
  custom_fields: z
    .record(z.string().max(120), z.string().max(2000))
    .refine((m) => Object.keys(m).length <= 60, {
      message: "Too many custom fields",
    })
    .optional(),
  // Keys to DELETE from the override map — fields the user added manually and
  // then removed. Additive to custom_fields (both may appear in one request);
  // deleting a key the client never overrode is a harmless no-op.
  custom_fields_remove: z.array(z.string().max(120)).max(60).optional(),
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

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const admin = createAdminSupabase();

  // Separate the custom-field override patch from the plain column
  // edits — it targets the custom_fields_overrides JSONB, not a
  // same-named column, and is merged (not replaced) so partial edits
  // don't wipe previously-overridden keys.
  const {
    custom_fields: customFieldsPatch,
    custom_fields_remove: customFieldsRemove,
    custom_stage_key: customStageKey,
    ...columnPatch
  } = parsed.data;

  const manageStages = clientHasFeature(client, MANAGE_STAGES_FLAG);

  // Custom-stage placement (manage_stages / Demo only): a DISPLAY-ONLY move into a
  // custom column. Sets the overlay pointer, never the enum `stage`, and fires NO
  // side-effects (no Slack / n8n / FUB). Real clients never reach this (gated), and
  // custom_stage_key is excluded from columnPatch above so it's never written for them.
  if (manageStages && customStageKey !== undefined) {
    if (customStageKey !== null) {
      // The two global "no show" stages are valid for every client without a
      // stored row; any other custom key must exist in the client's own rows.
      const isGlobal = (GLOBAL_CUSTOM_STAGE_KEYS as readonly string[]).includes(
        customStageKey,
      );
      if (!isGlobal) {
        const { data: st } = await admin
          .from("client_pipeline_stages")
          .select("key")
          .eq("client_id", client.id)
          .eq("kind", "custom")
          .eq("key", customStageKey)
          .maybeSingle();
        if (!st) {
          return NextResponse.json({ error: "Unknown custom stage" }, { status: 400 });
        }
      }
    }
    const { error: cErr } = await admin
      .from("client_pipeline_entries")
      .update({ custom_stage_key: customStageKey, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("client_id", client.id);
    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  // Snapshot pre-update stage so the Slack notification can show
  // "from → to". One row, indexed lookup — negligible cost. Reading
  // BEFORE the update is the only way; the UPDATE…RETURNING shape
  // PostgREST exposes only returns post-image columns.
  let priorStage: string | null = null;
  if (parsed.data.stage !== undefined) {
    const { data: prior } = await admin
      .from("client_pipeline_entries")
      .select("stage")
      .eq("id", id)
      .eq("client_id", client.id)
      .maybeSingle();
    priorStage = (prior?.stage as string | null) ?? null;
  }

  const patch: Record<string, unknown> = { ...columnPatch, updated_at: new Date().toISOString() };

  // A canonical stage move clears any custom-stage overlay (manage_stages only, so
  // the column write never happens for real clients).
  if (manageStages && parsed.data.stage !== undefined) {
    patch.custom_stage_key = null;
  }

  // Read-modify-write the overrides map when a custom-field patch is
  // present: load the current map, shallow-merge the patch on top
  // (patch wins), and include the merged result in the single UPDATE
  // below. Scoped by id + client_id so one client can never touch
  // another's entry.
  const hasCfPatch = customFieldsPatch && Object.keys(customFieldsPatch).length > 0;
  const hasCfRemove = customFieldsRemove && customFieldsRemove.length > 0;
  if (hasCfPatch || hasCfRemove) {
    const { data: cur } = await admin
      .from("client_pipeline_entries")
      .select("custom_fields_overrides")
      .eq("id", id)
      .eq("client_id", client.id)
      .maybeSingle();
    const map: Record<string, unknown> = {
      ...((cur?.custom_fields_overrides as Record<string, unknown> | null) ?? {}),
    };
    if (hasCfPatch) Object.assign(map, customFieldsPatch);
    if (hasCfRemove) {
      for (const k of customFieldsRemove) delete map[k];
    }
    patch.custom_fields_overrides = map;
  }
  const { data, error } = await admin
    .from("client_pipeline_entries")
    .update(patch)
    .eq("id", id)
    .eq("client_id", client.id)
    .select("id, stage, fub_pushed_at")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!data) return NextResponse.json({ error: "Entry not found" }, { status: 404 });

  // Notify Slack on any stage transition (Hired routes to its own
  // channel inside the helper). Fires only when stage actually
  // changed, not when the operator PATCH'd only a name/email/etc.
  if (
    parsed.data.stage !== undefined &&
    priorStage !== (data.stage as string)
  ) {
    const entryId = data.id as string;
    const fromStage = priorStage;
    const toStage = data.stage as string;
    const clientId = client.id;
    after(() =>
      notifyPortalStageChange({
        clientId,
        entryId,
        fromStage,
        toStage,
      }),
    );
  }

  // Stage → Introduction is a meaningful event for two downstream
  // listeners. Both run inside `after(...)` so the user's request
  // returns immediately and neither integration can break the other.
  if (data.stage === "introduction") {
    const entryId = data.id as string;
    // 1. Notify the n8n webhook (every introduction, no dedup —
    //    that's the operator's contract with n8n).
    after(() => notifyIntroduction([entryId], "portal_stage_change"));
    // 2. Push to the client's Follow Up Boss account, if connected
    //    AND we haven't already pushed this entry. Failures land on
    //    fub_last_error inside the helper, never throw out here.
    if (!data.fub_pushed_at && client.fub_api_key_set) {
      const clientId = client.id;
      after(async () => {
        try {
          await pushPipelineEntryToFub(clientId, entryId);
        } catch (err) {
          console.error("[fub] auto-push failed", err);
        }
      });
    }
  }

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
  const { error } = await admin
    .from("client_pipeline_entries")
    .delete()
    .eq("id", id)
    .eq("client_id", client.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
