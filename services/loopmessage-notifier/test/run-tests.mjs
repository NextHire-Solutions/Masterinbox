// Dependency-free test runner. `npm test`.
//
// Covers the parts that fail silently in production: phone normalization
// (a dropped agent is invisible), dedupe claim/release (a held claim after a
// failure would swallow a legitimate retry), and the retry classifier
// (retrying a 400 wastes time; not retrying a 502 loses a message).

import assert from "node:assert/strict";
import { normalizePhone } from "../src/phone.js";
import {
  DedupeStore,
  buildText,
  parseClientList,
  planNotifications,
  processIntroduction,
} from "../src/notify.js";
import { sendMessage } from "../src/loopmessage.js";

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

console.log("\npayload planning");

await test("pinned payload plans both team members", () => {
  const plan = planNotifications(PINNED);
  assert.equal(plan.ok, true);
  assert.equal(plan.recipients.length, 2);
  assert.deepEqual(
    plan.recipients.map((r) => r.contact),
    ["+19733966766", "+16314255731"],
  );
  assert.equal(plan.clientName, "Douglas Elliman");
  assert.equal(plan.skipped.length, 0);
});

await test("message text matches the copy the Twilio node sent", () => {
  const text = buildText("Lara Chopoorian", PINNED.lead);
  assert.equal(
    text,
    "Hi Lara Chopoorian, we received a new lead in the Introduction stage.\n\n" +
      "Lead name: Radhamilca Tucker\n" +
      "Email: rtucker@christiesrealestategroup.com\n" +
      "Company: Christies International Real Estate New York Llc",
  );
});

await test("null lead fields are omitted, not rendered as 'null'", () => {
  const text = buildText("Sam", { name: "Jo", email: null, company: null });
  assert.equal(text, "Hi Sam, we received a new lead in the Introduction stage.\n\nLead name: Jo");
  assert.ok(!text.includes("null"));
});

await test("unparseable member is skipped with a reason, others still send", () => {
  const plan = planNotifications({
    ...PINNED,
    team: [{ name: "Good", mobile: "9733966766" }, { name: "Bad", mobile: "n/a" }],
  });
  assert.equal(plan.recipients.length, 1);
  assert.deepEqual(plan.skipped, [{ name: "Bad", mobile: "n/a", reason: "no_digits" }]);
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

console.log("\ndedupe");

await test("same entry + same number is claimed once", () => {
  const d = new DedupeStore();
  assert.equal(d.claim("entry:+1555"), true);
  assert.equal(d.claim("entry:+1555"), false);
});

await test("same number on a different lead is allowed through", () => {
  const d = new DedupeStore();
  assert.equal(d.claim("entryA:+1555"), true);
  assert.equal(d.claim("entryB:+1555"), true);
});

await test("claim expires after the TTL", () => {
  const d = new DedupeStore({ ttlMs: 1000 });
  const t0 = 1_000_000;
  assert.equal(d.claim("k", t0), true);
  assert.equal(d.claim("k", t0 + 500), false);
  assert.equal(d.claim("k", t0 + 1001), true);
});

console.log("\nloopmessage client");

await test("transient 502 is retried then succeeds", async () => {
  const f = stubFetch([
    { status: 502, body: {} },
    { status: 200, body: { success: true, message_id: "MID-1" } },
  ]);
  const res = await sendMessage({
    apiKey: "k", contact: "+1555", text: "hi", backoffMs: 1, fetchImpl: f,
  });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 2);
  assert.equal(res.messageId, "MID-1");
});

await test("400 is not retried", async () => {
  const f = stubFetch([{ status: 400, body: { success: false, message: "bad contact" } }]);
  const res = await sendMessage({
    apiKey: "k", contact: "+1555", text: "hi", backoffMs: 1, fetchImpl: f,
  });
  assert.equal(res.ok, false);
  assert.equal(res.attempts, 1);
  assert.equal(f.calls.length, 1);
});

await test("HTTP 200 with success:false is treated as a failure", async () => {
  // The API does this — an auth failure returns {"success": false}.
  const f = stubFetch([{ status: 200, body: { success: false } }]);
  const res = await sendMessage({
    apiKey: "k", contact: "+1555", text: "hi", retries: 0, backoffMs: 1, fetchImpl: f,
  });
  assert.equal(res.ok, false);
});

await test("timeout is retried and reported by name", async () => {
  const f = stubFetch([
    { throw: "The operation was aborted", throwName: "TimeoutError" },
    { status: 200, body: { success: true, message_id: "MID-2" } },
  ]);
  const res = await sendMessage({
    apiKey: "k", contact: "+1555", text: "hi", backoffMs: 1, fetchImpl: f,
  });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 2);
});

await test("auth header and body shape match the API contract", async () => {
  const f = stubFetch([{ status: 200, body: { success: true, message_id: "M" } }]);
  await sendMessage({
    apiKey: "secret", contact: "+1555", text: "hi", sender: "SND", passthrough: "P", fetchImpl: f,
  });
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

console.log("\nend to end");

await test("pinned payload sends one message per member with correct passthrough", async () => {
  const f = stubFetch([{ status: 200, body: { success: true, message_id: "M" } }]);
  const quiet = { log() {}, warn() {}, error() {} };
  const res = await processIntroduction(PINNED, {
    apiKey: "k", sender: "SND", dedupe: new DedupeStore(), logger: quiet, fetchImpl: f,
  });
  assert.equal(res.ok, true);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(res.results.map((r) => r.status), ["queued", "queued"]);
  const pt = JSON.parse(f.calls[0].body.passthrough);
  assert.equal(pt.pipeline_entry_id, PINNED.pipeline_entry_id);
  assert.equal(pt.source, "inbox_label");
});

await test("replayed webhook does not double-text", async () => {
  const f = stubFetch([{ status: 200, body: { success: true, message_id: "M" } }]);
  const quiet = { log() {}, warn() {}, error() {} };
  const shared = new DedupeStore();
  const deps = { apiKey: "k", dedupe: shared, logger: quiet, fetchImpl: f };
  await processIntroduction(PINNED, deps);
  const second = await processIntroduction(PINNED, deps);
  assert.equal(f.calls.length, 2, "second delivery must not hit the API again");
  assert.deepEqual(
    second.results.map((r) => r.status),
    ["duplicate_suppressed", "duplicate_suppressed"],
  );
});

await test("a failed send releases its claim so a retry can get through", async () => {
  const quiet = { log() {}, warn() {}, error() {} };
  const shared = new DedupeStore();
  const failing = stubFetch([{ status: 400, body: { success: false, message: "nope" } }]);
  const first = await processIntroduction(PINNED, {
    apiKey: "k", dedupe: shared, logger: quiet, fetchImpl: failing,
  });
  assert.deepEqual(first.results.map((r) => r.status), ["failed", "failed"]);

  const ok = stubFetch([{ status: 200, body: { success: true, message_id: "M" } }]);
  const second = await processIntroduction(PINNED, {
    apiKey: "k", dedupe: shared, logger: quiet, fetchImpl: ok,
  });
  assert.deepEqual(second.results.map((r) => r.status), ["queued", "queued"]);
});

await test("dry run plans without calling the API", async () => {
  const f = stubFetch([{ status: 200, body: { success: true } }]);
  const quiet = { log() {}, warn() {}, error() {} };
  const res = await processIntroduction(PINNED, {
    apiKey: "k", dedupe: new DedupeStore(), logger: quiet, dryRun: true, fetchImpl: f,
  });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(res.results.map((r) => r.status), ["dry_run", "dry_run"]);
});

console.log("\nclient rollout (NOTIFY_CLIENTS / TEST_RECIPIENT_OVERRIDE)");

const DEMO = {
  ...PINNED,
  pipeline_entry_id: "demo-entry-1",
  client: { id: "11111111-2222-3333-4444-555555555555", name: "Demo Portal" },
  team: [
    { name: "Other Agent", mobile: "9733966766" },
    { name: "Demo Tester", mobile: "718-415-0537" },
  ],
};
const quietLogger = { log() {}, warn() {}, error() {} };

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
    const f = parseClientList(raw);
    assert.equal(f.matches({ id: "a", name: "Demo Portal" }), false, `raw=${raw}`);
  }
});

await test("a client that isn't enabled plans no recipients", () => {
  const plan = planNotifications(PINNED, { clientFilter: parseClientList("Demo Portal") });
  assert.equal(plan.ok, true);
  assert.equal(plan.ignored, "client_not_enabled");
  assert.equal(plan.recipients.length, 0);
});

await test("a client that isn't enabled makes zero LoopMessage calls", async () => {
  const f = stubFetch([{ status: 200, body: { success: true } }]);
  const res = await processIntroduction(PINNED, {
    apiKey: "k", dedupe: new DedupeStore(), logger: quietLogger, fetchImpl: f,
    clientFilter: parseClientList("Demo Portal"),
  });
  assert.equal(f.calls.length, 0);
  assert.equal(res.ignored, "client_not_enabled");
  assert.equal(res.client, "Douglas Elliman");
});

await test("override sends exactly one text to the override number, not the team", async () => {
  const f = stubFetch([{ status: 200, body: { success: true, message_id: "M" } }]);
  const res = await processIntroduction(DEMO, {
    apiKey: "k", dedupe: new DedupeStore(), logger: quietLogger, fetchImpl: f,
    clientFilter: parseClientList("Demo Portal"),
    testRecipientOverride: "+17184150537",
  });
  assert.equal(f.calls.length, 1, "one text per lead, whatever the team size");
  assert.equal(f.calls[0].body.contact, "+17184150537");
  assert.equal(res.testOverride, true);
});

await test("override greets the team member who owns that number", () => {
  const plan = planNotifications(DEMO, {
    clientFilter: parseClientList("Demo Portal"),
    testRecipientOverride: "+17184150537",
  });
  assert.equal(plan.recipients[0].name, "Demo Tester");
  assert.ok(plan.recipients[0].text.startsWith("Hi Demo Tester,"));
});

await test("override falls back to the first named member, then 'there'", () => {
  const noOwner = { ...DEMO, team: [{ name: "Other Agent", mobile: "9733966766" }] };
  assert.equal(
    planNotifications(noOwner, { testRecipientOverride: "+17184150537" }).recipients[0].name,
    "Other Agent",
  );
  const noTeam = { ...DEMO, team: [] };
  const plan = planNotifications(noTeam, { testRecipientOverride: "+17184150537" });
  assert.equal(plan.recipients.length, 1, "still sends when the team is empty");
  assert.ok(plan.recipients[0].text.startsWith("Hi there,"));
});

await test("replayed override event does not double-text the test number", async () => {
  const f = stubFetch([{ status: 200, body: { success: true, message_id: "M" } }]);
  const deps = {
    apiKey: "k", dedupe: new DedupeStore(), logger: quietLogger, fetchImpl: f,
    clientFilter: parseClientList("Demo Portal"), testRecipientOverride: "+17184150537",
  };
  await processIntroduction(DEMO, deps);
  const second = await processIntroduction(DEMO, deps);
  assert.equal(f.calls.length, 1);
  assert.equal(second.results[0].status, "duplicate_suppressed");
});

await test("a different lead for the same client still texts the test number", async () => {
  const f = stubFetch([{ status: 200, body: { success: true, message_id: "M" } }]);
  const deps = {
    apiKey: "k", dedupe: new DedupeStore(), logger: quietLogger, fetchImpl: f,
    clientFilter: parseClientList("Demo Portal"), testRecipientOverride: "+17184150537",
  };
  await processIntroduction(DEMO, deps);
  await processIntroduction({ ...DEMO, pipeline_entry_id: "demo-entry-2" }, deps);
  assert.equal(f.calls.length, 2);
});

await test("a dry run does not block the real send that follows", async () => {
  // Regression: dry run used to claim the dedupe key, suppressing the real
  // delivery of that lead for the full TTL.
  const shared = new DedupeStore();
  const f = stubFetch([{ status: 200, body: { success: true, message_id: "M" } }]);
  const deps = { apiKey: "k", dedupe: shared, logger: quietLogger, fetchImpl: f };
  await processIntroduction(PINNED, { ...deps, dryRun: true });
  const real = await processIntroduction(PINNED, deps);
  assert.deepEqual(real.results.map((r) => r.status), ["queued", "queued"]);
});

await test("an invalid override number is refused, not sent", () => {
  const plan = planNotifications(DEMO, { testRecipientOverride: "not-a-number" });
  assert.equal(plan.ok, false);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const { name, err } of failures) console.error(`${name}:\n${err.stack}\n`);
  process.exit(1);
}
