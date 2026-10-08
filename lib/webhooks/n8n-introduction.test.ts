/*
 * What the Introduction webhooks actually POST, with and without the Team
 * page's per-member SMS switches (team_sms_notifications flag).
 *
 * The real notifyIntroduction runs against the in-memory PostgREST (see
 * test/fake-postgrest.ts for why nothing here may touch the real database),
 * and the two webhook hosts are captured instead of called:
 *   sms.test   = N8N_INTRODUCTION_WEBHOOK_URL (the LoopMessage SMS notifier)
 *   bison.test = BISON_INTRODUCTION_WEBHOOK_URL (the orchestrator)
 *
 * The headline guards: a client WITHOUT the flag gets exactly today's
 * payload, and Bison's payload never changes, flag or not.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest, type Row } from "../test/fake-postgrest";

configureFakeEnvironment("");
process.env.N8N_INTRODUCTION_WEBHOOK_URL = "http://sms.test/webhooks/introduction";
process.env.BISON_INTRODUCTION_WEBHOOK_URL = "http://bison.test/api/webhooks/masterinbox";

type Post = { host: string; body: Record<string, unknown> & { team: { name: string; mobile: string }[] } };

const db = new FakePostgrest();
const posts: Post[] = [];
// Simulates PostgREST rejecting a query (e.g. a column that isn't migrated).
let rejectQuery: ((url: URL) => boolean) | null = null;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.host === "sms.test" || url.host === "bison.test") {
    posts.push({ host: url.host, body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }
  if (rejectQuery?.(url)) {
    return new Response(
      JSON.stringify({ code: "42703", message: "column does not exist", details: null, hint: null }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  return db.fetch(input, init);
}) as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const { notifyIntroduction } = await import("./n8n-introduction");

const DEMO = "00ef116c-646d-43b4-a323-680548ea7126";
const OTHER = "11111111-1111-4111-8111-111111111111";

function entry(id: string, clientId: string, clientName: string): Row {
  // FakePostgrest ignores select/embeds, so embedded rows ride inline.
  return {
    id,
    client_id: clientId,
    stage: "introduction",
    lead_name: "Laura Wilson",
    lead_email: "laura@example.com",
    lead_phone: "6652341234",
    current_brokerage: "Legacy Realty Group",
    thread_id: `thread-${id}`,
    introduced_at: "2026-10-08T00:00:00Z",
    leads: { company: "Legacy Realty Group", title: null, custom_fields: {} },
    clients: { id: clientId, name: clientName, slug: null, portal_token: null },
    assigned_team_member: null,
    threads: { campaign_name: null },
  };
}

function seed({ demoFlagged = true, demoSwitches = { Eddy: true, Ryan: false, Amy: true } } = {}) {
  db.reset();
  posts.length = 0;
  rejectQuery = null;
  db.seed("clients", [
    {
      id: DEMO,
      name: "Demo Portal",
      feature_flags: demoFlagged ? { manage_stages: true, team_sms_notifications: true } : { manage_stages: true },
    },
    { id: OTHER, name: "Other Client", feature_flags: { manage_stages: true } },
  ]);
  db.seed("client_team_members", [
    { client_id: DEMO, name: "Eddy", phone: "7184150537", active: true, receives_sms: demoSwitches.Eddy },
    { client_id: DEMO, name: "Ryan", phone: "+16475720433", active: true, receives_sms: demoSwitches.Ryan },
    { client_id: DEMO, name: "Amy", phone: "8173711939", active: true, receives_sms: demoSwitches.Amy },
    { client_id: DEMO, name: "Inactive Ivy", phone: "2125550100", active: false, receives_sms: true },
    { client_id: DEMO, name: "No-Phone Nia", phone: null, active: true, receives_sms: true },
    // Other has no flag, so its switches mean nothing: Oscar stays in.
    { client_id: OTHER, name: "Olivia", phone: "3105550111", active: true, receives_sms: true },
    { client_id: OTHER, name: "Oscar", phone: "3105550112", active: true, receives_sms: false },
  ]);
  db.seed("client_pipeline_entries", [entry("e-demo", DEMO, "Demo Portal"), entry("e-other", OTHER, "Other Client")]);
}

const names = (p: Post | undefined) => p?.body.team.map((m) => m.name);
const post = (host: string, entryId: string) =>
  posts.find((p) => p.host === host && p.body.pipeline_entry_id === entryId);

test("a client without the flag gets today's payload: switches ignored, same keys", async () => {
  seed({ demoFlagged: false });
  await notifyIntroduction(["e-demo"], "portal_stage_change");
  const sms = post("sms.test", "e-demo");
  assert.deepEqual(names(sms), ["Eddy", "Ryan", "Amy"], "active + phone, Ryan's switch ignored");
  assert.deepEqual(Object.keys(sms!.body), [
    "event", "occurred_at", "source", "pipeline_entry_id", "lead", "client", "team",
  ]);
  assert.deepEqual(sms!.body.team[1], { name: "Ryan", mobile: "+16475720433" });
});

test("with the flag, the SMS notifier gets only members switched on", async () => {
  seed();
  await notifyIntroduction(["e-demo"], "portal_stage_change");
  assert.deepEqual(names(post("sms.test", "e-demo")), ["Eddy", "Amy"]);
});

test("the flag never changes Bison: full team, same body", async () => {
  seed();
  await notifyIntroduction(["e-demo"], "inbox_label"); // inbox + lead email → Bison fires
  const sms = post("sms.test", "e-demo")!;
  const bison = post("bison.test", "e-demo")!;
  assert.deepEqual(names(bison), ["Eddy", "Ryan", "Amy"]);
  // Apart from team, the SMS body is the exact n8n payload Bison extends
  // (Bison adds fields to lead and client, so those two are skipped).
  for (const [k, v] of Object.entries(sms.body)) {
    if (k === "team" || k === "lead" || k === "client") continue;
    assert.deepEqual(bison.body[k], v, `bison.${k}`);
  }
});

test("other clients in the same batch are untouched", async () => {
  seed();
  await notifyIntroduction(["e-demo", "e-other"], "inbox_label");
  assert.deepEqual(names(post("sms.test", "e-other")), ["Olivia", "Oscar"]);
  assert.deepEqual(names(post("bison.test", "e-other")), ["Olivia", "Oscar"]);
  assert.deepEqual(names(post("sms.test", "e-demo")), ["Eddy", "Amy"]);
});

test("everyone switched off: no SMS POST at all, Bison still fires", async () => {
  seed({ demoSwitches: { Eddy: false, Ryan: false, Amy: false } });
  await notifyIntroduction(["e-demo"], "inbox_label");
  assert.equal(post("sms.test", "e-demo"), undefined);
  assert.deepEqual(names(post("bison.test", "e-demo")), ["Eddy", "Ryan", "Amy"]);
});

test("switches unreadable (column not migrated): no SMS for the flagged client only", async () => {
  seed();
  rejectQuery = (u) => u.pathname.endsWith("/client_team_members") && u.search.includes("receives_sms");
  await notifyIntroduction(["e-demo", "e-other"], "inbox_label");
  assert.equal(post("sms.test", "e-demo"), undefined, "can't see who opted out → text nobody");
  assert.deepEqual(names(post("sms.test", "e-other")), ["Olivia", "Oscar"]);
  assert.deepEqual(names(post("bison.test", "e-demo")), ["Eddy", "Ryan", "Amy"]);
});

test("feature flags unreadable: everyone keeps today's behaviour", async () => {
  seed();
  rejectQuery = (u) => u.pathname.endsWith("/clients") && (u.searchParams.get("select") ?? "").includes("feature_flags");
  await notifyIntroduction(["e-demo", "e-other"], "portal_stage_change");
  assert.deepEqual(names(post("sms.test", "e-demo")), ["Eddy", "Ryan", "Amy"]);
  assert.deepEqual(names(post("sms.test", "e-other")), ["Olivia", "Oscar"]);
});

test("no switch reads happen when the SMS webhook isn't configured", async () => {
  seed();
  const saved = process.env.N8N_INTRODUCTION_WEBHOOK_URL;
  delete process.env.N8N_INTRODUCTION_WEBHOOK_URL;
  try {
    await notifyIntroduction(["e-demo"], "inbox_label");
  } finally {
    process.env.N8N_INTRODUCTION_WEBHOOK_URL = saved;
  }
  assert.equal(post("sms.test", "e-demo"), undefined);
  assert.equal(db.calls.filter((c) => c.table === "clients").length, 0);
});
