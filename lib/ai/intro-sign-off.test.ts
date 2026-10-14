/*
 * Who signs an introduction (14 Oct): the mailbox it goes out from.
 *
 * Introductions are sent from Nicole's address, but the macro's sign-off,
 * "Best,\n{{sender.name}}", was filled with the campaign mailbox that first
 * emailed the lead ("Lydia Reed"). These pin the agent's handover to Nicole's
 * name whenever it goes from her mailbox, and to the campaign mailbox's name
 * when it cannot. The Introduce button's half is in
 * ../inbox/intro-sender.test.ts.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../test/fake-postgrest";
import { parseHandover } from "./agent-config";
import { planHandover } from "./qualification";

configureFakeEnvironment("");
delete process.env.MASTER_INBOX_INTRO_SENDER_EMAIL;
const db = new FakePostgrest();
const realFetch = globalThis.fetch;
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const { assembleRunInput, handoverVariables } = await import("./runtime");

const WS = "11111111-1111-4111-8111-111111111111";
const NICOLE = "nicole.c@brokerstaffer.com";

const CLIENT = {
  name: "C21 Results - Elite Team",
  contactName: "Sierra Shaw",
  contactRole: "Recruiter and Brand Ambassador",
  contactEmail: "sshaw@example.com",
  brokerage: "C21 Results - Elite Team",
};

const lead = {
  leadName: "Lara Cohen",
  leadEmail: "lara@example.com",
  leadPhone: "(404) 555-0606",
  leadCompany: "SDC Realty",
  leadTitle: null,
  subject: "Re: opportunity",
  ourEmail: "lydia@campaign.example",
};

test("the handover is signed by Nicole when it goes from her mailbox — never the campaign mailbox's persona", () => {
  const plan = planHandover(parseHandover({ cc_emails: [], message: "" }), {
    client: CLIENT,
    unavailableReason: null,
    variables: handoverVariables({ ...lead, senderName: "Lydia Reed", introSenderName: "Nicole Collins" }),
  });
  assert.equal(plan.kind, "introduce");
  if (plan.kind !== "introduce") return;
  assert.ok(plan.body.endsWith("Best,\nNicole Collins\nTalent Acquisition | C21 Results - Elite Team"), plan.body);
  assert.equal(plan.body.includes("Lydia Reed"), false);
});

test("without an intro sender name, the campaign mailbox's name stays (an older caller, or no usable Nicole mailbox)", () => {
  assert.equal(handoverVariables({ ...lead, senderName: "Lydia Reed" }).sender.name, "Lydia Reed");
  assert.equal(handoverVariables({ ...lead, senderName: "Lydia Reed", introSenderName: null }).sender.name, "Lydia Reed");
});

function seed(provider: "emailbison" | "instantly") {
  db.reset();
  const [campaign] = db.seed("channels", [
    { workspace_id: WS, provider, status: "connected", display_name: "Lydia Reed", external_account_id: "lydia@campaign.example", instantly_account_id: null },
  ]);
  db.seed("channels", [
    ...db.rows("channels"),
    // Nicole's live EmailBison mailbox, and her Instantly one, disconnected — as in production.
    { workspace_id: WS, provider: "emailbison", status: "connected", display_name: "Nicole Collins", external_account_id: NICOLE, instantly_account_id: null },
    { workspace_id: WS, provider: "instantly", status: "disconnected", display_name: NICOLE, external_account_id: null, instantly_account_id: NICOLE },
  ]);
  const [l] = db.seed("leads", [{ workspace_id: WS, full_name: "Lara Cohen", email: "lara@example.com", company: "SDC Realty", custom_fields: {} }]);
  const [thread] = db.seed("threads", [
    { workspace_id: WS, channel_id: campaign.id, lead_id: l.id, client_id: null, subject: "Opportunity", outbound_sender_email: "lydia@campaign.example", source_provider: provider },
  ]);
  db.seed("messages", [
    { workspace_id: WS, thread_id: thread.id, direction: "inbound", body_text: "Sure, tell me more.", sent_at: "2026-10-14T15:00:00.000Z" },
  ]);
  db.seed("label_assignments", []);
  return thread.id;
}

test("an EmailBison conversation: the agent's input carries Nicole's name for the introduction, the campaign name for everything else", async () => {
  const input = await assembleRunInput(WS, seed("emailbison"));
  assert.ok(input);
  assert.equal(input.senderName, "Lydia Reed", "ordinary replies are unchanged");
  assert.equal(input.introSenderName, "Nicole Collins");
});

test("an Instantly conversation, where Nicole's mailbox is disconnected: the introduction goes from the campaign mailbox, so it keeps that name", async () => {
  const input = await assembleRunInput(WS, seed("instantly"));
  assert.ok(input);
  assert.equal(input.introSenderName, "Lydia Reed");
});

test("nothing left the process", () => {
  assert.deepEqual(db.blocked, []);
  globalThis.fetch = realFetch;
});
