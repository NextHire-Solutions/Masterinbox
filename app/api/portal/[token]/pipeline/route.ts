import { NextResponse, after } from "next/server";
import { z } from "zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { resolvePortalClient } from "@/lib/portals/token";
import { notifyIntroduction } from "@/lib/webhooks/n8n-introduction";
import { notifyPortalStageChange } from "@/lib/webhooks/slack-portal";
import { pushPipelineEntryToFub } from "@/lib/integrations/push-pipeline-entry";
import { clientHasFeature } from "@/lib/portals/feature-flags";

// POST /api/portal/[token]/pipeline — manually create a pipeline entry
// from the client portal. Used when the client wants to log an intro
// that didn't come through the inbox (cold reach-out, networking,
// etc.). The row has no thread_id and no external_intros backing.

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

const createSchema = z.object({
  lead_name: z.string().max(200).nullable().optional(),
  lead_email: z.string().email().max(200).nullable().optional(),
  lead_phone: z.string().max(80).nullable().optional(),
  current_brokerage: z.string().max(200).nullable().optional(),
  agent_profile_url: z.string().max(500).nullable().optional(),
  introduced_at: z.string().datetime().nullable().optional(),
  stage: z.enum(STAGES).optional(),
  needs_replacement: z.boolean().optional(),
});

const bulkSchema = z.object({
  action: z.enum(["delete", "stage", "assign"]),
  // 5000 ceiling — UI also chunks client-side to keep individual
  // requests well under any infrastructure timeout.
  ids: z.array(z.string().uuid()).min(1).max(5000),
  stage: z.enum(STAGES).optional(),
  // `assign` only — null clears the assignment on every id in the
  // batch; a uuid sets the same recruiter on all of them.
  assigned_team_member_id: z.string().uuid().nullable().optional(),
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

  const json = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const admin = createAdminSupabase();
  // Source split: when the client has the pipeline_source_split flag
  // turned on (Demo Portal today), manually-added leads land as
  // "Client Entry" so FUB records the right origin. Real clients
  // without the flag fall through to the column default
  // ('BrokerStaffer') by omitting `source` from the insert payload.
  // Behaviour for real clients is bit-identical to pre-flag — the
  // column was added in migration 0054 with a 'BrokerStaffer'
  // default, and we don't write to it unless the flag is on.
  const source = clientHasFeature(client, "pipeline_source_split")
    ? "Client Entry"
    : undefined;
  const row = {
    client_id: client.id,
    stage: parsed.data.stage ?? "introduction",
    needs_replacement: parsed.data.needs_replacement ?? false,
    lead_name: parsed.data.lead_name ?? null,
    lead_email: parsed.data.lead_email ?? null,
    lead_phone: parsed.data.lead_phone ?? null,
    current_brokerage: parsed.data.current_brokerage ?? null,
    agent_profile_url: parsed.data.agent_profile_url ?? null,
    introduced_at: parsed.data.introduced_at ?? new Date().toISOString(),
    ...(source ? { source } : {}),
  };
  const { data, error } = await admin
    .from("client_pipeline_entries")
    .insert(row)
    .select("id, source")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Stage → Introduction is observed by two downstream listeners.
  // Both run inside `after(...)` so the user's request returns
  // immediately and neither integration can break the other.
  if (row.stage === "introduction") {
    const entryId = data.id as string;
    // 1. n8n webhook — every introduction event.
    after(() => notifyIntroduction([entryId], "portal_add_lead"));
    // 2. Follow Up Boss auto-push — only if the client has connected
    //    their FUB account in Settings. Helper writes
    //    fub_last_error on failure rather than throwing.
    if (client.fub_api_key_set) {
      const clientId = client.id;
      after(async () => {
        try {
          await pushPipelineEntryToFub(clientId, entryId);
        } catch (err) {
          console.error("[fub] auto-push on create failed", err);
        }
      });
    }
  }

  // Return `source` so the client's optimistic row in
  // EditLeadDialog uses the value the server actually wrote
  // (Client Entry when pipeline_source_split is on, the default
  // 'BrokerStaffer' otherwise). Without this the optimistic chip
  // shows the wrong source until a full page load.
  return NextResponse.json({
    ok: true,
    id: data.id,
    source: (data as { source?: string }).source ?? "BrokerStaffer",
  });
}

// PATCH /api/portal/[token]/pipeline — bulk actions. Body chooses
// between delete and stage move, with `ids` listing affected entries.
// Each id is scoped to this client so cross-client tampering is moot.
export async function PATCH(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const client = await resolvePortalClient(token);
  if (!client) {
    return NextResponse.json({ error: "Portal not found" }, { status: 404 });
  }
  const parsed = bulkSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  const admin = createAdminSupabase();
  if (parsed.data.action === "delete") {
    const { error } = await admin
      .from("client_pipeline_entries")
      .delete()
      .eq("client_id", client.id)
      .in("id", parsed.data.ids);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  }
  if (parsed.data.action === "stage") {
    if (!parsed.data.stage) {
      return NextResponse.json({ error: "stage required" }, { status: 400 });
    }
    const newStage = parsed.data.stage;
    // Snapshot prior stages on the affected rows so the Slack
    // notification can show "from → to" per entry. Indexed read.
    const { data: priorRows } = await admin
      .from("client_pipeline_entries")
      .select("id, stage")
      .eq("client_id", client.id)
      .in("id", parsed.data.ids);
    const priorStageById = new Map<string, string | null>();
    for (const r of (priorRows ?? []) as Array<{ id: string; stage: string | null }>) {
      priorStageById.set(r.id, r.stage);
    }
    // .select("id") so downstream notifications only cover rows that
    // actually belong to this client (foreign ids fall out of the
    // update silently).
    const { data: updated, error } = await admin
      .from("client_pipeline_entries")
      .update({ stage: newStage, updated_at: new Date().toISOString() })
      .eq("client_id", client.id)
      .in("id", parsed.data.ids)
      .select("id");
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });

    // Slack: one message per actually-changed entry (skip rows that
    // were already on the target stage). Runs inside after() so the
    // user-visible response returns immediately.
    if (updated && updated.length > 0) {
      const entryIds = (updated as { id: string }[]).map((r) => r.id);
      const clientId = client.id;
      const transitioned = entryIds.filter(
        (eid) => priorStageById.get(eid) !== newStage,
      );
      if (transitioned.length > 0) {
        after(async () => {
          for (const eid of transitioned) {
            await notifyPortalStageChange({
              clientId,
              entryId: eid,
              fromStage: priorStageById.get(eid) ?? null,
              toStage: newStage,
            });
            // Polite pacing for Slack's 1/sec per-channel cap.
            await new Promise((r) => setTimeout(r, 120));
          }
        });
      }
    }

    if (newStage === "introduction" && updated && updated.length > 0) {
      const entryIds = (updated as { id: string }[]).map((r) => r.id);
      // 1. n8n webhook — fires for every entry in the batch.
      after(() => notifyIntroduction(entryIds, "portal_stage_change"));
      // 2. Follow Up Boss auto-push — same gate as the single PATCH:
      //    only entries whose fub_pushed_at is null and the client
      //    has connected. Sequential to keep FUB-side rate limits
      //    polite (~1 req/sec is well under the published cap).
      if (client.fub_api_key_set) {
        const clientId = client.id;
        after(async () => {
          try {
            const { data: pushable } = await admin
              .from("client_pipeline_entries")
              .select("id")
              .eq("client_id", clientId)
              .in("id", entryIds)
              .is("fub_pushed_at", null);
            for (const row of (pushable ?? []) as Array<{ id: string }>) {
              try {
                await pushPipelineEntryToFub(clientId, row.id);
              } catch (err) {
                console.error("[fub] bulk auto-push failed", row.id, err);
              }
            }
          } catch (err) {
            console.error("[fub] bulk auto-push setup failed", err);
          }
        });
      }
    }

    return NextResponse.json({ ok: true });
  }
  if (parsed.data.action === "assign") {
    // null is a valid value — it clears the assignment. zod's
    // optional+nullable lets `assigned_team_member_id` be undefined
    // OR explicitly null; treat undefined as "field missing" since
    // the caller has to be explicit about clearing.
    if (parsed.data.assigned_team_member_id === undefined) {
      return NextResponse.json(
        { error: "assigned_team_member_id required (use null to clear)" },
        { status: 400 },
      );
    }
    const { error } = await admin
      .from("client_pipeline_entries")
      .update({
        assigned_team_member_id: parsed.data.assigned_team_member_id,
        updated_at: new Date().toISOString(),
      })
      .eq("client_id", client.id)
      .in("id", parsed.data.ids);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
