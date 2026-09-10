import { cache } from "react";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/db/paginated-select";

// Per-client data loaders for the portal expansion. Every query goes
// through the service-role admin client with a code-level client_id
// filter — same pattern as lib/portals/intro-leads.ts.

// Hosts whose URLs must never reach a client-facing portal — internal
// agent-sourcing tools (e.g. Courted) we don't expose to clients. Matched
// as a hostname substring so every subdomain (brokerage.courted.io) and any
// query string is covered. Applied at LOAD TIME only: the row in the DB, the
// inbox prospect panel, and the Follow Up Boss push all keep the raw value —
// this strips it purely from the portal payload the client sees.
const CONCEALED_PORTAL_URL_HOSTS = ["courted.io"] as const;
function isConcealedPortalUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const s = value.toLowerCase();
  return CONCEALED_PORTAL_URL_HOSTS.some((h) => s.includes(h));
}

export type PipelineStage =
  | "introduction"
  | "phone_screen_scheduled"
  | "phone_screen"
  // Added 2026-06-12, gated to Demo Portal only via the
  // "interview_scheduled_stage" feature flag (see
  // lib/portals/feature-flags.ts). Real clients use
  // visibleStagesFor() below, which omits this from every
  // dropdown / chip / legend they render, so the new stage stays
  // invisible to them until rollout is approved. The enum value
  // itself lives in Postgres (migration 0052) so the type can
  // include it safely.
  | "interview_scheduled"
  | "interview"
  | "hired"
  | "keep_warm"
  | "we_they_rejected"
  | "no_show";

export interface PipelineNote {
  id: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface PipelineEntry {
  id: string;
  stage: PipelineStage;
  // Display-only overlay (manage_stages): when set, the entry renders in this
  // custom stage instead of its canonical `stage`. Always null for real clients
  // (they never set it) and for any entry sitting on a canonical stage.
  custom_stage_key: string | null;
  needs_replacement: boolean;
  lead_name: string | null;
  lead_email: string | null;
  lead_phone: string | null;
  current_brokerage: string | null;
  agent_profile_url: string | null;
  // Derived at load time from the lead's enrichment payload — surfaced
  // as separate columns so the row template can render them without
  // each component hunting through custom_fields.
  lead_location: string | null;
  introduced_at: string | null;
  // Full Instantly enrichment payload for the lead detail side-panel.
  // null when the entry was triggered by a label assignment (no
  // external_intros row backed it).
  lead_detail: Record<string, unknown> | null;
  // Keys in custom_fields that exist ONLY as per-entry overrides — i.e. fields
  // a user added manually, not present in the shared Bison/Instantly
  // enrichment. These are the only custom fields safe to DELETE (removing an
  // enrichment override would just revert to the source value). Omitted/empty
  // for legacy rows.
  manual_custom_field_keys?: string[];
  campaign_name: string | null;
  // FK to threads.id. Populated by the Introduction-label trigger
  // and by the external_intros backfill (migration 0023/0027). Null
  // for entries the operator added manually from the portal — those
  // have no email thread to show, so the "View conversation" button
  // is gated off this.
  thread_id: string | null;
  // Timestamped notes (newest first). Backed by client_pipeline_notes.
  notes_log: PipelineNote[];
  // Recruiter ownership — points at a row in client_team_members
  // (the intro-notification roster). null = unassigned.
  // assigned_team_member is the joined display tuple, fetched in the
  // same SELECT so the row UI doesn't need a second hop.
  assigned_team_member_id: string | null;
  assigned_team_member: { id: string; name: string } | null;
  // Follow Up Boss push state. Set when the entry has been
  // successfully pushed (auto or manual). fub_last_error captures
  // the most recent failure so the row can surface "Push failed:
  // <reason>". The actual API key lives on the client row, not here.
  fub_event_id: string | null;
  fub_pushed_at: string | null;
  fub_last_error: string | null;
  // Origin tag forwarded to FollowUpBoss as the event source.
  // "BrokerStaffer" = lead came from Nicole's intros (the historical
  // default, what every legacy row carries). "Client Entry" = lead
  // the client added themselves via the portal (manual form or CSV
  // upload). Backed by client_pipeline_entries.source (migration
  // 0054), non-null with a 'BrokerStaffer' default so the value is
  // safe to read everywhere without null-handling.
  source: string;
}

export interface DncEntry {
  id: string;
  kind: "agent" | "company";
  name: string;
  email: string | null;
  phone: string | null;
  brokerage: string | null;
  // Company rows carry a normalized blocked domain (added in 0032);
  // agent rows leave this null.
  domain: string | null;
  notes: string | null;
  added_by: string;
  pushed_to_instantly: boolean;
  pushed_to_emailbison: boolean;
  push_error: string | null;
  created_at: string;
}

export interface AgentEntry {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  license: string | null;
  pushed_to_instantly: boolean;
  pushed_to_emailbison: boolean;
  push_error: string | null;
  created_at: string;
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  title: string | null;
  phone: string | null;
  receives: "intro" | "digest" | "admin";
  active: boolean;
  avatar_url: string | null;
  // Legacy columns from when Team was a second blocklist. We don't
  // write them anymore but the rows still exist; kept on the type so
  // existing data deserialises cleanly. Safe to drop in a future
  // schema cleanup.
  pushed_to_instantly: boolean;
  pushed_to_emailbison: boolean;
  push_error: string | null;
  created_at: string;
}

// Each loader is wrapped in cache() so a single render can fetch them
// once even when several components ask. The portal layout intentionally
// only loads counts; per-page reads happen in the page itself.

export const loadPipelineEntries = cache(
  async (clientId: string): Promise<PipelineEntry[]> => {
    const admin = createAdminSupabase();
    // Pull the pipeline rows + the enriched lead_detail / campaign_name
    // from external_intros via the FK + the lead's custom_fields (so we
    // can derive location/company/website when the snapshot columns are
    // empty). PostgREST flattens these joined rows into nested objects.
    const { data, error } = await admin
      .from("client_pipeline_entries")
      .select(
        "id, stage, custom_stage_key, needs_replacement, lead_name, lead_email, lead_phone, current_brokerage, agent_profile_url, introduced_at, thread_id, assigned_team_member_id, fub_event_id, fub_pushed_at, fub_last_error, source, custom_fields_overrides, assigned_team_member:assigned_team_member_id (id, name), external_intros:external_intro_id (lead_detail, campaign_name), leads:lead_id (custom_fields, company)",
      )
      .eq("client_id", clientId)
      .order("introduced_at", { ascending: false })
      .range(0, 9_999);
    if (error || !data) return [];

    // Second hop: fetch all timestamped notes for the visible entries in
    // one batched query.
    const entryIds = (data as Array<{ id: string }>).map((r) => r.id);
    const notesByEntry = new Map<string, PipelineNote[]>();
    if (entryIds.length > 0) {
      const { data: noteRows } = await admin
        .from("client_pipeline_notes")
        .select("id, entry_id, body, created_at, updated_at")
        .in("entry_id", entryIds)
        .order("created_at", { ascending: false })
        .range(0, 9_999);
      for (const n of (noteRows ?? []) as Array<PipelineNote & { entry_id: string }>) {
        const arr = notesByEntry.get(n.entry_id) ?? [];
        arr.push({ id: n.id, body: n.body, created_at: n.created_at, updated_at: n.updated_at });
        notesByEntry.set(n.entry_id, arr);
      }
    }

    return (data as unknown as Array<
      Omit<
        PipelineEntry,
        | "lead_detail"
        | "campaign_name"
        | "notes_log"
        | "lead_location"
        | "assigned_team_member"
      > & {
        external_intros:
          | { lead_detail: Record<string, unknown> | null; campaign_name: string | null }
          | { lead_detail: Record<string, unknown> | null; campaign_name: string | null }[]
          | null;
        leads:
          | { custom_fields: Record<string, unknown> | null; company: string | null }
          | { custom_fields: Record<string, unknown> | null; company: string | null }[]
          | null;
        assigned_team_member:
          | { id: string; name: string }
          | { id: string; name: string }[]
          | null;
      }
    >).map((r) => {
      // PostgREST returns the joined row as either a single object or an
      // array depending on cardinality config. Normalise to scalar.
      const ext = Array.isArray(r.external_intros)
        ? r.external_intros[0] ?? null
        : r.external_intros;
      const lead = Array.isArray(r.leads) ? r.leads[0] ?? null : r.leads;
      const cf = (lead?.custom_fields ?? {}) as Record<string, unknown>;
      const extCf = ((ext?.lead_detail as { custom_fields?: Record<string, unknown> } | null)
        ?.custom_fields ?? {}) as Record<string, unknown>;
      // Client-authored per-entry overrides (migration 0057) win over
      // the raw Bison/Instantly enrichment. `?? {}` so a pre-migration
      // row (or a null column) is a no-op — display stays byte-identical
      // to before overrides existed.
      const overrides =
        ((r as { custom_fields_overrides?: Record<string, unknown> | null })
          .custom_fields_overrides ?? {}) as Record<string, unknown>;
      const merged = { ...cf, ...extCf, ...overrides };
      // Portal privacy: drop any custom field whose value points at a
      // concealed host (e.g. courted.io) so no portal surface — the profile
      // link, the editable field grid, the detail drawer — can render it.
      // Only URL-style values match; phone / location / company are untouched.
      for (const k of Object.keys(merged)) {
        if (isConcealedPortalUrl(merged[k])) delete merged[k];
      }
      // Keys present ONLY in the per-entry overrides (absent from both base
      // enrichment sources) are fields the user added manually — the only
      // ones safe to offer for deletion.
      const baseCustomFieldKeys = new Set(
        [...Object.keys(cf), ...Object.keys(extCf)].map((k) => k.toLowerCase()),
      );
      const manualCustomFieldKeys = Object.keys(overrides).filter(
        (k) => !baseCustomFieldKeys.has(k.toLowerCase()),
      );
      const pickStr = (...keys: string[]) => {
        for (const k of keys) {
          const v = merged[k];
          if (v == null) continue;
          const s = String(v).trim();
          if (s && s !== "null" && s !== "undefined") return s;
        }
        return null;
      };

      const {
        external_intros: _ignore1,
        leads: _ignore2,
        assigned_team_member: assignedRaw,
        ...rest
      } = r;
      void _ignore1;
      void _ignore2;
      const assignedTeamMember = Array.isArray(assignedRaw)
        ? assignedRaw[0] ?? null
        : assignedRaw;

      return {
        ...rest,
        current_brokerage:
          rest.current_brokerage ||
          lead?.company ||
          pickStr("companyName", "company", "company_name", "Company", "current_brokerage", "brokerage"),
        agent_profile_url:
          (isConcealedPortalUrl(rest.agent_profile_url)
            ? null
            : rest.agent_profile_url) ||
          pickStr("Agent Profile", "agentProfile", "agent_profile", "website", "Website", "url"),
        lead_location: pickStr(
          "location",
          "Location",
          "city",
          "City",
          "address",
          "Address",
          "market",
          "Market",
        ),
        // Thread the MERGED custom_fields (leads.custom_fields ∪
        // external_intros.lead_detail.custom_fields) so the expanded
        // candidate card surfaces extras for BOTH lead sources:
        //
        //   • legacy external-intros feed → already carried them via
        //     ext.lead_detail.custom_fields.
        //   • Instantly-webhook leads → previously dropped here because
        //     ext.lead_detail was null. Now they ride through.
        //
        // The expanded card's dedup loop skips email/phone/company/
        // title/location, so City, State, LicenseNumber, AgencyZip,
        // Last12Mos_*, etc., render automatically.
        lead_detail: ext?.lead_detail
          ? { ...ext.lead_detail, custom_fields: merged }
          : { custom_fields: merged },
        manual_custom_field_keys: manualCustomFieldKeys,
        campaign_name: ext?.campaign_name ?? null,
        notes_log: notesByEntry.get(rest.id) ?? [],
        assigned_team_member: assignedTeamMember,
      } satisfies PipelineEntry;
    });
  },
);

// Three list loaders. Each pages past Supabase's server-side
// db-max-rows=1000 cap via fetchAllRows — a single .range(0, N)
// call does NOT lift it (the server replies Content-Range: 0-999/N
// no matter what range the client asks for). Without paging, a
// brokerage that imports a 3,400-row CSV only ever sees the first
// 1,000 rows in the UI even though the inserts succeeded.
//
// Each loader keeps its own ordering. fetchAllRows preserves the
// per-window ORDER BY across the concatenated result.

export const loadDncEntries = cache(
  async (clientId: string): Promise<DncEntry[]> => {
    const admin = createAdminSupabase();
    try {
      return await fetchAllRows<DncEntry>(({ from, to }) =>
        admin
          .from("client_dnc_entries")
          .select(
            "id, kind, name, email, phone, brokerage, domain, notes, added_by, pushed_to_instantly, pushed_to_emailbison, push_error, created_at",
          )
          .eq("client_id", clientId)
          .order("created_at", { ascending: false })
          .range(from, to),
      );
    } catch (err) {
      console.error("[loadDncEntries] failed", err);
      return [];
    }
  },
);

export const loadAgentEntries = cache(
  async (clientId: string): Promise<AgentEntry[]> => {
    const admin = createAdminSupabase();
    try {
      return await fetchAllRows<AgentEntry>(({ from, to }) =>
        admin
          .from("client_agents")
          .select(
            "id, name, email, phone, license, pushed_to_instantly, pushed_to_emailbison, push_error, created_at",
          )
          .eq("client_id", clientId)
          .order("created_at", { ascending: false })
          .range(from, to),
      );
    } catch (err) {
      console.error("[loadAgentEntries] failed", err);
      return [];
    }
  },
);

export const loadTeamMembers = cache(
  async (clientId: string): Promise<TeamMember[]> => {
    const admin = createAdminSupabase();
    try {
      return await fetchAllRows<TeamMember>(({ from, to }) =>
        admin
          .from("client_team_members")
          .select(
            "id, name, email, title, phone, receives, active, avatar_url, pushed_to_instantly, pushed_to_emailbison, push_error, created_at",
          )
          .eq("client_id", clientId)
          .order("created_at", { ascending: true })
          .range(from, to),
      );
    } catch (err) {
      console.error("[loadTeamMembers] failed", err);
      return [];
    }
  },
);

// Counts for the admin overview and the portal sidebar pills. One RPC
// call returns all four counts in a single round-trip — the SQL lives in
// migration 0025 (portal_counts). Cached per-render so the layout +
// page can share the same numbers without re-asking.
export const loadPortalCounts = cache(
  async (clientId: string) => {
    const admin = createAdminSupabase();
    const { data, error } = await admin
      .rpc("portal_counts", { client_uuid: clientId })
      .single();
    if (error || !data) {
      return { pipeline: 0, dnc: 0, agents: 0, team: 0 };
    }
    const row = data as {
      pipeline: number | null;
      dnc: number | null;
      agents: number | null;
      team: number | null;
    };
    return {
      pipeline: row.pipeline ?? 0,
      dnc: row.dnc ?? 0,
      agents: row.agents ?? 0,
      team: row.team ?? 0,
    };
  },
);

// Default display labels for the pipeline stage enum. The enum
// values (keep_warm, we_they_rejected) stay frozen in the database
// to avoid a destructive migration; only the user-facing copy
// changes here.
//
// Each client can override any subset of these via the editor on
// the Recruiting Pipeline page — overrides land in
// `clients.stage_label_overrides` (jsonb) and the UI reads the
// merged map through resolveStageLabels() + the StageLabelsProvider
// context in [components/portals/stage-labels-context.tsx]. Anything
// not overridden falls back to the value here.
export const DEFAULT_STAGE_LABELS: Record<PipelineStage, string> = {
  introduction: "Introduction",
  phone_screen_scheduled: "Phone Screen Scheduled",
  phone_screen: "Phone Screen",
  interview_scheduled: "Interview Scheduled",
  interview: "Interview",
  hired: "Hired",
  keep_warm: "Nurture",
  we_they_rejected: "Not a Fit",
  no_show: "No Response",
};

// Hard cap on a custom label length. Keeps the badges, dropdowns,
// and bulk-action menu from blowing out their column widths.
export const STAGE_LABEL_MAX_LEN = 40;

// Merge per-client overrides over the defaults. Unknown keys and
// empty / whitespace values are ignored so a stale or malformed
// JSON blob can never blank out a label or sneak in a bogus stage.
// Values are trimmed and capped to STAGE_LABEL_MAX_LEN so a very
// long override can't break the layout.
export function resolveStageLabels(
  overrides: Record<string, unknown> | null | undefined,
): Record<PipelineStage, string> {
  const merged: Record<PipelineStage, string> = { ...DEFAULT_STAGE_LABELS };
  if (!overrides || typeof overrides !== "object") return merged;
  for (const stage of STAGE_ORDER) {
    const raw = (overrides as Record<string, unknown>)[stage];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    merged[stage] = trimmed.slice(0, STAGE_LABEL_MAX_LEN);
  }
  return merged;
}

// One-line definitions surfaced in the pipeline legend so clients
// understand what each stage means without asking. Order tracks
// STAGE_ORDER below.
export const STAGE_DESCRIPTIONS: Record<PipelineStage, string> = {
  introduction:
    "An agent has been introduced to you and initial contact has been made.",
  phone_screen_scheduled:
    "A phone screen has been booked with the agent — they haven't been screened yet.",
  phone_screen:
    "The phone screen has happened. You're evaluating the agent before moving to a full interview.",
  interview_scheduled:
    "An interview has been booked with the agent. The interview itself hasn't happened yet.",
  interview:
    "The interview has happened, or is being scheduled for an in-person / longer conversation.",
  hired: "The agent has accepted and is joining your team.",
  keep_warm:
    "The agent is interested but not ready to move forward yet. We stay in touch and re-engage at the right time.",
  we_they_rejected:
    "The agent was not a fit, the interview did not meet expectations, or the agent decided not to move forward.",
  no_show:
    "The agent did not attend the scheduled phone screen or interview.",
};

export const STAGE_ORDER: PipelineStage[] = [
  "introduction",
  "phone_screen_scheduled",
  "phone_screen",
  "interview_scheduled",
  "interview",
  "hired",
  "keep_warm",
  "we_they_rejected",
  "no_show",
];

// Per-client visible stages. Filters out stages that are still
// feature-flagged off for this client. Use this anywhere the UI
// renders a stage list (dropdowns, chips, legend, filter pills,
// label editor). The canonical full set in STAGE_ORDER stays
// untouched so `Record<PipelineStage, T>` initialisers and
// exhaustiveness checks keep working.
//
// Today's only gate: `interview_scheduled` is hidden until a
// client carries feature_flags.interview_scheduled_stage = true.
// Default for every existing client is no flag set, so they keep
// seeing the same eight stages as before this change.
export function visibleStagesFor(
  client: { feature_flags?: Record<string, unknown> | null } | null | undefined,
): PipelineStage[] {
  const flags = client?.feature_flags;
  const hasInterviewScheduled =
    flags && typeof flags === "object"
      ? Boolean((flags as Record<string, unknown>).interview_scheduled_stage)
      : false;
  if (hasInterviewScheduled) return STAGE_ORDER;
  return STAGE_ORDER.filter((s) => s !== "interview_scheduled");
}

// Build a labels map safe to ship across the server→client boundary
// as a React prop. Stages that are NOT in `visibleStages` get their
// user-facing label replaced with the raw enum key (e.g.
// "interview_scheduled" instead of "Interview Scheduled"). The
// Record<PipelineStage, string> shape is preserved so every
// downstream lookup keeps working without conditional handling.
//
// Why: Next.js serialises every server-rendered client component's
// props into a `<script>` payload for hydration. If we pass the
// full `Record<PipelineStage, string>` down to PipelineBoard /
// StageLabelsProvider, the hidden stage's HUMAN label leaks into
// View Source on every real client portal. Replacing the label
// with the enum key keeps that string out of the SSR'd HTML
// entirely — anyone curling the page sees `interview_scheduled` as
// the value, not the polished "Interview Scheduled" copy. Demo Portal
// (the only client with the flag) still receives the full labels.
export function safeStageLabelsFor(
  fullLabels: Record<PipelineStage, string>,
  visibleStages: PipelineStage[],
): Record<PipelineStage, string> {
  const visible = new Set(visibleStages);
  const out = {} as Record<PipelineStage, string>;
  for (const stage of STAGE_ORDER) {
    out[stage] = visible.has(stage) ? fullLabels[stage] : stage;
  }
  return out;
}
