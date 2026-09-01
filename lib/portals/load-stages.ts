import { createAdminSupabase } from "@/lib/supabase/admin";
import type { ClientStageRow } from "./stage-config";

// Load a client's custom pipeline-stage rows (migration 0074).
//
// FAIL-OPEN by design: this is only ever consulted for clients with the
// `manage_stages` flag on (Demo), and ANY problem — the table not existing yet,
// an RLS/permission issue, a network blip — resolves to an empty list, which
// makes the caller fall back to the canonical hardcoded stages (i.e. today's
// exact behavior). A stage-config read can never break a portal render.
export async function loadClientStageRows(clientId: string): Promise<ClientStageRow[]> {
  try {
    const admin = createAdminSupabase();
    const { data, error } = await admin
      .from("client_pipeline_stages")
      .select("key, label, color, sort_order, kind, canonical_stage, hidden")
      .eq("client_id", clientId)
      .order("sort_order", { ascending: true });
    if (error || !Array.isArray(data)) return [];
    return data as ClientStageRow[];
  } catch {
    return [];
  }
}
