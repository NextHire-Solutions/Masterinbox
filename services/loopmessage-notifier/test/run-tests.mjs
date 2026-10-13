// Dependency-free test runner. `npm test`.
//
// Covers the parts that fail silently or expensively in production:
// phone normalization (a dropped agent is invisible), LoopMessage's
// first-message rules (breaking them gets the sender blocked for every
// client), pacing and the warm-up cap, consent (no alert to anyone who
// hasn't messaged the sender), and state surviving a restart.
//
// Time is simulated: every engine test owns its clock.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePhone } from "../src/phone.js";
import {
  buildText,
  buildWelcomeText,
  isSafeInitialText,
  parseClientList,
  planNotifications,
  processIntroduction,
} from "../src/notify.js";
import { sendMessage } from "../src/loopmessage.js";
import { Engine, warmupCap } from "../src/engine.js";
import { interpretReply, parseLoopEvent, readReply } from "../src/inbound.js";
import { FileStore, MemoryStore } from "../src/store.js";

let passed = 0;
let failed = 0;
let finished = false;
const failures = [];

// A test awaiting a promise that never settles makes Node exit early with
// code 13 and no summary; say so instead of ending silently.
process.on("exit", (code) => {
  if (!finished) console.log(`\ntest run did not finish (exit ${code}): a test is waiting on something that never happens`);
});

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

function stubFetch(responses) {
  const calls = [];
  let i = 0;
  const impl = async (url, opts) => {
    calls.push({ url, opts, body: opts?.body ? JSON.parse(opts.body) : null });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    if (next.throw) {
      // fetch reports socket errors as TypeError("fetch failed") with the
      // real code on `cause`.
      throw Object.assign(new Error(next.throw), {
        name: next.throwName ?? "Error",
        ...(next.throwCode ? { cause: { code: next.throwCode } } : {}),
      });
    }
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      text: async () => JSON.stringify(next.body ?? {}),
    };
  };
  impl.calls = calls;
  return impl;
}

const quiet = { log() {}, warn() {}, error() {} };

// A logger that keeps every line, parsed.
function captureLogs() {
  const lines = [];
  const push = (line) => lines.push(JSON.parse(line));
  return { lines, logger: { log: push, warn: push, error: push } };
}

// A send that waits until the test opens the gate.
function gate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

// Let queued promise work run until `cond` holds.
async function until(cond) {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(cond(), "condition never became true");
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// The exact payload the Masterinbox webhook sends (from the pinned n8n data).
const PINNED = {
  event: "lead.introduction",
  occurred_at: "2026-06-11T14:26:44.658Z",
  source: "inbox_label",
  pipeline_entry_id: "537ea483-e501-4595-abbd-7d2c0c8b30fd",
  // Masterinbox's SMS approval (lib/portals/team-sms.ts), present on
  // every Introduction it sends for a client with SMS alerts on.
  sms_enabled: true,
  lead: {
    name: "Radhamilca Tucker",
    email: "rtucker@christiesrealestategroup.com",
    company: "Christies International Real Estate New York Llc",
    phone: null,
  },
  client: { id: "f7fbfc19-503f-46ba-9251-c8d5a432d75c", name: "Douglas Elliman" },
  team: [
    { name: "Lara Chopoorian", mobile: "9733966766" },
    { name: "Elisa Angelione", mobile: "631-425-5731" },
  ],
};

const DEMO = {
  ...PINNED,
  pipeline_entry_id: "demo-entry-1",
  client: { id: "11111111-2222-3333-4444-555555555555", name: "Demo Portal" },
  team: [
    { name: "Other Agent", mobile: "9733966766" },
    { name: "Demo Tester", mobile: "718-415-0537" },
  ],
};

// Engine harness: simulated clock, recorded sends, swappable replies.
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);

const A = { name: "Avery Real", mobile: "9733966766" };
const B = { name: "Blake Real", mobile: "631-425-5731" };
const C = { name: "Casey Real", mobile: "(718) 415-0537" };
const A_E164 = "+19733966766";
const B_E164 = "+16314255731";
const C_E164 = "+17184150537";

function harness({ config = {}, store = new MemoryStore(), reply, logger = quiet, start = T0 } = {}) {
  let t = start;
  const sent = [];
  const send = async (m) => {
    sent.push({ ...m, at: t });
    if (reply) return reply(m, sent.length);
    return { ok: true, messageId: `M${sent.length}` };
  };
  const make = () => new Engine({ store, send, now: () => t, config, logger });
  return {
    engine: make(),
    restart: make,
    sent,
    store,
    now: () => t,
    advance(ms) {
      t += ms;
    },
  };
}

// What a redeploy at this moment would find on disk.
const onDiskNow = (h) => structuredClone(h.store.data);

// A disk that can fill up.
class FlakyStore extends MemoryStore {
  failing = false;
  save(state) {
    if (this.failing) throw new Error("ENOSPC: no space left on device");
    super.save(state);
  }
}
const entryOf = (m) => JSON.parse(m.passthrough).pipeline_entry_id;

function intro(entryId, team, { client = { id: "c-demo", name: "Demo Portal" } } = {}) {
  return planNotifications({
    event: "lead.introduction",
    source: "portal_add_lead",
    pipeline_entry_id: entryId,
    sms_enabled: true,
    lead: PINNED.lead,
    client,
    team,
  });
}

const alertsIn = (sent) => sent.filter((m) => /you have a new agent/.test(m.text));
const welcomesIn = (sent) => sent.filter((m) => /Reply YES/.test(m.text));
const fail = (code, status = 400) => ({ ok: false, code, status, error: `code_${code}` });
// What loopmessage.js returns when LoopMessage couldn't be reached at all
// (nothing was sent), and when it may have queued the message anyway.
const unreachable = { ok: false, ambiguous: false, status: null, code: null, error: "ECONNREFUSED" };
const maybeSent = { ok: false, ambiguous: true, status: null, code: null, error: "timeout" };

// ---------------------------------------------------------------------------
console.log("\nphone normalization");

await test("bare 10-digit NANP gets +1 (real production row)", () => {
  assert.deepEqual(normalizePhone("9733966766"), { ok: true, e164: "+19733966766" });
});

await test("dashed 10-digit gets +1 (real production row)", () => {
  assert.deepEqual(normalizePhone("631-425-5731"), { ok: true, e164: "+16314255731" });
});

await test("brackets and spaces are stripped", () => {
  assert.deepEqual(normalizePhone("(973) 396-6766"), { ok: true, e164: "+19733966766" });
});

await test("leading 1 is not doubled", () => {
  assert.deepEqual(normalizePhone("1 973 396 6766"), { ok: true, e164: "+19733966766" });
});

await test("already-international number is preserved", () => {
  assert.deepEqual(normalizePhone("+916238287637"), { ok: true, e164: "+916238287637" });
  assert.deepEqual(normalizePhone("+17184150537"), { ok: true, e164: "+17184150537" });
});

await test("Demo Portal's placeholder +1 555 100 1001 numbers are rejected", () => {
  // Real rows on the Demo Portal team. Texting them would waste a first
  // message from LoopMessage's daily cap.
  for (const p of ["+15551001001", "+15551001002", "+15551001003"]) {
    assert.equal(normalizePhone(p).ok, false, p);
  }
});

await test("+1 numbers with the wrong length are rejected", () => {
  assert.equal(normalizePhone("+1973396676").ok, false);
  assert.equal(normalizePhone("+197339667661").ok, false);
});

await test("trailing extension is stripped, not absorbed into the number", () => {
  // Without extension handling this becomes +1973396676612 — a valid-looking
  // number that silently texts nobody.
  assert.deepEqual(normalizePhone("973-396-6766 x12"), { ok: true, e164: "+19733966766" });
  assert.deepEqual(normalizePhone("973-396-6766 ext. 400"), { ok: true, e164: "+19733966766" });
});

await test("invalid NANP area code is rejected", () => {
  assert.equal(normalizePhone("1234567890").ok, false);
  assert.equal(normalizePhone("0733966766").ok, false);
});

await test("empty and junk inputs are rejected with a reason", () => {
  assert.deepEqual(normalizePhone(null), { ok: false, reason: "empty" });
  assert.deepEqual(normalizePhone(""), { ok: false, reason: "empty" });
  assert.deepEqual(normalizePhone("  "), { ok: false, reason: "empty" });
  assert.deepEqual(normalizePhone("n/a"), { ok: false, reason: "no_digits" });
  assert.equal(normalizePhone("12345").ok, false);
});

// ---------------------------------------------------------------------------
console.log("\npayload planning");

await test("pinned payload plans both team members", () => {
  const plan = planNotifications(PINNED);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.recipients.map((r) => r.contact), ["+19733966766", "+16314255731"]);
  assert.equal(plan.clientName, "Douglas Elliman");
  assert.equal(plan.skipped.length, 0);
});

await test("unparseable member is skipped with a reason, others still planned", () => {
  const plan = planNotifications({
    ...PINNED,
    team: [{ name: "Good", mobile: "9733966766" }, { name: "Bad", mobile: "n/a" }],
  });
  assert.equal(plan.recipients.length, 1);
  assert.deepEqual(plan.skipped, [{ name: "Bad", mobile: "n/a", reason: "no_digits" }]);
});

await test("a phone listed twice on a team gets one text", () => {
  const plan = planNotifications({
    ...PINNED,
    team: [{ name: "Desk", mobile: "9733966766" }, { name: "Desk again", mobile: "(973) 396-6766" }],
  });
  assert.equal(plan.recipients.length, 1);
  assert.equal(plan.skipped[0].reason, "duplicate_phone_on_team");
});

await test("wrong event and missing entry id are rejected", () => {
  assert.equal(planNotifications({ ...PINNED, event: "lead.replied" }).ok, false);
  assert.equal(planNotifications({ ...PINNED, pipeline_entry_id: null }).ok, false);
  assert.equal(planNotifications(null).ok, false);
  assert.equal(planNotifications("string").ok, false);
});

await test("empty team is valid but plans nothing", () => {
  const plan = planNotifications({ ...PINNED, team: [] });
  assert.equal(plan.ok, true);
  assert.equal(plan.recipients.length, 0);
});

// ---------------------------------------------------------------------------
console.log("\ncopy");

await test("alert text is exactly the client's approved example", () => {
  // Eddy's wording, Oct 2026: agent, phone, brokerage; no email. No opt-out
  // line of ours: LoopMessage appends its own, and two looked wrong.
  assert.equal(
    buildText("Eddy", {
      name: "Laura Wilson",
      email: "laura@hotmail.com",
      phone: "6652341234",
      company: "Legacy Realty Group",
    }),
    "Hi Eddy, you have a new agent in the Introduction stage.\n\n" +
      "Agent: Laura Wilson\n" +
      "Phone: (665) 234-1234\n" +
      "Brokerage: Legacy Realty Group",
  );
});

await test("the alert greets by first name and never includes the email", () => {
  const text = buildText("Lara Chopoorian", PINNED.lead);
  assert.equal(
    text,
    "Hi Lara, you have a new agent in the Introduction stage.\n\n" +
      "Agent: Radhamilca Tucker\n" +
      "Brokerage: Christies International Real Estate New York Llc",
  );
  assert.ok(!text.includes("@"));
  assert.ok(!/stop/i.test(text), "LoopMessage adds the opt-out line; we don't repeat it");
});

await test("empty lead fields are omitted, not rendered as 'null'", () => {
  assert.equal(
    buildText("Sam", { name: "Jo", phone: null, company: null }),
    "Hi Sam, you have a new agent in the Introduction stage.\n\nAgent: Jo",
  );
  assert.equal(
    buildText(null, {}),
    "Hi there, you have a new agent in the Introduction stage.",
  );
});

await test("lead phones: US formatted as (xxx) xxx-xxxx, others kept as entered", () => {
  assert.match(buildText("A", { phone: "+1 665-234-1234" }), /Phone: \(665\) 234-1234/);
  assert.match(buildText("A", { phone: "(665)2341234" }), /Phone: \(665\) 234-1234/);
  assert.match(buildText("A", { phone: "+44 20 7946 0958" }), /Phone: \+44 20 7946 0958/);
});

await test("the alert itself is NOT safe as a first message (it has the lead's phone)", () => {
  // Why alerts only ever go to people who've already messaged the sender.
  assert.equal(isSafeInitialText(buildText("Lara", { name: "Laura", phone: "6652341234" })), false);
});

await test("the welcome is exactly the client's approved wording and safe as a first message", () => {
  const text = buildWelcomeText({ name: "Eddy", brand: "BrokerStaffer" });
  assert.equal(
    text,
    "Hi Eddy, this is BrokerStaffer. We'll text you here whenever a new agent is introduced " +
      "to your team. Reply YES to start getting these, or STOP to opt out.",
  );
  assert.equal(isSafeInitialText(text), true);
});

await test("odd first names are dropped from the welcome", () => {
  const text = buildWelcomeText({ name: "agent@x.com", brand: "BrokerStaffer" });
  assert.ok(text.startsWith("Hi there,"));
  assert.equal(isSafeInitialText(text), true);
  assert.ok(buildWelcomeText({ name: "Lara Chopoorian", brand: "B" }).startsWith("Hi Lara,"));
});

await test("the safety check catches what LoopMessage forbids", () => {
  for (const bad of ["mail me at a@b.co", "see https://x.y", "www.site", "acme.com", "call 212 555 0100", "only $5"]) {
    assert.equal(isSafeInitialText(bad), false, bad);
  }
  for (const good of ["C21 Results - Elite Team", "54 Realty", "Properties & Estates Boston", "SERHANT. NJ"]) {
    assert.equal(isSafeInitialText(good), true, good);
  }
});

// ---------------------------------------------------------------------------
console.log("\nclient rollout (NOTIFY_CLIENTS / TEST_RECIPIENT_OVERRIDE)");

function engineStub() {
  const calls = [];
  return {
    calls,
    async handleIntroduction(plan, opts) {
      calls.push({ plan, opts });
      return plan.recipients.map((r) => ({ contact: r.contact, status: "stub" }));
    },
  };
}

await test("client list matches by name case-insensitively and by id", () => {
  const f = parseClientList(" demo portal , 11111111-2222-3333-4444-555555555555");
  assert.equal(f.matches({ name: "Demo Portal" }), true);
  assert.equal(f.matches({ id: "11111111-2222-3333-4444-555555555555", name: "Renamed" }), true);
  assert.equal(f.matches({ id: "x", name: "Douglas Elliman" }), false);
});

await test("'*' enables every client", () => {
  assert.equal(parseClientList("*").matches({ name: "Anyone" }), true);
});

await test("empty or unset list enables nobody (fails closed)", () => {
  for (const raw of [undefined, null, "", " , "]) {
    assert.equal(parseClientList(raw).matches({ id: "a", name: "Demo Portal" }), false, `raw=${raw}`);
  }
});

await test("a client that isn't enabled never reaches the engine", async () => {
  const engine = engineStub();
  const res = await processIntroduction(PINNED, {
    engine, logger: quiet, clientFilter: parseClientList("Demo Portal"),
  });
  assert.equal(engine.calls.length, 0);
  assert.equal(res.ignored, "client_not_enabled");
  assert.equal(res.client, "Douglas Elliman");
});

await test("override hands the engine exactly one recipient: the override number", async () => {
  const engine = engineStub();
  const res = await processIntroduction(DEMO, {
    engine, logger: quiet,
    clientFilter: parseClientList("Demo Portal"),
    testRecipientOverride: "+17184150537",
  });
  assert.equal(engine.calls[0].plan.recipients.length, 1);
  assert.equal(engine.calls[0].plan.recipients[0].contact, "+17184150537");
  assert.equal(res.testOverride, true);
});

await test("override greets the team member who owns that number", () => {
  const plan = planNotifications(DEMO, { testRecipientOverride: "+17184150537" });
  assert.equal(plan.recipients[0].name, "Demo Tester");
  assert.ok(plan.recipients[0].text.startsWith("Hi Demo,"));
});

await test("override falls back to the first named member, then 'there'", () => {
  const noOwner = { ...DEMO, team: [{ name: "Other Agent", mobile: "9733966766" }] };
  assert.equal(planNotifications(noOwner, { testRecipientOverride: "+17184150537" }).recipients[0].name, "Other Agent");
  const plan = planNotifications({ ...DEMO, team: [] }, { testRecipientOverride: "+17184150537" });
  assert.equal(plan.recipients.length, 1, "still plans when the team is empty");
  assert.ok(plan.recipients[0].text.startsWith("Hi there,"));
});

await test("an Introduction without Masterinbox's SMS approval is not texted", () => {
  const { sms_enabled: _approved, ...unapproved } = PINNED;
  const plan = planNotifications(unapproved);
  assert.equal(plan.ok, true);
  assert.equal(plan.ignored, "sms_not_approved");
  assert.equal(plan.recipients.length, 0);
});

await test("only a literal true counts as approval", () => {
  for (const v of ["true", 1, "yes", null, false]) {
    assert.equal(planNotifications({ ...PINNED, sms_enabled: v }).ignored, "sms_not_approved", String(v));
  }
});

await test("unapproved Introductions never reach the engine, even for an allowed client", async () => {
  const engine = engineStub();
  const { sms_enabled: _approved, ...unapproved } = DEMO;
  const res = await processIntroduction(unapproved, {
    engine, logger: quiet, clientFilter: parseClientList("*"),
  });
  assert.equal(engine.calls.length, 0);
  assert.equal(res.ignored, "sms_not_approved");
});

await test("an invalid override number is refused, not sent", () => {
  assert.equal(planNotifications(DEMO, { testRecipientOverride: "not-a-number" }).ok, false);
});

await test("dry_run is passed through to the engine", async () => {
  const engine = engineStub();
  const res = await processIntroduction(DEMO, { engine, logger: quiet, dryRun: true });
  assert.equal(engine.calls[0].opts.dryRun, true);
  assert.equal(res.dryRun, true);
});

await test("the webhook path hands the plan over to be saved, without waiting on sends", async () => {
  const saved = [];
  const engine = {
    enqueueIntroduction: (plan) => saved.push(plan),
    handleIntroduction: () => assert.fail("the webhook path must not wait on the engine"),
  };
  const res = await processIntroduction(DEMO, { engine, logger: quiet, enqueue: true });
  assert.equal(res.accepted, true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].entryId, "demo-entry-1");
});

await test("a malformed introduction is rejected with a log line, not dropped silently", async () => {
  const logs = captureLogs();
  const engine = engineStub();
  const res = await processIntroduction(
    { event: "lead.introduction", sms_enabled: true },
    { engine, logger: logs.logger, enqueue: true },
  );
  assert.equal(res.ok, false);
  assert.equal(engine.calls.length, 0);
  assert.ok(logs.lines.some((l) => l.msg === "introduction_rejected" && l.reason === "missing_pipeline_entry_id"));
});

// ---------------------------------------------------------------------------
console.log("\nloopmessage client");

const send1 = (fetchImpl) => sendMessage({ apiKey: "k", contact: "+1555", text: "hi", backoffMs: 1, fetchImpl });

await test("429 is retried (LoopMessage didn't take it), then succeeds", async () => {
  const f = stubFetch([
    { status: 429, body: {} },
    { status: 200, body: { success: true, message_id: "MID-1" } },
  ]);
  const res = await send1(f);
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 2);
  assert.equal(res.messageId, "MID-1");
});

await test("a connection that was never made is retried, then succeeds", async () => {
  const f = stubFetch([
    { throw: "fetch failed", throwName: "TypeError", throwCode: "ECONNREFUSED" },
    { status: 200, body: { success: true, message_id: "MID-2" } },
  ]);
  const res = await send1(f);
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 2);
});

await test("if LoopMessage can't be reached at all, the result says nothing was sent", async () => {
  const f = stubFetch([{ throw: "fetch failed", throwName: "TypeError", throwCode: "ENOTFOUND" }]);
  const res = await send1(f);
  assert.equal(res.ok, false);
  assert.equal(res.ambiguous, false);
  assert.equal(res.status, null);
  assert.equal(f.calls.length, 3);
});

await test("a timeout may have been sent: reported as ambiguous and never retried", async () => {
  const f = stubFetch([
    { throw: "The operation was aborted", throwName: "TimeoutError" },
    { status: 200, body: { success: true, message_id: "MID-3" } },
  ]);
  const res = await send1(f);
  assert.equal(res.ok, false);
  assert.equal(res.ambiguous, true);
  assert.equal(res.error, "timeout");
  assert.equal(f.calls.length, 1);
});

await test("a connection dropped mid-request is ambiguous too", async () => {
  const f = stubFetch([{ throw: "fetch failed", throwName: "TypeError", throwCode: "ECONNRESET" }]);
  const res = await send1(f);
  assert.equal(res.ambiguous, true);
  assert.equal(f.calls.length, 1);
});

await test("a 5xx without a LoopMessage code is ambiguous and not retried", async () => {
  for (const status of [500, 502, 503, 504]) {
    const f = stubFetch([{ status, body: {} }, { status: 200, body: { success: true } }]);
    const res = await send1(f);
    assert.equal(res.ok, false, String(status));
    assert.equal(res.ambiguous, true, String(status));
    assert.equal(f.calls.length, 1, String(status));
  }
});

await test("a 5xx carrying a LoopMessage error code is a refusal, not ambiguous", async () => {
  const f = stubFetch([{ status: 500, body: { success: false, code: 1000, message: "x" } }]);
  const res = await send1(f);
  assert.equal(res.ambiguous, false);
  assert.equal(res.code, 1000);
});

await test("400 is not retried, and carries LoopMessage's error code", async () => {
  const f = stubFetch([{ status: 400, body: { success: false, code: 500, message: "opted out" } }]);
  const res = await send1(f);
  assert.equal(res.ok, false);
  assert.equal(res.ambiguous, false);
  assert.equal(res.attempts, 1);
  assert.equal(res.code, 500);
  assert.equal(f.calls.length, 1);
});

await test("HTTP 200 with success:false is treated as a failure", async () => {
  const f = stubFetch([{ status: 200, body: { success: false } }]);
  const res = await sendMessage({ apiKey: "k", contact: "+1555", text: "hi", retries: 0, backoffMs: 1, fetchImpl: f });
  assert.equal(res.ok, false);
  assert.equal(res.ambiguous, false);
});

await test("auth header and body shape match the API contract", async () => {
  const f = stubFetch([{ status: 200, body: { success: true, message_id: "M" } }]);
  await sendMessage({ apiKey: "secret", contact: "+1555", text: "hi", sender: "SND", passthrough: "P", fetchImpl: f });
  const call = f.calls[0];
  assert.equal(call.opts.headers["X-API-KEY"], "secret");
  assert.ok(!("Authorization" in call.opts.headers));
  assert.ok(call.url.endsWith("/message/send/"));
  assert.deepEqual(call.body, { contact: "+1555", text: "hi", sender: "SND", passthrough: "P" });
});

await test("unset optional fields are omitted, never sent as empty strings", async () => {
  const f = stubFetch([{ status: 200, body: { success: true } }]);
  await sendMessage({ apiKey: "k", contact: "+1555", text: "hi", sender: "", fetchImpl: f });
  assert.deepEqual(Object.keys(f.calls[0].body).sort(), ["contact", "text"]);
});

// ---------------------------------------------------------------------------
console.log("\nLoopMessage webhooks");

await test("dashboard webhook body is read as an inbound message", () => {
  assert.deepEqual(
    parseLoopEvent({
      event: "message_inbound", contact: "+13231112233", text: "yes",
      message_type: "text", message_id: "m1", webhook_id: "w1", api_version: "1.0",
    }),
    { type: "inbound", contact: "+13231112233", text: "yes", messageId: "m1" },
  );
});

await test("the n8n integration's body (no event field) is read as inbound too", () => {
  const evt = parseLoopEvent({ message_id: "m2", contact: "+13231112233", text: "hi", channel: "imessage", sender: "s" });
  assert.equal(evt.type, "inbound");
});

await test("delivery events carry the message id and numeric error code", () => {
  assert.deepEqual(parseLoopEvent({ event: "message_failed", message_id: "m3", error_code: "180" }), {
    type: "status", event: "message_failed", messageId: "m3", errorCode: 180,
  });
  assert.equal(parseLoopEvent({ event: "message_delivered", message_id: "m4" }).errorCode, null);
});

await test("group chats, reactions and junk are ignored", () => {
  assert.equal(parseLoopEvent({ event: "message_inbound", contact: "+1", text: "x", group: { id: "g" } }).type, "ignore");
  assert.equal(parseLoopEvent({ event: "message_reaction", contact: "+1" }).type, "ignore");
  assert.equal(parseLoopEvent([]).type, "ignore");
  assert.equal(parseLoopEvent(null).type, "ignore");
  assert.equal(parseLoopEvent({ event: "message_inbound", text: "no contact" }).type, "ignore");
});

// What the service does with a reply, by where the person is. Examples are
// taken from realistic replies (see the commit message for how they were
// gathered).
const act = (text, stage, name = "Eddy Grant") => interpretReply(text, { name, stage }).action;
const WELCOME = "Hi Eddy, this is BrokerStaffer. We'll text you here whenever a new agent is introduced to your team. Reply YES to start getting these, or STOP to opt out.";
// As the recipient sees it: LoopMessage appends its opt-out line.
const ALERT = "Hi Eddy, you have a new agent in the Introduction stage.\n\nAgent: Laura Wilson\nTo opt-out reply: stop";

await test("after the welcome, a reply that is a yes starts alerts", () => {
  for (const t of [
    "yes", "Yes!", "YES please", "y", "yeah", "Yep", "yas", "Yessir", "sure", "Sure thing", "ok", "Ok 👍", "okay", "k",
    "kk", "Sounds good", "Sounds great, thanks", "Perfect", "Absolutely", "Of course", "Sign me up", "Count me in",
    "Please do", "Keep them coming!", "No problem", "No worries", "No doubt!", "Not a problem", "np", "Thanks!",
    "Thank you so much", "Appreciate it", "Good", "Gotcha 👍", "Noted", "10-4", "Opt in", "That’s fine",
    "I'm good with that", "Sí, gracias", "👍", "👍🏽", "✅", "🙏", "🔥", "Oh ok, thanks", "Hi! Yes please",
    "Good morning! Yes please", "Eddy here, yes please", "Yes please! Excited to see who’s coming in",
    "No complaints here, send them over", "Yes. Let me know if I need to do anything",
    `Liked “${WELCOME}”`, `Loved “${WELCOME}”`,
    // other ways of saying it
    "Absolutely, no need to ask twice!", "Alrighty!", "Mhm", "Okie dokie", "Ready!", "Add me", "Say less", "Fasho",
    "Hell yeah", "Keep me in the loop!", "Dale, gracias!", "De acuerdo", "Está bien", "Claro que sí", "Siii",
    "I consent to receiving these messages.", "Good afternoon. I confirm that I would like to receive these alerts.",
    "Thank you for reaching out. Yes, please enroll me.", "That would be great, thank you.", "I am agree", "🆗",
    "Hey! Yep that's me, go ahead and send them over",
    // a yes, then a question about the alerts themselves
    "Yes! Do these come in real time or once a day?", "Yep! What time do they usually come in?",
    "Yes please. Is there a way to get them by email too?",
  ]) {
    assert.equal(act(t, "welcome"), "consent", t);
  }
});

await test("after the welcome, anything less than a clean yes keeps the alerts held", () => {
  for (const t of [
    // questions and confusion
    "Who is this?", "How did you get my number?", "?", "Hello?", "Hi", "Which team is this for?", "Is this legit?",
    "Yes?", "Okay??", "Subscribe to what?", "y tho", "Yes I guess??", "Hmm", "🤔", "", "...", "This is Laura",
    "Good morning", `Questioned “${WELCOME}”`, `Laughed at “${WELCOME}”`, `Cuestionó “${WELCOME}”`,
    // a yes with doubt attached
    "Ok but who is this?", "Sure, who's this?", "Cool, how did you get my number?", "Ok but I'm not a realtor",
    "Sure, let me ask my broker first", "Yes but let me confirm with my team lead first", "Ok let me think about it",
    "K I'll look into it", "Ok, I'll check with Mike and let you know", "Before I say yes, is this free?",
    "Ok but why do I need this?", "Sure 🖕", "Yes, just don’t text me after 9pm lol",
    "Sure! I’ll reply STOP if it gets to be too much lol", "Yes please. If I want to stop them later do I just text stop?",
    "Ok. Can I opt out anytime?", "Yes!! Don’t ever stop sending these 😂", "Yes, spam me with agents lol",
    "Yes please. Unsubscribe me from the email version though",
    // not a yes at all
    "Nice try", "Please explain", "Please call me", "Please send more info first", "Sounds like a scam to me",
    "Are you sure you have the right number?", "Not so sure about this", "Why would I reply yes to a random number?",
    "I'm sure you mean well but no", "Let me check with Dana first", "Maybe later", "Not yet", "Huh, neat. Sure",
    "No idea what this is lol", "No, not yet — let me talk to my broker first",
  ]) {
    assert.notEqual(act(t, "welcome"), "consent", JSON.stringify(t));
  }
  // A team member who hesitates or asks is followed up with, not dropped.
  for (const t of [
    "Is this spam?", "Is this a scam?", "Who is this?", "Ok but I'm not a realtor", "Sure, let me ask my broker first",
    "No, not yet — let me talk to my broker first", "Sure, no spam please", "Ok. And you are?",
    "Sure, what are these for?", "Absolutely! Who else on my team is getting these?",
    "Don't know who set this up but sure", "I don’t know you guys but Dana said to expect this, so yes",
    "Sure! Do you text everyone this?", "Ok. Why me", "Ok. What do you want",
    "Yes please, and if you can stop sending these to my work email that'd be great", "No idea what this is lol",
    "Our emails keep going to spam lately",
  ]) {
    assert.equal(act(t, "welcome"), "hold", t);
  }
});

await test("after the welcome, refusals opt out", () => {
  for (const t of [
    "STOP", "stop.", "Stop please", "UNSUBSCRIBE", "end", "Cancel", "please stop", "Opt-out", "No", "Nope", "nah",
    "No thanks", "No, thank you", "Thanks but no thanks", "Not interested", "I'm not interested", "I'm all set, thank you",
    "Hell nah", "Yeah nah", "Claro que no", "Yeah I don't think so", "Wrong number", "Sorry wrong #", "wrong numbr",
    "You have the wrong person", "This is Laura, not Eddy", "There's no Eddy at this number", "Not Eddy lol",
    "I don't know you", "I don't know an Eddy", "Remove my number", "Don't contact me", "Please stop texting me",
    "Never text me again", "Quit texting me", "Unsub", "unsubcribe", "Stopp", "👎", "🛑", `Disliked “${WELCOME}”`,
    "Hell no", "Absolutely not", "I'll pass", "This is spam", "Yes, stop", "Please don't", "Hi! No thanks",
    "Yes, I want to opt out", "Ok, I'd like to opt out please", "Yes please remove me", "Sure, remove me", "I’m good, thanks",
    "Yes take me off", "Cool, how do I unsubscribe?",
  ]) {
    assert.equal(act(t, "welcome"), "opt_out", t);
  }
});

await test("people getting alerts are opted out only by a clear request to stop them", () => {
  for (const t of [
    "STOP", "Stop please", "please stop", "stop!!", "STOP 🛑", "🛑", "Unsubscribe", "unsubscribe me", "Opt out",
    "Remove", "remove me", "Please remove my number", "Cancel", "Cancel these alerts please", "No more texts please",
    "No more of these", "Please stop texting me", "Stop sending me these", "Take me off this list",
    "I want off this list", "Don't text me anymore", "Do not send me these", "Turn these off",
    "How do I turn these off?", "I don't want these texts anymore", "I no longer work there",
    "I left the team in June", "Wrong number, there's no Eddy here", "This isn't Eddy anymore, he changed numbers",
    "Yes, stop", "No más mensajes por favor", "quit", "S T O P", "Please remove my number from your system, thanks",
    "Plz take me off ur list", "Remove me from ur list", "I no longer want to receive these alerts",
    "Not on the team anymore", "Not interested anymore, please stop", "Stop please, I'm all set", "how do i stop these",
    "Can I get off this list?", "Pls stop txting me", "Please stop msging me thx", "Stop sending me leads",
    "We cancelled with BrokerStaffer, please stop texting", "Stop. I retired last month", "I'd like to opt out",
    "Please take me off these texts", "Thanks but please stop", "Can you please stop", "I asked you to stop",
    "I told you to stop texting me", "Can you remove me?", "Stop texting me I am not interested",
    "Darme de baja por favor", "Ya no me manden mensajes", "Quiero darme de baja", "Dejen de enviarme mensajes por favor",
  ]) {
    assert.equal(act(t, "active"), "opt_out", t);
  }
});

await test("replies about the lead, or with a limit, never opt a team member out", () => {
  for (const t of [
    "Going to stop by her office tomorrow to say hi", "I'll stop by", "Gonna stop by", "She told me to stop calling her",
    "She said stop", "She replied STOP", "She texted back 'stop texting me' 😬", "Her exact words were stop texting me",
    "She was like 'don't contact me' lol", "She replied 'remove me from your list'", "She said stop texting me lol",
    "Spoke with her - she asked us to stop reaching out", "She said don't text me, call only",
    "She basically said leave me alone lol", "It went to my spam folder lol", "Went to spam", "This lead is spam",
    "Her number comes up as Spam Likely", "She unsubscribed", "Meeting her at the Starbucks by Stop & Shop",
    "She just moved to One Stop Realty", "Don't ever stop sending me leads like this 🔥", "I'd hate for these to stop",
    "I don't want these to stop", "Please stop sending me the same lead twice", "That's the wrong number",
    "Wrong number on this one", "Not interested in this one", "She's not interested in these recruiting calls",
    "She did not contact me back yet", "Can you tell her to stop texting me? She's sent me 6 texts today lol",
    "Don't text her yet, I'll call", "No, already called her", "Who is she?", "Take me off this lead, Jen has her",
    "Can you remove me from this one? Mike already has her", "Stop emailing her, she already joined us 🎉",
    "Not Eddy's style but I'll call", "End of day works for me", "No more texts about her, she signed with us",
    "Enough with these Legacy agents lol none of them ever switch",
    "Can you cancel these duplicate texts? Getting each one twice",
    "Please don't text me again before 8am", "Don't text me anymore after 9pm please", "Can I turn these off on weekends?",
    "Unsubscribe me from the email version", "Eddy here - no answer on her phone, will try again tmrw",
    'Lol "unsubscribe me" was her whole reply',
    "This is Eddy, I don't see an email for her, just the phone number",
    "Hey it's Eddy, no luck reaching her, number goes to voicemail",
    `Liked “${ALERT}”`, `Loved “${ALERT}”`, `Disliked “${ALERT}”`, "👍", "❌", "No", "Thanks",
  ]) {
    assert.equal(act(t, "active"), "reply", t);
  }
  // A first name that's an everyday word isn't read as one; a lead who
  // shares the member's name isn't a denial.
  assert.equal(interpretReply("Will do. No answer at her number yet, will try again", { name: "Will Smith", stage: "active" }).action, "reply");
  assert.equal(interpretReply("Called Laura, no answer. Left a voicemail on her cell phone.", { name: "Laura Smith", stage: "active" }).action, "reply");
});

await test("replies that talk about stopping without asking are flagged for a person to check", () => {
  assert.equal(interpretReply("Please stop sending me the same lead twice", { stage: "active" }).mentionsStop, true);
  assert.equal(interpretReply("Pause these for 2 weeks please", { stage: "active" }).mentionsStop, true);
  assert.equal(interpretReply("Thanks, calling her now", { stage: "active" }).mentionsStop, false);
  assert.equal(interpretReply("End of day works for me", { stage: "active" }).mentionsStop, false);
});

await test("someone texting the sender first opts in, unless they refuse or ask who we are", () => {
  for (const t of ["Hi", "Hello", "Hey it's Eddy", "Dana told me to text this number", "ok", "Hey it's Eddy, any alerts for me yet?"]) {
    assert.equal(act(t, "first_contact"), "consent", t);
  }
  for (const t of ["Who is this?", "?", "", "🤔", `Liked “${WELCOME}”`, "Hello?? Got a text from this number"]) {
    assert.equal(act(t, "first_contact"), "hold", JSON.stringify(t));
  }
  for (const t of ["STOP", "Wrong number", "No thanks"]) assert.equal(act(t, "first_contact"), "opt_out", t);
});

await test("an opted-out person comes back only on START or YES", () => {
  for (const t of ["START", "start", "Unstop", "yes", "Yes please", "Start again please"]) {
    assert.equal(act(t, "opted_out"), "resume", t);
  }
  for (const t of ["hello", "Who is this?", "ok", "STOP", "Yes, stop", "thanks", "Yes? who is this", "Y r u still texting me?", "Yes I said stop"]) {
    assert.equal(act(t, "opted_out"), "hold", t);
  }
});

await test("a reaction quoting our STOP line is read as the reaction, not as STOP", () => {
  const r = readReply(`Liked “${ALERT}”`);
  assert.equal(r.stop, false);
  assert.equal(r.reaction, "positive");
  assert.equal(readReply(`Reacted 👍 to “${WELCOME}”`).yes, true);
  assert.equal(readReply(`Removed a like from “${WELCOME}”`).yes, false);
  assert.equal(readReply(`Le gustó “${WELCOME}”`).yes, true);
});

await test("a huge reply is read quickly", () => {
  const started = Date.now();
  readReply(`reacted ${"a ".repeat(400_000)}x`);
  readReply(`removed a ${"b ".repeat(400_000)}`);
  readReply("stop ".repeat(200_000));
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
});


// ---------------------------------------------------------------------------
console.log("\nengine: consent before alerts");

await test("a new number gets a welcome first; the alert is held, not sent", async () => {
  const h = harness();
  const res = await h.engine.handleIntroduction(intro("e1", [A]));
  assert.equal(res[0].status, "held_welcome_queued");
  assert.equal(h.sent.length, 0, "nothing goes out until the scheduler runs");

  await h.engine.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(welcomesIn(h.sent).length, 1);
  assert.equal(isSafeInitialText(h.sent[0].text), true, "first message obeys LoopMessage's content rules");
  assert.ok(!h.sent[0].text.includes("rtucker"), "no lead details in a first message");
  assert.equal(h.engine.state.contacts[A_E164].status, "welcomed");
});

await test("a reply activates them and releases the held alert straight away", async () => {
  const h = harness();
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick();
  const out = await h.engine.handleInbound({ contact: A_E164, text: "Yes" });
  assert.equal(out.status, "active");
  await h.engine.idle();
  assert.equal(alertsIn(h.sent).length, 1);
  assert.match(alertsIn(h.sent)[0].text, /Agent: Radhamilca Tucker/);
});

await test("an ordinary reply counts as consent", async () => {
  const h = harness();
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick();
  await h.engine.handleInbound({ contact: A_E164, text: "ok thanks" });
  await h.engine.idle();
  assert.equal(h.engine.state.contacts[A_E164].status, "active");
  assert.equal(alertsIn(h.sent).length, 1);
});

await test("someone who texts the sender first gets alerts at once, and no welcome", async () => {
  const h = harness();
  await h.engine.handleInbound({ contact: A_E164, text: "Hi" });
  const res = await h.engine.handleIntroduction(intro("e1", [A]));
  assert.equal(res[0].status, "sent");
  await h.engine.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(welcomesIn(h.sent).length, 0);
});

await test("a reply that arrives before the welcome goes out cancels the welcome", async () => {
  const h = harness();
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.handleInbound({ contact: A_E164, text: "hello" });
  await h.engine.idle();
  await h.engine.tick();
  assert.equal(welcomesIn(h.sent).length, 0);
  assert.equal(alertsIn(h.sent).length, 1);
});

await test("a second lead for someone awaiting a reply is held too", async () => {
  const h = harness();
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick();
  const res = await h.engine.handleIntroduction(intro("e2", [A]));
  assert.equal(res[0].status, "held_awaiting_reply");
  await h.engine.handleInbound({ contact: A_E164, text: "yes" });
  await h.engine.idle();
  assert.equal(alertsIn(h.sent).length, 2);
});

await test("inbound from an email address is ignored", async () => {
  const h = harness();
  const out = await h.engine.handleInbound({ contact: "agent@icloud.com", text: "hi" });
  assert.equal(out.ignored, "email_contact");
  assert.equal(Object.keys(h.engine.state.contacts).length, 0);
});

await test("a STOP from an email address is logged as an error, with the address", () => {
  const logs = captureLogs();
  const h = harness({ logger: logs.logger });
  h.engine.handleInbound({ contact: "agent@icloud.com", text: "STOP" });
  const line = logs.lines.find((l) => l.msg === "inbound_from_email_contact");
  assert.equal(line.level, "error");
  assert.equal(line.contact, "agent@icloud.com");
});

await test("refusals of the welcome opt out: nothing held is ever sent", async () => {
  for (const reply of ["No", "Wrong number", "No thanks", "I'm not interested", "Please stop texting me, I never signed up for this"]) {
    const h = harness();
    await h.engine.handleIntroduction(intro("e1", [A]));
    await h.engine.tick();
    const out = h.engine.handleInbound({ contact: A_E164, text: reply });
    await h.engine.idle();
    assert.equal(out.status, "opted_out", reply);
    assert.equal(alertsIn(h.sent).length, 0, reply);
    assert.equal(h.engine.state.contacts[A_E164].held.length, 0, reply);
  }
});

await test("'who is this?' isn't consent: alerts stay held until a real reply", async () => {
  const logs = captureLogs();
  const h = harness({ logger: logs.logger });
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick();
  const q = h.engine.handleInbound({ contact: A_E164, text: "Who is this?" });
  await h.engine.idle();
  assert.equal(q.status, "welcomed");
  assert.equal(alertsIn(h.sent).length, 0);
  const held = logs.lines.find((l) => l.msg === "reply_not_consent");
  assert.equal(held.text, "Who is this?", "logged with the text, for someone to follow up");
  assert.equal(h.engine.state.contacts[A_E164].held.length, 1);
  h.engine.handleInbound({ contact: A_E164, text: "ah ok, thanks" });
  await h.engine.idle();
  assert.equal(alertsIn(h.sent).length, 1);
});

await test("a 'no' from someone already getting alerts is just a reply", () => {
  const h = harness();
  h.engine.handleInbound({ contact: A_E164, text: "hi" });
  const out = h.engine.handleInbound({ contact: A_E164, text: "No, already called her" });
  assert.equal(out.status, "active");
});

await test("replies to an alert about the lead don't opt the team member out", () => {
  for (const reply of ["That's the wrong number", "Wrong number on this one", "Don't text her yet, I'll call", "Who is she?", "Not interested in this one"]) {
    const h = harness();
    h.engine.handleInbound({ contact: A_E164, text: "hi" });
    const out = h.engine.handleInbound({ contact: A_E164, text: reply });
    assert.equal(out.status, "active", reply);
  }
});

await test("a stranger's replies to the welcome never release the alert", async () => {
  // A mistyped number on the Team page: none of these is consent.
  for (const reply of [
    "How did you get my number?", "Remove my number", "Don't contact me", "Who?", "?", "Quit texting me",
    "Never text me again", "Unsub", "wrong #", "You have the wrong person", "Do I know you?", "🤔", "",
  ]) {
    const h = harness();
    await h.engine.handleIntroduction(intro("e1", [A]));
    await h.engine.tick();
    h.engine.handleInbound({ contact: A_E164, text: reply });
    await h.engine.idle();
    await h.engine.tick();
    assert.notEqual(h.engine.state.contacts[A_E164].status, "active", JSON.stringify(reply));
    assert.equal(alertsIn(h.sent).length, 0, JSON.stringify(reply));
  }
});

await test("a reply is applied at once, even while a slow send is in progress", async () => {
  const g = gate();
  const h = harness({
    reply: async (m, n) => {
      if (n === 1) await g.promise;
      return { ok: true, messageId: `M${n}` };
    },
  });
  await h.engine.handleIntroduction(intro("e1", [A, B]));
  const ticking = h.engine.tick();
  await until(() => h.sent.length === 1); // A's welcome is stuck in LoopMessage
  const out = h.engine.handleInbound({ contact: B_E164, text: "STOP" });
  assert.equal(out.status, "opted_out", "applied without waiting for the send");
  assert.equal(h.store.data.contacts[B_E164].status, "opted_out", "and saved");
  g.open();
  await ticking;
  h.advance(15 * MIN);
  await h.engine.tick();
  assert.equal(h.sent.filter((m) => m.contact === B_E164).length, 0);
});

// ---------------------------------------------------------------------------
console.log("\nengine: STOP");

await test("STOP opts them out: held alerts dropped, later alerts skipped", async () => {
  const h = harness();
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick();
  await h.engine.handleInbound({ contact: A_E164, text: "STOP" });
  await h.engine.idle();
  const c = h.engine.state.contacts[A_E164];
  assert.equal(c.status, "opted_out");
  assert.equal(c.held.length, 0);
  assert.equal(h.sent.length, 1, "only the welcome ever went out");
  const res = await h.engine.handleIntroduction(intro("e2", [A]));
  assert.equal(res[0].status, "skipped_opted_out");
});

await test("STOP before the welcome is sent cancels it", async () => {
  const h = harness();
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.handleInbound({ contact: A_E164, text: "stop" });
  await h.engine.tick();
  assert.equal(h.sent.length, 0);
});

await test("an opted-out person stays out on 'hello' and comes back on START", async () => {
  const h = harness();
  await h.engine.handleInbound({ contact: A_E164, text: "STOP" });
  await h.engine.handleInbound({ contact: A_E164, text: "hello" });
  assert.equal(h.engine.state.contacts[A_E164].status, "opted_out");
  await h.engine.handleInbound({ contact: A_E164, text: "START" });
  assert.equal(h.engine.state.contacts[A_E164].status, "active");
});

await test("LoopMessage redelivering a 'YES' after a STOP doesn't opt them back in", async () => {
  const h = harness();
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick();
  h.engine.handleInbound({ contact: A_E164, text: "YES", messageId: "in-1" });
  await h.engine.idle();
  h.engine.handleInbound({ contact: A_E164, text: "STOP", messageId: "in-2" });
  const retried = h.engine.handleInbound({ contact: A_E164, text: "YES", messageId: "in-1" });
  assert.equal(retried.ignored, "duplicate_message");
  assert.equal(h.engine.state.contacts[A_E164].status, "opted_out");
  const restarted = h.restart();
  assert.equal(restarted.handleInbound({ contact: A_E164, text: "YES", messageId: "in-1" }).ignored, "duplicate_message", "remembered across a restart");
  assert.equal(restarted.state.contacts[A_E164].status, "opted_out");
});

await test("a STOP in the middle of a release stops the rest", async () => {
  const g = gate();
  const h = harness({
    reply: async (m, n) => {
      if (n === 2) await g.promise;
      return { ok: true, messageId: `M${n}` };
    },
  });
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick(); // welcome
  await h.engine.handleIntroduction(intro("e2", [A]));
  await h.engine.handleIntroduction(intro("e3", [A]));
  h.engine.handleInbound({ contact: A_E164, text: "yes" }); // releases e1, e2, e3
  await until(() => h.sent.length === 2); // e1 is with LoopMessage
  h.engine.handleInbound({ contact: A_E164, text: "STOP" });
  g.open();
  await h.engine.idle();
  assert.deepEqual(alertsIn(h.sent).map(entryOf), ["e1"], "only the alert already on its way");
  assert.equal(h.engine.state.contacts[A_E164].status, "opted_out");
  assert.equal(h.engine.state.contacts[A_E164].held.length, 0);
});

// ---------------------------------------------------------------------------
console.log("\nengine: LoopMessage pacing");

await test("first messages to new numbers are at least 15 minutes apart", async () => {
  const h = harness();
  await h.engine.handleIntroduction(intro("e1", [A, B]));
  await h.engine.tick();
  assert.equal(h.sent.length, 1);
  h.advance(14 * MIN);
  await h.engine.tick();
  assert.equal(h.sent.length, 1, "not before 15 minutes");
  h.advance(1 * MIN);
  await h.engine.tick();
  assert.equal(h.sent.length, 2);
});

await test("the daily cap follows LoopMessage's warm-up: 2 a day at the start", async () => {
  const h = harness();
  await h.engine.handleIntroduction(intro("e1", [A, B, C]));
  await h.engine.tick();
  h.advance(15 * MIN);
  await h.engine.tick();
  h.advance(15 * MIN);
  await h.engine.tick();
  assert.equal(welcomesIn(h.sent).length, 2, "the third waits for tomorrow");
  h.advance(DAY);
  await h.engine.tick();
  assert.equal(welcomesIn(h.sent).length, 3);
});

await test("warm-up schedule matches LoopMessage's table", () => {
  const start = T0;
  assert.equal(warmupCap(null, start), 2);
  assert.equal(warmupCap(start, start), 2); // day 1
  assert.equal(warmupCap(start, start + 1 * DAY), 2); // day 2
  assert.equal(warmupCap(start, start + 2 * DAY), 5); // day 3
  assert.equal(warmupCap(start, start + 4 * DAY), 10); // day 5
  assert.equal(warmupCap(start, start + 7 * DAY), 20); // day 8
  assert.equal(warmupCap(start, start + 14 * DAY), 30); // day 15
  assert.equal(warmupCap(start, start + 21 * DAY), 50); // day 22
});

await test("INIT_DAILY_CAP overrides the warm-up", async () => {
  const h = harness({ config: { initDailyCap: 1 } });
  await h.engine.handleIntroduction(intro("e1", [A, B]));
  await h.engine.tick();
  h.advance(15 * MIN);
  await h.engine.tick();
  assert.equal(h.sent.length, 1);
});

await test("opted-in people who haven't texted that day get one text per pass, 15 seconds apart", async () => {
  const h = harness();
  for (const c of [A_E164, B_E164, C_E164]) h.engine.handleInbound({ contact: c, text: "hi" });
  h.advance(2 * DAY);
  const res = await h.engine.handleIntroduction(intro("e1", [A, B, C]));
  assert.deepEqual(res.map((r) => r.status), ["queued_paced", "queued_paced", "queued_paced"]);
  await h.engine.tick();
  assert.equal(h.sent.length, 1, "one per pass, not all at once");
  h.advance(15_000);
  await h.engine.tick();
  h.advance(15_000);
  await h.engine.tick();
  assert.equal(h.sent.length, 3);
  assert.equal(h.sent[2].at - h.sent[0].at, 30_000);
});

await test("a longer gap between such texts is honoured when one is set", async () => {
  const h = harness({ config: { coldIntervalMs: 2 * MIN } });
  await h.engine.handleInbound({ contact: A_E164, text: "hi" });
  await h.engine.handleInbound({ contact: B_E164, text: "hi" });
  h.advance(2 * DAY);
  await h.engine.handleIntroduction(intro("e1", [A, B]));
  await h.engine.tick();
  assert.equal(h.sent.length, 1);
  h.advance(1 * MIN);
  await h.engine.tick();
  assert.equal(h.sent.length, 1, "not before 2 minutes");
  h.advance(1 * MIN);
  await h.engine.tick();
  assert.equal(h.sent.length, 2);
});

await test("if LoopMessage says we're over its limit (540), texts drop to its 2-minute pace for an hour", async () => {
  const h = harness({ reply: (m, n) => (n === 2 ? fail(540) : { ok: true, messageId: `M${n}` }) });
  for (const c of [A_E164, B_E164, C_E164]) h.engine.handleInbound({ contact: c, text: "hi" });
  h.advance(2 * DAY);
  await h.engine.handleIntroduction(intro("e1", [A, B, C]));
  await h.engine.tick(); // A
  h.advance(15_000);
  await h.engine.tick(); // B: refused 540
  assert.equal(h.engine.stats().slowed_down, true);
  assert.equal(h.engine.state.outbox.length, 2, "B's alert is kept");
  h.advance(15_000);
  await h.engine.tick();
  assert.equal(h.sent.length, 2, "waits out 2 minutes before trying again");
  h.advance(105_000); // 2 minutes after the refusal
  await h.engine.tick(); // B again, accepted
  assert.equal(alertsIn(h.sent).filter((m) => m.contact === B_E164).length, 2);
  h.advance(15_000);
  await h.engine.tick();
  assert.equal(h.sent.filter((m) => m.contact === C_E164).length, 0, "now 2 minutes apart");
  h.advance(105_000);
  await h.engine.tick();
  assert.equal(h.sent.filter((m) => m.contact === C_E164).length, 1);
  // An hour on, back to one per pass.
  h.advance(HOUR);
  assert.equal(h.engine.stats().slowed_down, false);
  await h.engine.handleIntroduction(intro("e2", [A, B]));
  await h.engine.tick();
  h.advance(15_000);
  await h.engine.tick();
  assert.equal(h.sent.filter((m) => entryOf(m) === "e2").length, 2);
});

await test("a second 540 while already slowed pauses for an hour", async () => {
  const h = harness({ reply: () => fail(540) });
  h.engine.handleInbound({ contact: A_E164, text: "hi" });
  h.advance(2 * DAY);
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick(); // refused: slowed
  h.advance(2 * MIN);
  await h.engine.tick(); // refused again at the slow pace: a real limit
  assert.equal(h.sent.length, 2);
  h.advance(30 * MIN);
  await h.engine.tick();
  assert.equal(h.sent.length, 2, "paused for an hour");
  h.advance(31 * MIN);
  await h.engine.tick();
  assert.equal(h.sent.length, 3);
});

await test("people who messaged recently get alerts at once, no spacing", async () => {
  const h = harness();
  await h.engine.handleInbound({ contact: A_E164, text: "hi" });
  await h.engine.handleInbound({ contact: B_E164, text: "hi" });
  const res = await h.engine.handleIntroduction(intro("e1", [A, B]));
  assert.deepEqual(res.map((r) => r.status), ["sent", "sent"]);
  assert.equal(h.sent.length, 2);
});

await test("a welcome and a paced alert share the gap: never in the same pass, never within it", async () => {
  const h = harness({ config: { coldIntervalMs: 2 * MIN } });
  h.engine.handleInbound({ contact: A_E164, text: "hi" });
  h.advance(2 * DAY); // A is active but quiet: their alerts are paced
  await h.engine.handleIntroduction(intro("e1", [A, B])); // A paced, B welcomed
  await h.engine.tick();
  assert.equal(h.sent.length, 1, "one such message per tick");
  assert.equal(welcomesIn(h.sent).length, 1, "the welcome goes first");
  h.advance(15 * 1000);
  await h.engine.tick();
  h.advance(90 * 1000);
  await h.engine.tick();
  assert.equal(h.sent.length, 1, "the paced alert waits 2 minutes after the welcome");
  h.advance(15 * 1000);
  await h.engine.tick();
  assert.equal(alertsIn(h.sent).length, 1);
  assert.ok(h.sent[1].at - h.sent[0].at >= 2 * MIN);
});

await test("a paced alert pushes the next welcome back by the gap", async () => {
  const h = harness({ config: { coldIntervalMs: 2 * MIN } });
  h.engine.handleInbound({ contact: A_E164, text: "hi" });
  h.advance(2 * DAY);
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick(); // A's paced alert
  assert.equal(alertsIn(h.sent).length, 1);
  await h.engine.handleIntroduction(intro("e2", [B]));
  h.advance(1 * MIN);
  await h.engine.tick();
  assert.equal(welcomesIn(h.sent).length, 0, "not within 2 minutes of the paced alert");
  h.advance(1 * MIN);
  await h.engine.tick();
  assert.equal(welcomesIn(h.sent).length, 1);
});

await test("the welcome cap is a rolling 24 hours: midnight doesn't reset it", async () => {
  const h = harness({ config: { initDailyCap: 2 } });
  h.advance(11 * HOUR + 30 * MIN); // 23:30 UTC
  await h.engine.handleIntroduction(intro("e1", [A, B, C]));
  await h.engine.tick(); // 23:30
  h.advance(15 * MIN);
  await h.engine.tick(); // 23:45
  h.advance(15 * MIN);
  await h.engine.tick(); // 00:00, a new UTC day
  assert.equal(welcomesIn(h.sent).length, 2);
  h.advance(23 * HOUR);
  await h.engine.tick(); // 23:00, both still inside the window
  assert.equal(welcomesIn(h.sent).length, 2);
  h.advance(30 * MIN);
  await h.engine.tick(); // 24 hours after the first
  assert.equal(welcomesIn(h.sent).length, 3);
});

await test("spacing is counted from when a slow send finished, not when it started", async () => {
  let h;
  h = harness({
    reply: (m, n) => {
      h.advance(MIN); // LoopMessage takes a minute to answer
      return { ok: true, messageId: `M${n}` };
    },
  });
  await h.engine.handleIntroduction(intro("e1", [A, B]));
  await h.engine.tick();
  h.advance(14 * MIN); // 15 minutes after it started, 14 after it finished
  await h.engine.tick();
  assert.equal(welcomesIn(h.sent).length, 1);
  h.advance(1 * MIN);
  await h.engine.tick();
  assert.equal(welcomesIn(h.sent).length, 2);
});

await test("state from the per-day counter carries today's welcomes into the rolling window", async () => {
  const v1 = {
    contacts: {}, welcomeQueue: [], outbox: [], dedupe: {},
    pacing: { lastInitAt: T0 - HOUR, firstInitAt: T0 - 30 * DAY, initDay: utcDay(T0 - HOUR), initCountToday: 2 },
  };
  const h = harness({ config: { initDailyCap: 2 }, store: new MemoryStore(v1) });
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick();
  assert.equal(welcomesIn(h.sent).length, 0, "the 2 sent earlier today still count");
  h.advance(23 * HOUR);
  await h.engine.tick();
  assert.equal(welcomesIn(h.sent).length, 1);
});

await test("state from the previous version keeps its welcome spacing and duplicate windows", async () => {
  const v1 = {
    contacts: { [A_E164]: { contact: A_E164, status: "active", name: "Avery", lastInboundAt: T0 - 2 * DAY, held: [] } },
    welcomeQueue: [], outbox: [],
    dedupe: { [`e1:${A_E164}`]: T0 + HOUR }, // the old version texted e1 five hours ago (6h window)
    pacing: { lastInitAt: T0 - MIN, firstInitAt: T0 - 30 * DAY, initDay: utcDay(T0), initCountToday: 1, lastColdAt: null },
  };
  const h = harness({ store: new MemoryStore(v1), config: { coldIntervalMs: 2 * MIN } });
  await h.engine.handleIntroduction(intro("e2", [A])); // A is quiet: paced
  await h.engine.tick();
  assert.equal(h.sent.length, 0, "the old version's welcome a minute ago still holds the 2-minute spacing");
  h.advance(MIN);
  await h.engine.tick();
  assert.equal(alertsIn(h.sent).length, 1);
  h.advance(2 * HOUR); // past the old 6-hour window
  assert.equal((await h.engine.handleIntroduction(intro("e1", [A])))[0].status, "duplicate_suppressed");
});

await test("welcomes sent just before midnight under the per-day counter still count after it", async () => {
  // The per-day counter reset at midnight, so only the contacts know.
  const midnight = Date.UTC(2026, 9, 8, 0, 0, 0);
  const at = (h, m) => midnight - (24 - h) * HOUR + m * MIN; // the evening before
  const v1 = {
    contacts: {
      [B_E164]: { contact: B_E164, status: "welcomed", name: "Blake", welcomedAt: at(22, 50), held: [] },
      [C_E164]: { contact: C_E164, status: "welcomed", name: "Casey", welcomedAt: at(23, 10), held: [] },
    },
    welcomeQueue: [], outbox: [], dedupe: {},
    pacing: { lastInitAt: at(23, 10), firstInitAt: at(22, 50) - 30 * DAY, initDay: utcDay(midnight), initCountToday: 0 },
  };
  const h = harness({ config: { initDailyCap: 2 }, store: new MemoryStore(v1), start: midnight + 10 * MIN });
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick();
  assert.equal(welcomesIn(h.sent).length, 0, "22:50 and 23:10 still fill the cap");
  h.advance(22 * HOUR + 40 * MIN); // 22:50, 24h after the first
  await h.engine.tick();
  assert.equal(welcomesIn(h.sent).length, 1);
});

// ---------------------------------------------------------------------------
console.log("\nengine: duplicates, expiry, restarts");

await test("a replayed lead texts nobody twice, even across a restart", async () => {
  const h = harness();
  await h.engine.handleInbound({ contact: A_E164, text: "hi" });
  await h.engine.handleIntroduction(intro("e1", [A]));
  const restarted = h.restart();
  const res = await restarted.handleIntroduction(intro("e1", [A]));
  assert.equal(res[0].status, "duplicate_suppressed");
  assert.equal(h.sent.length, 1);
});

await test("a lead re-fired while still held is sent once on release", async () => {
  const h = harness();
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick();
  h.advance(7 * HOUR);
  await h.engine.handleIntroduction(intro("e1", [A]));
  assert.equal(h.engine.state.contacts[A_E164].held.length, 1, "one held copy per lead");
  await h.engine.handleInbound({ contact: A_E164, text: "yes" });
  await h.engine.idle();
  assert.equal(alertsIn(h.sent).length, 1);
});

await test("a lead re-fired hours later isn't a second text for someone already alerted", async () => {
  const h = harness();
  h.engine.handleInbound({ contact: A_E164, text: "hi" });
  await h.engine.handleIntroduction(intro("e1", [A]));
  h.advance(7 * HOUR);
  const again = await h.engine.handleIntroduction(intro("e1", [A]));
  assert.equal(again[0].status, "duplicate_suppressed");
  assert.equal(alertsIn(h.sent).length, 1);
});

await test("the duplicate window runs from when the alert was sent, not when it was first held", async () => {
  const h = harness();
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick(); // welcome
  h.advance(23 * HOUR + 30 * MIN);
  h.engine.handleInbound({ contact: A_E164, text: "yes" }); // held 23.5h, sent now
  await h.engine.idle();
  assert.equal(alertsIn(h.sent).length, 1);
  h.advance(45 * MIN); // the key set when it was held has expired
  const again = await h.engine.handleIntroduction(intro("e1", [A]));
  assert.equal(again[0].status, "duplicate_suppressed");
  assert.equal(alertsIn(h.sent).length, 1);
});

await test("the duplicate window is never shorter than how long an alert can be held", () => {
  const h = harness({ config: { holdTtlMs: 48 * HOUR, dedupeTtlMs: 6 * HOUR } });
  assert.equal(h.engine.config.dedupeTtlMs, 48 * HOUR);
});

await test("a held alert older than a day is dropped, not sent late", async () => {
  const h = harness();
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick();
  h.advance(25 * HOUR);
  await h.engine.handleInbound({ contact: A_E164, text: "yes" });
  await h.engine.idle();
  assert.equal(alertsIn(h.sent).length, 0);
  assert.equal(h.engine.state.contacts[A_E164].status, "active");
});

await test("an alert held under the old wording goes out in the new wording", async () => {
  // State saved before the Oct 2026 copy change held finished text only.
  const legacy = {
    contacts: {
      [A_E164]: {
        contact: A_E164, status: "welcomed", name: "Eddy", clientName: "Demo Portal",
        createdAt: T0, welcomedAt: T0,
        held: [{
          entryId: "old-1",
          text: "Hi Eddy, we received a new lead in the Introduction stage.\n\n" +
            "Lead name: Laura Wilson\nEmail: laura@hotmail.com\nCompany: Legacy Realty Group",
          passthrough: "{}",
          at: T0,
        }],
      },
    },
    welcomeQueue: [], outbox: [], dedupe: {}, pacing: {},
  };
  const h = harness({ store: new MemoryStore(legacy) });
  await h.engine.handleInbound({ contact: A_E164, text: "yes" });
  await h.engine.idle();
  assert.equal(
    h.sent[0].text,
    "Hi Eddy, you have a new agent in the Introduction stage.\n\n" +
      "Agent: Laura Wilson\nBrokerage: Legacy Realty Group",
  );
});

await test("a held alert is worded at send time, not when it was held", async () => {
  const h = harness();
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick();
  h.engine.state.contacts[A_E164].held[0].text = "STALE WORDING";
  await h.engine.handleInbound({ contact: A_E164, text: "yes" });
  await h.engine.idle();
  assert.equal(alertsIn(h.sent)[0].text, buildText("Avery Real", PINNED.lead));
});

await test("at most 5 alerts are held per person", async () => {
  const h = harness();
  await h.engine.handleIntroduction(intro("e0", [A]));
  await h.engine.tick();
  for (let i = 1; i <= 6; i++) await h.engine.handleIntroduction(intro(`e${i}`, [A]));
  assert.equal(h.engine.state.contacts[A_E164].held.length, 5);
  await h.engine.handleInbound({ contact: A_E164, text: "yes" });
  await h.engine.idle();
  assert.equal(alertsIn(h.sent).length, 5);
});

await test("welcome queue, held alerts and the pacing clock survive a restart", async () => {
  const h = harness();
  await h.engine.handleIntroduction(intro("e1", [A, B]));
  await h.engine.tick(); // welcome to A
  let e = h.restart();
  h.advance(14 * MIN);
  await e.tick();
  assert.equal(h.sent.length, 1, "15-minute spacing survived the restart");
  h.advance(1 * MIN);
  await e.tick();
  assert.equal(welcomesIn(h.sent).length, 2, "B's queued welcome survived");
  e = h.restart();
  await e.handleInbound({ contact: A_E164, text: "yes" });
  await e.idle();
  assert.equal(alertsIn(h.sent).length, 1, "A's held alert survived");
});

await test("a reply racing a send releases the held alert exactly once", async () => {
  const h = harness({
    reply: async (m, n) => {
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, messageId: `M${n}` };
    },
  });
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick();
  await Promise.all([
    h.engine.handleInbound({ contact: A_E164, text: "yes", messageId: "in-1" }),
    h.engine.handleInbound({ contact: A_E164, text: "yes", messageId: "in-1" }), // LoopMessage retrying
    h.engine.handleInbound({ contact: A_E164, text: "thanks", messageId: "in-2" }),
    h.engine.tick(),
  ]);
  await h.engine.idle();
  assert.equal(alertsIn(h.sent).length, 1);
});

const slowOk = async (m, n) => {
  await new Promise((r) => setTimeout(r, 5));
  return { ok: true, messageId: `M${n}` };
};

await test("overlapping scheduler ticks never send the same welcome twice", async () => {
  // A slow LoopMessage call can outlast the 15s tick interval.
  const h = harness({ reply: slowOk });
  await h.engine.handleIntroduction(intro("e1", [A, B]));
  await Promise.all([h.engine.tick(), h.engine.tick(), h.engine.tick()]);
  assert.equal(welcomesIn(h.sent).length, 1);
});

await test("a reply during a welcome send doesn't knock the next person out of the queue", async () => {
  const g = gate();
  const h = harness({
    reply: async (m, n) => {
      if (n === 1) await g.promise;
      return { ok: true, messageId: `M${n}` };
    },
  });
  await h.engine.handleIntroduction(intro("e1", [A, B]));
  const ticking = h.engine.tick();
  await until(() => h.sent.length === 1); // A's welcome is on its way
  h.engine.handleInbound({ contact: A_E164, text: "yes" });
  g.open();
  await ticking;
  await h.engine.idle();
  assert.equal(h.engine.state.contacts[A_E164].status, "active", "the reply isn't undone by the welcome finishing");
  h.advance(15 * MIN);
  await h.engine.tick();
  assert.equal(welcomesIn(h.sent).filter((m) => m.contact === B_E164).length, 1);
});

await test("an accepted introduction survives a redeploy before it's routed", async () => {
  const old = harness();
  old.engine.handleInbound({ contact: A_E164, text: "hi" });
  old.engine.enqueueIntroduction(intro("e1", [A]));
  const disk = onDiskNow(old); // the webhook has been answered; the process dies here
  assert.equal(disk.intake.length, 1, "saved before the webhook is answered");

  const h = harness({ store: new MemoryStore(disk), start: old.now() });
  await h.engine.tick();
  assert.equal(alertsIn(h.sent).length, 1, "the next process routes it");
  assert.equal(h.engine.state.intake.length, 0);
});

await test("a welcome cut off mid-send by a redeploy is never sent a second time", async () => {
  let disk = null;
  const old = harness({
    reply: () => {
      disk = onDiskNow(old);
      return new Promise(() => {}); // the process dies inside the send
    },
  });
  await old.engine.handleIntroduction(intro("e1", [A, B]));
  old.engine.tick();
  await until(() => disk);

  const h = harness({ store: new MemoryStore(disk), start: old.now() });
  const a = h.engine.state.contacts[A_E164];
  assert.equal(a.status, "welcomed");
  assert.equal(a.welcomeUnconfirmed, true);
  for (let i = 0; i < 3; i++) {
    await h.engine.tick();
    h.advance(15 * MIN);
  }
  assert.equal(h.sent.filter((m) => m.contact === A_E164).length, 0, "no second first message");
  assert.equal(welcomesIn(h.sent).length, 1, "B's welcome still goes, 15 minutes later");
  assert.ok(h.sent[0].at - old.now() >= 15 * MIN);
});

await test("an alert cut off mid-release isn't resent, and the rest still go", async () => {
  let disk = null;
  const old = harness({
    reply: (m, n) => {
      if (n === 2) {
        disk = onDiskNow(old);
        return new Promise(() => {});
      }
      return { ok: true, messageId: `M${n}` };
    },
  });
  await old.engine.handleIntroduction(intro("e1", [A]));
  await old.engine.tick(); // welcome
  await old.engine.handleIntroduction(intro("e2", [A]));
  old.engine.handleInbound({ contact: A_E164, text: "yes" }); // release: e1 is cut off
  await until(() => disk);

  const h = harness({ store: new MemoryStore(disk), start: old.now() });
  await h.engine.tick();
  assert.deepEqual(alertsIn(h.sent).map(entryOf), ["e2"]);
  assert.equal(h.engine.state.contacts[A_E164].held.length, 0);
});

await test("a paced alert cut off mid-send isn't resent", async () => {
  let disk = null;
  const old = harness({
    reply: () => {
      disk = onDiskNow(old);
      return new Promise(() => {});
    },
  });
  old.engine.handleInbound({ contact: A_E164, text: "hi" });
  old.advance(2 * DAY);
  await old.engine.handleIntroduction(intro("e1", [A]));
  old.engine.tick();
  await until(() => disk);

  const h = harness({ store: new MemoryStore(disk), start: old.now() });
  for (let i = 0; i < 3; i++) {
    await h.engine.tick();
    h.advance(5 * MIN);
  }
  assert.equal(h.sent.length, 0);
  assert.equal(h.engine.state.outbox.length, 0);
});

await test("no welcome goes out unless its in-flight mark is on disk", async () => {
  const store = new FlakyStore();
  const h = harness({ store });
  await h.engine.handleIntroduction(intro("e1", [A]));
  store.failing = true;
  await h.engine.tick();
  assert.equal(h.sent.length, 0);
  store.failing = false;
  h.advance(5 * MIN);
  await h.engine.tick();
  assert.equal(welcomesIn(h.sent).length, 1);
});

await test("no alert goes out unless its in-flight mark is on disk: immediate, released or paced", async () => {
  // Immediate: waits in the outbox.
  let store = new FlakyStore();
  let h = harness({ store });
  h.engine.handleInbound({ contact: A_E164, text: "hi" });
  store.failing = true;
  const res = await h.engine.handleIntroduction(intro("e1", [A]));
  assert.equal(res[0].status, "queued_retry");
  assert.equal(h.sent.length, 0);
  store.failing = false;
  h.advance(5 * MIN);
  await h.engine.tick();
  assert.equal(alertsIn(h.sent).length, 1);

  // Released: stays held, the scheduler sends it once the disk is back.
  store = new FlakyStore();
  h = harness({ store });
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick();
  store.failing = true;
  h.engine.handleInbound({ contact: A_E164, text: "yes" });
  await h.engine.idle();
  assert.equal(alertsIn(h.sent).length, 0);
  store.failing = false;
  await h.engine.tick();
  assert.equal(alertsIn(h.sent).length, 1);

  // Paced: stays in the outbox.
  store = new FlakyStore();
  h = harness({ store });
  h.engine.handleInbound({ contact: A_E164, text: "hi" });
  h.advance(2 * DAY);
  await h.engine.handleIntroduction(intro("e1", [A]));
  store.failing = true;
  await h.engine.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.engine.state.outbox.length, 1);
  store.failing = false;
  h.advance(5 * MIN);
  await h.engine.tick();
  assert.equal(alertsIn(h.sent).length, 1);
});

await test("a reply that couldn't be saved gets a 503 until it is, and is never applied twice", () => {
  const store = new FlakyStore();
  const h = harness({ store });
  store.failing = true;
  const first = h.engine.handleInbound({ contact: A_E164, text: "STOP", messageId: "in-1" });
  assert.equal(first.saved, false, "the webhook answers 503");
  assert.equal(first.status, "opted_out", "but it's honoured at once");
  const stillFailing = h.engine.handleInbound({ contact: A_E164, text: "STOP", messageId: "in-1" });
  assert.equal(stillFailing.saved, false, "LoopMessage's retry gets a 503 too while the disk is failing");
  store.failing = false;
  const retry = h.engine.handleInbound({ contact: A_E164, text: "STOP", messageId: "in-1" });
  assert.equal(retry.ignored, "duplicate_message");
  assert.equal(retry.saved, true);
  assert.equal(store.data.contacts[A_E164].status, "opted_out");
});

await test("a YES that couldn't be saved can't undo a STOP sent after it", async () => {
  const store = new FlakyStore();
  const h = harness({ store });
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick();
  store.failing = true;
  assert.equal(h.engine.handleInbound({ contact: A_E164, text: "YES", messageId: "in-yes" }).saved, false);
  store.failing = false;
  h.engine.handleInbound({ contact: A_E164, text: "STOP", messageId: "in-stop" });
  const redelivered = h.engine.handleInbound({ contact: A_E164, text: "YES", messageId: "in-yes" });
  assert.equal(redelivered.ignored, "duplicate_message");
  await h.engine.idle();
  assert.equal(h.engine.state.contacts[A_E164].status, "opted_out");
  assert.equal(alertsIn(h.sent).length, 0);
});

await test("a delivery event that couldn't be saved is acknowledged only once it is", async () => {
  const store = new FlakyStore();
  const h = harness({ store });
  h.engine.handleInbound({ contact: A_E164, text: "hi" });
  await h.engine.handleIntroduction(intro("e1", [A])); // M1
  store.failing = true;
  const failed = () => h.engine.handleStatusEvent({ event: "message_failed", messageId: "M1", errorCode: 1010 });
  assert.equal(failed().saved, false);
  assert.equal(failed().saved, false, "redelivered while the disk is still failing");
  store.failing = false;
  const again = failed();
  assert.equal(again.ignored, "unknown_message");
  assert.equal(again.saved, true);
});

await test("an introduction that couldn't be saved says so, on either path", async () => {
  const store = new FlakyStore();
  const h = harness({ store });
  store.failing = true;
  const { saved } = h.engine.enqueueIntroduction(intro("e1", [A]));
  assert.equal(saved, false);
  let res = await processIntroduction(DEMO, { engine: { enqueueIntroduction: () => ({ id: "x", saved: false }) }, logger: quiet, enqueue: true });
  assert.equal(res.saved, false);
  res = await processIntroduction(DEMO, { engine: { dirty: true, handleIntroduction: async () => [] }, logger: quiet });
  assert.equal(res.saved, false, "?wait=1 answers 503");
  res = await processIntroduction(DEMO, { engine: { dirty: true, handleIntroduction: async () => [] }, logger: quiet, dryRun: true });
  assert.equal(res.saved, true, "a dry run saves nothing, so nothing failed");
});

await test("a paced send cut off by a restart after a STOP still counts for the spacing", async () => {
  const config = { coldIntervalMs: 2 * MIN };
  const old = harness({ config, reply: () => new Promise(() => {}) }); // the process dies inside the send
  old.engine.handleInbound({ contact: A_E164, text: "hi" });
  old.engine.handleInbound({ contact: B_E164, text: "hi" });
  old.advance(2 * DAY);
  await old.engine.handleIntroduction(intro("e1", [A, B])); // both paced
  old.engine.tick(); // A's alert is sent and never returns
  await until(() => old.sent.length === 1);
  old.engine.handleInbound({ contact: A_E164, text: "STOP" }); // removes A's alert, saved
  const h = harness({ config, store: new MemoryStore(onDiskNow(old)), start: old.now() });
  await h.engine.tick();
  assert.equal(h.sent.length, 0, "B waits 2 minutes from the cut-off send");
  h.advance(2 * MIN);
  await h.engine.tick();
  assert.equal(h.sent.filter((m) => m.contact === B_E164).length, 1);
});

await test("an immediate alert cut off by a restart is logged as possibly sent, and not resent", async () => {
  const old = harness({ reply: () => new Promise(() => {}) });
  old.engine.handleInbound({ contact: A_E164, text: "hi" });
  old.engine.enqueueIntroduction(intro("e1", [A]));
  await until(() => old.sent.length === 1);
  const logs = captureLogs();
  const h = harness({ store: new MemoryStore(onDiskNow(old)), start: old.now(), logger: logs.logger });
  assert.ok(logs.lines.some((l) => l.msg === "alert_send_interrupted" && l.entry_id === "e1"));
  await h.engine.tick();
  assert.equal(h.sent.length, 0);
});

await test("alerts left held on someone already active are sent, paced if they've gone quiet", async () => {
  const held = (entryId) => ({ entryId, lead: PINNED.lead, name: "Avery", passthrough: JSON.stringify({ pipeline_entry_id: entryId }), at: T0 });
  const state = {
    contacts: {
      [A_E164]: { contact: A_E164, status: "active", name: "Avery", lastInboundAt: T0, held: [held("r1")] },
      [B_E164]: { contact: B_E164, status: "active", name: "Blake", lastInboundAt: T0 - 2 * DAY, held: [held("q1"), held("q2")] },
    },
  };
  const h = harness({ store: new MemoryStore(state) });
  await h.engine.tick();
  assert.deepEqual(alertsIn(h.sent).map(entryOf), ["r1", "q1"], "recent goes at once; one paced alert per tick");
  h.advance(2 * MIN);
  await h.engine.tick();
  assert.deepEqual(alertsIn(h.sent).map(entryOf), ["r1", "q1", "q2"]);
});

await test("shutdown waits for work queued while it waits, and gives up at its limit", async () => {
  const first = gate();
  const second = gate();
  const h = harness({
    reply: async (m, n) => {
      if (n === 2) await first.promise;
      if (n === 3) await second.promise;
      return { ok: true, messageId: `M${n}` };
    },
  });
  await h.engine.handleIntroduction(intro("e0", [B]));
  await h.engine.tick(); // B's welcome; e0 is held for B
  h.engine.handleInbound({ contact: A_E164, text: "hi" });
  h.engine.enqueueIntroduction(intro("e1", [A])); // A's alert gets stuck in LoopMessage
  let drained = null;
  const waiting = h.engine.drain({ timeoutMs: 2000 }).then((v) => (drained = v));
  await until(() => h.sent.length === 2);
  h.engine.handleInbound({ contact: B_E164, text: "yes" }); // queues B's release during shutdown
  first.open();
  await until(() => h.sent.length === 3); // B's release is sending
  assert.equal(drained, null, "still waiting for B's release");
  second.open();
  await waiting;
  assert.equal(drained, true);
  assert.deepEqual(alertsIn(h.sent).map(entryOf).sort(), ["e0", "e1"]);

  const stuck = harness({ reply: () => new Promise(() => {}) });
  stuck.engine.handleInbound({ contact: A_E164, text: "hi" });
  stuck.engine.enqueueIntroduction(intro("e1", [A]));
  assert.equal(await stuck.engine.drain({ timeoutMs: 30 }), false);
});

await test("dry run previews without changing state, sending, or blocking the real run", async () => {
  const h = harness();
  const res = await h.engine.handleIntroduction(intro("e1", [A]), { dryRun: true });
  assert.equal(res[0].status, "would_hold_and_send_welcome");
  assert.equal(Object.keys(h.engine.state.contacts).length, 0);
  await h.engine.tick();
  assert.equal(h.sent.length, 0);
  const real = await h.engine.handleIntroduction(intro("e1", [A]));
  assert.equal(real[0].status, "held_welcome_queued");
});

// ---------------------------------------------------------------------------
console.log("\nengine: LoopMessage refusals");

await test("welcome refused 500 (opted out) marks them opted out", async () => {
  const h = harness({ reply: () => fail(500) });
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick();
  assert.equal(h.engine.state.contacts[A_E164].status, "opted_out");
});

await test("welcome refused as an invalid number marks them unreachable", async () => {
  for (const code of [180, 165]) {
    const h = harness({ reply: () => fail(code) });
    await h.engine.handleIntroduction(intro("e1", [A]));
    await h.engine.tick();
    const c = h.engine.state.contacts[A_E164];
    assert.equal(c.status, "unreachable", `code ${code}`);
    assert.equal(c.held.length, 0);
    const res = await h.engine.handleIntroduction(intro("e2", [A]));
    assert.equal(res[0].status, "skipped_unreachable");
  }
});

await test("welcome refused 520 waits for them to text first, then releases", async () => {
  const h = harness({ reply: (m, n) => (n === 1 ? fail(520) : { ok: true, messageId: `M${n}` }) });
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick();
  const c = h.engine.state.contacts[A_E164];
  assert.equal(c.status, "needs_inbound");
  h.advance(30 * MIN);
  await h.engine.tick();
  assert.equal(h.sent.length, 1, "no second attempt to start the conversation");
  await h.engine.handleInbound({ contact: A_E164, text: "hi" });
  await h.engine.idle();
  assert.equal(alertsIn(h.sent).length, 1);
});

await test("a welcome refused 540 is tried again after 2 minutes, and they stay queued", async () => {
  const h = harness({ reply: (m, n) => (n === 1 ? fail(540) : { ok: true, messageId: `M${n}` }) });
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick();
  assert.equal(h.engine.state.contacts[A_E164].status, "welcome_queued");
  h.advance(1 * MIN);
  await h.engine.tick();
  assert.equal(h.sent.length, 1);
  h.advance(1 * MIN);
  await h.engine.tick();
  assert.equal(h.engine.state.contacts[A_E164].status, "welcomed");
});

await test("welcome refused for the plan's limit (550) pauses an hour and keeps them queued", async () => {
  const h = harness({ reply: (m, n) => (n === 1 ? fail(550) : { ok: true, messageId: `M${n}` }) });
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick();
  assert.equal(h.engine.state.contacts[A_E164].status, "welcome_queued");
  h.advance(30 * MIN);
  await h.engine.tick();
  assert.equal(h.sent.length, 1);
  h.advance(31 * MIN);
  await h.engine.tick();
  assert.equal(h.engine.state.contacts[A_E164].status, "welcomed");
});

await test("a sender/account problem (220) pauses sending without failing the contact", async () => {
  const h = harness({ reply: (m, n) => (n === 1 ? fail(220) : { ok: true, messageId: `M${n}` }) });
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick();
  const c = h.engine.state.contacts[A_E164];
  assert.equal(c.status, "welcome_queued");
  assert.ok(!c.welcomeAttempts, "not counted against them");
  h.advance(61 * MIN);
  await h.engine.tick();
  assert.equal(c.status, "welcomed");
});

await test("a LoopMessage outage retries the welcome without failing the person", async () => {
  const h = harness({ reply: (m, n) => (n <= 4 ? unreachable : { ok: true, messageId: `M${n}` }) });
  await h.engine.handleIntroduction(intro("e1", [A]));
  for (let i = 0; i < 4; i++) {
    await h.engine.tick();
    h.advance(5 * MIN);
  }
  await h.engine.tick();
  assert.equal(h.engine.state.contacts[A_E164].status, "welcomed");
  assert.ok(!h.engine.state.contacts[A_E164].welcomeAttempts, "not counted against them");
});

await test("a welcome LoopMessage may have received is never sent again, and counts toward the cap", async () => {
  const h = harness({ reply: (m, n) => (n === 1 ? maybeSent : { ok: true, messageId: `M${n}` }) });
  await h.engine.handleIntroduction(intro("e1", [A, B]));
  await h.engine.tick();
  const a = h.engine.state.contacts[A_E164];
  assert.equal(a.status, "welcomed");
  assert.equal(a.welcomeUnconfirmed, true);
  for (let i = 0; i < 4; i++) {
    h.advance(15 * MIN);
    await h.engine.tick();
  }
  assert.equal(h.sent.filter((m) => m.contact === A_E164).length, 1, "A's welcome isn't repeated");
  assert.equal(h.engine.stats().welcomes_last_24h, 2);
  h.engine.handleInbound({ contact: A_E164, text: "yes" });
  await h.engine.idle();
  assert.equal(alertsIn(h.sent).length, 1, "a reply still releases their alert");
});

await test("an alert LoopMessage may have received is not sent again", async () => {
  const h = harness({ reply: () => ({ ...maybeSent, status: 502, error: "bad gateway" }) });
  h.engine.handleInbound({ contact: A_E164, text: "hi" });
  const res = await h.engine.handleIntroduction(intro("e1", [A]));
  assert.equal(res[0].status, "sent_unconfirmed");
  for (let i = 0; i < 3; i++) {
    h.advance(5 * MIN);
    await h.engine.tick();
  }
  assert.equal(h.sent.length, 1);
  assert.equal((await h.engine.handleIntroduction(intro("e1", [A])))[0].status, "duplicate_suppressed");
});

await test("a send that throws counts as maybe sent, not as a failure to retry", async () => {
  const h = harness({ reply: () => { throw new Error("boom"); } });
  h.engine.handleInbound({ contact: A_E164, text: "hi" });
  const res = await h.engine.handleIntroduction(intro("e1", [A]));
  assert.equal(res[0].status, "sent_unconfirmed");
});

await test("an unrecognised refusal code gives up on the welcome after 3 tries", async () => {
  const h = harness({ reply: () => fail(100) });
  await h.engine.handleIntroduction(intro("e1", [A]));
  for (let i = 0; i < 3; i++) {
    await h.engine.tick();
    h.advance(5 * MIN);
  }
  const c = h.engine.state.contacts[A_E164];
  assert.equal(c.status, "welcome_failed");
  assert.equal(c.held.length, 0);
});

await test("an alert refused 500 marks the person opted out", async () => {
  const h = harness({ reply: () => fail(500) });
  await h.engine.handleInbound({ contact: A_E164, text: "hi" });
  const res = await h.engine.handleIntroduction(intro("e1", [A]));
  assert.equal(res[0].status, "failed_opted_out");
  assert.equal(h.engine.state.contacts[A_E164].status, "opted_out");
});

await test("an alert refused 510 (conversation gone) re-welcomes and holds the alert", async () => {
  const h = harness({ reply: (m, n) => (n === 1 ? fail(510) : { ok: true, messageId: `M${n}` }) });
  await h.engine.handleInbound({ contact: A_E164, text: "hi" });
  const res = await h.engine.handleIntroduction(intro("e1", [A]));
  assert.equal(res[0].status, "held_welcome_queued");
  const c = h.engine.state.contacts[A_E164];
  assert.equal(c.held.length, 1);
  await h.engine.tick();
  assert.equal(welcomesIn(h.sent).length, 1);
});

await test("an alert that couldn't reach LoopMessage is retried from the outbox", async () => {
  const h = harness({ reply: (m, n) => (n === 1 ? unreachable : { ok: true, messageId: `M${n}` }) });
  await h.engine.handleInbound({ contact: A_E164, text: "hi" });
  const res = await h.engine.handleIntroduction(intro("e1", [A]));
  assert.equal(res[0].status, "queued_retry");
  await h.engine.tick();
  assert.equal(h.sent.length, 1, "waits for the retry delay");
  h.advance(5 * MIN);
  await h.engine.tick();
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1].text, /Agent: Radhamilca Tucker/);
});

await test("delivery webhooks update the welcome: delivered, or failed as invalid", async () => {
  const h = harness();
  await h.engine.handleIntroduction(intro("e1", [A, B]));
  await h.engine.tick(); // M1 → A
  h.advance(15 * MIN);
  await h.engine.tick(); // M2 → B
  await h.engine.handleStatusEvent({ event: "message_delivered", messageId: "M1" });
  assert.ok(h.engine.state.contacts[A_E164].welcomeDeliveredAt);
  await h.engine.handleStatusEvent({ event: "message_failed", messageId: "M2", errorCode: 180 });
  assert.equal(h.engine.state.contacts[B_E164].status, "unreachable");
  const ignored = await h.engine.handleStatusEvent({ event: "message_failed", messageId: "nope" });
  assert.equal(ignored.ignored, "unknown_message");
});

await test("a welcome that failed without a reason is sent again, 3 times at most", async () => {
  const h = harness({ config: { initDailyCap: 10 } });
  await h.engine.handleIntroduction(intro("e1", [A]));
  for (let i = 1; i <= 3; i++) {
    await h.engine.tick();
    h.engine.handleStatusEvent({ event: "message_failed", messageId: `M${i}`, errorCode: null });
    if (i === 1) {
      // LoopMessage redelivering the same event changes nothing.
      h.engine.handleStatusEvent({ event: "message_failed", messageId: "M1", errorCode: null });
      assert.equal(h.engine.state.contacts[A_E164].welcomeAttempts, 1);
      assert.equal(h.engine.state.contacts[A_E164].status, "welcome_queued");
    }
    h.advance(15 * MIN);
  }
  assert.equal(welcomesIn(h.sent).length, 3);
  assert.equal(h.engine.state.contacts[A_E164].status, "welcome_failed");
});

await test("a welcome that failed with 520 waits for them to text first", async () => {
  const h = harness();
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick();
  h.engine.handleStatusEvent({ event: "message_failed", messageId: "M1", errorCode: 520 });
  assert.equal(h.engine.state.contacts[A_E164].status, "needs_inbound");
  assert.equal(h.engine.state.contacts[A_E164].held.length, 1, "their alert waits for them");
});

await test("an alert LoopMessage couldn't deliver is logged, and the lead can be sent again", async () => {
  const logs = captureLogs();
  const h = harness({ logger: logs.logger });
  h.engine.handleInbound({ contact: A_E164, text: "hi" });
  await h.engine.handleIntroduction(intro("e1", [A])); // M1
  h.engine.handleStatusEvent({ event: "message_failed", messageId: "M1", errorCode: 1010 });
  assert.ok(logs.lines.some((l) => l.msg === "alert_not_delivered" && l.entry_id === "e1" && l.code === 1010));
  assert.equal(h.engine.state.contacts[A_E164].status, "active");
  assert.equal((await h.engine.handleIntroduction(intro("e1", [A])))[0].status, "sent");
});

await test("a delivery event that arrives before its send's answer is redelivered, not lost", async () => {
  const g = gate();
  const h = harness({
    reply: async (m, n) => {
      await g.promise;
      return { ok: true, messageId: `M${n}` };
    },
  });
  h.engine.handleInbound({ contact: A_E164, text: "hi" });
  const routing = h.engine.handleIntroduction(intro("e1", [A]));
  await until(() => h.sent.length === 1);
  // LoopMessage reports M1 failed before its HTTP answer told us the id.
  const early = h.engine.handleStatusEvent({ event: "message_failed", messageId: "M1", errorCode: 500 });
  assert.equal(early.retryLater, true, "answered 503 so LoopMessage tries again");
  g.open();
  await routing;
  h.engine.handleStatusEvent({ event: "message_failed", messageId: "M1", errorCode: 500 });
  assert.equal(h.engine.state.contacts[A_E164].status, "opted_out");
  assert.equal(h.engine.handleStatusEvent({ event: "message_delivered", messageId: "zzz" }).retryLater, false, "nothing in flight: just unknown");
});

await test("a late delivery failure doesn't override a reply sent while that alert was going out", async () => {
  let h;
  h = harness({
    reply: (m, n) => {
      h.advance(10_000); // LoopMessage takes 10s; they text us meanwhile
      h.engine.handleInbound({ contact: A_E164, text: "on it" });
      return { ok: true, messageId: `M${n}` };
    },
  });
  h.engine.handleInbound({ contact: A_E164, text: "hi" });
  await h.engine.handleIntroduction(intro("e1", [A]));
  h.engine.handleStatusEvent({ event: "message_failed", messageId: "M1", errorCode: 180 });
  assert.equal(h.engine.state.contacts[A_E164].status, "active");
});

await test("a reply while the welcome is still being sent is read as an answer to it", async () => {
  for (const [reply, status] of [["hi", "welcome_queued"], ["yes", "active"]]) {
    const g = gate();
    const h = harness({
      reply: async (m, n) => {
        await g.promise;
        return { ok: true, messageId: `M${n}` };
      },
    });
    await h.engine.handleIntroduction(intro("e1", [A]));
    const ticking = h.engine.tick();
    await until(() => h.sent.length === 1);
    h.engine.handleInbound({ contact: A_E164, text: reply });
    assert.equal(h.engine.state.contacts[A_E164].status, status, reply);
    g.open();
    await ticking;
  }
});

await test("an introduction left over from more than a day ago isn't replayed", async () => {
  const logs = captureLogs();
  const old = harness();
  old.engine.handleInbound({ contact: A_E164, text: "hi" });
  old.engine.enqueueIntroduction(intro("e1", [A]));
  const disk = onDiskNow(old); // the service goes down here, for over a day
  const h = harness({ store: new MemoryStore(disk), start: old.now() + 25 * HOUR, logger: logs.logger });
  await h.engine.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.engine.state.intake.length, 0);
  assert.ok(logs.lines.some((l) => l.msg === "introduction_expired" && l.entry_id === "e1"));
});

await test("state written by the previous version again after a rollback is migrated again", async () => {
  // This version ran (rolling times), was rolled back (the old version
  // sent two welcomes and wrote its per-day counter), then came back.
  const state = {
    version: 1,
    contacts: {
      [B_E164]: { contact: B_E164, status: "welcomed", name: "Blake", welcomedAt: T0 - 20 * MIN, held: [] },
      [C_E164]: { contact: C_E164, status: "welcomed", name: "Casey", welcomedAt: T0 - 5 * MIN, held: [] },
    },
    welcomeQueue: [], outbox: [], dedupe: { [`e9:${A_E164}`]: T0 + 4 * HOUR, [`e8:${A_E164}`]: T0 + 20 * HOUR },
    pacing: { initTimes: [T0 - 2 * HOUR], lastInitAt: T0 - 5 * MIN, firstInitAt: T0 - 30 * DAY, initDay: utcDay(T0), initCountToday: 2 },
  };
  const h = harness({ config: { initDailyCap: 3 }, store: new MemoryStore(state) });
  assert.equal(h.engine.stats().welcomes_last_24h, 3, "this version's welcome and the old version's two");
  assert.ok(h.engine.state.dedupe[`e9:${A_E164}`] > T0 + 20 * HOUR, "the old version's 6-hour key now lasts 24 hours");
  assert.equal(h.engine.state.dedupe[`e8:${A_E164}`], T0 + 20 * HOUR, "this version's own key is left alone");
  await h.engine.handleIntroduction(intro("e1", [A]));
  h.advance(30 * MIN);
  await h.engine.tick();
  assert.equal(welcomesIn(h.sent).length, 0, "the cap of 3 is full");
});

await test("a late delivery failure for an older alert doesn't override a newer reply", async () => {
  for (const code of [180, 510, 500]) {
    const h = harness();
    h.engine.handleInbound({ contact: A_E164, text: "hi" });
    await h.engine.handleIntroduction(intro("e1", [A])); // M1
    h.advance(MIN);
    h.engine.handleInbound({ contact: A_E164, text: "calling her now" });
    h.engine.handleStatusEvent({ event: "message_failed", messageId: "M1", errorCode: code });
    assert.equal(h.engine.state.contacts[A_E164].status, "active", `code ${code}`);
    assert.equal(h.engine.state.welcomeQueue.length, 0, `code ${code}`);
  }
});

await test("an alert that bounces as opted out (500) opts them out", async () => {
  const h = harness();
  h.engine.handleInbound({ contact: A_E164, text: "hi" });
  await h.engine.handleIntroduction(intro("e1", [A]));
  h.engine.handleStatusEvent({ event: "message_failed", messageId: "M1", errorCode: 500 });
  assert.equal(h.engine.state.contacts[A_E164].status, "opted_out");
});

await test("nothing LoopMessage reports about a send undoes a STOP that came in during it", async () => {
  for (const r of [fail(180), fail(510), fail(540), unreachable]) {
    const g = gate();
    const h = harness({
      reply: async () => {
        await g.promise;
        return r;
      },
    });
    h.engine.handleInbound({ contact: A_E164, text: "hi" });
    const routing = h.engine.handleIntroduction(intro("e1", [A]));
    await until(() => h.sent.length === 1);
    h.engine.handleInbound({ contact: A_E164, text: "STOP" });
    g.open();
    await routing;
    await h.engine.tick();
    const c = h.engine.state.contacts[A_E164];
    assert.equal(c.status, "opted_out", `code ${r.code}`);
    assert.equal(c.held.length + h.engine.state.outbox.length + h.engine.state.welcomeQueue.length, 0, `code ${r.code}`);
  }
});

await test("nothing LoopMessage reports about a welcome undoes a STOP that came in during it", async () => {
  for (const r of [fail(180), fail(520), fail(540), fail(100), unreachable]) {
    const g = gate();
    const h = harness({
      reply: async () => {
        await g.promise;
        return r;
      },
    });
    await h.engine.handleIntroduction(intro("e1", [A]));
    const ticking = h.engine.tick();
    await until(() => h.sent.length === 1);
    h.engine.handleInbound({ contact: A_E164, text: "STOP" });
    g.open();
    await ticking;
    h.advance(HOUR + MIN);
    await h.engine.tick();
    assert.equal(h.engine.state.contacts[A_E164].status, "opted_out", `code ${r.code}`);
    assert.equal(h.sent.length, 1, `code ${r.code}`);
  }
});

await test("a sender-wide refusal pauses everyone even if that person replied during the send", async () => {
  // A welcome refused 550 while its recipient texts in.
  const g = gate();
  let h = harness({
    reply: async (m, n) => {
      if (n === 1) {
        await g.promise;
        return fail(550);
      }
      return { ok: true, messageId: `M${n}` };
    },
  });
  await h.engine.handleIntroduction(intro("e1", [A, B]));
  let ticking = h.engine.tick();
  await until(() => h.sent.length === 1);
  h.engine.handleInbound({ contact: A_E164, text: "yes" });
  g.open();
  await ticking;
  h.advance(30 * MIN);
  await h.engine.tick();
  assert.equal(welcomesIn(h.sent).filter((m) => m.contact === B_E164).length, 0, "B waits out the hour");
  h.advance(31 * MIN);
  await h.engine.tick();
  assert.equal(welcomesIn(h.sent).filter((m) => m.contact === B_E164).length, 1);

  // An alert refused 550 while its recipient opts out.
  const g2 = gate();
  h = harness({
    reply: async (m, n) => {
      if (n === 1) {
        await g2.promise;
        return fail(550);
      }
      return { ok: true, messageId: `M${n}` };
    },
  });
  h.engine.handleInbound({ contact: A_E164, text: "hi" });
  h.engine.handleInbound({ contact: B_E164, text: "hi" });
  h.advance(2 * DAY); // B is quiet: B's alerts are paced
  h.engine.handleInbound({ contact: A_E164, text: "hi again" });
  const routing = h.engine.handleIntroduction(intro("e1", [A, B]));
  await until(() => h.sent.length === 1);
  h.engine.handleInbound({ contact: A_E164, text: "STOP" });
  g2.open();
  await routing;
  h.advance(30 * MIN);
  await h.engine.tick();
  assert.equal(h.sent.filter((m) => m.contact === B_E164).length, 0, "B's paced alert waits out the hour");
  h.advance(31 * MIN);
  await h.engine.tick();
  assert.equal(h.sent.filter((m) => m.contact === B_E164).length, 1);
});

await test("an alert refused with HTTP 429 pauses sending and keeps the alert", async () => {
  const h = harness({ reply: (m, n) => (n === 1 ? { ok: false, status: 429, code: null, error: "slow down" } : { ok: true, messageId: `M${n}` }) });
  h.engine.handleInbound({ contact: A_E164, text: "hi" });
  const res = await h.engine.handleIntroduction(intro("e1", [A]));
  assert.equal(res[0].status, "queued_retry");
  h.advance(30 * MIN);
  await h.engine.tick();
  assert.equal(h.sent.length, 1, "paused");
  h.advance(31 * MIN);
  await h.engine.tick();
  assert.equal(alertsIn(h.sent).length, 2);
});

await test("two welcome refusals in a row pause welcomes instead of parking everyone", async () => {
  const h = harness({
    config: { initDailyCap: 10 },
    reply: (m, n) => (n <= 2 ? fail(520) : { ok: true, messageId: `M${n}` }),
  });
  const status = (x) => h.engine.state.contacts[x].status;
  await h.engine.handleIntroduction(intro("e1", [A, B, C]));
  await h.engine.tick();
  assert.equal(status(A_E164), "needs_inbound", "one refusal: probably about A");
  h.advance(15 * MIN);
  await h.engine.tick();
  assert.equal(status(B_E164), "welcome_queued", "a second in a row: probably the sender");
  assert.equal(status(A_E164), "welcome_queued", "so A gets another chance");
  h.advance(30 * MIN);
  await h.engine.tick();
  assert.equal(h.sent.length, 2, "paused for an hour");
  h.advance(31 * MIN);
  await h.engine.tick();
  assert.equal(h.sent.length, 3);
  assert.equal(status(C_E164), "welcomed");
});

await test("someone refused twice is parked even mid-streak, so they can't block the queue", async () => {
  const h = harness({ config: { initDailyCap: 10 }, reply: () => fail(520) });
  await h.engine.handleIntroduction(intro("e1", [A, B]));
  for (let i = 0; i < 8; i++) {
    await h.engine.tick();
    h.advance(61 * MIN);
  }
  const s = h.engine.state;
  assert.equal(s.contacts[A_E164].status, "needs_inbound");
  assert.equal(s.contacts[B_E164].status, "needs_inbound");
  assert.equal(s.welcomeQueue.length, 0);
  assert.ok(h.sent.length <= 4, "each person tried twice at most");
});

await test("stats report the welcome reply rate LoopMessage watches", async () => {
  const h = harness();
  await h.engine.handleIntroduction(intro("e1", [A, B]));
  await h.engine.tick();
  h.advance(15 * MIN);
  await h.engine.tick();
  await h.engine.handleInbound({ contact: A_E164, text: "yes" });
  await h.engine.idle();
  const s = h.engine.stats();
  assert.equal(s.welcome_reply_rate, 0.5);
  assert.equal(s.contacts.active, 1);
  assert.equal(s.contacts.welcomed, 1);
});

await test("an unsafe brand is refused at startup", () => {
  assert.throws(
    () => new Engine({ store: new MemoryStore(), send: async () => ({ ok: true }), config: { brand: "Call 212-555-0100" }, logger: quiet }),
    /forbids/,
  );
});

// ---------------------------------------------------------------------------
console.log("\nfile store");

await test("state round-trips through the file, written atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "lm-store-"));
  const store = new FileStore(join(dir, "nested", "state.json"), { logger: quiet });
  assert.equal(store.load(), null, "missing file means fresh state");
  store.save({ contacts: { "+1": { status: "active" } } });
  assert.deepEqual(store.load(), { contacts: { "+1": { status: "active" } } });
  assert.ok(!readdirSync(join(dir, "nested")).some((f) => f.endsWith(".tmp")), "no temp file left behind");
});

await test("an unreadable state file is set aside and the service starts fresh", () => {
  const dir = mkdtempSync(join(tmpdir(), "lm-store-"));
  const path = join(dir, "state.json");
  writeFileSync(path, "{not json");
  const store = new FileStore(path, { logger: quiet });
  assert.equal(store.load(), null);
  const aside = readdirSync(dir).find((f) => f.startsWith("state.json.corrupt-"));
  assert.ok(aside, "corrupt file kept for inspection");
  assert.equal(readFileSync(join(dir, aside), "utf8"), "{not json");
});

finished = true;
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const { name, err } of failures) console.error(`${name}:\n${err.stack}\n`);
  process.exit(1);
}
