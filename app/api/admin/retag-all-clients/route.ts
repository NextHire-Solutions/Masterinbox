import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/db/paginated-select";
import { isSuperAdmin } from "@/lib/auth/super-admin";
import { _invalidateClientCache, deriveClientIdFromCampaign } from "@/lib/clients/derive";

// POST /api/admin/retag-all-clients
//
// Re-derives client_id for EVERY thread from its campaign_name using the
// current matching logic + client catalog. Run this once after the
// matching rules change (or after adding aliases) so threads that were
// previously dropped into "Unknown" — or matched to the wrong client —
// get corrected in bulk.
//
// Auth: super-admin session OR ?token=<service-role>.

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  const url = new URL(request.url);
  const supplied = url.searchParams.get("token") ?? request.headers.get("x-admin-token");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  let authorized = false;
  if (supplied && serviceKey && supplied === serviceKey) authorized = true;
  else {
    const supabase = await createServerSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user && isSuperAdmin(user.email)) authorized = true;
  }
  if (!authorized) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminSupabase();
  _invalidateClientCache(); // make sure we derive against fresh client data

  // Page past db-max-rows=1000 — this admin job scans the entire
  // workspace, which routinely exceeds 1000 threads. See
  // lib/db/paginated-select.ts.
  let scanError: { message: string } | null = null;
  const threads = await fetchAllRows<{
    id: string;
    campaign_name: string | null;
    client_id: string | null;
    campaign_id: string | null;
    source_provider: string | null;
  }>(({ from, to }) =>
    admin
      .from("threads")
      .select("id, campaign_name, client_id, campaign_id, source_provider")
      .not("campaign_name", "is", null)
      .range(from, to),
  ).catch((err: Error) => {
    scanError = { message: err.message };
    return [];
  });
  if (scanError) {
    return NextResponse.json({ ok: false, error: (scanError as { message: string }).message }, { status: 500 });
  }

  // Derive the correct client for each thread, then group thread ids by
  // their NEW client so we can update in one statement per client rather
  // than one statement per thread.
  const moveTo = new Map<string, string[]>(); // newClientId → threadIds
  let scanned = 0;
  let changed = 0;
  for (const t of threads) {
    scanned++;
    // A portal chosen for the campaign (os_campaign_portals) must win here
    // too, or a retag would undo it.
    const newClientId = await deriveClientIdFromCampaign(t.campaign_name as string, {
      platform: t.source_provider === "instantly" ? "instantly" : "emailbison",
      id: t.campaign_id,
    });
    if (!newClientId) continue;
    if (newClientId === t.client_id) continue;
    changed++;
    const list = moveTo.get(newClientId) ?? [];
    list.push(t.id as string);
    moveTo.set(newClientId, list);
  }

  for (const [clientId, ids] of moveTo.entries()) {
    const CHUNK = 200;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const { error: upErr } = await admin
        .from("threads")
        .update({ client_id: clientId })
        .in("id", slice);
      if (upErr) {
        return NextResponse.json(
          { ok: false, error: upErr.message, scanned, changed },
          { status: 500 },
        );
      }
    }
  }

  return NextResponse.json({
    ok: true,
    scanned,
    retagged: changed,
    clients_touched: moveTo.size,
  });
}
