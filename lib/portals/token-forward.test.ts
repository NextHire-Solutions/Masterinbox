import { test } from "node:test";
import assert from "node:assert/strict";

import { forwardTokenFor } from "./token-forward";

const portal = (over: Partial<{ portal_token: string | null; slug: string | null; portal_enabled: boolean | null }> = {}) => ({
  portal_token: "jeff-cook-new-a1b2c3",
  slug: "jeff-cook-real-estate",
  portal_enabled: true,
  ...over,
});

test("an old link goes to the portal's current link", () => {
  assert.equal(forwardTokenFor("jeff-cook-real-estate-481980e1d7", portal()), "jeff-cook-new-a1b2c3");
  assert.equal(forwardTokenFor("old-token-1234", portal({ portal_enabled: null })), "jeff-cook-new-a1b2c3", "never switched = on");
});

test("only where the current link would open: off, Unknown, gone or no link answer not found, as before", () => {
  assert.equal(forwardTokenFor("old-token-1234", portal({ portal_enabled: false })), null);
  assert.equal(forwardTokenFor("old-token-1234", portal({ slug: "unknown" })), null);
  assert.equal(forwardTokenFor("old-token-1234", null), null);
  assert.equal(forwardTokenFor("old-token-1234", portal({ portal_token: null })), null);
  assert.equal(forwardTokenFor("old-token-1234", portal({ portal_token: "" })), null);
});

test("never to itself — no redirect loop", () => {
  assert.equal(forwardTokenFor("jeff-cook-new-a1b2c3", portal()), null);
});
