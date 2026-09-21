/*
 * Copied from BrokerStaffer OS, deliberately.
 *
 * Both apps read the same database and must run the reply agent by the same
 * rules, so this file is kept in step with
 * `src/lib/tools/master-inbox/ai/stats.ts` in the workspace. If one changes,
 * change the other. There is no shared package between the two deployments.
 */
import { createAdminSupabase } from "@/lib/supabase/admin";

import { describeSchedule } from "./schedule";
import { parseSchedule } from "./agent-config";

/*
 * Per-agent numbers, read once and served twice.
 *
 * ---------------------------------------------------------------------------
 * ONE READER FOR THE PANEL AND THE API
 *
 * Plan §8 asks for a stats panel in the app and a matching endpoint "so an
 * external tool gets all the info about them". Two readers over one view is how
 * those two quietly diverge — a rounding rule here, a renamed field there —
 * until the number on the screen and the number in the client's spreadsheet
 * disagree and nobody can say which is right. So there is one reader, and the
 * panel is a caller of it.
 *
 * ---------------------------------------------------------------------------
 * EVERYTHING IS DERIVED
 *
 * `v_reply_agent_stats` (migration 0010) computes the counts from
 * `reply_drafts`, `agent_thread_state` and `messages`. This file adds no
 * arithmetic beyond formatting — if a number is wrong, it is wrong in the
 * view, which is one place to look.
 */

export interface AgentStatsRow {
  agent_id: string;
  name: string;
  run_mode: string;
  active: boolean;
  client_ids: string[];
  channel_filter: string;
  provider: string;
  model: string;
  tone: string;
  schedule: string;
  qualification: {
    enabled: boolean;
    question_count: number;
    required: number;
    pass_rule: string;
  };
  handover: { cc_count: number };
  stats: {
    replies_drafted: number;
    replies_sent: number;
    drafts_failed: number;
    lead_replies_received: number;
    qualification_started: number;
    qualification_qualified: number;
    qualification_handed_over: number;
    qualification_stopped: number;
    sends_held: number;
    stop_reasons: Record<string, number>;
    reply_rate: number | null;
    qualification_rate: number | null;
    handover_rate: number | null;
    tokens_prompt: number;
    tokens_completion: number;
    tokens_total: number;
  };
  created_at: string;
  updated_at: string;
}

export interface StatsPage {
  rows: AgentStatsRow[];
  total: number;
}

export type StatsRead =
  | { available: true; page: StatsPage }
  /** The view is missing — migration 0010 has not been run. */
  | { available: false; reason: string };

function n(v: unknown): number {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
}

function rate(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function shape(row: Record<string, unknown>): AgentStatsRow {
  const qual = (row.qualification ?? {}) as Record<string, unknown>;
  const questions = Array.isArray(qual.questions) ? qual.questions : [];
  const handover = (row.handover_summary ?? {}) as Record<string, unknown>;
  return {
    agent_id: row.agent_id as string,
    name: (row.name as string) ?? "",
    run_mode: (row.run_mode as string) ?? "shadow",
    active: Boolean(row.active),
    client_ids: Array.isArray(row.client_ids) ? (row.client_ids as string[]) : [],
    channel_filter: (row.channel_filter as string) ?? "both",
    provider: (row.provider as string) ?? "",
    model: (row.model as string) ?? "",
    tone: (row.tone as string) ?? "",
    // Rendered rather than raw: the consumer wants to know what the schedule
    // MEANS, and the jsonb shape is ours to change.
    schedule: describeSchedule(parseSchedule(row.schedule)),
    qualification: {
      enabled: qual.enabled === true,
      question_count: questions.length,
      required: n(qual.required),
      pass_rule: (qual.pass_rule as string) ?? "all_answered",
    },
    // The view still reports handover_summary.mark_introduction for older
    // rows; it is not surfaced — a live introduction is always labelled.
    handover: {
      cc_count: n(handover.cc_count),
    },
    stats: {
      replies_drafted: n(row.replies_drafted),
      replies_sent: n(row.replies_sent),
      drafts_failed: n(row.drafts_failed),
      lead_replies_received: n(row.lead_replies_received),
      qualification_started: n(row.qualification_started),
      qualification_qualified: n(row.qualification_qualified),
      qualification_handed_over: n(row.qualification_handed_over),
      qualification_stopped: n(row.qualification_stopped),
      sends_held: n(row.sends_held),
      stop_reasons: (row.stop_reasons as Record<string, number>) ?? {},
      reply_rate: rate(row.reply_rate),
      qualification_rate: rate(row.qualification_rate),
      handover_rate: rate(row.handover_rate),
      tokens_prompt: n(row.tokens_prompt),
      tokens_completion: n(row.tokens_completion),
      tokens_total: n(row.tokens_total),
    },
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export interface LoadStatsInput {
  workspaceId: string;
  /** ISO-8601 incremental cursor, matching the outcomes feed's contract. */
  updatedSince?: string | null;
  page?: number;
  perPage?: number;
}

export async function loadAgentStats(input: LoadStatsInput): Promise<StatsRead> {
  const page = Math.max(1, input.page ?? 1);
  const perPage = Math.min(Math.max(1, input.perPage ?? 100), 200);
  const from = (page - 1) * perPage;

  const admin = createAdminSupabase();
  let query = admin
    .from("v_reply_agent_stats")
    .select("*", { count: "exact" })
    .eq("workspace_id", input.workspaceId)
    // Stable cursor: (updated_at, agent_id), so paging never dupes or skips —
    // the same ordering rule the outcomes feed uses.
    .order("updated_at", { ascending: true })
    .order("agent_id", { ascending: true })
    .range(from, from + perPage - 1);
  if (input.updatedSince) query = query.gte("updated_at", input.updatedSince);

  const { data, error, count } = await query;
  if (error) {
    const missing =
      error.message.toLowerCase().includes("does not exist") ||
      error.message.toLowerCase().includes("could not find the table") ||
      error.message.toLowerCase().includes("schema cache");
    return {
      available: false,
      reason: missing
        ? "v_reply_agent_stats is missing — run migrations 0009 and 0010"
        : error.message,
    };
  }

  return {
    available: true,
    page: {
      rows: ((data ?? []) as Array<Record<string, unknown>>).map(shape),
      total: count ?? 0,
    },
  };
}
