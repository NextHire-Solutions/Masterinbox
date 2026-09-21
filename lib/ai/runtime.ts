/*
 * Copied from BrokerStaffer OS, deliberately.
 *
 * Both apps read the same database and must run the reply agent by the same
 * rules, so this file is kept in step with
 * `src/lib/tools/master-inbox/ai/runtime.ts` in the workspace. If one changes,
 * change the other. There is no shared package between the two deployments.
 */
import { createDraftForAgent, loadAgentWithKey, loadAgents, type ReplyAgent } from "./agent";
import { selectAgentForThread, type SelectableAgent } from "./agent-config";
import {
  advance,
  planHandover,
  renderQuestionGuidance,
  EMPTY_STATE,
  type HandoverPlan,
  type QualificationState,
} from "./qualification";
import { attemptLiveSend } from "./live";
import { gatherSafetyFacts } from "./safety-facts";
import { evaluate } from "./safety";
import { loadThreadState, upsertThreadState, type StoredThreadState } from "./thread-state";
import type { ConversationTurn, LeadFact } from "./reply";
import type { IntroMacroClient } from "../inbox/intro-macro";

/*
 * What the reply agent does when a lead replies.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE FILE THE PLAN'S §3 DIAGRAM DESCRIBES
 *
 *   lead reply arrives
 *     → pick the active agent for this client        agent-config.ts
 *     → branch on its mode:  pause → stop
 *                            shadow → draft, never send
 *                            live → continue
 *     → work the qualification script                qualification.ts
 *     → draft in the house voice                     agent.ts + retrieval.ts
 *       … or, when qualified, the introduction       qualification.ts (planHandover)
 *     → safety gate, then send                       live.ts + safety.ts
 *     → hand over by CC when qualified               live.ts
 *
 * Every step is a separate module and this one only sequences them, which is
 * deliberate: the plan puts the finished feature in the standalone MasterInbox
 * app, and a port that has to re-derive the sequencing is a port that changes
 * behaviour. Nothing here imports a route, a React component or a workspace
 * helper — only the engine and Supabase.
 *
 * ---------------------------------------------------------------------------
 * IT RETURNS AN OUTCOME AND IT NEVER THROWS
 *
 * The call sites are webhook handlers (EmailBison, Instantly), which must ack
 * the provider whatever happened in here. Every failure is a value.
 */

export interface RunAgentInput {
  workspaceId: string;
  threadId: string;
  channelId: string | null;
  /** threads.client_id — which client's conversation this is. */
  clientId: string | null;
  /** The inbound message that triggered this run; guards against double-acting. */
  inboundMessageId: string | null;
  inboundText: string | null;
  leadName: string | null;
  leadEmail: string | null;
  /*
   * The rest of what the introduction macro asks for — `{{lead.phone_number}}`,
   * `{{lead.company}}`, `{{lead.title}}` — read the way the thread view reads
   * them for the composer, so the agent's handover and the Introduce button
   * fill the same gaps with the same values.
   */
  leadPhone: string | null;
  leadCompany: string | null;
  leadTitle: string | null;
  /** Everything else enrichment knows, minus the commercially sensitive. */
  leadFacts: LeadFact[];
  ourName: string | null;
  ourEmail: string | null;
  /**
   * What `{{sender.name}}` resolves to: the sending channel's display name,
   * which is what the composer passes as `fromName`. Kept apart from
   * `ourName` so the drafting prompt for ordinary replies is unchanged.
   */
  senderName: string | null;
  subject: string | null;
  /** Full thread, oldest → newest, exactly as createDraftForAgent wants it. */
  conversation: ConversationTurn[];
  /**
   * Who the handover introduces the lead to: the thread's client, resolved
   * from `threads.client_id` → `os_clients.mi_client_id` by
   * `resolveIntroduction`. Null client means there is nobody to introduce
   * them to, and a qualified lead stops rather than gets an invented one.
   */
  introduction: IntroductionSource;
  now?: Date;
  /*
   * Work out what would happen and stop short of doing it: no model call, no
   * `reply_drafts` row, no state write, no send attempt. The safety gate still
   * runs, because it only reads.
   *
   * This exists so the feature can be VERIFIED against real threads — the
   * right agent is selected, the right question is next, the gate refuses for
   * the right reason — without putting a draft in front of an operator or
   * spending a token. It is what scripts/reply-agent-workflow-test.mjs drives.
   */
  dryRun?: boolean;
}

/** The thread's client, as the introduction macro needs it. */
export interface IntroductionSource {
  client: IntroMacroClient | null;
  /** Why `client` is null, in words fit for a log line and a stop reason. */
  unavailableReason: string | null;
}

/** What the handover would be, or was — the body a person sees and who is copied. */
export interface HandoverSummary {
  body: string;
  /** Everyone who WOULD be copied in. In shadow nothing is sent, so this is the record of it. */
  cc: string[];
  source: "macro" | "override";
}

export type RunAgentOutcome =
  | { status: "no_agent"; reason: string }
  | { status: "paused"; agentId: string; agentName: string }
  | { status: "already_handled"; agentId: string }
  | { status: "finished"; agentId: string; state: QualificationState["status"] }
  | { status: "no_key"; agentId: string; agentName: string }
  | { status: "draft_failed"; agentId: string; error: string }
  | {
      /**
       * The lead qualified but there is no introduction to make: the thread
       * has no client, or the client has no introduction details. The state
       * row says `stopped` with the reason, and a person takes it from here.
       */
      status: "stopped";
      agentId: string;
      agentName: string;
      reason: string;
      detail: string;
    }
  | {
      /** dryRun only: the lead would qualify and the thread would stop, as above. */
      status: "would_stop";
      agentId: string;
      agentName: string;
      reason: string;
      detail: string;
    }
  | {
      /** dryRun only: everything decided, nothing done. */
      status: "would_draft";
      agentId: string;
      agentName: string;
      intent: "question" | "handover" | "reply";
      mode: "shadow" | "live";
      /** The instruction that would have been appended to the prompt. Null for the handover, which has no prompt. */
      guidance: string | null;
      /** Present when intent is handover: the introduction exactly as it would go out. */
      handover?: HandoverSummary;
      /** Present when mode would be live: what the gate says right now. */
      gate?: { allowed: boolean; reason?: string; detail?: string };
    }
  | {
      status: "drafted";
      agentId: string;
      agentName: string;
      draftId: string;
      /** What this draft is: the next qualification question, the handover, or a plain reply. */
      intent: "question" | "handover" | "reply";
      mode: "shadow" | "live";
      /**
       * Present when intent is handover. `reply_drafts` has no CC column, so
       * this is where the addresses that would be copied in are recorded for
       * a shadow draft; the body is what the draft row holds.
       */
      handover?: HandoverSummary;
      /** Present when mode was live: what the gate did with it. */
      live?: { status: "sent" | "held"; reason?: string; detail?: string };
    };

function toSelectable(a: ReplyAgent): SelectableAgent {
  return {
    id: a.id,
    name: a.name,
    active: a.active,
    created_at: a.created_at,
    channel_filter: a.channel_filter,
    channel_ids: a.channel_ids,
    run_mode: a.run_mode,
    client_ids: a.client_ids,
  };
}

function asQualificationState(state: StoredThreadState | null): QualificationState {
  return state ? { status: state.status, step: state.step, answers: state.answers } : EMPTY_STATE;
}

export async function runReplyAgentOnInbound(input: RunAgentInput): Promise<RunAgentOutcome> {
  const now = input.now ?? new Date();

  // ---- 1. which agent owns this conversation ------------------------------
  const agents = await loadAgents(input.workspaceId);
  const selection = selectAgentForThread(agents.map(toSelectable), {
    clientId: input.clientId,
    channelId: input.channelId,
    channelType: "email",
  });
  if (selection.status === "none") return { status: "no_agent", reason: selection.reason };
  if (selection.status === "paused") {
    /*
     * The one place "pause" becomes real. Note what does NOT happen: no draft,
     * no state write, no fallback to another agent. Plan §2 calls pause the
     * kill switch, and a kill switch has to be silent as well as inert.
     */
    return { status: "paused", agentId: selection.agent.id, agentName: selection.agent.name };
  }
  const agent = agents.find((a) => a.id === selection.agent.id)!;

  // ---- 2. where this conversation had got to ------------------------------
  const read = await loadThreadState(input.threadId, agent.id);
  const stored = read.available ? read.state : null;
  if (!read.available) {
    // Migration 0009 has not run. The agent still drafts — it simply cannot
    // remember a script. Said once per run, at warn, so it is visible in logs
    // without drowning them.
    console.warn(`[agent] ${read.reason}; running without qualification state`);
  }

  /*
   * Idempotency. Providers retry webhooks and the sync workers re-read
   * conversations; acting twice on one inbound message would ask the same
   * question twice and — in live mode — send twice.
   */
  if (stored && input.inboundMessageId && stored.lastInboundMessageId === input.inboundMessageId) {
    return { status: "already_handled", agentId: agent.id };
  }

  // ---- 3. what the script says to do next ---------------------------------
  const action = advance({
    config: agent.qualification,
    state: asQualificationState(stored),
    inboundText: input.inboundText ?? "",
    now,
  });
  if (action.kind === "finished") {
    return { status: "finished", agentId: agent.id, state: action.status };
  }

  let guidanceSuffix: string | undefined;
  let intent: "question" | "handover" | "reply" = "reply";
  let handoverPlan: HandoverPlan | null = null;
  let qualifiedState: QualificationState | null = null;
  if (action.kind === "ask") {
    guidanceSuffix = renderQuestionGuidance(action.question, action.state.answers);
    intent = "question";
  } else if (action.kind === "qualified") {
    /*
     * The handover is the introduction: the macro rendered from the client's
     * record with the client's contacts on CC, exactly what the composer's
     * Introduce button produces. No model is involved — see `planHandover`
     * for why — so there is no guidance to append.
     */
    intent = "handover";
    qualifiedState = action.state;
    handoverPlan = planHandover(agent.handover, {
      client: input.introduction.client,
      unavailableReason: input.introduction.unavailableReason,
      variables: {
        lead: {
          name: input.leadName,
          email: input.leadEmail,
          phone: input.leadPhone,
          company: input.leadCompany,
          title: input.leadTitle,
        },
        thread: { subject: input.subject },
        sender: { name: input.senderName, email: input.ourEmail },
      },
    });
  }

  // ---- 3b. a qualified lead with nobody to introduce them to -------------
  if (handoverPlan && handoverPlan.kind === "stop") {
    /*
     * Not a draft, not a hold: a stop. The old handover would have had the
     * model write an introduction to nobody in particular. This one refuses
     * to invent an introduction and leaves the thread for a person, with the
     * reason on the state row where the screen and the stats view read it.
     */
    if (input.dryRun) {
      return {
        status: "would_stop",
        agentId: agent.id,
        agentName: agent.name,
        reason: handoverPlan.reason,
        detail: handoverPlan.detail,
      };
    }
    if (read.available) {
      await upsertThreadState({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        agentId: agent.id,
        status: "stopped",
        step: qualifiedState?.step,
        answers: qualifiedState?.answers,
        stopReason: handoverPlan.reason,
        lastInboundMessageId: input.inboundMessageId ?? null,
        lastActionAt: now.toISOString(),
      });
    }
    console.warn(
      `[agent] stopped thread=${input.threadId} agent=${agent.id} reason=${handoverPlan.reason} — ${handoverPlan.detail}`,
    );
    return {
      status: "stopped",
      agentId: agent.id,
      agentName: agent.name,
      reason: handoverPlan.reason,
      detail: handoverPlan.detail,
    };
  }
  const handover: HandoverSummary | undefined =
    handoverPlan && handoverPlan.kind === "introduce"
      ? { body: handoverPlan.body, cc: handoverPlan.cc, source: handoverPlan.source }
      : undefined;

  // ---- 4. write the reply -------------------------------------------------
  if (input.dryRun) {
    /*
     * Stop here. Everything above was a read; everything below writes a draft,
     * moves the script on, or tries to send. The gate is still evaluated,
     * because a dry run that skipped it would not tell you the one thing you
     * most want to know before going live: what would have stopped it.
     */
    let gate: { allowed: boolean; reason?: string; detail?: string } | undefined;
    if (agent.run_mode === "live") {
      const facts = await gatherSafetyFacts({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        agentId: agent.id,
        runMode: agent.run_mode,
        schedule: agent.schedule,
        lastInboundText: input.inboundText,
        hasRecipient: Boolean(input.leadEmail),
        now,
      });
      const verdict = evaluate(facts);
      gate = verdict.allowed
        ? { allowed: true }
        : { allowed: false, reason: verdict.reason, detail: verdict.detail };
    }
    return {
      status: "would_draft",
      agentId: agent.id,
      agentName: agent.name,
      intent,
      mode: agent.run_mode === "live" ? "live" : "shadow",
      guidance: guidanceSuffix ?? null,
      handover,
      gate,
    };
  }

  let draft: { draftId: string; body: string };
  if (handover) {
    /*
     * The introduction is a fixed message, so it does not go through the
     * model and does not need the agent's API key. It is still a
     * `reply_drafts` row on this agent, because that row is how a shadow draft
     * reaches a person: the thread view seeds the composer with it, where the
     * Introduce button still works exactly as before.
     */
    const inserted = await insertHandoverDraft({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      agentId: agent.id,
      body: handover.body,
    });
    if (inserted.status !== "ok") {
      return { status: "draft_failed", agentId: agent.id, error: inserted.error };
    }
    draft = { draftId: inserted.draftId, body: handover.body };
  } else {
    const full = await loadAgentWithKey(agent.id);
    if (!full || !full.api_key) {
      return { status: "no_key", agentId: agent.id, agentName: agent.name };
    }

    const written = await createDraftForAgent({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      agent: full,
      leadName: input.leadName,
      leadEmail: input.leadEmail,
      /*
       * Resolved for the introduction macro and then dropped one line before
       * the draft, so the model wrote every reply knowing only a name and an
       * address — and asked for the rest.
       */
      leadPhone: input.leadPhone,
      leadCompany: input.leadCompany,
      leadTitle: input.leadTitle,
      leadFacts: input.leadFacts,
      ourName: input.ourName,
      ourEmail: input.ourEmail,
      subject: input.subject,
      conversation: input.conversation,
      guidanceSuffix,
    });
    if (written.status !== "ok") {
      /*
       * No state advance on a failed draft. If the model 500s, the question was
       * never asked, and recording that we asked it would skip it forever.
       */
      const error =
        written.status === "no_key"
          ? "no api key"
          : written.status === "insert_failed"
            ? written.error
            : written.error;
      return { status: "draft_failed", agentId: agent.id, error };
    }
    draft = { draftId: written.draftId, body: written.body };
  }

  // ---- 5. remember where we are -------------------------------------------
  if (action.kind !== "not_qualifying") {
    await upsertThreadState({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      agentId: agent.id,
      status: action.state.status,
      step: action.state.step,
      answers: action.state.answers,
      lastInboundMessageId: input.inboundMessageId ?? null,
      lastActionAt: now.toISOString(),
    });
  } else if (read.available) {
    /*
     * An agent with no script still gets a state row, holding nothing but the
     * message it last acted on. Two reasons: the idempotency check above needs
     * somewhere to look, and `v_reply_agent_stats` counts lead replies through
     * this table — without a row, an agent that drafts but does not qualify
     * would report zero conversations.
     */
    await upsertThreadState({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      agentId: agent.id,
      lastInboundMessageId: input.inboundMessageId ?? null,
      lastActionAt: now.toISOString(),
    });
  }

  // ---- 6. shadow stops here ------------------------------------------------
  if (agent.run_mode !== "live") {
    if (handover) {
      // Nothing is sent in shadow, so the CC list has nowhere to live but the
      // log and the outcome. Said once, at info, so a person checking what
      // the agent WOULD have done can see who it would have copied.
      console.info(
        `[agent] shadow handover thread=${input.threadId} draft=${draft.draftId} ` +
          `would cc ${handover.cc.length > 0 ? handover.cc.join(", ") : "nobody"} (${handover.source})`,
      );
    }
    return {
      status: "drafted",
      agentId: agent.id,
      agentName: agent.name,
      draftId: draft.draftId,
      intent,
      mode: "shadow",
      handover,
    };
  }

  // ---- 7. live: the gate, and then (not) the send --------------------------
  const live = await attemptLiveSend({
    agent,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    draftId: draft.draftId,
    body: draft.body,
    subject: input.subject,
    toEmail: input.leadEmail,
    lastInboundText: input.inboundText,
    isHandover: intent === "handover",
    cc: handover?.cc ?? [],
    leadName: input.leadName,
    state: stored,
    now,
  });

  return {
    status: "drafted",
    agentId: agent.id,
    agentName: agent.name,
    draftId: draft.draftId,
    intent,
    mode: "live",
    handover,
    live:
      live.status === "sent"
        ? { status: "sent" }
        : { status: "held", reason: live.reason, detail: live.detail },
  };
}

/*
 * The introduction draft: a fixed body, straight into `reply_drafts`.
 *
 * Deliberately NOT `createDraftForAgent`: that function is the model path —
 * it gathers guidance, calls the provider and records tokens — and an
 * introduction has none of those. Same table, same `status: "pending"`, same
 * `agent_id`, so everything that reads drafts (the thread view, the stats
 * view, the corpus) sees this one exactly as it sees any other.
 */
async function insertHandoverDraft(input: {
  workspaceId: string;
  threadId: string;
  agentId: string;
  body: string;
}): Promise<{ status: "ok"; draftId: string } | { status: "insert_failed"; error: string }> {
  const { createAdminSupabase } = await import("@/lib/supabase/admin");
  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from("reply_drafts")
    .insert({
      workspace_id: input.workspaceId,
      thread_id: input.threadId,
      agent_id: input.agentId,
      status: "pending",
      generated_body: input.body,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[agent] failed to insert the handover draft", error);
    return { status: "insert_failed", error: error?.message ?? "Insert failed" };
  }
  return { status: "ok", draftId: data.id as string };
}

/*
 * The one-line entry point.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *
 * Three places already assemble the same context by hand before drafting — the
 * composer's AI Reply route and the two sync workers — and each does it
 * slightly differently (one reads the lead from `leads`, two take it from the
 * webhook payload). Every one of them would have to grow the client id, the
 * inbound message id and the inbound text to reach the new engine.
 *
 * So the assembly lives here, once, and a call site becomes:
 *
 *     await runReplyAgentForThread(workspaceId, threadId);
 *
 * That is exactly what the two sync workers do — sync/emailbison.ts and
 * sync/instantly.ts call this in place of their old "pick the first active
 * agent and draft" block — so the engine runs on every inbound reply.
 *
 * `options.ourName`: the EmailBison webhook carries the sender mailbox's
 * display name, and the old block passed it through to the prompt ("Your name
 * (the sender): …"). The thread row does not store it, so the worker hands it
 * in here rather than lose it. Optional; absent, the prompt says "You".
 */
export async function runReplyAgentForThread(
  workspaceId: string,
  threadId: string,
  options: { now?: Date; dryRun?: boolean; ourName?: string | null } = {},
): Promise<RunAgentOutcome> {
  const input = await assembleRunInput(workspaceId, threadId);
  if (!input) return { status: "no_agent", reason: "thread not found" };
  return runReplyAgentOnInbound({
    ...input,
    ourName: options.ourName ?? input.ourName,
    now: options.now,
    dryRun: options.dryRun,
  });
}

/**
 * Everything `runReplyAgentOnInbound` needs, read from the database.
 *
 * Exported on its own — and read-only by construction — so a script can see
 * exactly what the engine would see for a real thread (which client, which
 * contacts, which lead values) without running the agent on it. That is what
 * scripts/reply-agent-handover-test.mjs does.
 */
export async function assembleRunInput(
  workspaceId: string,
  threadId: string,
): Promise<Omit<RunAgentInput, "now" | "dryRun"> | null> {
  const { createAdminSupabase } = await import("@/lib/supabase/admin");
  const admin = createAdminSupabase();

  const { data: thread } = await admin
    .from("threads")
    .select("id, workspace_id, subject, channel_id, lead_id, client_id, outbound_sender_email")
    .eq("id", threadId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!thread) return null;

  const { data: allMessages } = await admin
    .from("messages")
    .select("id, direction, subject, body_text, body_html, sent_at")
    .eq("thread_id", threadId)
    .order("sent_at", { ascending: true });

  const stripHtml = (html: string) =>
    html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const messages = allMessages ?? [];
  const conversation: ConversationTurn[] = messages.map((m) => ({
    direction: m.direction as "inbound" | "outbound",
    sentAt: (m.sent_at as string | null) ?? null,
    body: (m.body_text as string | null) ?? stripHtml((m.body_html as string | null) ?? ""),
  }));
  const lastInbound = [...messages].reverse().find((m) => m.direction === "inbound");

  let leadName: string | null = null;
  let leadEmail: string | null = null;
  let leadPhone: string | null = null;
  let leadCompany: string | null = null;
  let leadTitle: string | null = null;
  let leadFacts: LeadFact[] = [];
  if (thread.lead_id) {
    const { data: lead } = await admin
      .from("leads")
      .select("full_name, email, company, title, custom_fields")
      .eq("id", thread.lead_id)
      .maybeSingle();
    leadName = (lead?.full_name as string | null) ?? null;
    leadEmail = ((lead?.email as string | null) ?? "").trim() || null;
    /*
     * Phone, company and title, read the way the thread view reads them for
     * the composer. The lead row has no phone column; the enrichment payloads
     * put it in `custom_fields` under a handful of keys, and the same keys are
     * tried here in the same order so the agent and the button agree.
     */
    const cf = (lead?.custom_fields ?? null) as Record<string, unknown> | null;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
    leadCompany = str(lead?.company) ?? str(cf?.company) ?? str(cf?.Company) ?? null;
    leadTitle = str(lead?.title) ?? str(cf?.title) ?? str(cf?.Title) ?? null;
    leadPhone =
      str(cf?.phone) ??
      str(cf?.Phone) ??
      str(cf?.["phone number"]) ??
      str(cf?.phone_number) ??
      str(cf?.mobile) ??
      null;

    /*
     * The rest of what enrichment found, for the model to use rather than ask
     * for — office city, licence, brokerage and whatever a campaign attached.
     *
     * NOT the whole object. The keys already surfaced above would appear twice
     * under different names, and these payloads carry sales volume and
     * commission estimates. A reply opening "I see you did $4.8m buy-side" is
     * not warmer, it is alarming.
     */
    const SENSITIVE = /gci|commission|volume|buy.?side|list.?side|sales|income|revenue|price/i;
    const ALREADY = /^(phone|company|title|email|name|first|last)/i;
    leadFacts = Object.entries(cf ?? {})
      .filter(([k, v]) => typeof v === "string" && v.trim() && !SENSITIVE.test(k) && !ALREADY.test(k))
      .slice(0, 12)
      .map(([k, v]) => ({ label: k.replace(/[_-]+/g, " ").trim(), value: String(v).slice(0, 120) }));
  }

  // `{{sender.name}}` — the channel's display name, as the composer has it.
  let senderName: string | null = null;
  if (thread.channel_id) {
    const { data: channel } = await admin
      .from("channels")
      .select("display_name")
      .eq("id", thread.channel_id as string)
      .maybeSingle();
    senderName = ((channel?.display_name as string | null) ?? "").trim() || null;
  }

  const clientId = (thread.client_id as string | null) ?? null;
  const introduction = await resolveIntroduction(clientId);

  return {
    workspaceId,
    threadId,
    channelId: (thread.channel_id as string | null) ?? null,
    clientId,
    inboundMessageId: (lastInbound?.id as string | null) ?? null,
    inboundText:
      (lastInbound?.body_text as string | null) ??
      (lastInbound ? stripHtml((lastInbound.body_html as string | null) ?? "") : null),
    leadName,
    leadEmail,
    leadPhone,
    leadCompany,
    leadTitle,
    leadFacts,
    ourName: null,
    ourEmail: (thread.outbound_sender_email as string | null) ?? null,
    senderName,
    subject: (lastInbound?.subject as string | null) ?? (thread.subject as string | null) ?? null,
    conversation,
    introduction,
  };
}

/**
 * The thread's client, as the introduction macro needs it.
 *
 * The same lookup the intro-macro route makes for the Introduce button:
 * `threads.client_id` names a Master Inbox client, and the introduction
 * details live on the roster record keyed to it by `os_clients.mi_client_id`.
 * A missing table, a client with no roster record and a client that was never
 * assigned are all "nobody to introduce them to" rather than failures — the
 * handover stops with the reason, it does not throw inside a webhook.
 */
export async function resolveIntroduction(clientId: string | null): Promise<IntroductionSource> {
  if (!clientId) {
    return { client: null, unavailableReason: "this conversation is not assigned to a client" };
  }
  const { createAdminSupabase } = await import("@/lib/supabase/admin");
  const admin = createAdminSupabase();

  const { data: miClient } = await admin
    .from("clients")
    .select("id, name")
    .eq("id", clientId)
    .maybeSingle();
  const clientName = (miClient?.name as string | undefined) ?? "this client";

  let row: Record<string, unknown> | null = null;
  try {
    const { data, error } = await admin
      .from("os_clients")
      .select(
        "name, contact_name, contact_role, contact_email, " +
          "contact2_name, contact2_role, contact2_email, " +
          "contact3_name, contact3_role, contact3_email, brokerage",
      )
      .eq("mi_client_id", clientId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    row = (data as Record<string, unknown> | null) ?? null;
  } catch (err) {
    return {
      client: null,
      unavailableReason: `the introduction details for ${clientName} could not be read (${
        err instanceof Error ? err.message : String(err)
      })`,
    };
  }
  if (!row) {
    return {
      client: null,
      unavailableReason: `${clientName} is not on the workspace roster, so it has no introduction details`,
    };
  }

  const str = (k: string) => (row?.[k] as string | null) ?? null;
  return {
    client: {
      name: (row.name as string | null) ?? clientName,
      contactName: str("contact_name"),
      contactRole: str("contact_role"),
      contactEmail: str("contact_email"),
      // The second and third people, when this client has them. Anyone without
      // both a name and a role is ignored by the macro.
      extraContacts: [2, 3].map((n) => ({
        name: str(`contact${n}_name`),
        role: str(`contact${n}_role`),
        email: str(`contact${n}_email`),
      })),
      brokerage: str("brokerage"),
    },
    unavailableReason: null,
  };
}
