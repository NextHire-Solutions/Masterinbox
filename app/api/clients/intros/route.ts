import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/workspace";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/db/paginated-select";
import { DEFAULT_STAGE_LABELS } from "@/lib/portals/portal-data";
import { env } from "@/lib/env";

// GET /api/clients/intros[?label=Introduction]
//
// Returns one row per intro EVENT (label_assignments row), not per-client
// aggregates. Use this when the consumer needs to bucket by week itself
// — bucketing on the client side means we don't re-call the API on
// every "previous week" navigation, and the same payload also drives
// "last intro X days ago" without a second endpoint.
//
// Required fields per row:
//   - client_name : the matching BrokerStaffer client display name
//   - assigned_at : ISO 8601 UTC timestamp the label landed on the thread
//
// Nice-to-have fields included (consumer can ignore):
//   - client_slug, client_id, thread_id, lead_email, lead_name,
//     campaign_id, campaign_name
//
// Sort: most-recent assignment first.
//
// Auth: normal user session OR `?token=<SUPABASE_SERVICE_ROLE_KEY>` /
// `x-admin-token: ...` header (skipping requires the proxy-level bypass
// which is already wired for any token-bearing /api/* request).

export const dynamic = "force-dynamic";
// Belt + suspenders vs Next.js's Data Cache. `force-dynamic` above
// only disables the route-level render cache; it does NOT disable
// caching of the `fetch()` calls supabase-js makes under the hood.
// This directive tells Next.js "no fetch call inside this route
// may be cached." createAdminSupabase() also passes cache: "no-store"
// on every outgoing call, so this is a second guardrail, not the
// primary one.
export const fetchCache = "force-no-store";

interface IntroRow {
  client_name: string;
  assigned_at: string;
  // Most-recent modification of the LEAD (its client_pipeline_entries
  // row): stage change, note add, or any lead-level edit. Equals
  // assigned_at right after the lead enters the stage, and bumps forward
  // on later edits. Never null — falls back to assigned_at when the row
  // has no pipeline entry (e.g. an Interested thread never introduced).
  // NOTE: updated_at also moves on our own automation (FollowUp Boss
  // push, "move agent"). For a clean "did the CLIENT engage?" signal use
  // client_activity_at below.
  updated_at: string;
  // Last time the CLIENT engaged with this lead (moved a stage, added a
  // note, edited a field). Excludes intro creation / FUB push / move-agent
  // — see migration 0061. null means the client has never touched it since
  // it entered the stage (the reliable "stagnant" signal), and also null
  // before migration 0061 is applied.
  client_activity_at: string | null;
  // Nice-to-have:
  client_slug: string;
  client_id: string;
  // null only for portal pipeline-stage rows (e.g. "Hired") whose agent
  // was added straight to the portal and never had an inbox thread.
  thread_id: string | null;
  lead_email: string | null;
  lead_name: string | null;
  // Campaign that originally surfaced the thread (snapshot at
  // ingestion time — never re-derived from EmailBison/Instantly).
  // Both fields are null for threads we received without a campaign
  // hint (one-off external intros, manual portal adds, etc.).
  campaign_id: string | null;
  campaign_name: string | null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const labelName = (url.searchParams.get("label") ?? "Introduction").trim();

  const suppliedToken =
    url.searchParams.get("token") ?? request.headers.get("x-admin-token");
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  let workspaceId: string;
  if (suppliedToken && serviceKey && suppliedToken === serviceKey) {
    workspaceId =
      url.searchParams.get("workspace") ?? env.WORKSPACE_ID ?? "";
    if (!workspaceId) {
      return NextResponse.json(
        { error: "workspace param required when using service-role token" },
        { status: 400 },
      );
    }
  } else {
    const userClient = await createServerSupabase();
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    const session = await requireSession();
    workspaceId = session.activeWorkspace.id;
  }

  const admin = createAdminSupabase();

  // Resolve the label id (case-insensitive name match).
  const { data: labelRow } = await admin
    .from("labels")
    .select("id")
    .eq("workspace_id", workspaceId)
    .ilike("name", labelName)
    .maybeSingle();
  if (!labelRow?.id) {
    // Not a workspace label. It may be a client-portal PIPELINE STAGE
    // (e.g. "Hired"), which lives on client_pipeline_entries.stage rather
    // than on label_assignments. Fall back to the pipeline so callers get
    // the exact same row shape they get for Introduction / Interested.
    return introsFromPipelineStage(admin, labelName);
  }

  // "Interested" is a funnel STATE, not a terminal one: every Introduction
  // was Interested first, but applying the Introduction label wipes the
  // Interested label (single-label-per-thread — see the labels route). So an
  // Interested query that only counts the live "Interested" label loses every
  // lead the moment it's introduced. Union the Introduction label into the
  // Interested query so the total reflects "ever showed interest". Other
  // labels (Introduction itself, etc.) are unaffected — this branch is
  // Interested-only.
  const labelIds: string[] = [labelRow.id];
  if (labelName.toLowerCase() === "interested") {
    const { data: introRow } = await admin
      .from("labels")
      .select("id")
      .eq("workspace_id", workspaceId)
      .ilike("name", "Introduction")
      .maybeSingle();
    if (introRow?.id && introRow.id !== labelRow.id) labelIds.push(introRow.id);
  }

  // Pull every assignment for these label(s). .range() alone does NOT
  // lift Supabase's server-side db-max-rows=1000 cap — the response
  // comes back capped no matter what range the client asks for. Page
  // in 1000-row windows via fetchAllRows. See lib/db/paginated-select.
  const rawAssignmentList = await fetchAllRows<{
    assigned_at: string;
    target_id: string;
  }>(({ from, to }) =>
    admin
      .from("label_assignments")
      .select("assigned_at, target_id")
      .eq("workspace_id", workspaceId)
      .eq("target_type", "thread")
      .in("label_id", labelIds)
      .order("assigned_at", { ascending: false })
      .range(from, to),
  );

  // One row per thread. The list is ordered most-recent-first, so the first
  // occurrence wins. With single-label-per-thread semantics a thread carries
  // at most one of {Interested, Introduction} so there's normally nothing to
  // collapse, but this defends against any thread that somehow holds both.
  const seenThreads = new Set<string>();
  const assignmentList = rawAssignmentList.filter((a) => {
    if (seenThreads.has(a.target_id)) return false;
    seenThreads.add(a.target_id);
    return true;
  });

  if (assignmentList.length === 0) {
    return NextResponse.json({
      ok: true,
      label: labelName,
      label_id: labelRow.id,
      intros: [],
    });
  }

  // Bulk-resolve threads → client_id + lead_id + campaign in chunks
  // (PostgREST URL length cap on `in()`).
  //
  // Chunk size math: a uuid encodes to 37 bytes in the URL (36 + comma).
  // With the `select=id,client_id,lead_id,campaign_id,campaign_name`
  // clause + apikey/auth headers + PostgREST wrapper, the request URL
  // header hits the ~16 KB PostgREST cap at roughly 407 ids. undici
  // reports "HTTP headers exceeded server limits (typically 16KB)"
  // and supabase-js returns `data: null` on the failing chunk —
  // silently dropping every assignment in the batch.
  //
  // 200 keeps a full-select in.() URL under ~8 KB with ample headroom
  // for auth/select growth. Same size used for the leads bulk-lookup
  // below because it has an equally wide select clause. See the
  // 2026-07-07 investigation on /api/clients/intros returning 0
  // Introduction rows once the campaign crossed ~400 assignments.
  const threadIds = Array.from(new Set(assignmentList.map((a) => a.target_id)));
  const threadMeta = new Map<
    string,
    {
      client_id: string | null;
      lead_id: string | null;
      campaign_id: string | null;
      campaign_name: string | null;
    }
  >();
  const CHUNK = 200;
  for (let i = 0; i < threadIds.length; i += CHUNK) {
    const slice = threadIds.slice(i, i + CHUNK);
    const { data: threads } = await admin
      .from("threads")
      .select("id, client_id, lead_id, campaign_id, campaign_name")
      .in("id", slice);
    for (const t of (threads ?? []) as Array<{
      id: string;
      client_id: string | null;
      lead_id: string | null;
      campaign_id: string | null;
      campaign_name: string | null;
    }>) {
      threadMeta.set(t.id, {
        client_id: t.client_id,
        lead_id: t.lead_id,
        campaign_id: t.campaign_id,
        campaign_name: t.campaign_name,
      });
    }
  }

  // Bulk-resolve clients → name + slug.
  const clientIds = Array.from(
    new Set(
      Array.from(threadMeta.values())
        .map((m) => m.client_id)
        .filter((v): v is string => Boolean(v)),
    ),
  );
  const clientById = new Map<string, { name: string; slug: string }>();
  if (clientIds.length > 0) {
    const { data: clients } = await admin
      .from("clients")
      .select("id, name, slug")
      .in("id", clientIds);
    for (const c of (clients ?? []) as Array<{ id: string; name: string; slug: string }>) {
      clientById.set(c.id, { name: c.name, slug: c.slug });
    }
  }

  // Bulk-resolve leads → email + full_name (nice-to-have fields).
  const leadIds = Array.from(
    new Set(
      Array.from(threadMeta.values())
        .map((m) => m.lead_id)
        .filter((v): v is string => Boolean(v)),
    ),
  );
  const leadById = new Map<string, { email: string | null; full_name: string | null }>();
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const slice = leadIds.slice(i, i + CHUNK);
    const { data: leads } = await admin
      .from("leads")
      .select("id, email, full_name")
      .in("id", slice);
    for (const l of (leads ?? []) as Array<{
      id: string;
      email: string | null;
      full_name: string | null;
    }>) {
      leadById.set(l.id, { email: l.email, full_name: l.full_name });
    }
  }

  // Lead activity per row = the matching client_pipeline_entries row's
  // updated_at (the Introduction label creates that entry via trigger; a
  // note/stage/edit bumps its updated_at — see migration 0060). Keyed by
  // thread_id: a thread maps to one pipeline entry. Rows with no entry
  // (e.g. an Interested thread never introduced) fall back to assigned_at
  // so updated_at is never null.
  // client_activity_at (migration 0061) = last genuine client engagement.
  // Probe so this works before/after the migration lands.
  const caProbe = await admin
    .from("client_pipeline_entries")
    .select("client_activity_at")
    .limit(1);
  const hasClientActivity = !caProbe.error;
  const entryCols = hasClientActivity
    ? "thread_id, updated_at, client_activity_at"
    : "thread_id, updated_at";

  const updatedByThread = new Map<string, string>();
  const clientActivityByThread = new Map<string, string>();
  for (let i = 0; i < threadIds.length; i += CHUNK) {
    const slice = threadIds.slice(i, i + CHUNK);
    const { data: entries } = await (
      admin
        .from("client_pipeline_entries")
        .select(entryCols) as unknown as {
        in(
          col: string,
          vals: string[],
        ): PromiseLike<{
          data:
            | Array<{
                thread_id: string | null;
                updated_at: string;
                client_activity_at?: string | null;
              }>
            | null;
        }>;
      }
    ).in("thread_id", slice);
    for (const e of entries ?? []) {
      if (!e.thread_id) continue;
      const prev = updatedByThread.get(e.thread_id);
      // If a thread somehow maps to >1 entry, keep the most recent.
      if (!prev || e.updated_at > prev) updatedByThread.set(e.thread_id, e.updated_at);
      if (e.client_activity_at) {
        const pc = clientActivityByThread.get(e.thread_id);
        if (!pc || e.client_activity_at > pc)
          clientActivityByThread.set(e.thread_id, e.client_activity_at);
      }
    }
  }

  // Assemble rows. Drop assignments whose thread has no client_id —
  // those threads belong to the "Unknown" fallback bucket (or pre-dating
  // the client tagging) and don't roll up to a real client.
  const intros: IntroRow[] = [];
  for (const a of assignmentList) {
    const meta = threadMeta.get(a.target_id);
    if (!meta?.client_id) continue;
    const client = clientById.get(meta.client_id);
    if (!client) continue;
    const lead = meta.lead_id ? leadById.get(meta.lead_id) : null;
    intros.push({
      client_name: client.name,
      assigned_at: a.assigned_at,
      updated_at: updatedByThread.get(a.target_id) ?? a.assigned_at,
      client_activity_at: clientActivityByThread.get(a.target_id) ?? null,
      client_slug: client.slug,
      client_id: meta.client_id,
      thread_id: a.target_id,
      lead_email: lead?.email ?? null,
      lead_name: lead?.full_name ?? null,
      campaign_id: meta.campaign_id ?? null,
      campaign_name: meta.campaign_name ?? null,
    });
  }

  return NextResponse.json({
    ok: true,
    label: labelName,
    label_id: labelRow.id,
    intros,
  });
}

// Source rows from a client-portal pipeline STAGE (e.g. "Hired") instead
// of label_assignments. Returns the identical envelope + IntroRow shape as
// the label path so the same consumer code works for both.
//
// Notes on the mapping:
//   - assigned_at → client_pipeline_entries.updated_at. There's no
//     dedicated "entered this stage" timestamp; updated_at moves whenever
//     the row changes, and in practice that's the stage transition — the
//     best available "hired at" signal for weekly bucketing.
//   - lead_name / lead_email → the row's SNAPSHOT columns. Most hired
//     agents are added straight to the portal (no inbox thread), so we
//     must not rely on a threads/leads join for identity.
//   - thread_id / campaign → only present for entries that still carry a
//     thread; null otherwise.
//   - clients (and their pipeline entries) are a global singleton in this
//     deployment (migration 0010), not workspace-scoped — mirroring how
//     the rest of the app treats clients — so there's no workspace filter.
async function introsFromPipelineStage(
  admin: ReturnType<typeof createAdminSupabase>,
  labelName: string,
): Promise<Response> {
  const stageEntry = Object.entries(DEFAULT_STAGE_LABELS).find(
    ([, label]) => label.toLowerCase() === labelName.toLowerCase(),
  );
  if (!stageEntry) {
    return NextResponse.json(
      { error: `Label "${labelName}" not found in this workspace.` },
      { status: 404 },
    );
  }
  const stageKey = stageEntry[0];

  // hired_at (0059) and client_activity_at (0061) exist only after their
  // migrations. Probe each so this route works whether or not they've
  // landed — it can never 500 on a column-not-found, so code deploy and DB
  // migration are fully decoupled (safe in any order).
  const [hiredProbe, caProbe] = await Promise.all([
    admin.from("client_pipeline_entries").select("hired_at").limit(1),
    admin.from("client_pipeline_entries").select("client_activity_at").limit(1),
  ]);
  const hasHiredAt = !hiredProbe.error;
  const hasClientActivity = !caProbe.error;
  const cols = [
    "client_id, thread_id, lead_name, lead_email, updated_at",
    hasHiredAt ? "hired_at" : null,
    hasClientActivity ? "client_activity_at" : null,
  ]
    .filter(Boolean)
    .join(", ");

  type PipeRow = {
    client_id: string;
    thread_id: string | null;
    lead_name: string | null;
    lead_email: string | null;
    hired_at?: string | null;
    client_activity_at?: string | null;
    updated_at: string;
  };
  const pipeRows = await fetchAllRows<PipeRow>(({ from, to }) =>
    (
      admin
        .from("client_pipeline_entries")
        .select(cols)
        .eq("stage", stageKey)
        .order("updated_at", { ascending: false }) as unknown as {
        range(
          from: number,
          to: number,
        ): PromiseLike<{
          data: PipeRow[] | null;
          error: { message: string } | null;
        }>;
      }
    ).range(from, to),
  );

  if (pipeRows.length === 0) {
    return NextResponse.json({
      ok: true,
      label: labelName,
      label_id: null,
      source: "pipeline",
      intros: [],
    });
  }

  const CHUNK = 200;

  // clients → name + slug
  const clientIds = Array.from(
    new Set(pipeRows.map((r) => r.client_id).filter(Boolean)),
  );
  const clientById = new Map<string, { name: string; slug: string }>();
  for (let i = 0; i < clientIds.length; i += CHUNK) {
    const slice = clientIds.slice(i, i + CHUNK);
    const { data: clients } = await admin
      .from("clients")
      .select("id, name, slug")
      .in("id", slice);
    for (const c of (clients ?? []) as Array<{ id: string; name: string; slug: string }>) {
      clientById.set(c.id, { name: c.name, slug: c.slug });
    }
  }

  // campaign (nice-to-have) via threads for entries that still have one
  const threadIds = Array.from(
    new Set(
      pipeRows
        .map((r) => r.thread_id)
        .filter((v): v is string => Boolean(v)),
    ),
  );
  const campaignByThread = new Map<
    string,
    { campaign_id: string | null; campaign_name: string | null }
  >();
  for (let i = 0; i < threadIds.length; i += CHUNK) {
    const slice = threadIds.slice(i, i + CHUNK);
    const { data: threads } = await admin
      .from("threads")
      .select("id, campaign_id, campaign_name")
      .in("id", slice);
    for (const t of (threads ?? []) as Array<{
      id: string;
      campaign_id: string | null;
      campaign_name: string | null;
    }>) {
      campaignByThread.set(t.id, {
        campaign_id: t.campaign_id,
        campaign_name: t.campaign_name,
      });
    }
  }

  const intros: IntroRow[] = [];
  for (const r of pipeRows) {
    const client = clientById.get(r.client_id);
    if (!client) continue; // orphaned entry (client deleted) — skip
    const camp = r.thread_id ? campaignByThread.get(r.thread_id) : null;
    intros.push({
      client_name: client.name,
      // Prefer the real stage-entry timestamp (set by the DB trigger for
      // rows hired after migration 0059). Older rows have no hired_at, so
      // fall back to updated_at — the prior behaviour.
      assigned_at: r.hired_at ?? r.updated_at,
      // Lead activity: the entry's own updated_at (bumps on note/edit).
      updated_at: r.updated_at,
      // Last genuine client engagement (null until the client acts).
      client_activity_at: r.client_activity_at ?? null,
      client_slug: client.slug,
      client_id: r.client_id,
      thread_id: r.thread_id,
      lead_email: r.lead_email,
      lead_name: r.lead_name,
      campaign_id: camp?.campaign_id ?? null,
      campaign_name: camp?.campaign_name ?? null,
    });
  }

  return NextResponse.json({
    ok: true,
    label: labelName,
    label_id: null,
    source: "pipeline",
    intros,
  });
}
