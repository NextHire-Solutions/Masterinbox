import { test, mock } from "node:test";
import assert from "node:assert/strict";

// A lead in ANY of a client's portals finds the client's roster record, so the
// Introduce button and the agent's handover work for P&E Florida as for Boston.
const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

const TABLES: Record<string, Record<string, unknown>[]> = {
  os_clients: [
    { id: "pe", name: "Properties & Estates", aliases: ["Properties & Estates Florida", "Properties & Estates Boston"], mi_client_id: "bos", contact_name: "Pat" },
    { id: "keyes", name: "The Keyes Company", aliases: [], mi_client_id: "keyes-mi", contact_name: "Kim" },
    { id: "d1", name: "Twin Realty", aliases: ["Shared Name"], mi_client_id: null, contact_name: "A" },
    { id: "d2", name: "Other Realty", aliases: ["Shared Name"], mi_client_id: null, contact_name: "B" },
  ],
  os_campaign_portals: [] as Record<string, unknown>[],
};
function from(table: string) {
  const eqs: [string, unknown][] = [];
  const rows = () => (TABLES[table] ?? []).filter((r) => eqs.every(([k, v]) => r[k] === v));
  const b = {
    select: () => b,
    eq: (k: string, v: unknown) => { eqs.push([k, v]); return b; },
    limit: () => b,
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(res),
  };
  return b;
}

let find: typeof import("./roster-for-portal").rosterRowForPortal;
test("setup", { skip }, async () => {
  mock.module("../supabase/admin", { namedExports: { createAdminSupabase: () => ({ from }) } });
  find = (await import("./roster-for-portal")).rosterRowForPortal;
});

test("the linked portal finds its record", { skip }, async () => {
  assert.equal((await find("bos", "Properties & Estates Boston", "id")).row?.id, "pe");
});

test("a second portal is found by its name among the client's aliases", { skip }, async () => {
  assert.equal((await find("fla", "Properties & Estates Florida", "id")).row?.id, "pe");
});

test("a second portal is found through a campaign → portal choice", { skip }, async () => {
  TABLES.os_campaign_portals = [{ mi_client_id: "fla2", os_client_id: "pe" }];
  assert.equal((await find("fla2", "Some Other Name", "id")).row?.id, "pe");
  TABLES.os_campaign_portals = [];
});

test("a name shared by two records finds nobody rather than guessing", { skip }, async () => {
  assert.equal((await find("x", "Shared Name", "id")).row, null);
  assert.equal((await find("x", "No Such Client", "id")).row, null);
});
