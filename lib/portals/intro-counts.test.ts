import { test } from "node:test";
import assert from "node:assert/strict";

import { countIntroductions, type LabelledIntro, type PortalEntryRow } from "./intro-counts";

const entry = (client_id: string, thread_id: string | null, introduced_at: string, source = "BrokerStaffer"): PortalEntryRow => ({ client_id, thread_id, source, introduced_at });
const label = (client_id: string, thread_id: string, assigned_at: string): LabelledIntro => ({ client_id, thread_id, assigned_at });

test("54 Realty: 31 in both, 19 only in the portal, 3 only labelled — 53, of which 3 not in the portal", () => {
  const entries: PortalEntryRow[] = [];
  const labelled: LabelledIntro[] = [];
  for (let i = 0; i < 31; i++) {
    entries.push(entry("54", `t${i}`, "2026-09-01T00:00:00Z"));
    labelled.push(label("54", `t${i}`, "2026-09-01T00:00:00Z"));
  }
  for (let i = 0; i < 19; i++) entries.push(entry("54", null, "2026-04-01T00:00:00Z")); // before Master Inbox
  labelled.push(label("54", "x1", "2026-08-13T19:21:00Z"), label("54", "x2", "2026-08-18T16:24:00Z"), label("54", "x3", "2026-10-14T12:00:00Z"));
  const c = countIntroductions(entries, labelled).get("54")!;
  assert.deepEqual(c, { count: 53, inPortal: 50, notInPortal: 3, lastAt: "2026-10-14T12:00:00Z" });
});

test("the client's own candidates are not our introductions", () => {
  const c = countIntroductions([entry("c", null, "2026-10-01", "Client Entry"), entry("c", "t1", "2026-10-02")], []).get("c")!;
  assert.equal(c.count, 1);
});

test("a labelled conversation the client had already added counts once, as in the portal", () => {
  const c = countIntroductions([entry("c", "t1", "2026-10-01", "Client Entry")], [label("c", "t1", "2026-10-05")]).get("c")!;
  assert.deepEqual([c.count, c.inPortal, c.notInPortal], [1, 1, 0]);
});

test("an introduction in another client's portal is counted there, never twice", () => {
  const m = countIntroductions([entry("a", "t1", "2026-10-01")], [label("b", "t1", "2026-10-01")]);
  assert.equal(m.get("a")!.count, 1);
  assert.equal(m.get("b"), undefined);
});

test("entries with no client are ignored; a client with nothing has no row", () => {
  const m = countIntroductions([{ client_id: null, thread_id: "t", source: "BrokerStaffer", introduced_at: null }], []);
  assert.equal(m.size, 0);
});
