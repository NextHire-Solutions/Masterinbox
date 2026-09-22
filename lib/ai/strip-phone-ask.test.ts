import assert from "node:assert/strict";
import { test } from "node:test";

import { stripPhoneAsk } from "./retrieval";

/*
 * The sentences here are real, copied from the corpus and from the distilled
 * playbook. The rule they enforce: we no longer ask a lead to confirm a phone
 * number, but the introduction still STATES the number we hold, and that must
 * not be stripped with it.
 */

test("the house's stock confirmation line is removed", () => {
  const out = stripPhoneAsk("Great to hear you're interested! Can you confirm that (704) 750-5708 is the best number to reach you?");
  assert.equal(out, "Great to hear you're interested!");
});

test("only the asking sentence goes, the rest of the reply stays", () => {
  const out = stripPhoneAsk(
    "Carrie, I appreciate your response. Can you confirm that 513-602-6970 is the best number to reach you? Feel free to reach out any time.",
  );
  assert.equal(out, "Carrie, I appreciate your response. Feel free to reach out any time.");
});

test("the introduction still states the number we hold", () => {
  const line = "Rima, I recently connected with Ruben, who can be reached directly at (818) 445-6147 and is currently with LPT Realty, Inc.";
  assert.equal(stripPhoneAsk(line), line);
});

test("a style-guide bullet that is only an ask disappears", () => {
  const out = stripPhoneAsk(["- Acknowledge the sender's message positively.",
                             "- Confirm or ask for the best contact number.",
                             "- Use a friendly and professional tone."].join("\n"));
  assert.equal(out, "- Acknowledge the sender's message positively.\n- Use a friendly and professional tone.");
});

test("the playbook's mixed bullet keeps the half that is not about phones", () => {
  const out = stripPhoneAsk("- Ask for the best contact number and any relevant details about their current affiliation.");
  assert.equal(out, "");
});

test("other phrasings of the same ask are caught", () => {
  for (const s of [
    "What's the best number to reach you?",
    "Could you confirm your phone number for me?",
    "Is 513-602-6970 the best number to reach you?",
  ]) {
    assert.equal(stripPhoneAsk(s), "", `not stripped: ${s}`);
  }
});

test("a number mentioned without being asked about survives", () => {
  const keep = "I have you down as 513-602-6970 and will pass that along.";
  assert.equal(stripPhoneAsk(keep), keep);
});

test("text with no phone talk is returned untouched", () => {
  const keep = "Thanks Carrie, understood. I'll keep you posted if anything changes.";
  assert.equal(stripPhoneAsk(keep), keep);
});
