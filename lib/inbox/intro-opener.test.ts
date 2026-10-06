import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanOpener, withOpener } from "./intro-opener";

test("opener: one clean sentence, or nothing", () => {
  assert.equal(cleanOpener('"Great to hear you are focused on luxury listings in Charleston"'), "Great to hear you are focused on luxury listings in Charleston.");
  assert.equal(cleanOpener("NONE"), null);
  assert.equal(cleanOpener("none."), null);
  assert.equal(cleanOpener(""), null);
  assert.equal(cleanOpener("Hey Gisele, thanks!"), null, "a greeting is not an opening line");
  assert.equal(cleanOpener("Thanks for {{lead.first_name}}."), null);
});

test("opener: placed under the greeting, once", () => {
  const body = "Hey Gisele,\n\nI'd like to introduce you to Nicole.\n\nBest,\nSam";
  const out = withOpener(body, "Thanks for sharing your plans for next year.");
  assert.equal(out, "Hey Gisele,\n\nThanks for sharing your plans for next year.\n\nI'd like to introduce you to Nicole.\n\nBest,\nSam");
  assert.equal(withOpener(out, "Thanks for sharing your plans for next year."), out);
});

test("opener: never a promise, never a reply to a refusal (seen on real replies, 6 Oct)", () => {
  assert.equal(cleanOpener("I appreciate your request and will ensure your email is removed from our list promptly."), null);
  assert.equal(cleanOpener("I appreciate your clarity and will ensure you are removed from our list as requested."), null);
  assert.equal(cleanOpener("I appreciate your response and understand that you're not interested at this time."), null);
  assert.equal(cleanOpener("We'll be in touch soon."), null);
  assert.equal(cleanOpener("It's great to hear you're open to exploring a move this year."), "It's great to hear you're open to exploring a move this year.");
});
