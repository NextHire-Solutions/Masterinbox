// Outbound webhook notification for human-initiated Introductions.
//
// Fires POST(s) whenever a HUMAN marks a lead as Introduction — inbox
// label (single/bulk), portal Add Lead, or a portal stage move. AI
// auto-labeling is excluded by construction: the AI path (lib/ai/run.ts)
// writes label_assignments directly and never passes through the route
// handlers that call this helper. Do NOT move this into the
// client_pipeline_on_intro_label DB trigger — that trigger also fires
// for assigned_by='ai' and would re-include AI intros.
//
// Two independent destinations, both optional, both fire in parallel
// per pipeline entry:
//   1. N8N_INTRODUCTION_WEBHOOK_URL — legacy n8n workflow. Payload
//      shape is bit-identical to what it's always received.
//   2. BISON_INTRODUCTION_WEBHOOK_URL — Corofy orchestrator. Payload
//      is a superset of n8n: adds thread_id, campaign, introduced_at,
//      lead.title/location/custom_fields, client.slug/portal_url,
//      and assigned_recruiter.
// Either failing never affects the other; both failing never affects
// the caller — every fetch is wrapped in try/catch, and callers
// already invoke this inside next/server `after(...)`.
//
// N8N_INTRODUCTION_WEBHOOK_URL now points at the LoopMessage SMS
// notifier. It is only POSTed to for clients with SMS alerts on (the
// Client Portals page switch), with only the team members whose Team
// page SMS switch is on, marked approved; see lib/portals/team-sms.ts.
// Bison always gets the full team, whatever the SMS settings.

import { createAdminSupabase } from "@/lib/supabase/admin";
import { chunkedRun } from "@/lib/db/chunked-in";
import { env } from "@/lib/env";
import { publicPortalUrl } from "@/lib/portals/public-url";
import { loadSmsRecipients, smsBodyFor } from "@/lib/portals/team-sms";

export type IntroductionSource =
  | "inbox_label"
  | "inbox_bulk_label"
  | "portal_add_lead"
  | "portal_stage_change"
  | "portal_csv_upload";

// Embed shapes. Every field here maps to a REAL column on the
// underlying table — verified against the schema, not derived at
// render time. leads.phone / leads.email don't exist as columns
// (phone lives on cpe.lead_phone; email on cpe.lead_email); so
// nothing on this embed duplicates the pipeline-entry snapshot.
type LeadEmbed = {
  company: string | null;
  title: string | null;
  custom_fields: Record<string, unknown> | null;
};
type ClientEmbed = {
  id: string;
  name: string;
  slug: string | null;
  portal_token: string | null;
};
type RecruiterEmbed = {
  id: string;
  name: string | null;
};
// Threads carry the campaign snapshot (client_pipeline_entries does
// NOT). Embed the thread via cpe.thread_id and read campaign_name off
// that. Threads without a campaign hint (portal manual-add, etc.)
// come back with campaign_name null.
type ThreadEmbed = {
  campaign_name: string | null;
};

type PipelineRow = {
  id: string;
  client_id: string;
  stage: string;
  lead_name: string | null;
  lead_email: string | null;
  lead_phone: string | null;
  current_brokerage: string | null;
  thread_id: string | null;
  introduced_at: string | null;
  // Embedded relations come back as object or array depending on the
  // FK cardinality PostgREST infers — handle both (see portal-data.ts).
  leads: LeadEmbed | LeadEmbed[] | null;
  clients: ClientEmbed | ClientEmbed[] | null;
  assigned_team_member: RecruiterEmbed | RecruiterEmbed[] | null;
  threads: ThreadEmbed | ThreadEmbed[] | null;
};

function first<T>(v: T | T[] | null): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
}

// Notify n8n for the given client_pipeline_entries ids. Rows whose stage
// is not 'introduction' are skipped, so callers can pass ids without
// re-checking. One POST per entry.
export async function notifyIntroduction(
  entryIds: string[],
  source: IntroductionSource,
): Promise<void> {
  try {
    const n8nUrl = env.N8N_INTRODUCTION_WEBHOOK_URL;
    const bisonUrl = env.BISON_INTRODUCTION_WEBHOOK_URL;
    // Both unset = silent no-op. Same behaviour as before for the
    // n8n-only case; adds the Bison branch without cost.
    if ((!n8nUrl && !bisonUrl) || entryIds.length === 0) return;

    const admin = createAdminSupabase();

    // SELECT includes only fields that map to REAL columns on the
    // underlying tables (verified July 7 after the deployed
    // webhook was silently 400-ing on phantom columns like
    // client_pipeline_entries.lead_location,
    // client_pipeline_entries.campaign_name (lives on threads),
    // and leads.phone (lives on cpe.lead_phone).
    // The threads embed here is only used for campaign_name.
    const chunks = await chunkedRun(entryIds, (slice) =>
      admin
        .from("client_pipeline_entries")
        .select(
          "id, client_id, stage, lead_name, lead_email, lead_phone, current_brokerage, thread_id, introduced_at, leads:lead_id (company, title, custom_fields), clients:client_id (id, name, slug, portal_token), assigned_team_member:assigned_team_member_id (id, name), threads:thread_id (campaign_name)",
        )
        .in("id", slice),
    );
    const rows = chunks
      .flatMap((c) => (c.data ?? []) as PipelineRow[])
      .filter((r) => r.stage === "introduction");
    if (rows.length === 0) return;

    // One team query for all affected clients, grouped in memory.
    const clientIds = [...new Set(rows.map((r) => r.client_id))];
    const teamChunks = await chunkedRun(clientIds, (slice) =>
      admin
        .from("client_team_members")
        .select("client_id, name, phone")
        .in("client_id", slice)
        .eq("active", true)
        .not("phone", "is", null),
    );
    const teamByClient = new Map<string, { name: string; mobile: string }[]>();
    for (const chunk of teamChunks) {
      for (const m of (chunk.data ?? []) as {
        client_id: string;
        name: string;
        phone: string;
      }[]) {
        const list = teamByClient.get(m.client_id) ?? [];
        list.push({ name: m.name, mobile: m.phone });
        teamByClient.set(m.client_id, list);
      }
    }

    // Team-page SMS switches, for flagged clients only. Kept OUT of the
    // two selects above on purpose: they swallow errors, so a column
    // they can't find would silently stop every client's webhooks.
    const smsRecipients = n8nUrl ? await loadSmsRecipients(admin, clientIds) : null;

    const occurredAt = new Date().toISOString();
    await Promise.all(
      rows.map(async (row) => {
        const client = first(row.clients);
        const lead = first(row.leads);
        const recruiter = first(row.assigned_team_member);
        const thread = first(row.threads);
        const team = teamByClient.get(row.client_id) ?? [];
        const company = lead?.company || row.current_brokerage || null;
        const campaignName = thread?.campaign_name ?? null;

        // n8n payload — SAME shape as before (bit-identical keys).
        // Existing n8n workflows read exactly these fields.
        const n8nPayload = {
          event: "lead.introduction",
          occurred_at: occurredAt,
          source,
          pipeline_entry_id: row.id,
          lead: {
            name: row.lead_name,
            email: row.lead_email,
            company,
            phone: row.lead_phone,
          },
          client: { id: row.client_id, name: client?.name ?? null },
          team,
        };

        // Bison payload — additive superset. Everything the
        // orchestrator might want to route on / enrich with.
        // Only fields backed by real DB columns land here; if a
        // useful field can't be sourced without derivation, we
        // leave it out rather than silently ship null.
        const bisonPayload = {
          ...n8nPayload,
          thread_id: row.thread_id ?? null,
          introduced_at: row.introduced_at ?? null,
          campaign: campaignName ? { name: campaignName } : null,
          lead: {
            ...n8nPayload.lead,
            title: lead?.title ?? null,
            custom_fields: lead?.custom_fields ?? {},
          },
          client: {
            ...n8nPayload.client,
            slug: client?.slug ?? null,
            portal_url: publicPortalUrl(client?.portal_token ?? null),
          },
          assigned_recruiter: recruiter?.id
            ? { id: recruiter.id, name: recruiter.name }
            : null,
        };

        const targets: Array<{
          label: "n8n" | "bison";
          url: string;
          body: unknown;
        }> = [];
        // SMS notifier: only for clients with SMS alerts on, with only the
        // members switched on, marked approved. No POST otherwise: SMS off,
        // nobody switched on, or the settings couldn't be read. Bison is
        // never affected.
        if (n8nUrl) {
          const smsBody = smsBodyFor(n8nPayload, row.client_id, smsRecipients);
          if (smsBody) {
            targets.push({ label: "n8n", url: n8nUrl, body: smsBody });
          } else {
            console.log(
              `[n8n-introduction] no SMS for entry ${row.id}: SMS alerts off for this client, nobody switched on, or settings unreadable`,
            );
          }
        }
        // Bison / orchestrator ONLY fires when:
        //   (a) source is MasterInbox-originated (inbox_label or
        //       inbox_bulk_label). Portal-driven events
        //       (portal_add_lead, portal_stage_change,
        //       portal_csv_upload) intentionally do NOT hit Bison —
        //       those are the brokerage client acting inside their
        //       portal and the orchestrator only wants
        //       staff-triggered intros.
        //   (b) lead_email is set. The orchestrator requires a
        //       lead email to enrich / route; sending without one
        //       just wastes a POST. n8n keeps receiving every
        //       source and every lead as before.
        const isInboxSource =
          source === "inbox_label" || source === "inbox_bulk_label";
        const hasLeadEmail = Boolean(
          row.lead_email && row.lead_email.trim().length > 0,
        );
        if (bisonUrl && isInboxSource && hasLeadEmail) {
          targets.push({ label: "bison", url: bisonUrl, body: bisonPayload });
        }

        // Independent try/catch per target so a dead n8n never
        // affects Bison, and vice versa. Fire both in parallel —
        // typical 10s cap dominates wall-clock so serialising would
        // double the tail latency for no benefit.
        await Promise.all(
          targets.map(async (t) => {
            try {
              const res = await fetch(t.url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(t.body),
                signal: AbortSignal.timeout(10_000),
              });
              if (!res.ok) {
                console.error(
                  `[${t.label}-introduction] webhook responded ${res.status} for entry ${row.id}`,
                );
              }
            } catch (err) {
              console.error(
                `[${t.label}-introduction] webhook POST failed for entry ${row.id}:`,
                err,
              );
            }
          }),
        );
      }),
    );
  } catch (err) {
    console.error("[n8n-introduction] notify failed:", err);
  }
}

// Inbox paths know thread ids, not pipeline entry ids — the DB trigger
// (migration 0023) creates the pipeline row when the Introduction label
// lands. Resolve threads → entries here; threads without a pipeline row
// (e.g. no client_id) drop out naturally.
export async function notifyIntroductionForThreads(
  threadIds: string[],
  source: IntroductionSource,
): Promise<void> {
  try {
    // Same "either webhook configured?" gate as notifyIntroduction —
    // was previously n8n-only, now supports Bison too.
    if (
      (!env.N8N_INTRODUCTION_WEBHOOK_URL &&
        !env.BISON_INTRODUCTION_WEBHOOK_URL) ||
      threadIds.length === 0
    )
      return;
    const admin = createAdminSupabase();
    const chunks = await chunkedRun(threadIds, (slice) =>
      admin
        .from("client_pipeline_entries")
        .select("id")
        .in("thread_id", slice)
        .eq("stage", "introduction"),
    );
    const ids = chunks.flatMap((c) =>
      ((c.data ?? []) as { id: string }[]).map((r) => r.id),
    );
    await notifyIntroduction(ids, source);
  } catch (err) {
    console.error("[n8n-introduction] thread resolve failed:", err);
  }
}
