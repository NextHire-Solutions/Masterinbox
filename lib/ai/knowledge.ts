import "server-only";

import { createAdminSupabase } from "@/lib/supabase/admin";

/*
 * Reading the reply agent's house style and objection playbook.
 *
 * READ ONLY, on purpose. Both documents are distilled from the corpus and
 * edited by people in the workspace, which owns the whole of that machinery —
 * the corpus build, the distillation, the proposals screen. This app only ever
 * needs to put them in front of the model when it drafts, so porting the
 * writing half would be two copies of something only one side runs.
 */
export interface Knowledge {
  styleGuide: string | null;
  objectionPlaybook: string | null;
  distilledAt: string | null;
  distilledFrom: number | null;
  updatedBy: string | null;
}

export async function loadKnowledge(workspaceId: string): Promise<Knowledge> {
  const { data } = await createAdminSupabase()
    .from("os_agent_knowledge")
    .select("style_guide, objection_playbook, distilled_at, distilled_from, updated_by")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  return {
    styleGuide: (data?.style_guide as string | null) ?? null,
    objectionPlaybook: (data?.objection_playbook as string | null) ?? null,
    distilledAt: (data?.distilled_at as string | null) ?? null,
    distilledFrom: (data?.distilled_from as number | null) ?? null,
    updatedBy: (data?.updated_by as string | null) ?? null,
  };
}
