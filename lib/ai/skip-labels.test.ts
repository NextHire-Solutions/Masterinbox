/*
 * "Enable AI Reply Agent to respond to all categories except Interested"
 * (13 Oct). An agent has a list of categories it leaves to a person; a
 * conversation carrying one is not drafted for, not sent to, and not written
 * about. These tests pin the rule and — against the in-memory database — that
 * a skipped conversation really does cost nothing and touch nothing.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SKIP_LABELS, labelLeftToAPerson, parseQualification, parseSkipLabels, qualificationToJson,
} from "./agent-config";
import { configureFakeEnvironment, FakePostgrest } from "../test/fake-postgrest";

test("the default: an agent that was never told leaves Interested to a person", () => {
  assert.deepEqual([...DEFAULT_SKIP_LABELS], ["Interested"]);
  assert.deepEqual(parseSkipLabels(undefined), ["Interested"]);
  assert.deepEqual(parseSkipLabels(null), ["Interested"]);
  assert.deepEqual(parseSkipLabels("Interested"), ["Interested"], "not a list: the default, not a guess");
  assert.deepEqual(parseQualification(null).skipLabels, ["Interested"]);
  assert.deepEqual(parseQualification({ enabled: false, questions: [] }).skipLabels, ["Interested"], "a row saved before the setting existed");
});

test("an EMPTY list is a choice — answer every category — and is kept", () => {
  assert.deepEqual(parseSkipLabels([]), []);
  assert.deepEqual(parseQualification({ questions: [], skip_labels: [] }).skipLabels, []);
});

test("a saved list: trimmed, blanks and repeats dropped, capped", () => {
  assert.deepEqual(parseSkipLabels([" Interested ", "interested", "", "Meeting Booked", 7, null]), ["Interested", "Meeting Booked"]);
  assert.equal(parseSkipLabels(Array.from({ length: 50 }, (_, i) => `L${i}`)).length, 20);
});

test("the list survives being saved and read back", () => {
  const q = parseQualification({ enabled: true, questions: [{ id: "q1", text: "Licensed?" }], required: 1, pass_rule: "all_answered", skip_labels: ["Interested", "Meeting Booked"] });
  const again = parseQualification(qualificationToJson(q));
  assert.deepEqual(again, q);
  assert.deepEqual(qualificationToJson(parseQualification({ questions: [], skip_labels: [] })).skip_labels, []);
});

test("matching is the exact label name, in any case — never a label that merely contains it", () => {
  assert.equal(labelLeftToAPerson(["Interested"], ["Interested"]), "Interested");
  assert.equal(labelLeftToAPerson(["  interested "], ["INTERESTED"]), "  interested ");
  assert.equal(labelLeftToAPerson(["Not Interested"], ["Interested"]), null, "the opposite category must still be answered");
  assert.equal(labelLeftToAPerson(["Interested - follow up"], ["Interested"]), null);
  assert.equal(labelLeftToAPerson(["Out of Office", "Meeting Booked"], ["Interested", "Meeting Booked"]), "Meeting Booked");
  assert.equal(labelLeftToAPerson([], ["Interested"]), null, "an unlabelled reply is answered");
  assert.equal(labelLeftToAPerson(["Interested"], []), null, "no list, nothing is skipped");
  assert.equal(labelLeftToAPerson(["Interested"], ["", "  "]), null);
});

/* ------------------------------------------------- the run, end to end --- */

configureFakeEnvironment("");
delete process.env.REPLY_AGENT_LIVE_SEND;
delete process.env.MASTER_INBOX_REPLY_AGENT_LIVE_SEND;
const db = new FakePostgrest();
const realFetch = globalThis.fetch;
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

let runtime: typeof import("./runtime") | null = null;
try {
  runtime = await import("./runtime");
} catch (err) {
  if ((err as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") throw err;
}
const skip = runtime ? false : "needs the @/ alias hooks: node --import ./scripts/alias-hooks.mjs --test";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const THREAD = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";

function seedAgent(skipLabels: string[] | undefined) {
  db.reset();
  db.seed("reply_agents", [{
    id: AGENT, workspace_id: WORKSPACE, name: "Shadow agent", mode: "auto", tone: "professional", response_length: "medium",
    max_tokens: 1000, temperature: 0.1, provider: "openai", model: "gpt-4o-mini", api_key_encrypted: null, system_prompt: null,
    channel_ids: [], channel_filter: "both", active: true, auto_respond_new: true, stats: {},
    created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z",
    run_mode: "shadow", client_ids: [], schedule: { kind: "always" },
    qualification: { questions: [], ...(skipLabels === undefined ? {} : { skip_labels: skipLabels }) },
    handover: { cc_emails: [], message: "" },
  }]);
}

const run = (threadLabels: string[] | null | undefined) =>
  runtime!.runReplyAgentOnInbound({
    workspaceId: WORKSPACE, threadId: THREAD, channelId: null, clientId: null,
    inboundMessageId: "m-1", inboundText: "Sure, tell me more.", threadLabels,
    leadName: "Jane", leadEmail: "jane@example.com", leadPhone: null, leadCompany: null, leadTitle: null, leadFacts: [],
    ourName: "Nicole", ourEmail: "nicole@example.com", senderName: "Nicole", subject: "Quick question",
    conversation: [{ direction: "inbound", sentAt: null, body: "Sure, tell me more." }],
    introduction: null,
  } as never);

/** Everything a run could have left behind. */
const touched = () => ({
  drafts: db.rows("reply_drafts").length,
  state: db.rows("agent_thread_state").length,
  messages: db.rows("messages").length,
  provider: db.providerCalls.length,
});
const NOTHING = { drafts: 0, state: 0, messages: 0, provider: 0 };

test("an Interested conversation is left to a person: no draft, no state, no send", { skip }, async () => {
  seedAgent(["Interested"]);
  const out = await run(["Interested"]);
  assert.deepEqual(out, { status: "left_to_person", agentId: AGENT, agentName: "Shadow agent", label: "Interested" });
  assert.deepEqual(touched(), NOTHING);
});

test("the default applies to an agent saved before the setting existed", { skip }, async () => {
  seedAgent(undefined);
  assert.equal((await run(["Interested"])).status, "left_to_person");
  assert.deepEqual(touched(), NOTHING);
});

test("every other category is still the agent's to answer", { skip }, async () => {
  for (const labels of [["Not Interested"], ["Out of Office"], ["Wrong Person"], [], undefined]) {
    seedAgent(["Interested"]);
    const out = await run(labels);
    assert.notEqual(out.status, "left_to_person", JSON.stringify(labels));
  }
});

test("an agent with an empty list answers Interested too", { skip }, async () => {
  seedAgent([]);
  assert.notEqual((await run(["Interested"])).status, "left_to_person");
});

test("labels that could not be read: the agent holds rather than guess — unless it has no list", { skip }, async () => {
  seedAgent(["Interested"]);
  assert.deepEqual(await run(null), { status: "left_to_person", agentId: AGENT, agentName: "Shadow agent", label: null });
  assert.deepEqual(touched(), NOTHING);
  seedAgent([]);
  assert.notEqual((await run(null)).status, "left_to_person");
});

test("cleanup", () => {
  globalThis.fetch = realFetch;
});
