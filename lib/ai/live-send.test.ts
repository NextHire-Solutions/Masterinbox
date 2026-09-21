/*
 * The live send, end to end, with the gate faked ON and the providers stubbed.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PROVES
 *
 * With the env gate faked open — by mocking `live-gate.ts` inside this process
 * only; the variable itself is never set — a live agent's reply goes through
 * the composer's own send path and leaves every row a person's send leaves:
 *
 *   · exactly one provider send, carrying the handover CC list
 *   · the outbound `messages` row, the draft marked sent, the as_written verdict
 *   · the Introduction label applied through apply-label as `system`
 *   · the thread state moved to `handed_over`
 *
 * and, the headline: THE HTML THE PROVIDER RECEIVES IS BYTE-IDENTICAL TO WHAT
 * THE COMPOSER WOULD HAVE SENT for the same draft. The composer's own
 * `plainTextToHtml` is read out of composer.tsx and executed here, so the
 * comparison is against the shipped function and not a copy of it.
 *
 * The release sweep (ai/release.ts) is covered the same way: a held handover
 * is released through the same transport with its CC list resolved as the
 * runtime resolved it.
 *
 * The database is an in-memory PostgREST and the providers are fake hosts —
 * see test/fake-postgrest.ts for why nothing here may touch the real database,
 * even a throwaway row. The last test asserts that no request left the process.
 *
 * Runs under `npm test` (which passes --experimental-test-module-mocks and the
 * @/ alias hooks). Skips itself, loudly, under a bare `node --test`.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { configureFakeEnvironment, FakePostgrest, type Row } from "../test/fake-postgrest";
import type { StoredThreadState } from "./thread-state";

// Node 24 strips types natively; the installed @types/node predates the export.
const { stripTypeScriptTypes } = (await import("node:module")) as unknown as {
  stripTypeScriptTypes: (code: string) => string;
};
const id = (row: Row): string => row.id as string;

configureFakeEnvironment("");
assert.equal(process.env.MASTER_INBOX_REPLY_AGENT_LIVE_SEND, undefined, "the env gate is never set by a test");

const db = new FakePostgrest();
const realFetch = globalThis.fetch;
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

/*
 * The gate, faked open for this process. Everything below imports the engine
 * AFTER this, so the safety gate and the transport both see `true` — from a
 * mocked function, not from the environment, which stays unset.
 */
let engine: {
  attemptLiveSend: typeof import("./live").attemptLiveSend;
  dispatch: typeof import("./send-transport").dispatch;
  agentBodyHtml: typeof import("./send-transport").agentBodyHtml;
  agentSubject: typeof import("./send-transport").agentSubject;
  LIVE_TRANSPORT_WIRED: boolean;
  releaseHeldReplies: typeof import("./release").releaseHeldReplies;
  loadAgents: typeof import("./agent").loadAgents;
  resolveIntroduction: typeof import("./runtime").resolveIntroduction;
  planHandover: typeof import("./qualification").planHandover;
  loadThreadState: typeof import("./thread-state").loadThreadState;
  liveSendingEnabled: () => boolean;
} | null = null;

if (canMock) {
  mock.module("./live-gate", {
    namedExports: {
      LIVE_SEND_ENV_VAR: "MASTER_INBOX_REPLY_AGENT_LIVE_SEND",
      LIVE_DISABLED_MESSAGE: "mocked",
      liveSendingEnabled: () => true,
    },
  });
  const [live, transport, release, agent, runtime, qualification, threadState, gate] = await Promise.all([
    import("./live"),
    import("./send-transport"),
    import("./release"),
    import("./agent"),
    import("./runtime"),
    import("./qualification"),
    import("./thread-state"),
    import("./live-gate"),
  ]);
  engine = {
    attemptLiveSend: live.attemptLiveSend,
    dispatch: transport.dispatch,
    agentBodyHtml: transport.agentBodyHtml,
    agentSubject: transport.agentSubject,
    LIVE_TRANSPORT_WIRED: transport.LIVE_TRANSPORT_WIRED,
    releaseHeldReplies: release.releaseHeldReplies,
    loadAgents: agent.loadAgents,
    resolveIntroduction: runtime.resolveIntroduction,
    planHandover: qualification.planHandover,
    loadThreadState: threadState.loadThreadState,
    liveSendingEnabled: gate.liveSendingEnabled,
  };
}

/* ========================================================================== */
/* The composer's own conversion, executed from composer.tsx                   */
/* ========================================================================== */

const COMPOSER = new URL("../../components/inbox/composer.tsx", import.meta.url);

/** `plainTextToHtml` (and the `escapeHtml` it calls), read from the composer and run as shipped. */
function composerPlainTextToHtml(): (s: string) => string {
  const src = readFileSync(COMPOSER, "utf8");
  const grab = (name: string) => {
    const m = src.match(new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n}\\n`));
    if (!m) throw new Error(`composer.tsx no longer defines ${name}`);
    return m[0];
  };
  const code = stripTypeScriptTypes(grab("escapeHtml") + grab("plainTextToHtml")) + "\nreturn plainTextToHtml;";
  return new Function(code)() as (s: string) => string;
}
const composerHtml = composerPlainTextToHtml();

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-18T15:00:00.000Z");

const ORDINARY_DRAFT =
  "Hi Jane,\n\nThanks for getting back to me. The role is a full-time listing coordinator " +
  "supporting two top producers.\n\nWould Thursday at 2pm work for a quick call?\n\nBest,\nNicole";

/** A live agent, its client on the roster, a lead who replied, and the Introduction label. */
function seed(provider: "emailbison" | "instantly") {
  db.reset();
  db.seed("workspaces", [{ id: WORKSPACE, created_at: "2026-01-01T00:00:00.000Z" }]);
  const [client] = db.seed("clients", [{ workspace_id: WORKSPACE, name: "Acme Realty", slug: "acme" }]);
  db.seed("os_clients", [
    {
      mi_client_id: client.id,
      name: "Acme Realty",
      brokerage: "Acme Realty Group",
      contact_name: "Nicole Collins",
      contact_role: "Team Leader",
      contact_email: "nicole@acme.example",
      contact2_name: "Sam Lee",
      contact2_role: "Managing Broker",
      contact2_email: "sam@acme.example",
      contact3_name: null,
      contact3_role: null,
      contact3_email: null,
    },
  ]);
  const [lead] = db.seed("leads", [
    {
      workspace_id: WORKSPACE,
      email: "jane@example.com",
      full_name: "Jane Doe",
      company: "Doe Realty",
      title: "Broker",
      custom_fields: { phone: "(555) 010-0199" },
    },
  ]);
  const [channel] = db.seed("channels", [
    {
      workspace_id: WORKSPACE,
      provider,
      display_name: "Nicole Sender",
      emailbison_team_id: provider === "emailbison" ? 7 : null,
      emailbison_sender_email_id: provider === "emailbison" ? "42" : null,
      instantly_account_id: provider === "instantly" ? "nicole@brokerstaffer.com" : null,
    },
  ]);
  const [thread] = db.seed("threads", [
    {
      workspace_id: WORKSPACE,
      lead_id: lead.id,
      channel_id: channel.id,
      client_id: client.id,
      subject: "Quick question about your team",
      outbound_sender_email: "nicole@brokerstaffer.com",
      source_provider: provider,
      needs_reply: true,
      seen: false,
      last_message_at: "2026-09-18T14:03:00.000Z",
      last_message_preview: "Sure, let's talk.",
    },
  ]);
  const [inbound] = db.seed("messages", [
    {
      workspace_id: WORKSPACE,
      thread_id: id(thread),
      direction: "inbound",
      sender: "jane@example.com",
      subject: "Quick question about your team",
      body_text: "Sure, let's talk. Yes I'm licensed and I'd be open to a move.",
      body_html: null,
      sent_at: "2026-09-18T14:03:00.000Z",
      emailbison_reply_id: provider === "emailbison" ? "5551" : null,
      instantly_email_id: provider === "instantly" ? "in-email-5551" : null,
      raw_payload: provider === "emailbison" ? { data: { sender_email: { id: 42 } } } : {},
    },
  ]);
  const [label] = db.seed("labels", [{ workspace_id: WORKSPACE, name: "Introduction" }]);
  const [agentRow] = db.seed("reply_agents", [
    {
      workspace_id: WORKSPACE,
      name: "Acme after-hours",
      mode: "auto",
      tone: "professional",
      response_length: "medium",
      max_tokens: 1000,
      temperature: 0.1,
      provider: "openai",
      model: "gpt-4o-mini",
      api_key_encrypted: null,
      system_prompt: null,
      channel_ids: [],
      channel_filter: "both",
      active: true,
      auto_respond_new: true,
      stats: {},
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
      run_mode: "live",
      client_ids: [client.id],
      schedule: { kind: "always" },
      qualification: { questions: [] },
      handover: { cc_emails: ["ops@brokerstaffer.com", "Nicole@acme.example"], message: "" },
    },
  ]);
  return { client, lead, channel, thread, inbound, label, agentRow };
}

function pendingDraft(threadId: string, agentId: string, body: string) {
  const [draft] = db.seed("reply_drafts", [
    {
      workspace_id: WORKSPACE,
      thread_id: threadId,
      agent_id: agentId,
      status: "pending",
      generated_body: body,
      created_at: "2026-09-18T14:05:00.000Z",
    },
  ]);
  return draft;
}

/** The handover exactly as runtime.ts plans it: the roster client through planHandover. */
async function planIntroduction(clientId: string, agent: { handover: Parameters<NonNullable<typeof engine>["planHandover"]>[0] }) {
  const intro = await engine!.resolveIntroduction(clientId);
  const plan = engine!.planHandover(agent.handover, {
    client: intro.client,
    unavailableReason: intro.unavailableReason,
    variables: {
      lead: { name: "Jane Doe", email: "jane@example.com", phone: "(555) 010-0199", company: "Doe Realty", title: "Broker" },
      thread: { subject: "Quick question about your team" },
      sender: { name: "Nicole Sender", email: "nicole@brokerstaffer.com" },
    },
  });
  assert.equal(plan.kind, "introduce");
  return plan as Extract<typeof plan, { kind: "introduce" }>;
}

const sendCalls = () => db.providerCalls.filter((c) => !c.path.includes("switch-workspace"));

/* ========================================================================== */
/* 1. Formatting parity — the headline                                         */
/* ========================================================================== */

test("the transport is wired and the mocked gate is open in this process only", { skip }, () => {
  assert.equal(engine!.LIVE_TRANSPORT_WIRED, true);
  assert.equal(engine!.liveSendingEnabled(), true);
  assert.equal(process.env.MASTER_INBOX_REPLY_AGENT_LIVE_SEND, undefined);
});

test("byte-compare: the agent converts an introduction macro exactly as the composer does", { skip }, async () => {
  const { client, agentRow } = seed("emailbison");
  const [agent] = await engine!.loadAgents(WORKSPACE);
  assert.equal(agent.id, id(agentRow));
  const plan = await planIntroduction(id(client), agent);

  // The macro is plain text with paragraph breaks…
  assert.ok(!/<[a-z]+>/i.test(plan.body), "the macro body is plain text");
  assert.equal(plan.body.split("\n\n").length, 6, "six blocks separated by blank lines");

  // …and both paths turn it into the same HTML, byte for byte.
  const html = engine!.agentBodyHtml(plan.body);
  assert.equal(html, composerHtml(plan.body));

  // Every block is its own paragraph; the single newlines inside the sign-off are line breaks.
  assert.equal((html.match(/<p>/g) ?? []).length, 6);
  assert.ok(html.startsWith("<p>Hey Jane,</p><p>I&#039;d like to introduce you to "));
  assert.ok(
    html.endsWith("</p><p>Best,<br>Nicole Sender<br>Talent Acquisition | Acme Realty Group</p>"),
    `sign-off keeps its breaks: ${html.slice(-120)}`,
  );
  assert.ok(html.includes("productive conversation!</p><p>Best,<br>"), '"Best," starts its own paragraph');
  assert.ok(!html.includes("\n"), "no raw newline survives into the HTML");
});

test("byte-compare: an ordinary agent draft converts exactly as the composer does", { skip }, () => {
  const html = engine!.agentBodyHtml(ORDINARY_DRAFT);
  assert.equal(html, composerHtml(ORDINARY_DRAFT));
  assert.equal(
    html,
    "<p>Hi Jane,</p><p>Thanks for getting back to me. The role is a full-time listing coordinator " +
      "supporting two top producers.</p><p>Would Thursday at 2pm work for a quick call?</p><p>Best,<br>Nicole</p>",
  );
});

test("an already-HTML body is passed through, never escaped twice; special characters are escaped once", { skip }, () => {
  const already = "<p>Tom &amp; Jerry</p><p>Best,<br>Nicole</p>";
  assert.equal(engine!.agentBodyHtml(already), already);
  assert.ok(!engine!.agentBodyHtml(already).includes("&lt;p&gt;"));

  const plain = "Tom & Jerry <3 \"quotes\" 'apostrophes'";
  const html = engine!.agentBodyHtml(plain);
  assert.equal(html, composerHtml(plain));
  assert.equal(html, "<p>Tom &amp; Jerry &lt;3 &quot;quotes&quot; &#039;apostrophes&#039;</p>");
});

test("the subject follows the composer's rule: exactly one Re: prefix", { skip }, () => {
  assert.equal(engine!.agentSubject("Quick question"), "Re: Quick question");
  assert.equal(engine!.agentSubject("Re: Quick question"), "Re: Quick question");
  assert.equal(engine!.agentSubject("RE: Quick question"), "RE: Quick question");
  assert.equal(engine!.agentSubject("  "), undefined);
  assert.equal(engine!.agentSubject(null), undefined);
});

/* ========================================================================== */
/* 2. The handover, through attemptLiveSend                                    */
/* ========================================================================== */

test("emailbison: a live handover sends once through the composer's path with the CC list, and books it like a person's", { skip }, async () => {
  const { client, thread, lead, label } = seed("emailbison");
  const [agent] = await engine!.loadAgents(WORKSPACE);
  const plan = await planIntroduction(id(client), agent);
  const draft = pendingDraft(id(thread), agent.id, plan.body);

  const result = await engine!.attemptLiveSend({
    agent,
    workspaceId: WORKSPACE,
    threadId: id(thread),
    draftId: id(draft),
    body: plan.body,
    subject: "Quick question about your team",
    toEmail: lead.email as string,
    lastInboundText: "Sure, let's talk. Yes I'm licensed and I'd be open to a move.",
    isHandover: true,
    cc: plan.cc,
    leadName: "Jane Doe",
    state: null,
    now: NOW,
  });
  assert.deepEqual(result, { status: "sent", providerMessageId: "987654" });

  // ---- exactly one send, the composer's request ----
  assert.deepEqual(
    db.providerCalls.map((c) => `${c.method} ${c.path}`),
    ["POST /api/workspaces/v1.1/switch-workspace", "POST /api/replies/5551/reply"],
  );
  const html = composerHtml(plan.body);
  assert.deepEqual(sendCalls()[0].body, {
    message: html,
    content_type: "html",
    to_emails: [{ email_address: "jane@example.com", name: "Jane Doe" }],
    cc_emails: plan.cc.map((email_address) => ({ email_address })),
    reply_all: false,
    inject_previous_email_body: true,
    sender_email_id: 42,
  });
  // The CC is the client's contacts first, then the agent's extras, de-duplicated case-insensitively.
  assert.deepEqual(plan.cc, ["nicole@acme.example", "sam@acme.example", "ops@brokerstaffer.com"]);

  // ---- the same rows a person's send writes ----
  const outbound = db.rows("messages").find((m) => m.direction === "outbound")!;
  assert.ok(outbound);
  assert.equal(outbound.body_html, html);
  assert.equal(outbound.subject, "Re: Quick question about your team");
  assert.equal(outbound.sender, "nicole@brokerstaffer.com");
  assert.equal(outbound.external_message_id, "eb:reply:987654");
  assert.deepEqual(outbound.recipients, { to: ["jane@example.com"], cc: plan.cc, bcc: [] });
  const t = db.rows("threads")[0];
  assert.equal(t.needs_reply, false);
  assert.equal(t.seen, true);
  assert.equal(t.last_message_at, outbound.sent_at);

  assert.equal(db.rows("reply_drafts")[0].status, "sent");
  assert.equal(db.rows("os_reply_feedback")[0].verdict, "as_written");
  assert.equal(db.rows("os_reply_feedback")[0].draft_id, id(draft));
  assert.equal(db.rows("os_reply_examples").length, 0, "an as_written send is not a correction");

  // ---- the Introduction label, through apply-label, as system ----
  const assignments = db.rows("label_assignments");
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].label_id, id(label));
  assert.equal(assignments[0].target_id, id(thread));
  assert.equal(assignments[0].assigned_by, "system");
  assert.equal(assignments[0].assigned_user_id, null);

  // ---- the thread state ----
  const state = await engine!.loadThreadState(id(thread), agent.id);
  assert.equal(state.available, true);
  const s = (state as { state: StoredThreadState }).state;
  assert.equal(s.status, "handed_over");
  assert.equal(s.sendsAttempted, 1);
  assert.equal(s.sendsMade, 1);
  assert.equal(s.holdReason, null);
  assert.equal(s.heldDraftId, null);
  assert.equal(s.handoverAt, NOW.toISOString());
  assert.equal(s.stopReason, null);
});

test("instantly: the same handover goes out as /emails/reply with the CC list and the composer's HTML", { skip }, async () => {
  const { client, thread, lead } = seed("instantly");
  const [agent] = await engine!.loadAgents(WORKSPACE);
  const plan = await planIntroduction(id(client), agent);
  const draft = pendingDraft(id(thread), agent.id, plan.body);

  const result = await engine!.attemptLiveSend({
    agent,
    workspaceId: WORKSPACE,
    threadId: id(thread),
    draftId: id(draft),
    body: plan.body,
    subject: "Quick question about your team",
    toEmail: lead.email as string,
    lastInboundText: "Sure, let's talk.",
    isHandover: true,
    cc: plan.cc,
    leadName: "Jane Doe",
    state: null,
    now: NOW,
  });
  assert.deepEqual(result, { status: "sent", providerMessageId: "instantly-email-uuid-1" });
  assert.deepEqual(db.providerCalls.map((c) => c.path), ["/emails/reply"]);
  assert.deepEqual(db.providerCalls[0].body, {
    reply_to_uuid: "in-email-5551",
    subject: "Re: Quick question about your team",
    body: { html: composerHtml(plan.body) },
    eaccount: "nicole@brokerstaffer.com",
    cc_address_email_list: plan.cc.join(","),
    include_original_body: true,
  });
  const outbound = db.rows("messages").find((m) => m.direction === "outbound")!;
  assert.equal(outbound.source_provider, "instantly");
  assert.equal(outbound.instantly_email_id, "instantly-email-uuid-1");
  assert.equal(db.rows("reply_drafts")[0].status, "sent");
  assert.equal(db.rows("label_assignments").length, 1);
  assert.equal(db.rows("label_assignments")[0].assigned_by, "system");
});

test("an ordinary (non-handover) reply carries no CC and applies no label", { skip }, async () => {
  const { thread, lead } = seed("emailbison");
  const [agent] = await engine!.loadAgents(WORKSPACE);
  const draft = pendingDraft(id(thread), agent.id, ORDINARY_DRAFT);
  const result = await engine!.attemptLiveSend({
    agent,
    workspaceId: WORKSPACE,
    threadId: id(thread),
    draftId: id(draft),
    body: ORDINARY_DRAFT,
    subject: "Re: Quick question about your team",
    toEmail: lead.email as string,
    lastInboundText: "Sure, let's talk.",
    isHandover: false,
    cc: ["should-not-be-used@acme.example"],
    leadName: "Jane Doe",
    state: null,
    now: NOW,
  });
  assert.equal(result.status, "sent");
  const body = sendCalls()[0].body as Record<string, unknown>;
  assert.equal(body.message, composerHtml(ORDINARY_DRAFT));
  assert.equal(body.cc_emails, undefined);
  assert.equal(db.rows("label_assignments").length, 0);
  const s = await engine!.loadThreadState(id(thread), agent.id);
  assert.equal((s as { state: { status: string } }).state.status, "qualifying");
});

/* ========================================================================== */
/* 3. The release sweep                                                        */
/* ========================================================================== */

test("release: a held handover is sent through the same transport with its CC list resolved as the runtime resolves it", { skip }, async () => {
  const { client, thread, label } = seed("emailbison");
  const [agent] = await engine!.loadAgents(WORKSPACE);
  const plan = await planIntroduction(id(client), agent);
  const draft = pendingDraft(id(thread), agent.id, plan.body);
  db.seed("agent_thread_state", [
    {
      workspace_id: WORKSPACE,
      thread_id: id(thread),
      agent_id: agent.id,
      status: "qualified",
      step: 0,
      answers: [],
      sends_attempted: 1,
      sends_made: 0,
      hold_reason: "live_disabled",
      held_draft_id: id(draft),
      held_at: "2026-09-18T09:00:00.000Z",
    },
  ]);

  const report = await engine!.releaseHeldReplies(WORKSPACE, NOW);
  assert.equal(report.scanned, 1);
  assert.equal(report.sent, 1);
  assert.deepEqual(report.outcomes, [{ threadId: id(thread), agentId: agent.id, result: "sent", reason: "released" }]);

  assert.equal(sendCalls().length, 1, "exactly one provider send");
  const body = sendCalls()[0].body as Record<string, unknown>;
  assert.equal(body.message, composerHtml(plan.body));
  assert.deepEqual(body.cc_emails, plan.cc.map((email_address) => ({ email_address })));
  assert.deepEqual(body.to_emails, [{ email_address: "jane@example.com", name: "Jane Doe" }]);

  assert.equal(db.rows("reply_drafts")[0].status, "sent");
  assert.equal(db.rows("label_assignments")[0]?.label_id, id(label));
  const s = (await engine!.loadThreadState(id(thread), agent.id)) as { state: StoredThreadState };
  assert.equal(s.state.status, "handed_over");
  assert.equal(s.state.holdReason, null);
  assert.equal(s.state.sendsMade, 1);
});

test("release: a handover whose client has lost its introduction details stops instead of sending an introduction to nobody", { skip }, async () => {
  const { client, thread } = seed("emailbison");
  const [agent] = await engine!.loadAgents(WORKSPACE);
  const plan = await planIntroduction(id(client), agent);
  const draft = pendingDraft(id(thread), agent.id, plan.body);
  db.rows("os_clients")[0].contact_role = null; // the roster changed while the reply was held
  db.seed("agent_thread_state", [
    {
      workspace_id: WORKSPACE,
      thread_id: id(thread),
      agent_id: agent.id,
      status: "qualified",
      hold_reason: "live_disabled",
      held_draft_id: id(draft),
      held_at: "2026-09-18T09:00:00.000Z",
    },
  ]);
  const report = await engine!.releaseHeldReplies(WORKSPACE, NOW);
  assert.equal(report.cleared, 1);
  assert.match(report.outcomes[0].reason, /no_introduction_details/);
  assert.equal(db.providerCalls.length, 0);
  const s = (await engine!.loadThreadState(id(thread), agent.id)) as { state: StoredThreadState };
  assert.equal(s.state.status, "stopped");
  assert.equal(s.state.stopReason, "no_introduction_details");
  assert.equal(s.state.holdReason, null);
  assert.equal(db.rows("reply_drafts")[0].status, "pending", "the draft stays for a person");
});

/* ========================================================================== */
/* 4. When the send path says no                                               */
/* ========================================================================== */

test("a provider rejection holds the reply as send_failed, retryable, with nothing written", { skip }, async () => {
  const { thread, lead } = seed("emailbison");
  const [agent] = await engine!.loadAgents(WORKSPACE);
  const draft = pendingDraft(id(thread), agent.id, ORDINARY_DRAFT);
  db.nextProviderResponses.push({ status: 200, body: { data: { name: "team" } } });
  db.nextProviderResponses.push({ status: 422, body: { message: "Sender email is disconnected." } });

  const result = await engine!.attemptLiveSend({
    agent, workspaceId: WORKSPACE, threadId: id(thread), draftId: id(draft), body: ORDINARY_DRAFT,
    subject: "Re: x", toEmail: lead.email as string, lastInboundText: "ok", isHandover: false, cc: [],
    state: null, now: NOW,
  });
  assert.equal(result.status, "held");
  assert.equal((result as { reason: string }).reason, "send_failed");
  assert.equal((result as { retryable: boolean }).retryable, true);
  assert.match((result as { detail: string }).detail, /422/);
  assert.equal(db.rows("messages").length, 1, "no outbound row");
  assert.equal(db.rows("reply_drafts")[0].status, "pending");
  const s = (await engine!.loadThreadState(id(thread), agent.id)) as { state: StoredThreadState };
  assert.equal(s.state.holdReason, "send_failed");
  assert.equal(s.state.heldDraftId, id(draft));
  assert.equal(s.state.status, "qualifying", "a retryable failure does not stop the thread");
  assert.equal(s.state.sendsAttempted, 1);
  assert.equal(s.state.sendsMade, 0);
});

test("a precondition the route would refuse stops the thread: nothing to reply to is not retryable", { skip }, async () => {
  const { thread, lead } = seed("emailbison");
  db.rows("messages")[0].emailbison_reply_id = null;
  const [agent] = await engine!.loadAgents(WORKSPACE);
  const draft = pendingDraft(id(thread), agent.id, ORDINARY_DRAFT);
  const result = await engine!.attemptLiveSend({
    agent, workspaceId: WORKSPACE, threadId: id(thread), draftId: id(draft), body: ORDINARY_DRAFT,
    subject: "Re: x", toEmail: lead.email as string, lastInboundText: "ok", isHandover: false, cc: [],
    state: null, now: NOW,
  });
  assert.equal(result.status, "held");
  assert.equal((result as { retryable: boolean }).retryable, false);
  assert.match((result as { detail: string }).detail, /No inbound EmailBison reply/);
  assert.equal(db.providerCalls.length, 0);
  const s = (await engine!.loadThreadState(id(thread), agent.id)) as { state: StoredThreadState };
  assert.equal(s.state.status, "stopped");
  assert.equal(s.state.stopReason, "send_failed");
});

test("nothing left the process: no request reached any host but the fakes", { skip }, () => {
  assert.deepEqual(db.blocked, []);
  assert.ok(db.providerCalls.every((c) => c.url.startsWith("http://emailbison.test/") || c.url.startsWith("http://instantly.test/")));
  assert.equal(process.env.MASTER_INBOX_REPLY_AGENT_LIVE_SEND, undefined);
  globalThis.fetch = realFetch;
});
