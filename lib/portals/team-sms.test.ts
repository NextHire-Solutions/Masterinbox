/*
 * The Team page's per-member SMS switch: the server-side gate on saving it,
 * the read that feeds the page, and the payload decision.
 *
 * The PATCH route runs for real (token lookup included) against the
 * in-memory PostgREST; see test/fake-postgrest.ts.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../test/fake-postgrest";

configureFakeEnvironment("");
process.env.CLIENT_PORTALS_ENABLED = "true"; // read at import by lib/portals/flag.ts

const db = new FakePostgrest();
let rejectQuery: ((url: URL) => boolean) | null = null;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  // Billing hold uses a filter the fake doesn't model; "not held".
  if (url.pathname.endsWith("/os_portal_blocks")) {
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
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

const { TEAM_SMS_FLAG, loadTeamSmsSettings, smsBodyFor } = await import("./team-sms");
const { PATCH } = await import("../../app/api/portal/[token]/team/[id]/route");

const DEMO = "00ef116c-646d-43b4-a323-680548ea7126";
const OTHER = "11111111-1111-4111-8111-111111111111";

function seed() {
  db.reset();
  rejectQuery = null;
  const portal = { portal_enabled: true, stage_label_overrides: {}, fub_api_key: null, fub_connected_at: null, ideal_agent_profile: {} };
  db.seed("clients", [
    { ...portal, id: DEMO, name: "Demo Portal", slug: "demo-portal", portal_token: "demo-token-1234", feature_flags: { [TEAM_SMS_FLAG]: true } },
    { ...portal, id: OTHER, name: "Other Client", slug: "other-client", portal_token: "other-token-1234", feature_flags: { manage_stages: true } },
  ]);
  const [eddy, ryan, olivia] = db.seed("client_team_members", [
    { client_id: DEMO, name: "Eddy", phone: "7184150537", active: true, receives_sms: true },
    { client_id: DEMO, name: "Ryan", phone: "+16475720433", active: true, receives_sms: false },
    { client_id: OTHER, name: "Olivia", phone: "3105550111", active: true, receives_sms: true },
  ]);
  return { eddy, ryan, olivia };
}

async function patch(token: string, id: string, body: unknown) {
  const res = await PATCH(
    new Request(`http://portal.test/api/portal/${token}/team/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ token, id }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test("saving the SMS switch works for a flagged client", async () => {
  const { eddy } = seed();
  const res = await patch("demo-token-1234", eddy.id, { receives_sms: false });
  assert.equal(res.status, 200);
  assert.equal(db.rows("client_team_members").find((r) => r.id === eddy.id)?.receives_sms, false);
});

test("a client without the flag can't save it: 404 and nothing written", async () => {
  const { olivia } = seed();
  const res = await patch("other-token-1234", olivia.id, { receives_sms: false });
  assert.equal(res.status, 404);
  assert.equal(db.writes("client_team_members", "PATCH").length, 0);
  assert.equal(db.rows("client_team_members").find((r) => r.id === olivia.id)?.receives_sms, true);
});

test("a crafted request can't sneak it in alongside an allowed field", async () => {
  const { olivia } = seed();
  const res = await patch("other-token-1234", olivia.id, { active: false, receives_sms: false });
  assert.equal(res.status, 404);
  assert.equal(db.writes("client_team_members", "PATCH").length, 0);
});

test("other edits are unchanged for clients without the flag", async () => {
  const { olivia } = seed();
  const res = await patch("other-token-1234", olivia.id, { active: false });
  assert.equal(res.status, 200);
  assert.equal(db.rows("client_team_members").find((r) => r.id === olivia.id)?.active, false);
});

test("a member of another client can't be switched through this portal", async () => {
  const { olivia } = seed();
  const res = await patch("demo-token-1234", olivia.id, { receives_sms: false });
  assert.equal(res.status, 404);
  assert.equal(db.rows("client_team_members").find((r) => r.id === olivia.id)?.receives_sms, true);
});

test("the switch must be a boolean", async () => {
  const { eddy } = seed();
  const res = await patch("demo-token-1234", eddy.id, { receives_sms: "no" });
  assert.equal(res.status, 400);
});

test("the Team page reads each member's switch for its own client", async () => {
  const { eddy, ryan } = seed();
  assert.deepEqual(await loadTeamSmsSettings(DEMO), { [eddy.id]: true, [ryan.id]: false });
});

test("if the switches can't be read, the page gets null (SMS column hidden)", async () => {
  seed();
  rejectQuery = (u) => u.pathname.endsWith("/client_team_members");
  assert.equal(await loadTeamSmsSettings(DEMO), null);
});

test("smsBodyFor: unflagged keeps the payload, flagged filters, empty or unreadable sends nothing", () => {
  const payload = { event: "lead.introduction", team: [{ name: "A", mobile: "1" }, { name: "B", mobile: "2" }] };
  assert.equal(smsBodyFor(payload, "x", null), payload);
  assert.equal(smsBodyFor(payload, "x", new Map()), payload);
  const only = smsBodyFor(payload, "x", new Map([["x", { ok: true as const, team: [{ name: "A", mobile: "1" }] }]]));
  assert.deepEqual(only, { event: "lead.introduction", team: [{ name: "A", mobile: "1" }] });
  assert.notEqual(only, payload, "a copy, never the shared object");
  assert.equal(smsBodyFor(payload, "x", new Map([["x", { ok: true as const, team: [] }]])), null);
  assert.equal(smsBodyFor(payload, "x", new Map([["x", { ok: false as const }]])), null);
});
