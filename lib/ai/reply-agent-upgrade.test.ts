/*
 * Copied from BrokerStaffer OS, deliberately.
 *
 * Both apps read the same database and must run the reply agent by the same
 * rules, so this file is kept in step with
 * `src/lib/tools/master-inbox/ai/reply-agent-upgrade.test.ts` in the workspace.
 * If one changes, change the other. There is no shared package between the two
 * deployments.
 *
 *   npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseRunConfig,
  parseSchedule,
  parseQualification,
  parseHandover,
  handoverToJson,
  selectAgentForThread,
  type SelectableAgent,
} from "./agent-config";
import { sendWindow, isWithinBusinessHours, nextWindowOpensAt } from "./schedule";
import {
  advance,
  hasPassed,
  mergeCc,
  planHandover,
  EMPTY_STATE,
  type HandoverContext,
  type QualificationState,
} from "./qualification";
import { renderIntroMacroTemplate } from "../inbox/intro-macro";
import { substituteVariables } from "../inbox/template-variables";
import {
  evaluate,
  looksLikeUnsubscribe,
  looksLikeNeedsHumanReview,
  DEFAULT_LIMITS,
  type SafetyFacts,
} from "./safety";

/*
 * The four decisions this upgrade makes, tested where they are made.
 *
 * Every one of these is a decision that, if wrong, is wrong quietly:
 *
 *   · WHICH AGENT runs on a thread — get it wrong and one client's agent
 *     answers another client's lead.
 *   · WHERE A CONVERSATION HAS GOT TO — get it wrong and the same question is
 *     asked twice, or the last answer is never counted.
 *   · WHETHER IT IS OUT OF HOURS — get it wrong and the after-hours cover the
 *     client is buying sends during their working day instead.
 *   · WHETHER IT IS SAFE TO SEND — get it wrong and a hostile lead gets an
 *     automated reply.
 *   · WHAT THE HANDOVER SAYS AND WHO IT COPIES — get it wrong and a lead is
 *     introduced to the wrong people, or to nobody, in the client's name.
 *
 * None of them can be checked by looking at a screen, which is why they are all
 * pure functions and why the tests are here rather than in a browser.
 */

/* ========================================================================== */
/* 1. Which agent runs on this thread                                          */
/* ========================================================================== */

const agent = (over: Partial<SelectableAgent> = {}): SelectableAgent => ({
  id: "a",
  name: "A",
  active: true,
  created_at: "2026-01-01T00:00:00Z",
  channel_filter: "both",
  channel_ids: [],
  run_mode: "shadow",
  client_ids: [],
  ...over,
});

const CLIENT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const ctx = { clientId: CLIENT, channelId: null, channelType: "email" as const };

test("an agent assigned to the client beats an unassigned house agent", () => {
  const house = agent({ id: "house", created_at: "2025-01-01T00:00:00Z" });
  const mine = agent({ id: "mine", client_ids: [CLIENT] });
  const out = selectAgentForThread([house, mine], ctx);
  assert.equal(out.status, "selected");
  assert.equal(out.status === "selected" && out.agent.id, "mine");
  assert.equal(out.status === "selected" && out.reason, "client_match");
});

test("pausing a client's agent stops the thread — the house agent does NOT inherit it", () => {
  /*
   * The most important line in agent-config.ts. Pause is sold to the client as
   * a kill switch; if a paused agent quietly handed its threads to another
   * agent, the leads would keep being answered by something the client thought
   * they had switched off.
   */
  const house = agent({ id: "house" });
  const mine = agent({ id: "mine", client_ids: [CLIENT], run_mode: "pause" });
  const out = selectAgentForThread([house, mine], ctx);
  assert.equal(out.status, "paused");
  assert.equal(out.status === "paused" && out.agent.id, "mine");
});

test("an agent assigned to a different client never runs on this one", () => {
  const theirs = agent({ id: "theirs", client_ids: [OTHER] });
  assert.equal(selectAgentForThread([theirs], ctx).status, "none");
});

test("a thread with no client still reaches the house agent", () => {
  const house = agent({ id: "house" });
  const out = selectAgentForThread([house], { ...ctx, clientId: null });
  assert.equal(out.status === "selected" && out.reason, "house_agent");
});

test("channel restrictions are applied before client matching", () => {
  const mine = agent({ id: "mine", client_ids: [CLIENT], channel_ids: ["chan-1"] });
  assert.equal(selectAgentForThread([mine], { ...ctx, channelId: "chan-2" }).status, "none");
  assert.equal(
    selectAgentForThread([mine], { ...ctx, channelId: "chan-1" }).status,
    "selected",
  );
});

test("inactive agents are not candidates at all", () => {
  assert.equal(
    selectAgentForThread([agent({ active: false, client_ids: [CLIENT] })], ctx).status,
    "none",
  );
});

test("ties break on the oldest agent, as the pre-upgrade code did", () => {
  const older = agent({ id: "older", created_at: "2024-01-01T00:00:00Z" });
  const newer = agent({ id: "newer", created_at: "2026-06-01T00:00:00Z" });
  const out = selectAgentForThread([newer, older], { ...ctx, clientId: null });
  assert.equal(out.status === "selected" && out.agent.id, "older");
});

/* ========================================================================== */
/* 2. Parsing: every fallback makes the agent do LESS                          */
/* ========================================================================== */

test("a row from before the migration defaults to shadow, not pause", () => {
  // Deploy order is not guaranteed. If an un-migrated row parsed as "pause",
  // shipping this code ahead of the migration would silently stop every agent.
  const cfg = parseRunConfig({});
  assert.equal(cfg.runMode, "shadow");
  assert.deepEqual(cfg.clientIds, []);
  assert.equal(cfg.qualification.enabled, false);
});

test("an unrecognised run_mode is pause", () => {
  assert.equal(parseRunConfig({ run_mode: "LIVE!" }).runMode, "pause");
  assert.equal(parseRunConfig({ run_mode: 7 }).runMode, "pause");
});

test("an unreadable schedule becomes off-hours, not 24/7", () => {
  const s = parseSchedule("nonsense");
  assert.equal(s.kind, "off_hours");
  assert.deepEqual(parseSchedule({ kind: "wat" }).kind, "off_hours");
});

test("an empty business-day list does not turn an off-hours agent into a 24/7 one", () => {
  const s = parseSchedule({ kind: "off_hours", business_days: [] });
  assert.deepEqual(s.businessDays, [1, 2, 3, 4, 5]);
});

test("qualification cannot be enabled with no questions, and `required` is clamped", () => {
  assert.equal(parseQualification({ enabled: true, questions: [] }).enabled, false);
  const q = parseQualification({
    enabled: true,
    questions: [{ text: "Are you licensed?" }, { text: "When are you free?" }],
    required: 9,
  });
  assert.equal(q.enabled, true);
  assert.equal(q.required, 2, "required can never exceed the number of questions");
  assert.equal(q.questions[0]?.id, "q1", "questions get stable ids when none are supplied");
});

test("handover keeps only addresses that look like addresses, and has no Introduction switch", () => {
  const h = parseHandover({
    cc_emails: ["client@example.com", "not an email", "client@example.com"],
    message: "Meet Dana.",
    // Still present in rows saved before the switch was removed. Accepted, ignored.
    mark_introduction: true,
  });
  assert.deepEqual(h.ccEmails, ["client@example.com"]);
  assert.equal("markIntroduction" in h, false, "a live introduction is always labelled; nothing to switch");
  assert.equal("mark_introduction" in handoverToJson(h), false, "and it is no longer written back");
});

/* ========================================================================== */
/* 3. The qualification script                                                 */
/* ========================================================================== */

const script = parseQualification({
  enabled: true,
  questions: [{ text: "Are you licensed in NY?" }, { text: "What times suit you?" }],
  required: 0,
  pass_rule: "all_answered",
});
const now = new Date("2026-08-18T12:00:00Z");

test("the script asks question 1, then 2, then qualifies", () => {
  const first = advance({ config: script, state: EMPTY_STATE, inboundText: "Tell me more", now });
  assert.equal(first.kind, "ask");
  assert.equal(first.kind === "ask" && first.question.text, "Are you licensed in NY?");
  assert.equal(first.kind === "ask" && first.state.step, 1);

  const second = advance({
    config: script,
    state: first.kind === "ask" ? first.state : EMPTY_STATE,
    inboundText: "Yes, licensed since 2019",
    now,
  });
  assert.equal(second.kind, "ask");
  assert.equal(second.kind === "ask" && second.question.text, "What times suit you?");
  assert.equal(
    second.kind === "ask" && second.state.answers[0]?.answer,
    "Yes, licensed since 2019",
    "the answer to question 1 is recorded before question 2 is chosen",
  );

  const third = advance({
    config: script,
    state: second.kind === "ask" ? second.state : EMPTY_STATE,
    inboundText: "Thursday afternoon",
    now,
  });
  assert.equal(third.kind, "qualified");
  assert.equal(third.kind === "qualified" && third.state.answers.length, 2);
});

test("a lead who replies twice before we answer does not fill in two answers", () => {
  const asked: QualificationState = { status: "qualifying", step: 1, answers: [] };
  const first = advance({ config: script, state: asked, inboundText: "Yes", now });
  assert.equal(first.kind === "ask" && first.state.answers.length, 1);
  // Second reply arrives while we are still on step 1 → it is context, not a
  // second answer to a question that was only asked once.
  const again = advance({
    config: script,
    state: first.kind === "ask" ? { ...first.state, step: 1 } : asked,
    inboundText: "…also, what's the pay?",
    now,
  });
  assert.equal(again.kind === "ask" && again.state.answers.length, 1);
});

test("an agent with no script is left alone entirely", () => {
  const off = parseQualification({ enabled: false, questions: [{ text: "x" }] });
  assert.equal(advance({ config: off, state: EMPTY_STATE, inboundText: "hi", now }).kind, "not_qualifying");
});

test("a finished conversation is not restarted by a later reply", () => {
  for (const status of ["handed_over", "stopped"] as const) {
    const out = advance({
      config: script,
      state: { status, step: 2, answers: [] },
      inboundText: "one more thing",
      now,
    });
    assert.equal(out.kind, "finished");
  }
});

test("pass rules: all_answered needs every question, any_answered needs `required`", () => {
  const answers = [{ questionId: "q1", question: "a", answer: "yes", at: "" }];
  assert.equal(hasPassed(script, answers), false);
  const any = parseQualification({
    enabled: true,
    questions: [{ text: "a" }, { text: "b" }],
    required: 1,
    pass_rule: "any_answered",
  });
  assert.equal(hasPassed(any, answers), true);
});

test("blank answers do not count towards the pass rule", () => {
  assert.equal(
    hasPassed(script, [
      { questionId: "q1", question: "a", answer: "   ", at: "" },
      { questionId: "q2", question: "b", answer: "yes", at: "" },
    ]),
    false,
  );
});

/* ========================================================================== */
/* 4. The send window                                                          */
/* ========================================================================== */

const NY = parseSchedule({
  kind: "off_hours",
  timezone: "America/New_York",
  business_days: [1, 2, 3, 4, 5],
  business_start: "09:00",
  business_end: "17:00",
});

test("9-to-5 New York is measured in New York, not in the container's UTC", () => {
  // 2026-08-18 is a Tuesday. 14:00 UTC = 10:00 EDT — inside business hours,
  // even though a UTC reading of "14:00" would also say inside. The case that
  // matters is the one below.
  assert.equal(isWithinBusinessHours(NY, new Date("2026-08-18T14:00:00Z")), true);
  // 21:00 UTC = 17:00 EDT exactly — the window is half-open, so this is OUT.
  assert.equal(isWithinBusinessHours(NY, new Date("2026-08-18T21:00:00Z")), false);
  // 12:30 UTC = 08:30 EDT — before the working day. A naive UTC comparison
  // would call this the middle of the afternoon and refuse to send.
  assert.equal(isWithinBusinessHours(NY, new Date("2026-08-18T12:30:00Z")), false);
});

test("weekends are outside business hours, which is when an off-hours agent works", () => {
  // 2026-08-22 is a Saturday.
  assert.equal(sendWindow(NY, new Date("2026-08-22T15:00:00Z")).open, true);
});

test("a 24/7 schedule is always open", () => {
  assert.equal(sendWindow(parseSchedule({ kind: "always" }), new Date()).open, true);
});

test("a timezone we cannot read holds the reply rather than sending it", () => {
  const broken = { ...NY, timezone: "Mars/Olympus_Mons" };
  const w = sendWindow(broken, new Date("2026-08-22T15:00:00Z"));
  assert.equal(w.open, false);
  assert.equal(w.open === false && w.reason, "schedule_unreadable");
});

test("an end time at or before the start holds everything rather than sending all day", () => {
  const inverted = { ...NY, businessStart: "17:00", businessEnd: "09:00" };
  assert.equal(isWithinBusinessHours(inverted, new Date("2026-08-18T14:00:00Z")), true);
});

test("the next open window is found, and it is after now", () => {
  const at = new Date("2026-08-18T14:00:00Z"); // inside business hours
  const next = nextWindowOpensAt(NY, at);
  assert.ok(next && next.getTime() > at.getTime());
  assert.equal(sendWindow(NY, next!).open, true);
});

/* ========================================================================== */
/* 5. The safety gate                                                          */
/* ========================================================================== */

const safe = (over: Partial<SafetyFacts> = {}): SafetyFacts => ({
  liveSendingEnabled: true,
  runMode: "live",
  doNotContact: false,
  unsubscribeRequested: false,
  hostileReply: false,
  needsHumanReview: false,
  sendsMadeOnThread: 0,
  sendsInRateWindow: 0,
  hasRecipient: true,
  window: { open: true },
  ...over,
});

test("with the env gate off, nothing else can make a send allowed", () => {
  const v = evaluate(safe({ liveSendingEnabled: false }));
  assert.equal(v.allowed, false);
  assert.equal(v.allowed === false && v.reason, "live_disabled");
});

test("shadow and pause never send, even with the env gate on", () => {
  for (const runMode of ["shadow", "pause"] as const) {
    const v = evaluate(safe({ runMode }));
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.reason, "not_live_mode");
  }
});

test("every hard stop is reported as itself", () => {
  const cases: Array<[Partial<SafetyFacts>, string]> = [
    [{ doNotContact: true }, "do_not_contact"],
    [{ unsubscribeRequested: true }, "unsubscribe_requested"],
    [{ hostileReply: true }, "hostile_reply"],
    [{ needsHumanReview: true }, "needs_human_review"],
    [{ hasRecipient: false }, "no_recipient"],
    [{ sendsMadeOnThread: DEFAULT_LIMITS.maxSendsPerThread }, "send_cap_reached"],
    [{ sendsInRateWindow: DEFAULT_LIMITS.maxSendsPerWindow }, "rate_limited"],
  ];
  for (const [facts, reason] of cases) {
    const v = evaluate(safe(facts));
    assert.equal(v.allowed, false, reason);
    assert.equal(v.allowed === false && v.reason, reason);
  }
});

test("a permanent refusal is not retryable; a temporary one is", () => {
  const dnc = evaluate(safe({ doNotContact: true }));
  assert.equal(dnc.allowed === false && dnc.retryable, false);
  const window = evaluate(safe({ window: { open: false, reason: "inside_business_hours" } }));
  assert.equal(window.allowed === false && window.reason, "outside_send_window");
  assert.equal(window.allowed === false && window.retryable, true);
});

test("the schedule is checked LAST, so a hostile thread is never reported as 'held until 6pm'", () => {
  const v = evaluate(safe({ hostileReply: true, window: { open: false, reason: "inside_business_hours" } }));
  assert.equal(v.allowed === false && v.reason, "hostile_reply");
});

test("a clean, in-window, live, enabled send is allowed", () => {
  assert.equal(evaluate(safe()).allowed, true);
});

test("the text signals catch the phrases that actually turn up", () => {
  for (const t of ["Please unsubscribe me", "TAKE ME OFF your list", "stop emailing me"]) {
    assert.equal(looksLikeUnsubscribe(t), true, t);
  }
  for (const t of ["I'm forwarding this to my attorney", "is this a bot?", "where did you get my email"]) {
    assert.equal(looksLikeNeedsHumanReview(t), true, t);
  }
  assert.equal(looksLikeUnsubscribe("Sounds good, send me the details"), false);
  assert.equal(looksLikeNeedsHumanReview("Sounds good, send me the details"), false);
});

/* ========================================================================== */
/* 5. The handover is the introduction                                         */
/* ========================================================================== */

/*
 * The client's instruction, verbatim: "client email should be cc'ed, agent
 * should check the client on each conversation and use the correct cc email.
 * and in place of handover, we can directly use the 'introduce' button
 * functionality."
 *
 * So every test here pins the handover to what the Introduce button does:
 * the body is `renderIntroMacroTemplate` put through `substituteVariables`,
 * and the CC list is the client's own contacts. `EXPECTED_BODY` is built from
 * those two functions on purpose — if the button's wording changes, the
 * handover must change with it, and a hand-written string would hide that.
 */

const ONE = {
  name: "JPAR Iron Horse Real Estate",
  contactName: "Nicole Collins",
  contactRole: "Team Leader",
  contactEmail: "nicole@jpar.example",
  brokerage: "JPAR Iron Horse Real Estate",
};
const TWO = {
  ...ONE,
  extraContacts: [{ name: "Shaurs Patel", role: "Managing Broker", email: "shaurs@jpar.example" }],
};
const THREE = {
  ...ONE,
  extraContacts: [
    { name: "Shaurs Patel", role: "Managing Broker", email: "shaurs@jpar.example" },
    { name: "Dana Ortiz", role: "Owner", email: "dana@jpar.example" },
  ],
};

const variables: HandoverContext["variables"] = {
  lead: {
    name: "Gisele Abrantes Trautman",
    email: "gisele@example.com",
    phone: "555-0100",
    company: "Compass",
    title: "Agent",
  },
  thread: { subject: "Re: opportunity" },
  sender: { name: "Nicole Collins", email: "nicole@gohub.example" },
};

const context = (client: HandoverContext["client"]): HandoverContext => ({
  client,
  unavailableReason: null,
  variables,
});

const noExtras = parseHandover({ cc_emails: [], message: "", mark_introduction: false });

/** Exactly what pressing Introduce in the composer would put in the editor. */
const buttonWouldInsert = (client: NonNullable<HandoverContext["client"]>) =>
  substituteVariables(renderIntroMacroTemplate(client), variables);

test("one contact: the body is the Introduce button's, and the CC is that one person", () => {
  const plan = planHandover(noExtras, context(ONE));
  assert.equal(plan.kind, "introduce");
  if (plan.kind !== "introduce") return;
  assert.equal(plan.body, buttonWouldInsert(ONE));
  assert.equal(
    plan.body.split("\n")[2],
    "I'd like to introduce you to Nicole Collins, Team Leader at JPAR Iron Horse Real Estate",
  );
  assert.equal(plan.body.split("\n")[0], "Hey Gisele,", "the greeting uses the lead's first name");
  assert.deepEqual(plan.cc, ["nicole@jpar.example"]);
  assert.equal(plan.source, "macro");
  assert.equal(plan.body.includes("{{"), false, "every placeholder is resolved");
});

test("two contacts: both are named on the first line and both are copied in, in order", () => {
  const plan = planHandover(noExtras, context(TWO));
  assert.equal(plan.kind, "introduce");
  if (plan.kind !== "introduce") return;
  assert.equal(plan.body, buttonWouldInsert(TWO));
  assert.equal(
    plan.body.split("\n")[2],
    "I'd like to introduce you to Nicole Collins, Team Leader, and Shaurs Patel, Managing Broker at JPAR Iron Horse Real Estate",
  );
  assert.deepEqual(plan.cc, ["nicole@jpar.example", "shaurs@jpar.example"]);
});

test("three contacts: all three named, all three copied", () => {
  const plan = planHandover(noExtras, context(THREE));
  assert.equal(plan.kind, "introduce");
  if (plan.kind !== "introduce") return;
  assert.equal(plan.body, buttonWouldInsert(THREE));
  assert.equal(
    plan.body.split("\n")[2],
    "I'd like to introduce you to Nicole Collins, Team Leader, Shaurs Patel, Managing Broker, and Dana Ortiz, Owner at JPAR Iron Horse Real Estate",
  );
  assert.deepEqual(plan.cc, ["nicole@jpar.example", "shaurs@jpar.example", "dana@jpar.example"]);
});

test("the agent's addresses are extra: merged after the client's, never duplicated", () => {
  const extras = parseHandover({
    cc_emails: ["ops@brokerstaffer.example", "NICOLE@jpar.example", "ops@brokerstaffer.example"],
    message: "",
    mark_introduction: false,
  });
  const plan = planHandover(extras, context(TWO));
  assert.equal(plan.kind, "introduce");
  if (plan.kind !== "introduce") return;
  // Client first, the extra once, and Nicole not a second time in a different case.
  assert.deepEqual(plan.cc, ["nicole@jpar.example", "shaurs@jpar.example", "ops@brokerstaffer.example"]);
  // The extras change who is copied, not what is said.
  assert.equal(plan.body, buttonWouldInsert(TWO));
});

test("a named contact without an address is introduced but not copied", () => {
  const client = { ...ONE, extraContacts: [{ name: "Shaurs Patel", role: "Managing Broker", email: null }] };
  const plan = planHandover(noExtras, context(client));
  assert.equal(plan.kind, "introduce");
  if (plan.kind !== "introduce") return;
  assert.ok(plan.body.includes("Shaurs Patel, Managing Broker"));
  assert.deepEqual(plan.cc, ["nicole@jpar.example"]);
});

test("a client with no introduction details produces a stop, not a body", () => {
  const bare = { name: "Acme Realty", contactName: null, contactRole: null, brokerage: null };
  const plan = planHandover(noExtras, context(bare));
  assert.equal(plan.kind, "stop");
  if (plan.kind !== "stop") return;
  assert.equal(plan.reason, "no_introduction_details");
  assert.ok(plan.detail.includes("Acme Realty"));
  assert.equal("body" in plan, false, "nothing is invented");
});

test("half a contact (a name with no role) is still no introduction", () => {
  const half = { ...ONE, contactRole: "" };
  const plan = planHandover(noExtras, context(half));
  assert.equal(plan.kind, "stop");
  assert.equal(plan.kind === "stop" && plan.reason, "no_introduction_details");
});

test("an override message does not rescue a client with no details — it changes the wording, not the people", () => {
  const withOverride = parseHandover({
    cc_emails: ["ops@brokerstaffer.example"],
    message: "Hi {{lead.first_name}}, meet the team.",
    mark_introduction: false,
  });
  const bare = { name: "Acme Realty", contactName: null, contactRole: null, brokerage: null };
  assert.equal(planHandover(withOverride, context(bare)).kind, "stop");
});

test("a thread with no client stops with its own reason", () => {
  const plan = planHandover(noExtras, {
    client: null,
    unavailableReason: "this conversation is not assigned to a client",
    variables,
  });
  assert.equal(plan.kind, "stop");
  if (plan.kind !== "stop") return;
  assert.equal(plan.reason, "no_client");
  assert.equal(plan.detail, "this conversation is not assigned to a client");
});

test("an override replaces the macro's wording, is substituted, and keeps the client's CC", () => {
  const withOverride = parseHandover({
    cc_emails: [],
    message: "Hi {{lead.first_name}}, meet the team at {{lead.company}}.\n{{sender.name}}",
    mark_introduction: false,
  });
  const plan = planHandover(withOverride, context(TWO));
  assert.equal(plan.kind, "introduce");
  if (plan.kind !== "introduce") return;
  assert.equal(plan.body, "Hi Gisele, meet the team at Compass.\nNicole Collins");
  assert.equal(plan.source, "override");
  assert.deepEqual(plan.cc, ["nicole@jpar.example", "shaurs@jpar.example"]);
});

test("a whitespace-only override is the same as none", () => {
  const blank = parseHandover({ cc_emails: [], message: "   \n ", mark_introduction: false });
  const plan = planHandover(blank, context(ONE));
  assert.equal(plan.kind === "introduce" && plan.source, "macro");
});

test("a lead with no phone or company still gets a sentence, with the gaps emptied as the button does", () => {
  const plan = planHandover(noExtras, {
    client: ONE,
    unavailableReason: null,
    variables: { ...variables, lead: { name: "Gisele Abrantes Trautman", email: "g@example.com" } },
  });
  assert.equal(plan.kind, "introduce");
  if (plan.kind !== "introduce") return;
  assert.equal(
    plan.body,
    substituteVariables(renderIntroMacroTemplate(ONE), {
      ...variables,
      lead: { name: "Gisele Abrantes Trautman", email: "g@example.com" },
    }),
  );
  assert.equal(plan.body.includes("{{"), false);
});

test("mergeCc keeps the first spelling, drops blanks, and never repeats a mailbox", () => {
  assert.deepEqual(
    mergeCc(["A@x.com", " ", "b@x.com"], ["a@X.com", "c@x.com", "B@x.com", "c@x.com"]),
    ["A@x.com", "b@x.com", "c@x.com"],
  );
  assert.deepEqual(mergeCc([], []), []);
});
