import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { requireSession } from "@/lib/auth/workspace";
import { _invalidateClientCache, deriveClientIdFromCampaign } from "@/lib/clients/derive";
import { CLIENT_PORTALS_ENABLED } from "@/lib/portals/flag";
import { publicPortalUrl } from "@/lib/portals/public-url";
import { env } from "@/lib/env";

// GET  /api/clients          -> list every client (id, name, slug, aliases, thread_count)
// POST /api/clients          -> create a new client { name, aliases? }
//
// Auth: any signed-in workspace member can read; member can write (BrokerStaffer
// is single-tenant). The clients table is a global catalog (no
// workspace_id) so we don't filter by workspace.

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  aliases: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  // Optional "Intro Macro" reply-template seed. When present, we
  // create a per-client reply_templates row with these values baked
  // in and the {{lead.*}} / {{sender.name}} tokens left for the
  // composer to resolve at insert time. Omit this key and the
  // request behaves bit-identically to before.
  intro_macro: z
    .object({
      brokerage: z.string().trim().min(1).max(160),
      client_full_name: z.string().trim().min(1).max(160),
      client_first_name: z.string().trim().min(1).max(80),
      client_role: z.string().trim().min(1).max(120),
    })
    .optional(),
});

// Pure body renderer for the Intro Macro reply template. The
// brokerage / client_* values are baked in at create time; the
// {{lead.*}} + {{sender.name}} tokens are the canonical composer
// placeholders (see lib/inbox/template-variables.ts). Kept as a
// verbatim string so the shape can be diffed / golden-tested
// later without any fixture machinery.
function renderIntroMacroBody(macro: {
  brokerage: string;
  client_full_name: string;
  client_first_name: string;
  client_role: string;
}): string {
  const { brokerage, client_full_name, client_first_name, client_role } = macro;
  return (
    `Hey {{lead.name}},\n\n` +
    `I'd like to introduce you to ${client_full_name}, ${client_role} at ${brokerage}\n\n` +
    `${client_first_name}, I recently connected with {{lead.first_name}}, ` +
    `who can be reached directly at {{lead.phone_number}} and is currently with {{lead.company}}.\n\n` +
    `{{lead.first_name}}, ${client_first_name} will be in touch directly to ` +
    `learn more about your business and discuss the opportunity in greater detail.\n\n` +
    `I hope you have a productive conversation!\n\n` +
    `Best,\n{{sender.name}}\nTalent Acquisition | ${brokerage}`
  );
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "client";
}

// Random lowercase hex string — used to make portal tokens unguessable.
function randomHex(len: number): string {
  return randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len);
}

export async function GET() {
  const user = await requireAuthedUser();
  if ("error" in user) return user.error;

  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from("clients")
    .select("id, name, slug, aliases, created_at")
    .order("name", { ascending: true });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Tag each client with how many threads currently point at it. The
  // previous implementation pulled every `threads.client_id` row (a
  // 10k-row table scan that was the worst offender behind the
  // "settings feels laggy" report); replaced with N parallel HEAD
  // counts. For ~25 clients that's ~25 lightweight requests in
  // parallel — orders of magnitude less wire traffic + faster than
  // the scan.
  const clientList = (data ?? []) as Array<{
    id: string;
    name: string;
    slug: string;
    aliases: string[] | null;
  }>;
  const counts = await Promise.all(
    clientList.map(async (c) => {
      const { count } = await admin
        .from("threads")
        .select("id", { count: "exact", head: true })
        .eq("client_id", c.id);
      return [c.id, count ?? 0] as const;
    }),
  );
  const byId = new Map<string, number>(counts);

  const rows = clientList.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    aliases: c.aliases ?? [],
    thread_count: byId.get(c.id) ?? 0,
    is_system: c.slug === "unknown",
  }));
  return NextResponse.json({ ok: true, clients: rows });
}

export async function POST(request: Request) {
  // Dual-auth (mirrors GET /api/clients/portals): a signed-in staff
  // session OR the SUPABASE_SERVICE_ROLE_KEY via `x-admin-token`
  // header / `?token=` query param. The token path lets external
  // callers (n8n / scripts) create clients end-to-end without a
  // browser session. Under the token path we default the workspace
  // to env.WORKSPACE_ID (the pinned singleton on prod) and leave
  // owner_user_id NULL — the `lists` column is nullable and 24
  // existing rows already carry NULL, so this stays consistent.
  const url = new URL(request.url);
  const suppliedToken =
    url.searchParams.get("token") ?? request.headers.get("x-admin-token");
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const usingServiceRole = Boolean(
    suppliedToken && serviceKey && suppliedToken === serviceKey,
  );

  let workspaceId: string;
  let ownerUserId: string | null;
  if (usingServiceRole) {
    workspaceId = url.searchParams.get("workspace") ?? env.WORKSPACE_ID ?? "";
    if (!workspaceId) {
      return NextResponse.json(
        { error: "workspace param required when using service-role token" },
        { status: 400 },
      );
    }
    ownerUserId = null;
  } else {
    // requireSession gives both the user AND the active workspace so
    // we can auto-create the matching sidebar list below.
    const session = await requireSession();
    workspaceId = session.activeWorkspace.id;
    ownerUserId = session.user.id;
  }

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const admin = createAdminSupabase();
  const slug = toSlug(parsed.data.name);
  // Portal columns are only written/selected when the Client Portals
  // feature is live — until then migration 0016 may not be applied, so
  // referencing portal_token would break client creation.
  const insertRow: Record<string, unknown> = {
    name: parsed.data.name,
    slug,
    aliases: parsed.data.aliases ?? [],
  };
  if (CLIENT_PORTALS_ENABLED) {
    // Auto-generate an unguessable portal token: readable slug prefix +
    // 10 random hex chars.
    insertRow.portal_token = `${slug}-${randomHex(10)}`;
    insertRow.portal_enabled = true;
    // Seed the standard portal feature flags a new client should launch
    // with. Historically these were flipped on per-client during rollout, so
    // portals created afterward came up missing them. Seeding here means every
    // new portal gets the current functionality automatically:
    //   • manage_stages       — the "Manage stages" panel (add/edit/reorder/hide)
    //   • pipeline_kanban_view — the List ↔ Board (kanban) view toggle
    insertRow.feature_flags = {
      manage_stages: true,
      pipeline_kanban_view: true,
    };
  }
  // Widen the returned column set so the caller gets everything
  // they'll need to hit the portal endpoints next (token + URL) and
  // to render admin UIs (feature flags, stage overrides, FUB state,
  // timestamps). fub_api_key is fetched but NEVER returned verbatim
  // — it's reshaped into fub_connected: boolean below, same policy
  // as GET /api/clients/portals.
  const { data, error } = await admin
    .from("clients")
    .insert(insertRow)
    .select("id, name, slug, aliases, portal_token, portal_enabled, feature_flags, stage_label_overrides, fub_api_key, fub_connected_at, created_at, updated_at")
    .single();
  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: error.code === "23505" ? 409 : 500 },
    );
  }

  _invalidateClientCache();

  // Re-tag any "Unknown" threads whose campaign_name matches the new
  // client (canonical name OR any alias). One small batch query —
  // doesn't fire on every webhook, only on this admin write.
  if (data) {
    await retagUnknownThreads(admin, data.id);
    // Sidebar list <-> client binding. Without this, the new client
    // exists in the catalog but has no sidebar surface — replies still
    // route via deriveClientIdFromCampaign, but the operator has no
    // list to click into. The unique partial index on
    // (workspace_id, client_id) makes this idempotent.
    await ensureListForClient(admin, {
      workspaceId,
      ownerUserId,
      clientId: data.id,
      clientName: data.name,
    });
  }

  // Optional Intro Macro reply-template seeding. Fires only when the
  // caller opts in via `intro_macro`. Wrapped in try/catch so a
  // template insert failure never rolls back the already-committed
  // client + sidebar list — the caller can always retry via
  // POST /api/reply-templates if it ever matters.
  let introTemplate:
    | { id: string; name: string; category: string | null }
    | null = null;
  if (parsed.data.intro_macro) {
    try {
      const body = renderIntroMacroBody(parsed.data.intro_macro);
      const { data: maxOrder } = await admin
        .from("reply_templates")
        .select("sort_order")
        .eq("workspace_id", workspaceId)
        .order("sort_order", { ascending: false })
        .limit(1)
        .maybeSingle();
      const nextOrder =
        ((maxOrder?.sort_order as number | null) ?? -1) + 1;
      const templateName = `Intro Macro - ${data.name}`;
      const { data: tmpl, error: tmplErr } = await admin
        .from("reply_templates")
        .insert({
          workspace_id: workspaceId,
          name: templateName,
          body,
          body_html: null,
          subject: null,
          cc: null,
          bcc: null,
          category: data.name,
          sort_order: nextOrder,
        })
        .select("id, name, category")
        .single();
      if (tmplErr) {
        console.error(
          "[clients] intro macro template insert failed",
          tmplErr,
        );
      } else if (tmpl) {
        introTemplate = {
          id: tmpl.id as string,
          name: tmpl.name as string,
          category: (tmpl.category as string | null) ?? null,
        };
      }
    } catch (err) {
      console.error("[clients] intro macro template create failed", err);
    }
  }

  // Reshape the returned row into a stable outward-facing envelope.
  // The pre-existing keys (id / name / slug / aliases) keep their old
  // shape verbatim so the single internal caller
  // (components/settings/clients-manager.tsx) stays bit-identical.
  const portalToken = (data.portal_token as string | null) ?? null;
  const rawApiKey = (data.fub_api_key as string | null) ?? null;
  const client = {
    id: data.id as string,
    name: data.name as string,
    slug: data.slug as string,
    aliases: (data.aliases as string[] | null) ?? [],
    portal_token: portalToken,
    portal_url: publicPortalUrl(portalToken),
    portal_enabled: Boolean(data.portal_enabled),
    fub_connected: typeof rawApiKey === "string" && rawApiKey.trim().length > 0,
    fub_connected_at: (data.fub_connected_at as string | null) ?? null,
    feature_flags:
      (data.feature_flags as Record<string, unknown> | null) ?? {},
    stage_label_overrides:
      (data.stage_label_overrides as Record<string, unknown> | null) ?? {},
    created_at: data.created_at as string,
    updated_at: data.updated_at as string,
  };

  return NextResponse.json({ ok: true, client, intro_template: introTemplate });
}

// Idempotent: ensures a `lists` row exists for the given client_id in
// this workspace. Re-runs are safe thanks to the
// `lists_workspace_client_unique` partial unique index — onConflict
// turns the second call into a no-op.
async function ensureListForClient(
  admin: ReturnType<typeof createAdminSupabase>,
  args: {
    workspaceId: string;
    // NULL under the service-role auth path (no session). The column
    // is nullable and 24 existing rows already carry NULL.
    ownerUserId: string | null;
    clientId: string;
    clientName: string;
  },
): Promise<void> {
  const { data: maxRow } = await admin
    .from("lists")
    .select("sort_order")
    .eq("workspace_id", args.workspaceId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextOrder = ((maxRow?.sort_order as number | null) ?? -1) + 1;
  await admin
    .from("lists")
    .upsert(
      {
        workspace_id: args.workspaceId,
        owner_user_id: args.ownerUserId,
        client_id: args.clientId,
        name: args.clientName,
        sort_order: nextOrder,
        shared: true,
      },
      { onConflict: "workspace_id,client_id", ignoreDuplicates: true },
    );
}

// Reusable: confirms there's a signed-in user. Returns an error
// response or the user object. Single-tenant: all members can manage
// clients (no per-role check beyond authenticated).
//
// Uses getUser() (not getSession()) so the JWT is actually verified
// against Supabase's auth server — getSession() reads the cookie
// without verification and triggers Supabase JS's security warning.
export async function requireAuthedUser() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }),
    };
  }
  return { user };
}

// Walk every thread currently tagged "Unknown" and re-derive against the
// freshly-inserted/updated client. The derive helper hits the in-memory
// cache (we just invalidated it). At ~tens of threads this is cheap.
export async function retagUnknownThreads(
  admin: ReturnType<typeof createAdminSupabase>,
  _changedClientId: string,
): Promise<void> {
  const { data: unknown } = await admin
    .from("clients")
    .select("id")
    .eq("slug", "unknown")
    .maybeSingle();
  if (!unknown?.id) return;
  const { data: rows } = await admin
    .from("threads")
    .select("id, campaign_name")
    .eq("client_id", unknown.id)
    .not("campaign_name", "is", null);
  for (const t of rows ?? []) {
    const newClientId = await deriveClientIdFromCampaign(t.campaign_name as string);
    if (newClientId && newClientId !== unknown.id) {
      await admin
        .from("threads")
        .update({ client_id: newClientId })
        .eq("id", t.id);
    }
  }
}
