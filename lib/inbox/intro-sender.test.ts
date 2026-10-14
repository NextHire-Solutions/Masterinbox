import assert from "node:assert/strict";
import { test } from "node:test";

import { introSignOffName, pickIntroChannel } from "./intro-sender";

const E = "nicole.c@brokerstaffer.com";
const rows = [
  { id: "inst", provider: "instantly", status: "disconnected", display_name: E, instantly_account_id: E, external_account_id: null },
  { id: "eb-dead", provider: "emailbison", status: "disconnected", display_name: "Nicole Collins", instantly_account_id: null, external_account_id: E },
  { id: "eb-live", provider: "emailbison", status: "connected", display_name: "Nicole Collins", instantly_account_id: null, external_account_id: E },
  { id: "other", provider: "emailbison", status: "connected", display_name: "Nicole Collins", instantly_account_id: null, external_account_id: "nicole.collins@hirealtynow.com" },
];

test("an EmailBison conversation introduces from Nicole's live EmailBison mailbox, never a dead one or a campaign mailbox", () => {
  assert.deepEqual(pickIntroChannel(rows, "emailbison", E), { email: E, channelId: "eb-live", name: "Nicole Collins", problem: null });
});

test("an Instantly conversation with Nicole disconnected there says so instead of failing the send", () => {
  const r = pickIntroChannel(rows, "instantly", E);
  assert.equal(r.channelId, null);
  assert.match(r.problem ?? "", /disconnected in Instantly/);
});

test("no mailbox on file for the platform", () => {
  assert.match(pickIntroChannel(rows.filter((r) => r.provider === "instantly"), "emailbison", E).problem ?? "", /not connected in EmailBison/);
});

test("an introduction from Nicole's mailbox is signed by Nicole, not the campaign mailbox that emailed the lead (14 Oct)", () => {
  const sender = pickIntroChannel(rows, "emailbison", E);
  assert.equal(introSignOffName(sender, "Lydia Reed"), "Nicole Collins");
});

test("when it cannot go from Nicole, it keeps the campaign mailbox's name — the name matches the From", () => {
  assert.equal(introSignOffName(pickIntroChannel(rows, "instantly", E), "Lydia Reed"), "Lydia Reed");
  assert.equal(introSignOffName(null, "Lydia Reed"), "Lydia Reed");
  assert.equal(introSignOffName(undefined, null), null);
  // A name without a mailbox to send from does not sign: From stays the campaign mailbox.
  assert.equal(introSignOffName({ email: E, channelId: null, name: "Nicole Collins", problem: "disconnected" }, "Lydia Reed"), "Lydia Reed");
});

test("a mailbox whose stored name is only its address never signs as the address", () => {
  const onlyAddress = [{ id: "eb", provider: "emailbison", status: "connected", display_name: E, instantly_account_id: null, external_account_id: E }];
  const sender = pickIntroChannel(onlyAddress, "emailbison", E);
  assert.equal(sender.channelId, "eb");
  assert.equal(sender.name, null);
  assert.equal(introSignOffName(sender, "Lydia Reed"), "Lydia Reed");
});
