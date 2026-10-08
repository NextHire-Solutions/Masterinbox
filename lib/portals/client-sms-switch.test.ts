/*
 * The staff "SMS" switch on the Client Portals page: PATCH /api/clients/[id]
 * with { sms_alerts } turns the team_sms_notifications flag on or off for one
 * client and leaves every other flag alone.
 *
 * The route runs for real against the in-memory PostgREST (see
 * test/fake-postgrest.ts). Only the staff-session check is mocked, because it
 * reads auth cookies that don't exist in a test.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { NextResponse } from "next/server";

import { configureFakeEnvironment, FakePostgrest } from "../test/fake-postgrest";

configureFakeEnvironment("");
process.env.CLIENT_PORTALS_ENABLED = "true"; // read at import by lib/portals/flag.ts

const db = new FakePostgrest();
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

let signedIn = true;
const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

let PATCH: typeof import("../../app/api/clients/[id]/route").PATCH | null = null;
if (canMock) {
  mock.module("../../app/api/clients/route", {
    namedExports: {
      requireAuthedUser: async () =>
        signedIn
          ? { user: { id: "staff-1" } }
          : { error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) },
      retagUnknownThreads: async () => {},
    },
  });
  ({ PATCH } = await import("../../app/api/clients/[id]/route"));
}
const { withFeatureFlag } = await import("./feature-flags");

const DEMO = "00ef116c-646d-43b4-a323-680548ea7126";
const OTHER = "11111111-1111-4111-8111-111111111111";
const UNKNOWN = "22222222-2222-4222-8222-222222222222";

function seed() {
  db.reset();
  signedIn = true;
  db.seed("clients", [
    { id: DEMO, name: "Demo Portal", slug: "demo-portal", aliases: [], feature_flags: { manage_stages: true, team_sms_notifications: true } },
    { id: OTHER, name: "Other Client", slug: "other-client", aliases: [], feature_flags: { manage_stages: true, portal_tour: true } },
    { id: UNKNOWN, name: "Unknown", slug: "unknown", aliases: [], feature_flags: {} },
  ]);
}

async function patch(id: string, body: unknown) {
  const res = await PATCH!(
    new Request(`http://inbox.test/api/clients/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return res.status;
}
const flagsOf = (id: string) => db.rows("clients").find((r) => r.id === id)?.feature_flags;

test("turning SMS on sets the flag and keeps every other flag", { skip }, async () => {
  seed();
  assert.equal(await patch(OTHER, { sms_alerts: true }), 200);
  assert.deepEqual(flagsOf(OTHER), { manage_stages: true, portal_tour: true, team_sms_notifications: true });
});

test("turning SMS off removes only that flag", { skip }, async () => {
  seed();
  assert.equal(await patch(DEMO, { sms_alerts: false }), 200);
  assert.deepEqual(flagsOf(DEMO), { manage_stages: true });
});

test("other clients are untouched", { skip }, async () => {
  seed();
  await patch(OTHER, { sms_alerts: true });
  assert.deepEqual(flagsOf(DEMO), { manage_stages: true, team_sms_notifications: true });
  assert.deepEqual(flagsOf(UNKNOWN), {});
});

test("the 'Unknown' fallback client can't have SMS", { skip }, async () => {
  seed();
  assert.equal(await patch(UNKNOWN, { sms_alerts: true }), 400);
  assert.deepEqual(flagsOf(UNKNOWN), {});
});

test("staff must be signed in", { skip }, async () => {
  seed();
  signedIn = false;
  assert.equal(await patch(OTHER, { sms_alerts: true }), 401);
  assert.deepEqual(flagsOf(OTHER), { manage_stages: true, portal_tour: true });
});

test("the switch must be a boolean", { skip }, async () => {
  seed();
  assert.equal(await patch(OTHER, { sms_alerts: "yes" }), 400);
});

test("withFeatureFlag copies, sets or removes one key, and tolerates a malformed map", () => {
  const flags = { a: true, b: true };
  assert.deepEqual(withFeatureFlag(flags, "c", true), { a: true, b: true, c: true });
  assert.deepEqual(withFeatureFlag(flags, "a", false), { b: true });
  assert.deepEqual(flags, { a: true, b: true }, "never mutates the input");
  assert.deepEqual(withFeatureFlag(null, "c", true), { c: true });
  assert.deepEqual(withFeatureFlag(["x"], "c", true), { c: true });
  assert.deepEqual(withFeatureFlag(undefined, "c", false), {});
});
