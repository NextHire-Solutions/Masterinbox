/*
 * Copied from BrokerStaffer OS, deliberately.
 *
 * Both apps read the same database and must run the reply agent by the same
 * rules, so this file is kept in step with
 * `src/lib/tools/master-inbox/ai/thread-state.ts` in the workspace. If one changes,
 * change the other. There is no shared package between the two deployments.
 */
import { createAdminSupabase } from "@/lib/supabase/admin";

import type { QualificationAnswer, QualificationState } from "./qualification";

/*
 * Where a qualification conversation keeps its place.
 *
 * ---------------------------------------------------------------------------
 * ONE ROW PER (THREAD, AGENT)
 *
 * `agent_thread_state`, from migration 0009. Everything in it is derived from
 * things that really happened — a question we asked, an answer the lead gave,
 * a send the gate refused — so it can always be rebuilt by reading the thread,
 * and losing it costs continuity rather than truth.
 *
 * ---------------------------------------------------------------------------
 * THE TABLE MIGHT NOT BE THERE
 *
 * This code can deploy before migration 0009 runs; the two are in different
 * hands. Every function here therefore reports `available: false` instead of
 * throwing when the table is missing, and the runtime treats that as "no
 * qualification, draft as we always have". The agent keeps working; it simply
 * cannot run a multi-turn script yet. An un-run migration must degrade the
 * feature, never the inbox.
 */

export interface StoredThreadState extends QualificationState {
  id: string;
  workspaceId: string;
  threadId: string;
  agentId: string;
  stopReason: string | null;
  lastInboundMessageId: string | null;
  lastActionAt: string | null;
  sendsAttempted: number;
  sendsMade: number;
  holdReason: string | null;
  heldDraftId: string | null;
  heldAt: string | null;
  handoverAt: string | null;
}

export type StateRead =
  | { available: true; state: StoredThreadState | null }
  | { available: false; reason: string };

/** Postgres/PostgREST's "that relation does not exist" — i.e. un-migrated. */
function isMissingTable(message: string | undefined): boolean {
  const m = (message ?? "").toLowerCase();
  return (
    m.includes("does not exist") ||
    m.includes("could not find the table") ||
    m.includes("schema cache")
  );
}

const COLUMNS =
  "id, workspace_id, thread_id, agent_id, status, step, answers, stop_reason, " +
  "last_inbound_message_id, last_action_at, sends_attempted, sends_made, " +
  "hold_reason, held_draft_id, held_at, handover_at";

function toState(row: Record<string, unknown>): StoredThreadState {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    threadId: row.thread_id as string,
    agentId: row.agent_id as string,
    status: (row.status as StoredThreadState["status"]) ?? "qualifying",
    step: Number(row.step ?? 0),
    answers: Array.isArray(row.answers) ? (row.answers as QualificationAnswer[]) : [],
    stopReason: (row.stop_reason as string | null) ?? null,
    lastInboundMessageId: (row.last_inbound_message_id as string | null) ?? null,
    lastActionAt: (row.last_action_at as string | null) ?? null,
    sendsAttempted: Number(row.sends_attempted ?? 0),
    sendsMade: Number(row.sends_made ?? 0),
    holdReason: (row.hold_reason as string | null) ?? null,
    heldDraftId: (row.held_draft_id as string | null) ?? null,
    heldAt: (row.held_at as string | null) ?? null,
    handoverAt: (row.handover_at as string | null) ?? null,
  };
}

export async function loadThreadState(threadId: string, agentId: string): Promise<StateRead> {
  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from("agent_thread_state")
    .select(COLUMNS)
    .eq("thread_id", threadId)
    .eq("agent_id", agentId)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error.message)) return { available: false, reason: "agent_thread_state is missing — run migration 0009" };
    console.error("[agent-state] load failed", error);
    return { available: false, reason: error.message };
  }
  return { available: true, state: data ? toState(data as unknown as Record<string, unknown>) : null };
}

export interface UpsertStateInput {
  workspaceId: string;
  threadId: string;
  agentId: string;
  status?: QualificationState["status"];
  step?: number;
  answers?: QualificationAnswer[];
  stopReason?: string | null;
  lastInboundMessageId?: string | null;
  lastActionAt?: string | null;
  sendsAttempted?: number;
  sendsMade?: number;
  holdReason?: string | null;
  heldDraftId?: string | null;
  heldAt?: string | null;
  handoverAt?: string | null;
}

/**
 * Write the state. Upserts on (thread_id, agent_id) — the unique constraint the
 * migration puts there — so a webhook that fires twice cannot open two rows for
 * one conversation.
 *
 * Returns false rather than throwing: a failure to remember where we are must
 * not fail the draft that was just written.
 */
export async function upsertThreadState(input: UpsertStateInput): Promise<boolean> {
  const admin = createAdminSupabase();
  const row: Record<string, unknown> = {
    workspace_id: input.workspaceId,
    thread_id: input.threadId,
    agent_id: input.agentId,
  };
  if (input.status !== undefined) row.status = input.status;
  if (input.step !== undefined) row.step = input.step;
  if (input.answers !== undefined) row.answers = input.answers;
  if (input.stopReason !== undefined) row.stop_reason = input.stopReason;
  if (input.lastInboundMessageId !== undefined) row.last_inbound_message_id = input.lastInboundMessageId;
  if (input.lastActionAt !== undefined) row.last_action_at = input.lastActionAt;
  if (input.sendsAttempted !== undefined) row.sends_attempted = input.sendsAttempted;
  if (input.sendsMade !== undefined) row.sends_made = input.sendsMade;
  if (input.holdReason !== undefined) row.hold_reason = input.holdReason;
  if (input.heldDraftId !== undefined) row.held_draft_id = input.heldDraftId;
  if (input.heldAt !== undefined) row.held_at = input.heldAt;
  if (input.handoverAt !== undefined) row.handover_at = input.handoverAt;

  const { error } = await admin
    .from("agent_thread_state")
    .upsert(row, { onConflict: "thread_id,agent_id" });
  if (error) {
    if (!isMissingTable(error.message)) console.error("[agent-state] upsert failed", error);
    return false;
  }
  return true;
}

/** Everything a live agent wrote and could not send yet. Drives ai/release.ts. */
export async function loadHeldStates(workspaceId: string, limit = 50): Promise<StoredThreadState[]> {
  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from("agent_thread_state")
    .select(COLUMNS)
    .eq("workspace_id", workspaceId)
    .not("hold_reason", "is", null)
    .order("held_at", { ascending: true })
    .limit(limit);
  if (error) {
    if (!isMissingTable(error.message)) console.error("[agent-state] held lookup failed", error);
    return [];
  }
  return (data ?? []).map((r) => toState(r as unknown as Record<string, unknown>));
}
