/*
 * Copied from BrokerStaffer OS, deliberately.
 *
 * Both apps read the same database and must run the reply agent by the same
 * rules, so this file is kept in step with
 * `src/lib/tools/master-inbox/ai/qualification.ts` in the workspace. If one changes,
 * change the other. There is no shared package between the two deployments.
 */
/*
 * The qualification engine: ask question 1, then question 2, then hand over.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THIS DIFFERENT FROM WHAT THE AGENT DOES TODAY
 *
 * Today every inbound reply is answered from scratch — the agent reads the
 * thread and writes something. That is stateless, and a stateless agent cannot
 * run a script: it has no way of knowing that it already asked about licensing
 * and is waiting for the answer. So the same question gets asked again, or a
 * different one gets asked at random, and the lead is never actually
 * qualified.
 *
 * This module is the missing memory, and it is deliberately the smallest
 * possible one: a step counter and a list of answers. Everything else —
 * writing the words, deciding whether it is safe to send them — lives
 * elsewhere.
 *
 * ---------------------------------------------------------------------------
 * PURE, AND IT NEVER DECIDES TO SEND
 *
 * `advance` takes the config, the stored state and what the lead just said,
 * and returns what SHOULD happen. Persisting it and acting on it belong to
 * thread-state.ts and runtime.ts. That split is what lets the whole script be
 * tested — including the awkward paths, like a lead who replies twice before
 * we answer once — without a database or a model.
 */

import type { AgentHandover, AgentQualification, QualificationQuestion } from "./agent-config";
import {
  hasIntroDetails,
  introContactEmails,
  renderIntroMacroTemplate,
  type IntroMacroClient,
} from "../inbox/intro-macro";
import { substituteVariables, type SubstitutionContext } from "../inbox/template-variables";

export interface QualificationAnswer {
  questionId: string;
  question: string;
  answer: string;
  at: string;
}

/** The persisted shape, mirroring agent_thread_state. */
export interface QualificationState {
  status: "qualifying" | "qualified" | "handed_over" | "stopped";
  /** How many questions have been ASKED. Index of the next one. */
  step: number;
  answers: QualificationAnswer[];
}

export const EMPTY_STATE: QualificationState = { status: "qualifying", step: 0, answers: [] };

export type QualificationAction =
  /** The agent has no script configured — reply as it does today. */
  | { kind: "not_qualifying" }
  /** Nothing to do: this thread is already finished, one way or another. */
  | { kind: "finished"; status: QualificationState["status"] }
  /** Ask this next. `state` is what to persist once it has been asked. */
  | { kind: "ask"; question: QualificationQuestion; state: QualificationState }
  /** The pass rule is satisfied. Hand over. */
  | { kind: "qualified"; state: QualificationState };

export interface AdvanceInput {
  config: AgentQualification;
  state: QualificationState;
  /** What the lead just said. Empty when the agent is opening the conversation. */
  inboundText: string;
  now: Date;
}

/**
 * Has the lead answered enough?
 *
 * `required` is a count, and `passRule` says how to read it:
 *   all_answered — every configured question must have an answer
 *   any_answered — `required` answers are enough, in any order
 *
 * `required = 0` means "all of them", which is what the column default says
 * and what a person who never touched the field would expect.
 */
export function hasPassed(config: AgentQualification, answers: QualificationAnswer[]): boolean {
  const answered = answers.filter((a) => a.answer.trim().length > 0).length;
  if (config.questions.length === 0) return false;
  if (config.passRule === "any_answered") {
    const need = config.required > 0 ? config.required : 1;
    return answered >= need;
  }
  const need = config.required > 0 ? config.required : config.questions.length;
  return answered >= need;
}

/**
 * What should happen on this inbound reply.
 *
 * The order of the two halves matters. We RECORD the answer to the question we
 * last asked before we decide what to ask next — otherwise the final answer is
 * collected but never counted, and a lead who answered everything is asked one
 * question too many.
 */
export function advance(input: AdvanceInput): QualificationAction {
  const { config, state, inboundText, now } = input;

  if (!config.enabled || config.questions.length === 0) return { kind: "not_qualifying" };
  if (state.status === "handed_over" || state.status === "stopped") {
    return { kind: "finished", status: state.status };
  }

  const answers = [...state.answers];

  /*
   * Record the answer to the question we are waiting on.
   *
   * Guarded on `step > answers.length` rather than on `step > 0`: if the lead
   * replies twice before we get a chance to ask the next question, the second
   * reply must not overwrite the first as an answer to the same question. The
   * extra words are still in the thread the model reads; they are simply not a
   * second answer to a question that was only asked once.
   */
  const awaiting = state.step > answers.length ? config.questions[state.step - 1] : undefined;
  if (awaiting && inboundText.trim().length > 0) {
    answers.push({
      questionId: awaiting.id,
      question: awaiting.text,
      answer: inboundText.trim(),
      at: now.toISOString(),
    });
  }

  if (hasPassed(config, answers)) {
    return { kind: "qualified", state: { status: "qualified", step: state.step, answers } };
  }

  const next = config.questions[state.step];
  if (!next) {
    /*
     * Out of questions and the rule is still unsatisfied — which only happens
     * when the lead answered some of them with nothing at all. Treat the script
     * as complete rather than looping: we have asked everything we have, and a
     * human reading the thread is better placed than another automated nudge.
     */
    return { kind: "qualified", state: { status: "qualified", step: state.step, answers } };
  }

  return {
    kind: "ask",
    question: next,
    state: { status: "qualifying", step: state.step + 1, answers },
  };
}

/**
 * The instruction handed to the drafting prompt.
 *
 * Deliberately an instruction about WHAT to cover rather than a script to
 * paste. The corpus and the house style (ai/retrieval.ts) decide how it reads;
 * pasting a fixed sentence would undo all of that and make every agent sound
 * like a form. The one hard rule is the last line: one question, not a list —
 * the manual flow this reproduces asks one thing at a time, and a lead facing
 * an interrogation answers none of it.
 */
export function renderQuestionGuidance(
  question: QualificationQuestion,
  answers: QualificationAnswer[],
): string {
  const lines: string[] = [];
  lines.push("QUALIFICATION");
  lines.push(
    "You are qualifying this lead. Acknowledge what they just said, then ask this one thing:",
  );
  lines.push(`  • ${question.text}`);
  if (answers.length > 0) {
    lines.push("");
    lines.push("Already answered — do not ask again:");
    for (const a of answers) lines.push(`  • ${a.question} → ${a.answer}`);
  }
  lines.push("");
  lines.push("Ask exactly one question. Do not list the remaining questions.");
  return lines.join("\n");
}

/* ===========================================================================
   THE HANDOVER IS AN INTRODUCTION
   =========================================================================== */

/*
 * The handover reply used to be a model-written message with whatever
 * addresses somebody typed into the agent's config on CC. Two things were
 * wrong with that, and the client said both in one breath: "why is it asking
 * me to enter cc emails? client email should be cc'ed … and in place of
 * handover, we can directly use the 'introduce' button functionality."
 *
 * So the handover IS the introduction. The body is the introduction macro
 * rendered from the thread's client record and the CC list is that client's
 * introduction contacts — exactly what the composer's Introduce button inserts
 * and copies in, produced by the same two functions, so the two cannot drift.
 *
 * Pure, like the rest of this module: reading the client record and writing
 * the draft belong to runtime.ts. This decides what the handover would be, or
 * why there cannot be one.
 */

/** What the runtime resolved for the thread's client. */
export interface HandoverContext {
  /**
   * The client's introduction details, from the roster record the thread's
   * `client_id` points at. Null when the thread has no client or the client
   * has no roster record.
   */
  client: IntroMacroClient | null;
  /** Why `client` is null, in words fit for a log line. */
  unavailableReason: string | null;
  /** The lead, the thread and the sender — what `{{lead.*}}` etc. resolve to. */
  variables: SubstitutionContext;
}

export type HandoverPlan =
  | {
      kind: "introduce";
      /** The finished reply, every placeholder resolved. */
      body: string;
      /** Everyone copied in: the client's contacts first, then any extra addresses. */
      cc: string[];
      /** Whether the body came from the macro or from the agent's override text. */
      source: "macro" | "override";
    }
  | {
      /** No introduction can be written. The thread stops; a person picks it up. */
      kind: "stop";
      reason: HandoverStopReason;
      detail: string;
    };

/**
 * The stop reasons, as stored in `agent_thread_state.stop_reason`.
 *
 * Same shape as the safety gate's (`do_not_contact`, `send_cap_reached`): one
 * token, counted by name in the stats view. "no_introduction_details" is the
 * one the client will actually see, and it means exactly what the Introduce
 * button's tooltip means when it is dark.
 */
export type HandoverStopReason = "no_client" | "no_introduction_details";

/**
 * Decide the handover for a qualified lead.
 *
 * ---------------------------------------------------------------------------
 * THE CLIENT RECORD IS THE SOURCE OF TRUTH, THE AGENT'S ADDRESSES ARE EXTRA
 *
 * The CC list starts with `introContactEmails(client)` — up to three people
 * from the roster — and the agent's `handover.ccEmails` are merged in after,
 * de-duplicated case-insensitively. An address typed into the agent can add
 * somebody; it can never replace the client's own contacts.
 *
 * ---------------------------------------------------------------------------
 * NO DETAILS, NO INVENTION
 *
 * A client without a contact name and role has no introduction to make. The
 * old handover would have had the model write something anyway. This one
 * stops the thread instead, with the reason on the state row, and that holds
 * even when the agent carries an override message: the override changes the
 * wording, not who the lead is being introduced to.
 *
 * ---------------------------------------------------------------------------
 * THE OVERRIDE IS A TEMPLATE, NOT AN INSTRUCTION
 *
 * `handover.message`, when set, replaces the macro's wording and goes through
 * the same substitution, so it may use `{{lead.first_name}}` and the rest.
 * Empty — the default — means the macro. It is no longer guidance to the
 * model: the introduction is a fixed message, and the client asked for the
 * button's behaviour, which never involved a model.
 */
export function planHandover(handover: AgentHandover, ctx: HandoverContext): HandoverPlan {
  if (!ctx.client) {
    return {
      kind: "stop",
      reason: "no_client",
      detail: ctx.unavailableReason ?? "this conversation is not assigned to a client",
    };
  }
  if (!hasIntroDetails(ctx.client)) {
    return {
      kind: "stop",
      reason: "no_introduction_details",
      detail:
        ctx.unavailableReason ??
        `${ctx.client.name} has no introduction details (contact name and role) on the roster`,
    };
  }

  const override = handover.message.trim();
  const template = override.length > 0 ? override : renderIntroMacroTemplate(ctx.client);

  return {
    kind: "introduce",
    body: substituteVariables(template, ctx.variables),
    cc: mergeCc(introContactEmails(ctx.client), handover.ccEmails),
    source: override.length > 0 ? "override" : "macro",
  };
}

/**
 * The client's contacts first, then the extras, no address twice.
 *
 * Case-insensitive on purpose — `Nicole@x.com` and `nicole@x.com` are the same
 * mailbox, and copying it twice looks careless to the person receiving it.
 * The first spelling seen is the one kept.
 */
export function mergeCc(primary: string[], extra: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...primary, ...extra]) {
    const email = raw.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}
