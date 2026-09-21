/*
 * Copied from BrokerStaffer OS, deliberately.
 *
 * Both apps read the same database and must run the reply agent by the same
 * rules, so this file is kept in step with
 * `src/lib/tools/master-inbox/ai/agent-config.ts` in the workspace. If one changes,
 * change the other. There is no shared package between the two deployments.
 */
/*
 * The agent's configuration, and which agent runs on a thread.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A PURE MODULE
 *
 * Nothing here touches the database or the network. Five jsonb columns arrive
 * as `unknown` from Supabase and leave as typed values with safe defaults, and
 * one function decides which agent owns a conversation. Both are decisions we
 * want to be able to test without a database and to lift into the standalone
 * Master Inbox app unchanged — the upgrade plan puts the config UI there, and
 * this file is the part that must not be rewritten when it moves.
 *
 * ---------------------------------------------------------------------------
 * EVERY PARSER IS TOTAL, AND EVERY DEFAULT IS THE SAFE ONE
 *
 * These columns are edited by people through a UI and read on the path of an
 * inbound webhook. A malformed `schedule` must not throw inside a webhook
 * handler — it must degrade to a configuration that cannot do any harm. So:
 *
 *   run_mode        anything unrecognised → "pause"   (do nothing)
 *   qualification   anything unrecognised → disabled  (no multi-turn script)
 *   handover        anything unrecognised → no extra CC, no Introduction label
 *                   (the client's own contacts are still copied in — they come
 *                   from the client record, not from this column)
 *   schedule        anything unrecognised → off-hours-only, not always-on
 *
 * Note the direction of each fallback: when we cannot understand the config,
 * the agent does LESS, never more. The one that looks backwards is `schedule`
 * — "always" is the permissive value, so an unreadable schedule falls back to
 * the restrictive one.
 */

/** What the agent is allowed to do. Plan §2. */
export type RunMode = "pause" | "shadow" | "live";

export const RUN_MODES: readonly RunMode[] = ["pause", "shadow", "live"] as const;

/** When a LIVE agent may auto-send. Plan §5. */
export interface AgentSchedule {
  /** "always" = 24/7. "off_hours" = only outside business hours / weekends. */
  kind: "always" | "off_hours";
  /** IANA zone, e.g. "America/New_York". Whose clock the window is measured on. */
  timezone: string;
  /** Business days, 0 = Sunday … 6 = Saturday. Outside these, always sendable. */
  businessDays: number[];
  /** "HH:MM", 24h, in `timezone`. */
  businessStart: string;
  businessEnd: string;
}

export interface QualificationQuestion {
  id: string;
  text: string;
}

/** The script the agent works through before a lead is qualified. Plan §7. */
export interface AgentQualification {
  enabled: boolean;
  questions: QualificationQuestion[];
  /** How many answers are needed before handover. 0 = all of them. */
  required: number;
  passRule: "all_answered" | "any_answered";
}

/**
 * How the lead is handed over. Plan §4, as revised by the client.
 *
 * The handover IS an introduction: the body is the introduction macro rendered
 * from the thread's client record, and the CC list is that client's
 * introduction contacts — what the composer's Introduce button produces. So
 * neither field here is the source of truth; see `planHandover` in
 * qualification.ts for how they are used.
 */
export interface AgentHandover {
  /**
   * EXTRA addresses to copy in, on top of the client's introduction contacts.
   * Merged and de-duplicated by `planHandover`; can add a person, never
   * replace the client's own.
   */
  ccEmails: string[];
  /**
   * Optional OVERRIDE of the macro's wording. Empty — the default — means the
   * introduction macro. When set it is used as the body, with the same
   * `{{lead.*}}` / `{{sender.*}}` substitution the macro gets.
   */
  message: string;
  /*
   * There is no "mark as Introduction" switch. A live introduction is always
   * labelled Introduction after it sends (ai/live.ts), through the same guarded
   * path the labels route uses. The stored jsonb may still carry a
   * `mark_introduction` key from before that decision; it is accepted and
   * ignored, so nothing needs a migration.
   */
}

/** The five new columns, parsed. */
export interface AgentRunConfig {
  runMode: RunMode;
  clientIds: string[];
  schedule: AgentSchedule;
  qualification: AgentQualification;
  handover: AgentHandover;
}

/*
 * The defaults, in one place.
 *
 * DEFAULT_SCHEDULE is "always" because that is the column default and because
 * an agent in shadow never consults it. `parseSchedule` does NOT fall back to
 * this on malformed input — see the note at the top of the file.
 */
export const DEFAULT_SCHEDULE: AgentSchedule = {
  kind: "always",
  timezone: "America/New_York",
  businessDays: [1, 2, 3, 4, 5],
  businessStart: "09:00",
  businessEnd: "17:00",
};

/** What an unreadable schedule becomes: the window that sends least. */
const RESTRICTIVE_SCHEDULE: AgentSchedule = { ...DEFAULT_SCHEDULE, kind: "off_hours" };

export const DEFAULT_QUALIFICATION: AgentQualification = {
  enabled: false,
  questions: [],
  required: 0,
  passRule: "all_answered",
};

export const DEFAULT_HANDOVER: AgentHandover = {
  ccEmails: [],
  message: "",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseRunMode(value: unknown): RunMode {
  return value === "shadow" || value === "live" || value === "pause" ? value : "pause";
}

/** `HH:MM`, 24-hour. Anything else is not a time we will act on. */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function parseSchedule(value: unknown): AgentSchedule {
  const raw = asRecord(value);
  if (!raw) return RESTRICTIVE_SCHEDULE;

  const kind = raw.kind === "always" || raw.kind === "off_hours" ? raw.kind : null;
  if (!kind) return RESTRICTIVE_SCHEDULE;
  // "always" carries no window, so nothing below can make it wrong.
  if (kind === "always") return { ...DEFAULT_SCHEDULE, kind: "always" };

  const timezone =
    typeof raw.timezone === "string" && raw.timezone.trim().length > 0
      ? raw.timezone.trim()
      : DEFAULT_SCHEDULE.timezone;

  const days = Array.isArray(raw.business_days)
    ? raw.business_days.filter(
        (d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6,
      )
    : [];

  const start = typeof raw.business_start === "string" && TIME_RE.test(raw.business_start)
    ? raw.business_start
    : DEFAULT_SCHEDULE.businessStart;
  const end = typeof raw.business_end === "string" && TIME_RE.test(raw.business_end)
    ? raw.business_end
    : DEFAULT_SCHEDULE.businessEnd;

  return {
    kind: "off_hours",
    timezone,
    // An empty day list would make every hour "outside business hours" and turn
    // an off-hours agent into a 24/7 one. That is precisely the mistake this
    // module exists to refuse, so we keep the weekday default instead.
    businessDays: days.length > 0 ? [...new Set(days)].sort((a, b) => a - b) : DEFAULT_SCHEDULE.businessDays,
    businessStart: start,
    businessEnd: end,
  };
}

export function scheduleToJson(s: AgentSchedule): Record<string, unknown> {
  return s.kind === "always"
    ? { kind: "always" }
    : {
        kind: "off_hours",
        timezone: s.timezone,
        business_days: s.businessDays,
        business_start: s.businessStart,
        business_end: s.businessEnd,
      };
}

export function parseQualification(value: unknown): AgentQualification {
  const raw = asRecord(value);
  if (!raw) return DEFAULT_QUALIFICATION;

  const questions: QualificationQuestion[] = Array.isArray(raw.questions)
    ? raw.questions
        .map((q, i) => {
          const r = asRecord(q);
          const text = typeof r?.text === "string" ? r.text.trim() : typeof q === "string" ? q.trim() : "";
          if (!text) return null;
          const id = typeof r?.id === "string" && r.id.trim() ? r.id.trim() : `q${i + 1}`;
          return { id, text };
        })
        .filter((q): q is QualificationQuestion => q !== null)
    : [];

  const requiredRaw = typeof raw.required === "number" ? Math.floor(raw.required) : 0;
  // `required` can never exceed the number of questions actually configured —
  // otherwise the pass rule is unsatisfiable and the lead is asked forever.
  const required = Math.max(0, Math.min(requiredRaw, questions.length));

  return {
    // A script with no questions cannot qualify anybody, so `enabled` is only
    // honoured when there is something to ask.
    enabled: raw.enabled === true && questions.length > 0,
    questions,
    required,
    passRule: raw.pass_rule === "any_answered" ? "any_answered" : "all_answered",
  };
}

export function qualificationToJson(q: AgentQualification): Record<string, unknown> {
  return {
    enabled: q.enabled,
    questions: q.questions.map((x) => ({ id: x.id, text: x.text })),
    required: q.required,
    pass_rule: q.passRule,
  };
}

/** Deliberately loose: we are keeping typos out, not validating deliverability. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseHandover(value: unknown): AgentHandover {
  const raw = asRecord(value);
  if (!raw) return DEFAULT_HANDOVER;
  const ccEmails = Array.isArray(raw.cc_emails)
    ? raw.cc_emails
        .filter((e): e is string => typeof e === "string")
        .map((e) => e.trim())
        .filter((e) => EMAIL_RE.test(e))
    : [];
  // `raw.mark_introduction` is deliberately not read — see AgentHandover.
  return {
    ccEmails: [...new Set(ccEmails)],
    message: typeof raw.message === "string" ? raw.message : "",
  };
}

export function handoverToJson(h: AgentHandover): Record<string, unknown> {
  return {
    cc_emails: h.ccEmails,
    message: h.message,
  };
}

/** Every jsonb column at once, for a row straight out of Supabase. */
export function parseRunConfig(row: {
  run_mode?: unknown;
  client_ids?: unknown;
  schedule?: unknown;
  qualification?: unknown;
  handover?: unknown;
}): AgentRunConfig {
  return {
    /*
     * A row from BEFORE migration 0009 has no run_mode at all. That is not a
     * malformed value, it is an un-migrated database, and treating it as
     * "pause" would silently stop every agent drafting the moment this code
     * deployed ahead of the migration. Absent → "shadow" (what the agent does
     * today); present-but-unrecognised → "pause".
     */
    runMode: row.run_mode === undefined || row.run_mode === null ? "shadow" : parseRunMode(row.run_mode),
    clientIds: Array.isArray(row.client_ids)
      ? row.client_ids.filter((c): c is string => typeof c === "string")
      : [],
    schedule: row.schedule === undefined || row.schedule === null
      ? DEFAULT_SCHEDULE
      : parseSchedule(row.schedule),
    qualification: parseQualification(row.qualification),
    handover: parseHandover(row.handover),
  };
}

/* ===========================================================================
   WHICH AGENT RUNS ON THIS THREAD
   =========================================================================== */

export interface SelectableAgent {
  id: string;
  name: string;
  active: boolean;
  created_at: string;
  channel_filter: "email" | "both" | string;
  channel_ids: string[];
  run_mode: RunMode;
  client_ids: string[];
}

export interface ThreadMatchContext {
  /** threads.client_id — null when sync could not attribute the thread. */
  clientId: string | null;
  channelId: string | null;
  channelType: "email";
}

export type SelectionOutcome =
  | { status: "selected"; agent: SelectableAgent; reason: "client_match" | "house_agent" }
  /** An agent IS assigned to this client and it is paused. Nothing else runs. */
  | { status: "paused"; agent: SelectableAgent }
  | { status: "none"; reason: "no_active_agents" | "no_channel_match" };

/**
 * Pick the one agent that owns this conversation.
 *
 * Plan §3: "Matched on the thread's client (and channel). One active agent per
 * client." Two rules do the work, and the second is the one worth stating:
 *
 *   1. An agent assigned to this thread's client wins over an unassigned
 *      "house" agent, always.
 *
 *   2. If this client HAS an assigned agent and that agent is paused, nothing
 *      runs — the house agent does not inherit the thread. Pause is described
 *      in the plan as a kill switch, and a kill switch that quietly hands the
 *      work to somebody else is not one. This is the single most important
 *      line in the file: it is what makes "pause" mean what the client thinks
 *      it means.
 *
 * Ties break on `created_at` ascending, which is the tie-break the existing
 * call sites already use, so behaviour for a workspace that never assigns a
 * client is byte-for-byte what it is today.
 */
export function selectAgentForThread(
  agents: SelectableAgent[],
  ctx: ThreadMatchContext,
): SelectionOutcome {
  const byAge = (a: SelectableAgent, b: SelectableAgent) => (a.created_at < b.created_at ? -1 : 1);

  const activeAgents = agents.filter((a) => a.active);
  if (activeAgents.length === 0) return { status: "none", reason: "no_active_agents" };

  // Channel first — an agent restricted to channels it does not cover is not a
  // candidate for any client. Same predicate the current call sites use.
  const channelMatched = activeAgents
    .filter((a) => a.channel_filter === "both" || a.channel_filter === ctx.channelType)
    .filter((a) => {
      if (a.channel_ids.length === 0) return true;
      return ctx.channelId !== null && a.channel_ids.includes(ctx.channelId);
    });
  if (channelMatched.length === 0) return { status: "none", reason: "no_channel_match" };

  const assignedToThisClient = ctx.clientId
    ? channelMatched.filter((a) => a.client_ids.includes(ctx.clientId as string))
    : [];

  if (assignedToThisClient.length > 0) {
    const runnable = assignedToThisClient.filter((a) => a.run_mode !== "pause").sort(byAge);
    if (runnable.length > 0) return { status: "selected", agent: runnable[0]!, reason: "client_match" };
    // Rule 2: assigned and paused. Stop here rather than falling back.
    return { status: "paused", agent: assignedToThisClient.sort(byAge)[0]! };
  }

  const house = channelMatched.filter((a) => a.client_ids.length === 0);
  const runnable = house.filter((a) => a.run_mode !== "pause").sort(byAge);
  if (runnable.length > 0) return { status: "selected", agent: runnable[0]!, reason: "house_agent" };
  if (house.length > 0) return { status: "paused", agent: house.sort(byAge)[0]! };
  return { status: "none", reason: "no_channel_match" };
}
