import { createAdminSupabase } from "@/lib/supabase/admin";

/*
 * The roster record (os_clients) a Master Inbox portal belongs to.
 *
 * A client can own several portals — Properties & Estates has Boston and
 * Florida — but os_clients.mi_client_id links only one of them. Looking a
 * portal up by that column alone found nobody for the others, so a lead in
 * the Florida portal showed "not on the workspace roster" and the Introduce
 * button and the reply agent's handover had nobody to introduce it to.
 *
 * In order:
 *   1. the record linked to this portal (os_clients.mi_client_id);
 *   2. the record a campaign → portal choice points at this portal from
 *      (os_campaign_portals, OS migration 0025);
 *   3. the one record whose name or aliases equal the portal's name.
 * A read error on step 1 is returned as an error; steps 2 and 3 are best effort.
 */
const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export async function rosterRowForPortal(
  portalId: string,
  portalName: string | null,
  columns: string,
): Promise<{ row: Record<string, unknown> | null; error?: string }> {
  const admin = createAdminSupabase();

  // Columns a migration may not have added yet — intro_override (0026),
  // more_contacts (0028): ask again without whichever one is missing.
  let cols = columns;
  let linked = await admin.from("os_clients").select(cols).eq("mi_client_id", portalId).maybeSingle();
  for (const optional of ["intro_override", "more_contacts"]) {
    if (linked.error && linked.error.message.includes(optional) && cols.includes(optional)) {
      cols = cols.replace(new RegExp(`,\\s*${optional}`), "");
      linked = await admin.from("os_clients").select(cols).eq("mi_client_id", portalId).maybeSingle();
    }
  }
  if (linked.error) return { row: null, error: linked.error.message };
  if (linked.data) return { row: linked.data as unknown as Record<string, unknown> };

  try {
    const { data: route } = await admin
      .from("os_campaign_portals").select("os_client_id").eq("mi_client_id", portalId).limit(1).maybeSingle();
    const osId = (route as { os_client_id?: string } | null)?.os_client_id;
    if (osId) {
      const { data } = await admin.from("os_clients").select(cols).eq("id", osId).maybeSingle();
      if (data) return { row: data as unknown as Record<string, unknown> };
    }
  } catch {
    /* no 0025 yet — fall through */
  }

  const want = norm(portalName);
  if (want) {
    const { data } = await admin.from("os_clients").select(`id, name, aliases, ${cols}`);
    const hits = ((data ?? []) as unknown as Record<string, unknown>[]).filter((r) =>
      [r.name as string, ...(((r.aliases as string[] | null) ?? []))].some((n) => norm(n) === want),
    );
    if (hits.length === 1) return { row: hits[0] };
  }
  return { row: null };
}
