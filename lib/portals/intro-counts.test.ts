import { test } from "node:test";
import assert from "node:assert/strict";

import { countIntroductions, type LabelledIntro, type PortalEntryRow } from "./intro-counts";

const entry = (client_id: string, thread_id: string | null, introduced_at: string, source = "BrokerStaffer"): PortalEntryRow => ({ client_id, thread_id, source, introduced_at });
const label = (client_id: string, thread_id: string, assigned_at: string): LabelledIntro => ({ client_id, thread_id, assigned_at });

test("54 Realty: 31 in both, 19 only in the portal, 3 only labelled — 50, as the portal shows, and 3 not in it", () => {
  const entries: PortalEntryRow[] = [];
  const labelled: LabelledIntro[] = [];
  for (let i = 0; i < 31; i++) {
    entries.push(entry("54", `t${i}`, "2026-09-01T00:00:00Z"));
    labelled.push(label("54", `t${i}`, "2026-09-01T00:00:00Z"));
  }
  for (let i = 0; i < 19; i++) entries.push(entry("54", null, "2026-04-01T00:00:00Z")); // before Master Inbox
  labelled.push(label("54", "x1", "2026-08-13T19:21:00Z"), label("54", "x2", "2026-08-18T16:24:00Z"), label("54", "x3", "2026-10-14T12:00:00Z"));
  const c = countIntroductions(entries, labelled).get("54")!;
  assert.deepEqual(c, { count: 50, inPortal: 50, notInPortal: 3, candidates: 50, lastAt: "2026-10-14T12:00:00Z" });
});

test("the client's own candidates are not our introductions — but they are in the portal's candidate count", () => {
  const c = countIntroductions([entry("c", null, "2026-10-01", "Client Entry"), entry("c", "t1", "2026-10-02")], []).get("c")!;
  assert.equal(c.count, 1);
  assert.equal(c.candidates, 2);
});

test("ChuckTown: the headline matches the portal (79); the 2 that never reached it are beside it, not in it", () => {
  const entries: PortalEntryRow[] = Array.from({ length: 79 }, (_, i) => entry("ct", `t${i}`, "2026-10-01"));
  const c = countIntroductions(entries, [label("ct", "m1", "2026-08-01"), label("ct", "m2", "2026-08-02")]).get("ct")!;
  assert.deepEqual([c.count, c.candidates, c.notInPortal], [79, 79, 2]);
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
