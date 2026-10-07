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
import { classifyReply, parseLoopEvent } from "../src/inbound.js";
import { FileStore, MemoryStore } from "../src/store.js";

let passed = 0;
let failed = 0;
const failures = [];

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
    if (next.throw) throw Object.assign(new Error(next.throw), { name: next.throwName });
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

// The exact payload the Masterinbox webhook sends (from the pinned n8n data).
const PINNED = {
  event: "lead.introduction",
  occurred_at: "2026-06-11T14:26:44.658Z",
  source: "inbox_label",
  pipeline_entry_id: "537ea483-e501-4595-abbd-7d2c0c8b30fd",
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

function harness({ config = {}, store = new MemoryStore(), reply } = {}) {
  let t = T0;
  const sent = [];
  const send = async (m) => {
    sent.push({ ...m, at: t });
    if (reply) return reply(m, sent.length);
    return { ok: true, messageId: `M${sent.length}` };
  };
  const make = () => new Engine({ store, send, now: () => t, config, logger: quiet });
  return {
    engine: make(),
    restart: make,
    sent,
    store,
    advance(ms) {
      t += ms;
    },
  };
}

function intro(entryId, team, { client = { id: "c-demo", name: "Demo Portal" } } = {}) {
  return planNotifications({
    event: "lead.introduction",
    source: "portal_add_lead",
    pipeline_entry_id: entryId,
    lead: PINNED.lead,
    client,
    team,
  });
}

const alertsIn = (sent) => sent.filter((m) => /you have a new agent/.test(m.text));
const welcomesIn = (sent) => sent.filter((m) => /Reply YES/.test(m.text));
const fail = (code, status = 400) => ({ ok: false, code, status, error: `code_${code}` });

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
  // Eddy's wording, Oct 2026: agent, phone, brokerage; no email.
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
      "Brokerage: Legacy Realty Group\n\n" +
      "To opt out, reply STOP.",
  );
});

await test("the alert greets by first name and never includes the email", () => {
  const text = buildText("Lara Chopoorian", PINNED.lead);
  assert.equal(
    text,
    "Hi Lara, you have a new agent in the Introduction stage.\n\n" +
      "Agent: Radhamilca Tucker\n" +
      "Brokerage: Christies International Real Estate New York Llc\n\n" +
      "To opt out, reply STOP.",
  );
  assert.ok(!text.includes("@"));
});

await test("empty lead fields are omitted, not rendered as 'null'", () => {
  assert.equal(
    buildText("Sam", { name: "Jo", phone: null, company: null }),
    "Hi Sam, you have a new agent in the Introduction stage.\n\nAgent: Jo\n\nTo opt out, reply STOP.",
  );
  assert.equal(
    buildText(null, {}),
    "Hi there, you have a new agent in the Introduction stage.\n\nTo opt out, reply STOP.",
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

await test("an invalid override number is refused, not sent", () => {
  assert.equal(planNotifications(DEMO, { testRecipientOverride: "not-a-number" }).ok, false);
});

await test("dry_run is passed through to the engine", async () => {
  const engine = engineStub();
  const res = await processIntroduction(DEMO, { engine, logger: quiet, dryRun: true });
  assert.equal(engine.calls[0].opts.dryRun, true);
  assert.equal(res.dryRun, true);
});

// ---------------------------------------------------------------------------
console.log("\nloopmessage client");

await test("transient 502 is retried then succeeds", async () => {
  const f = stubFetch([
    { status: 502, body: {} },
    { status: 200, body: { success: true, message_id: "MID-1" } },
  ]);
  const res = await sendMessage({ apiKey: "k", contact: "+1555", text: "hi", backoffMs: 1, fetchImpl: f });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 2);
  assert.equal(res.messageId, "MID-1");
});

await test("400 is not retried, and carries LoopMessage's error code", async () => {
  const f = stubFetch([{ status: 400, body: { success: false, code: 500, message: "opted out" } }]);
  const res = await sendMessage({ apiKey: "k", contact: "+1555", text: "hi", backoffMs: 1, fetchImpl: f });
  assert.equal(res.ok, false);
  assert.equal(res.attempts, 1);
  assert.equal(res.code, 500);
  assert.equal(f.calls.length, 1);
});

await test("HTTP 200 with success:false is treated as a failure", async () => {
  const f = stubFetch([{ status: 200, body: { success: false } }]);
  const res = await sendMessage({ apiKey: "k", contact: "+1555", text: "hi", retries: 0, backoffMs: 1, fetchImpl: f });
  assert.equal(res.ok, false);
});

await test("timeout is retried and reported by name", async () => {
  const f = stubFetch([
    { throw: "The operation was aborted", throwName: "TimeoutError" },
    { status: 200, body: { success: true, message_id: "MID-2" } },
  ]);
  const res = await sendMessage({ apiKey: "k", contact: "+1555", text: "hi", backoffMs: 1, fetchImpl: f });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 2);
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

await test("STOP and its variants opt out", () => {
  for (const t of ["STOP", "stop.", "Stop please", "opt out", "Opt-out", "UNSUBSCRIBE", "end", "Cancel", "please stop"]) {
    assert.equal(classifyReply(t), "stop", t);
  }
});

await test("ordinary sentences that mention end/stop don't opt anyone out", () => {
  for (const t of ["End of day works for me", "Don't stop the alerts, they're great", "Hi", "thanks!", ""]) {
    assert.notEqual(classifyReply(t), "stop", t);
  }
});

await test("YES / START are recognised as opting (back) in", () => {
  for (const t of ["yes", "Yes!", "START", "y", "yes please", "unstop"]) {
    assert.equal(classifyReply(t), "start", t);
  }
  assert.equal(classifyReply("ok"), "other");
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

await test("any reply other than STOP counts as consent", async () => {
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

await test("alerts to people quiet for a day are at least 2 minutes apart", async () => {
  const h = harness();
  await h.engine.handleInbound({ contact: A_E164, text: "hi" });
  await h.engine.handleInbound({ contact: B_E164, text: "hi" });
  h.advance(2 * DAY);
  const res = await h.engine.handleIntroduction(intro("e1", [A, B]));
  assert.deepEqual(res.map((r) => r.status), ["queued_paced", "queued_paced"]);
  await h.engine.tick();
  assert.equal(h.sent.length, 1);
  h.advance(1 * MIN);
  await h.engine.tick();
  assert.equal(h.sent.length, 1, "not before 2 minutes");
  h.advance(1 * MIN);
  await h.engine.tick();
  assert.equal(h.sent.length, 2);
});

await test("people who messaged recently get alerts at once, no spacing", async () => {
  const h = harness();
  await h.engine.handleInbound({ contact: A_E164, text: "hi" });
  await h.engine.handleInbound({ contact: B_E164, text: "hi" });
  const res = await h.engine.handleIntroduction(intro("e1", [A, B]));
  assert.deepEqual(res.map((r) => r.status), ["sent", "sent"]);
  assert.equal(h.sent.length, 2);
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
  h.advance(7 * HOUR); // past the 6h dedupe window, still within the 24h hold
  await h.engine.handleIntroduction(intro("e1", [A]));
  assert.equal(h.engine.state.contacts[A_E164].held.length, 1, "one held copy per lead");
  await h.engine.handleInbound({ contact: A_E164, text: "yes" });
  await h.engine.idle();
  assert.equal(alertsIn(h.sent).length, 1);
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
      "Agent: Laura Wilson\nBrokerage: Legacy Realty Group\n\nTo opt out, reply STOP.",
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
    h.engine.handleInbound({ contact: A_E164, text: "yes" }),
    h.engine.handleInbound({ contact: A_E164, text: "yes" }), // LoopMessage retrying
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
  const h = harness({ reply: slowOk });
  await h.engine.handleIntroduction(intro("e1", [A, B]));
  await Promise.all([h.engine.tick(), h.engine.handleInbound({ contact: A_E164, text: "hi" })]);
  await h.engine.idle();
  h.advance(15 * MIN);
  await h.engine.tick();
  assert.equal(welcomesIn(h.sent).filter((m) => m.contact === B_E164).length, 1);
  assert.equal(h.engine.state.contacts[A_E164].status, "active", "the reply isn't undone by the welcome finishing");
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
  const h = harness({ reply: () => fail(180) });
  await h.engine.handleIntroduction(intro("e1", [A]));
  await h.engine.tick();
  const c = h.engine.state.contacts[A_E164];
  assert.equal(c.status, "unreachable");
  assert.equal(c.held.length, 0);
  const res = await h.engine.handleIntroduction(intro("e2", [A]));
  assert.equal(res[0].status, "skipped_unreachable");
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

await test("welcome rate-limited (540) pauses an hour and keeps them queued", async () => {
  const h = harness({ reply: (m, n) => (n === 1 ? fail(540) : { ok: true, messageId: `M${n}` }) });
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
  const h = harness({ reply: (m, n) => (n <= 4 ? fail(null, 502) : { ok: true, messageId: `M${n}` }) });
  await h.engine.handleIntroduction(intro("e1", [A]));
  for (let i = 0; i < 4; i++) {
    await h.engine.tick();
    h.advance(5 * MIN);
  }
  await h.engine.tick();
  assert.equal(h.engine.state.contacts[A_E164].status, "welcomed");
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

await test("an alert that hits an outage is retried from the outbox", async () => {
  const h = harness({ reply: (m, n) => (n === 1 ? fail(null, 503) : { ok: true, messageId: `M${n}` }) });
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
  assert.equal(ignored.ignored, "not_a_welcome");
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

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const { name, err } of failures) console.error(`${name}:\n${err.stack}\n`);
  process.exit(1);
}
