/*
 * Proof that nothing sends while MASTER_INBOX_REPLY_AGENT_LIVE_SEND is unset.
 *
 * ---------------------------------------------------------------------------
 * THE REAL GATE, NOT A MOCK
 *
 * live-send.test.ts fakes the gate open to exercise the send. This file is the
 * other half: the gate as shipped, reading the real environment, with the
 * variable deleted from this process before anything is imported. Every lock
 * is checked with the transport WIRED — which is the state the code is now in
 * — so what is proven is that wiring changed nothing about the refusal:
 *
 *   1. `dispatch()` returns `gated` and makes NO request of any kind: not to
 *      a provider, not to the database.
 *   2. The safety gate reports `live_disabled`.
 *   3. `saveAgent({ run_mode: "live" })` still refuses.
 *   4. `attemptLiveSend` end to end holds the reply with `live_disabled`.
 *   5. The release sweep leaves a held reply held.
 *
 * The database is the in-memory fake and the providers are fake hosts (see
 * test/fake-postgrest.ts); the point is that none of them is even asked.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../test/fake-postgrest";

configureFakeEnvironment("");
delete process.env.MASTER_INBOX_REPLY_AGENT_LIVE_SEND;

const db = new FakePostgrest();
const realFetch = globalThis.fetch;
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

type Engine = {
  gate: typeof import("./live-gate");
  transport: typeof import("./send-transport");
  live: typeof import("./live");
  release: typeof import("./release");
  agent: typeof import("./agent");
  safetyFacts: typeof import("./safety-facts");
  safety: typeof import("./safety");
  threadState: typeof import("./thread-state");
};

async function load(): Promise<Engine | null> {
  try {
    const [gate, transport, live, release, agent, safetyFacts, safety, threadState] = await Promise.all([
      import("./live-gate"),
      import("./send-transport"),
      import("./live"),
      import("./release"),
      import("./agent"),
      import("./safety-facts"),
      import("./safety"),
      import("./thread-state"),
    ]);
    return { gate, transport, live, release, agent, safetyFacts, safety, threadState };
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_MODULE_NOT_FOUND") return null;
    throw err;
  }
}

const engine = await load();
const skip = engine ? false : "needs the @/ alias hooks: node --import ./scripts/alias-hooks.mjs --test";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const THREAD = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const DRAFT = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-09-18T15:00:00.000Z");

const liveAgent = () => ({
  id: AGENT,
  workspace_id: WORKSPACE,
  name: "Armed by mistake",
  mode: "auto" as const,
  tone: "professional",
  response_length: "medium" as const,
  max_tokens: 1000,
  temperature: 0.1,
  provider: "openai" as const,
  model: "gpt-4o-mini",
  has_api_key: false,
  system_prompt: null,
  channel_ids: [],
  channel_filter: "both" as const,
  active: true,
  auto_respond_new: true,
  stats: {},
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  run_mode: "live" as const,
  client_ids: [],
  schedule: { kind: "always" as const, timezone: "America/New_York", businessDays: [1, 2, 3, 4, 5], businessStart: "09:00", businessEnd: "18:00" },
  qualification: { enabled: false, questions: [], required: 0, passRule: "all_answered" as const },
  handover: { ccEmails: [], message: "" },
});

test("the gate reads the real environment and the variable is unset", { skip }, () => {
  assert.equal(process.env[engine!.gate.LIVE_SEND_ENV_VAR], undefined);
  assert.equal(engine!.gate.liveSendingEnabled(), false);
  assert.equal(engine!.transport.LIVE_TRANSPORT_WIRED, true, "the transport is wired, and still nothing may send");
});

test("dispatch(): gated, with no provider call and no database call", { skip }, async () => {
  db.reset();
  const result = await engine!.transport.dispatch({
    workspaceId: WORKSPACE,
    threadId: THREAD,
    agentId: AGENT,
    draftId: DRAFT,
    to: ["jane@example.com"],
    cc: ["nicole@acme.example"],
    subject: "Quick question",
    body: "Hi Jane,\n\nHere is a reply nobody authorised.\n\nBest,\nNicole",
    isHandover: true,
  });
  assert.equal(result.status, "gated");
  assert.match((result as { detail: string }).detail, /MASTER_INBOX_REPLY_AGENT_LIVE_SEND is not set/);
  assert.equal(db.providerCalls.length, 0, "no provider request");
  assert.equal(db.calls.length, 0, "no database request either");
  assert.deepEqual(db.blocked, []);
});

test("the safety gate reports live_disabled first, whatever else is true", { skip }, async () => {
  db.reset();
  db.seed("threads", [{ id: THREAD, workspace_id: WORKSPACE, lead_id: null, client_id: null }]);
  const facts = await engine!.safetyFacts.gatherSafetyFacts({
    workspaceId: WORKSPACE,
    threadId: THREAD,
    agentId: AGENT,
    runMode: "live",
    schedule: liveAgent().schedule,
    lastInboundText: "Sure, let's talk.",
    hasRecipient: true,
    now: NOW,
  });
  assert.equal(facts.liveSendingEnabled, false);
  const verdict = engine!.safety.evaluate(facts);
  assert.equal(verdict.allowed, false);
  assert.equal((verdict as { reason: string }).reason, "live_disabled");
});

test("saveAgent({ run_mode: 'live' }) still refuses, before it writes anything", { skip }, async () => {
  db.reset();
  await assert.rejects(
    engine!.agent.saveAgent({ id: AGENT, workspace_id: WORKSPACE, run_mode: "live" } as never),
    engine!.agent.LiveModeNotEnabledError,
  );
  assert.equal(db.writes("reply_agents", "POST").length + db.writes("reply_agents", "PATCH").length, 0);
});

test("attemptLiveSend holds the reply with live_disabled and calls no provider", { skip }, async () => {
  db.reset();
  db.seed("threads", [{ id: THREAD, workspace_id: WORKSPACE, lead_id: null, client_id: null }]);
  const result = await engine!.live.attemptLiveSend({
    agent: liveAgent(),
    workspaceId: WORKSPACE,
    threadId: THREAD,
    draftId: DRAFT,
    body: "Hi Jane,\n\nA reply.\n\nBest,\nNicole",
    subject: "Quick question",
    toEmail: "jane@example.com",
    lastInboundText: "Sure, let's talk.",
    isHandover: true,
    cc: ["nicole@acme.example"],
    state: null,
    now: NOW,
  });
  assert.equal(result.status, "held");
  assert.equal((result as { reason: string }).reason, "live_disabled");
  // The safety gate's own verdict: a hold, not a stop, and not something a
  // sweep should keep retrying until a person turns the variable on.
  assert.equal((result as { retryable: boolean }).retryable, false);
  assert.equal(db.providerCalls.length, 0);
  assert.equal(db.rows("messages").length, 0);
  const state = db.rows("agent_thread_state")[0];
  assert.equal(state.hold_reason, "live_disabled");
  assert.equal(state.held_draft_id, DRAFT);
  assert.equal(state.sends_attempted ?? 0, 0, "the gate refused before the attempt counter");
});

test("the release sweep leaves a held reply held and calls no provider", { skip }, async () => {
  db.reset();
  db.seed("workspaces", [{ id: WORKSPACE }]);
  db.seed("reply_agents", [{ ...liveAgent(), schedule: { kind: "always" }, qualification: { questions: [] }, handover: { cc_emails: [], message: "" } }]);
  db.seed("threads", [{ id: THREAD, workspace_id: WORKSPACE, lead_id: null, client_id: null, channel_id: null, subject: "x", outbound_sender_email: "n@x" }]);
  db.seed("reply_drafts", [{ id: DRAFT, workspace_id: WORKSPACE, thread_id: THREAD, agent_id: AGENT, status: "pending", generated_body: "Hi\n\nReply" }]);
  db.seed("agent_thread_state", [
    { workspace_id: WORKSPACE, thread_id: THREAD, agent_id: AGENT, status: "qualifying", hold_reason: "live_disabled", held_draft_id: DRAFT, held_at: "2026-09-18T09:00:00.000Z" },
  ]);
  const report = await engine!.release.releaseHeldReplies(WORKSPACE, NOW);
  assert.equal(report.scanned, 1);
  assert.equal(report.sent, 0);
  assert.equal(report.stillHeld, 1);
  assert.match(report.outcomes[0].reason, /^live_disabled/);
  assert.equal(db.providerCalls.length, 0);
  assert.equal(db.rows("messages").length, 0);
  assert.equal(db.rows("reply_drafts")[0].status, "pending");
});

test("nothing left the process", { skip }, () => {
  assert.deepEqual(db.blocked, []);
  assert.equal(db.providerCalls.length, 0);
  assert.equal(process.env.MASTER_INBOX_REPLY_AGENT_LIVE_SEND, undefined);
  globalThis.fetch = realFetch;
});
