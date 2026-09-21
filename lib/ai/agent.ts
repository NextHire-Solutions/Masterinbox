import { createAdminSupabase } from "@/lib/supabase/admin";
import { gatherGuidance, renderGuidance, EMPTY_GUIDANCE, type Guidance } from "@/lib/ai/retrieval";
import { env } from "@/lib/env";
import { generateReplyDraft, DEFAULT_REPLY_SYSTEM_PROMPT, type ConversationTurn, type LeadFact } from "@/lib/ai/reply";
import type { AiProvider } from "@/lib/ai/label";
import {
  parseRunConfig,
  scheduleToJson,
  qualificationToJson,
  handoverToJson,
  type AgentHandover,
  type AgentQualification,
  type AgentSchedule,
  type RunMode,
} from "@/lib/ai/agent-config";
import { LIVE_DISABLED_MESSAGE, liveSendingEnabled } from "@/lib/ai/live-gate";
import { findLeadPhone } from "@/lib/ai/lead-phone";

export type ChannelFilter = "email" | "both";

export interface ReplyAgent {
  id: string;
  workspace_id: string;
  name: string;
  mode: "human_in_loop" | "auto";
  tone: string;
  response_length: "short" | "medium" | "long" | "variable";
  max_tokens: number;
  temperature: number;
  provider: AiProvider;
  model: string;
  has_api_key: boolean;
  system_prompt: string | null;
  channel_ids: string[];
  channel_filter: ChannelFilter;
  active: boolean;
  auto_respond_new: boolean;
  stats: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  /*
   * The upgrade's five columns (migration 0009), parsed rather than raw — a
   * caller should never have to know that `schedule` is jsonb. They are
   * non-optional on the type and always populated, because `parseRunConfig`
   * supplies a safe value for a row written before the migration ran.
   */
  run_mode: RunMode;
  client_ids: string[];
  schedule: AgentSchedule;
  qualification: AgentQualification;
  handover: AgentHandover;
}

const LEGACY_COLUMNS =
  "id, workspace_id, name, mode, tone, response_length, max_tokens, temperature, provider, model, api_key_encrypted, system_prompt, channel_ids, channel_filter, active, auto_respond_new, stats, created_at, updated_at";

/** The five columns migration 0009 adds. Selected separately so we can retry without them. */
const UPGRADE_COLUMNS = "run_mode, client_ids, schedule, qualification, handover";

export async function loadAgents(workspaceId: string): Promise<ReplyAgent[]> {
  const admin = createAdminSupabase();
  const read = (columns: string) =>
    admin
      .from("reply_agents")
      .select(columns)
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: true });

  /*
   * TWO ATTEMPTS, BECAUSE THE CODE AND THE MIGRATION DEPLOY SEPARATELY.
   *
   * Selecting a column that does not exist is a hard PostgREST error, not a
   * null — so if this shipped before migration 0009 ran, every call would
   * return [] and every agent would silently stop drafting. That is a much
   * worse failure than "the new fields are absent", so the second attempt asks
   * for exactly what the app asked for yesterday and the run config falls back
   * to its safe defaults (shadow, no client assignment, no qualification).
   */
  let { data, error } = await read(`${LEGACY_COLUMNS}, ${UPGRADE_COLUMNS}`);
  if (error) {
    console.warn(
      "[agents] loadAgents: upgrade columns unavailable, falling back to the pre-0009 shape —",
      error.message,
    );
    ({ data, error } = await read(LEGACY_COLUMNS));
  }
  if (error) {
    console.error("[agents] loadAgents failed", error);
    return [];
  }
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((row) => ({
    id: row.id as string,
    workspace_id: row.workspace_id as string,
    name: row.name as string,
    mode: row.mode as "human_in_loop" | "auto",
    tone: row.tone as string,
    response_length: (row.response_length as "short" | "medium" | "long" | "variable") ?? "medium",
    max_tokens: row.max_tokens as number,
    temperature: Number(row.temperature),
    provider: row.provider as AiProvider,
    model: row.model as string,
    has_api_key: Boolean(row.api_key_encrypted),
    system_prompt: (row.system_prompt as string | null) ?? null,
    channel_ids: (row.channel_ids as string[]) ?? [],
    channel_filter: ((row.channel_filter as ChannelFilter | null) ?? "both") as ChannelFilter,
    active: row.active as boolean,
    auto_respond_new: row.auto_respond_new as boolean,
    stats: (row.stats as Record<string, unknown>) ?? {},
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    ...runConfigFields(row),
  }));
}

/*
 * The five upgrade columns, parsed and renamed to the shape `ReplyAgent`
 * exposes. The names on the row are the plan's (`run_mode`, `client_ids`) and
 * so are the names here; `parseRunConfig` returns the parsed values under
 * camelCase keys because it is a pure module with no opinion about the wire
 * format.
 */
function runConfigFields(row: Record<string, unknown>): Pick<
  ReplyAgent,
  "run_mode" | "client_ids" | "schedule" | "qualification" | "handover"
> {
  const cfg = parseRunConfig(row);
  return {
    run_mode: cfg.runMode,
    client_ids: cfg.clientIds,
    schedule: cfg.schedule,
    qualification: cfg.qualification,
    handover: cfg.handover,
  };
}

// Decrypt the agent's API key using the same pgcrypto helpers we use for
// the AI labeling config. Returns the agent row joined with the decrypted
// key, or null if the workspace isn't configured.
export async function loadAgentWithKey(
  agentId: string,
): Promise<(ReplyAgent & { api_key: string | null }) | null> {
  const key = env.APP_ENCRYPTION_KEY;
  if (!key) return null;
  const admin = createAdminSupabase();
  const { data, error } = await admin.rpc("reply_agent_decrypt", {
    p_agent: agentId,
    p_key: key,
  });
  if (error) {
    console.error("[agents] reply_agent_decrypt failed", error);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    mode: row.mode,
    tone: row.tone,
    response_length: (row.response_length as "short" | "medium" | "long" | "variable") ?? "medium",
    max_tokens: row.max_tokens,
    temperature: Number(row.temperature),
    provider: row.provider,
    model: row.model,
    has_api_key: Boolean(row.api_key),
    api_key: row.api_key ?? null,
    system_prompt: row.system_prompt,
    channel_ids: row.channel_ids ?? [],
    channel_filter: (row.channel_filter ?? "both") as ChannelFilter,
    active: row.active,
    auto_respond_new: row.auto_respond_new,
    stats: row.stats ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
    /*
     * The RPC returns these only once migration 0009 has rebuilt it (it has a
     * fixed RETURNS TABLE, so the columns cannot appear before then). Absent,
     * `runConfigFields` supplies the safe defaults — and, critically, shadow
     * rather than pause, so an un-migrated database keeps drafting.
     */
    ...runConfigFields(row as Record<string, unknown>),
  };
}

export interface SaveAgentInput {
  workspaceId: string;
  id?: string;
  name?: string;
  mode?: "human_in_loop" | "auto";
  tone?: string;
  response_length?: "short" | "medium" | "long" | "variable";
  max_tokens?: number;
  temperature?: number;
  provider?: AiProvider;
  model?: string;
  apiKey?: string | null; // null to clear, undefined to keep
  system_prompt?: string | null;
  channel_ids?: string[];
  channel_filter?: ChannelFilter;
  active?: boolean;
  auto_respond_new?: boolean;
  // ---- the upgrade's fields (migration 0009) ----
  run_mode?: RunMode;
  client_ids?: string[];
  schedule?: AgentSchedule;
  qualification?: AgentQualification;
  handover?: AgentHandover;
}

/** Thrown when someone tries to arm an agent on a server where Live cannot send. */
export class LiveModeNotEnabledError extends Error {
  constructor() {
    super(LIVE_DISABLED_MESSAGE);
    this.name = "LiveModeNotEnabledError";
  }
}

export async function saveAgent(input: SaveAgentInput): Promise<string> {
  const admin = createAdminSupabase();
  const key = env.APP_ENCRYPTION_KEY;

  /*
   * THE SECOND OF THE THREE LOCKS ON LIVE MODE.
   *
   * Deliberately here rather than in the route: every write to an agent comes
   * through this function — the create route, the patch route, the duplicate
   * action, and anything added later. A check in one route teaches one route.
   *
   * With the env gate unset, 'live' cannot be STORED at all, so there is no
   * way to arm an agent from the UI and no row that would start sending the
   * moment the variable was set. See ai/live-gate.ts for the other two locks.
   */
  if (input.run_mode === "live" && !liveSendingEnabled()) {
    throw new LiveModeNotEnabledError();
  }

  const update: Record<string, unknown> = {};
  if (input.name !== undefined) update.name = input.name;
  if (input.mode !== undefined) update.mode = input.mode;
  if (input.tone !== undefined) update.tone = input.tone;
  if (input.response_length !== undefined) update.response_length = input.response_length;
  if (input.max_tokens !== undefined) update.max_tokens = input.max_tokens;
  if (input.temperature !== undefined) update.temperature = input.temperature;
  if (input.provider !== undefined) update.provider = input.provider;
  if (input.model !== undefined) update.model = input.model;
  if (input.system_prompt !== undefined) update.system_prompt = input.system_prompt;
  if (input.channel_ids !== undefined) update.channel_ids = input.channel_ids;
  if (input.channel_filter !== undefined) update.channel_filter = input.channel_filter;
  if (input.active !== undefined) update.active = input.active;
  if (input.auto_respond_new !== undefined) update.auto_respond_new = input.auto_respond_new;
  if (input.run_mode !== undefined) update.run_mode = input.run_mode;
  if (input.client_ids !== undefined) update.client_ids = input.client_ids;
  if (input.schedule !== undefined) update.schedule = scheduleToJson(input.schedule);
  if (input.qualification !== undefined) update.qualification = qualificationToJson(input.qualification);
  if (input.handover !== undefined) update.handover = handoverToJson(input.handover);
  if (input.apiKey === null) update.api_key_encrypted = null;

  let agentId = input.id;
  if (agentId) {
    const { error } = await admin
      .from("reply_agents")
      .update(update)
      .eq("id", agentId)
      .eq("workspace_id", input.workspaceId);
    if (error) throw new Error(error.message);
  } else {
    if (!input.name) throw new Error("Name is required for new agents");
    const { data, error } = await admin
      .from("reply_agents")
      .insert({
        workspace_id: input.workspaceId,
        name: input.name,
        ...update,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    agentId = data.id;
  }

  if (input.apiKey && input.apiKey.length > 0 && agentId) {
    if (!key) throw new Error("APP_ENCRYPTION_KEY is not configured on the server.");
    const { error: encErr } = await admin.rpc("reply_agent_set_key", {
      p_agent: agentId,
      p_key: key,
      p_plaintext: input.apiKey,
    });
    if (encErr) throw new Error(encErr.message);
  }

  return agentId!;
}

export async function deleteAgent(workspaceId: string, agentId: string): Promise<void> {
  const admin = createAdminSupabase();
  const { error } = await admin
    .from("reply_agents")
    .delete()
    .eq("id", agentId)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(error.message);
}

/**
 * Clone an agent to make a test variant — plan §6.
 *
 * THE DUPLICATE STARTS PAUSED, ALWAYS, whatever the original was doing. The
 * plan is explicit about it ("a duplicated agent starts paused so nothing
 * changes until you deliberately swap it in") and the reason is the A/B design:
 * one active agent per client. A clone that inherited `live` would put two
 * agents on the same client's threads, and the comparison the whole feature
 * exists to produce would be against a mixture of both.
 *
 * The API key is NOT copied. `api_key_encrypted` is ciphertext under the
 * server's APP_ENCRYPTION_KEY and copying the bytes would work — which is
 * exactly why it is worth saying no on purpose: a duplicate is a new agent, and
 * a new agent's key is entered deliberately. (The caller re-enters it, or the
 * clone simply cannot draft, which is a visible, safe failure.)
 */
export async function duplicateAgent(
  workspaceId: string,
  agentId: string,
  newName?: string,
): Promise<string> {
  const admin = createAdminSupabase();
  const agents = await loadAgents(workspaceId);
  const source = agents.find((a) => a.id === agentId);
  if (!source) throw new Error("Agent not found");

  const { data, error } = await admin
    .from("reply_agents")
    .insert({
      workspace_id: workspaceId,
      name: (newName ?? `${source.name} (copy)`).slice(0, 80),
      mode: source.mode,
      tone: source.tone,
      response_length: source.response_length,
      max_tokens: source.max_tokens,
      temperature: source.temperature,
      provider: source.provider,
      model: source.model,
      system_prompt: source.system_prompt,
      channel_ids: source.channel_ids,
      channel_filter: source.channel_filter,
      // Inactive AND paused: two independent off switches, because `active` is
      // the pre-existing one that other call sites filter on and `run_mode` is
      // the new one. A clone must be invisible to both.
      active: false,
      auto_respond_new: false,
      run_mode: "pause",
      client_ids: source.client_ids,
      schedule: scheduleToJson(source.schedule),
      qualification: qualificationToJson(source.qualification),
      handover: handoverToJson(source.handover),
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

interface DraftContext {
  workspaceId: string;
  threadId: string;
  agent: ReplyAgent & { api_key: string | null };
  leadName: string | null;
  leadEmail: string | null;
  /** What the lead record already holds — see DraftInput for why. */
  leadPhone?: string | null;
  leadCompany?: string | null;
  leadTitle?: string | null;
  leadFacts?: LeadFact[];
  ourName: string | null;
  ourEmail: string | null;
  subject: string | null;
  /*
   * Extra instructions for THIS draft, appended after the retrieved guidance.
   *
   * The qualification engine's next question, or the handover message, arrive
   * here (see ai/qualification.ts `renderQuestionGuidance` /
   * `renderHandoverGuidance`). Optional, and absent on every existing call
   * site, so the composer's AI Reply button and the generate-draft route
   * produce byte-for-byte the prompt they produced before this feature existed.
   */
  guidanceSuffix?: string;
  // Full thread, oldest → newest. The last entry must be the most recent
  // inbound message — what the draft is replying to.
  conversation: ConversationTurn[];
}

export type CreateDraftResult =
  | { status: "ok"; draftId: string; body: string; guidance: Guidance }
  | { status: "no_key" }
  | { status: "insert_failed"; error: string }
  | { status: "ai_failed"; draftId: string; error: string };

// Generate + persist a draft. Returns a discriminated result so callers
// can surface the actual reason if drafting fails (provider 401, model
// timeout, etc.). All failures are also persisted on the reply_drafts
// row with status='rejected' + error_message.
export async function createDraftForAgent(ctx: DraftContext): Promise<CreateDraftResult> {
  if (!ctx.agent.api_key) return { status: "no_key" };
  const admin = createAdminSupabase();

  const { data: draftRow, error: insErr } = await admin
    .from("reply_drafts")
    .insert({
      workspace_id: ctx.workspaceId,
      thread_id: ctx.threadId,
      agent_id: ctx.agent.id,
      status: "pending",
    })
    .select("id")
    .single();
  if (insErr || !draftRow) {
    console.error("[agents] failed to create draft placeholder", insErr);
    return { status: "insert_failed", error: insErr?.message ?? "Insert failed" };
  }
  const draftId = draftRow.id as string;

  /*
   * WHAT THE AGENT IS ALLOWED TO READ BEFORE IT WRITES.
   *
   * The house style, the objection playbook, and the nearest real replies we
   * have actually sent — all distilled from this workspace's own history in
   * the OS and held in tables both apps share.
   *
   * Deliberately here rather than in a route: several call sites reach this
   * function — the composer's AI Reply button, the bulk route, and the
   * EmailBison and Instantly sync workers that draft automatically when a
   * reply lands. Putting retrieval in one route would teach some drafts and
   * leave the rest writing from a bare prompt, which is where most of the
   * never-sent drafts came from.
   *
   * `gatherGuidance` never throws and returns nothing useful rather than
   * failing, so an empty corpus degrades to exactly the prompt this code sent
   * before retrieval existed. The extra try/catch is belt and braces: a draft
   * must never fail because the thing meant to improve it did.
   */
  const lastInbound = [...ctx.conversation].reverse().find((t) => t.direction === "inbound");
  let guidance: Guidance = EMPTY_GUIDANCE;
  try {
    guidance = await gatherGuidance({
      workspaceId: ctx.workspaceId,
      inboundText: lastInbound?.body ?? "",
      threadId: ctx.threadId,
      provider: ctx.agent.provider,
      apiKey: ctx.agent.api_key,
    });
  } catch (err) {
    console.warn("[agents] guidance unavailable", err instanceof Error ? err.message : err);
  }

  try {
    const result = await generateReplyDraft({
      provider: ctx.agent.provider,
      apiKey: ctx.agent.api_key,
      model: ctx.agent.model,
      systemPrompt:
        ctx.agent.system_prompt && ctx.agent.system_prompt.trim().length > 0
          ? ctx.agent.system_prompt
          : DEFAULT_REPLY_SYSTEM_PROMPT,
      tone: ctx.agent.tone,
      responseLength: ctx.agent.response_length,
      temperature: ctx.agent.temperature,
      maxTokens: ctx.agent.max_tokens,
      leadName: ctx.leadName,
      leadEmail: ctx.leadEmail,
      /*
       * The number the LEAD gave, when they gave one. Their signature or their
       * own words beat the scraped record, which is often a years-old office
       * line. findLeadPhone also discards any number that appears in our own
       * outbound turns — inbound bodies quote our previous email, signature
       * included, and picking that up would put a stranger's number in a reply.
       */
      leadPhone: findLeadPhone(ctx.conversation, ctx.leadPhone)?.phone ?? null,
      leadCompany: ctx.leadCompany,
      leadTitle: ctx.leadTitle,
      leadFacts: ctx.leadFacts,
      ourName: ctx.ourName,
      ourEmail: ctx.ourEmail,
      subject: ctx.subject,
      conversation: ctx.conversation,
      /*
       * Retrieved guidance first, then this draft's own instruction. The order
       * is the same one retrieval.ts uses internally — general rules before
       * specific ones — and the suffix goes last so the question the agent has
       * to ask is the final thing the model reads.
       */
      guidance: [renderGuidance(guidance), ctx.guidanceSuffix?.trim()]
        .filter((part): part is string => Boolean(part && part.length > 0))
        .join("\n\n"),
    });

    await admin
      .from("reply_drafts")
      .update({
        generated_body: result.body,
        tokens_prompt: result.tokensPrompt,
        tokens_completion: result.tokensCompletion,
      })
      .eq("id", draftId);

    return { status: "ok", draftId, body: result.body, guidance };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown draft error";
    console.error("[agents] generateReplyDraft failed", message);
    await admin
      .from("reply_drafts")
      .update({ status: "rejected", error_message: message })
      .eq("id", draftId);
    return { status: "ai_failed", draftId, error: message };
  }
}
