import { test, mock } from "node:test";
import assert from "node:assert/strict";

/*
 * Campaign → portal (1 Oct): a portal chosen for a campaign in the OS
 * (os_campaign_portals) wins over the name guess; with no usable choice the
 * guess runs exactly as before. Properties & Estates is the real case — its
 * Florida campaign's replies went to the Boston portal.
 */
const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

const CLIENTS = [
  { id: "unk", name: "Unknown", slug: "unknown", aliases: [] },
  { id: "bos", name: "Properties & Estates Boston", slug: "properties-and-estates-boston", aliases: ["Properties & Estates"] },
  { id: "fla", name: "Properties & Estates Florida", slug: "properties-and-estates-florida", aliases: [] },
  { id: "keyes", name: "The Keyes Company", slug: "the-keyes-company", aliases: [] },
];
let routes: { platform: string; campaign_id: string; mi_client_id: string }[] = [];
let routesFail = false;
let routeReads = 0;

function from(table: string) {
  if (table === "clients") return { select: async () => ({ data: CLIENTS, error: null }) };
  const f: Record<string, string> = {};
  const b = {
    select: () => b,
    eq: (k: string, v: string) => { f[k] = v; return b; },
    maybeSingle: async () => {
      routeReads++;
      if (routesFail) return { data: null, error: { message: 'relation "os_campaign_portals" does not exist' } };
      return { data: routes.find((r) => r.platform === f.platform && r.campaign_id === f.campaign_id) ?? null, error: null };
    },
  };
  return b;
}

let derive: typeof import("./derive").deriveClientIdFromCampaign;
test("setup", { skip }, async () => {
  mock.module("../supabase/admin", { namedExports: { createAdminSupabase: () => ({ from }) } });
  derive = (await import("./derive")).deriveClientIdFromCampaign;
});

const FLORIDA_CAMPAIGN = "Properties & Estates Rutenberg 1 + South Florida + ZF NS1 SEPT-2026 (EST)";

test("with no choice saved, the name guess runs as before (and picks Boston — the bug)", { skip }, async () => {
  routes = []; routesFail = false;
  assert.equal(await derive(FLORIDA_CAMPAIGN, { platform: "emailbison", id: 295 }), "bos");
});

test("a saved choice for the campaign wins", { skip }, async () => {
  routes = [{ platform: "emailbison", campaign_id: "295", mi_client_id: "fla" }];
  assert.equal(await derive(FLORIDA_CAMPAIGN, { platform: "emailbison", id: 295 }), "fla");
  assert.equal(await derive(FLORIDA_CAMPAIGN, { platform: "emailbison", id: "295" }), "fla");
});

test("the choice is per campaign and per platform", { skip }, async () => {
  routes = [{ platform: "emailbison", campaign_id: "295", mi_client_id: "fla" }];
  assert.equal(await derive(FLORIDA_CAMPAIGN, { platform: "emailbison", id: 296 }), "bos");
  assert.equal(await derive(FLORIDA_CAMPAIGN, { platform: "instantly", id: "295" }), "bos");
});

test("a choice naming a portal that no longer exists is ignored", { skip }, async () => {
  routes = [{ platform: "emailbison", campaign_id: "295", mi_client_id: "deleted-portal" }];
  assert.equal(await derive(FLORIDA_CAMPAIGN, { platform: "emailbison", id: 295 }), "bos");
});

test("if the table cannot be read (not created yet), the guess runs", { skip }, async () => {
  routesFail = true;
  assert.equal(await derive(FLORIDA_CAMPAIGN, { platform: "emailbison", id: 295 }), "bos");
  routesFail = false;
});

test("without a campaign id nothing is looked up, and other clients are untouched", { skip }, async () => {
  routes = [{ platform: "emailbison", campaign_id: "295", mi_client_id: "fla" }];
  const before = routeReads;
  assert.equal(await derive("The Keyes Company 1 + Nicole + West"), "keyes");
  assert.equal(await derive("The Keyes Company 1 + Nicole + West", { platform: "emailbison", id: null }), "keyes");
  assert.equal(routeReads, before);
  assert.equal(await derive("Nothing matches this"), "unk");
});
