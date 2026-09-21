/*
 * The reply route, end to end, with the providers stubbed at the network.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PROVES
 *
 * The send core was lifted out of the route into `sendOutboundReply` so the
 * reply agent can use it. A person's send must not have changed in the
 * process: same request to EmailBison or Instantly, same outbound `messages`
 * row, same thread update, same feedback verdict, same drafts marked sent,
 * same composer auto-save removed, same status codes and bodies on failure.
 * These tests drive the route's own POST handler — parse, auth, membership
 * check and all — and assert every one of those.
 *
 * Only the session boundary is mocked: `createServerSupabase` needs a request
 * scope and a signed-in cookie, and here returns the admin client with a
 * signed-in user. The provider clients are real and pointed at fake hosts (see
 * test/fake-postgrest.ts); nothing here can reach send.brokerstaffer.com or
 * Instantly, and the last test asserts nothing tried.
 *
 * Kept in step with the OS's src/lib/tools/master-inbox/inbox/send-reply.test.ts;
 * the one difference is the Instantly text case, which asserts this route's own
 * behaviour.
 *
 * Runs under `npm test`, which passes --experimental-test-module-mocks and
 * the @/ alias hooks. Skips itself, loudly, under a bare `node --test`.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../test/fake-postgrest";

configureFakeEnvironment("");

const db = new FakePostgrest();
const realFetch = globalThis.fetch;
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

type Route = {
  POST: (request: Request, context: { params: Promise<{ threadId: string }> }) => Promise<Response>;
};

let route: Route | null = null;
if (canMock) {
  // The one mock: a signed-in person, through the client every write uses.
  const admin = await import("@/lib/supabase/admin");
  mock.module("@/lib/supabase/server", {
    namedExports: {
      createServerSupabase: async () => {
        const client = admin.createAdminSupabase();
        return new Proxy(client, {
          get(target, prop, receiver) {
            if (prop !== "auth") return Reflect.get(target, prop, receiver);
            return { getUser: async () => ({ data: { user: { id: null, email: "tester@example.com" } }, error: null }) };
          },
        });
      },
    },
  });
  route = (await import("@/app/api/threads/[threadId]/reply/route")) as Route;
}

const WORKSPACE = "11111111-1111-4111-8111-111111111111";

/** A thread with one inbound message, a pending draft and a composer auto-save. */
function seedThread(provider: "emailbison" | "instantly") {
  db.reset();
  db.seed("workspaces", [{ id: WORKSPACE, created_at: "2026-01-01T00:00:00.000Z" }]);
  const [lead] = db.seed("leads", [{ workspace_id: WORKSPACE, email: "jane@example.com", full_name: "Jane Doe" }]);
  const [channel] = db.seed("channels", [
    {
      workspace_id: WORKSPACE,
      provider,
      display_name: "nicole@brokerstaffer.com",
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
      subject: "Quick question about your team",
      outbound_sender_email: "nicole@brokerstaffer.com",
      source_provider: provider,
      instantly_thread_id: provider === "instantly" ? "it-1" : null,
      needs_reply: true,
      seen: false,
      last_message_at: "2026-09-15T14:03:00.000Z",
      last_message_preview: "Sure, let's talk.",
    },
  ]);
  const [inbound] = db.seed("messages", [
    {
      workspace_id: WORKSPACE,
      thread_id: thread.id,
      direction: "inbound",
      sender: "jane@example.com",
      subject: "Re: Quick question about your team",
      body_text: "Sure, let's talk. What does the role involve and when could we speak?",
      body_html: null,
      sent_at: "2026-09-15T14:03:00.000Z",
      emailbison_reply_id: provider === "emailbison" ? "5551" : null,
      instantly_email_id: provider === "instantly" ? "in-email-5551" : null,
      raw_payload: provider === "emailbison" ? { data: { sender_email: { id: 42 } } } : {},
    },
  ]);
  const [draft] = db.seed("reply_drafts", [
    {
      workspace_id: WORKSPACE,
      thread_id: thread.id,
      agent_id: null,
      status: "pending",
      generated_body: DRAFT_TEXT,
      created_at: "2026-09-15T14:04:00.000Z",
    },
  ]);
  db.seed("composer_drafts", [{ workspace_id: WORKSPACE, thread_id: thread.id, body_text: "typing…" }]);
  return { lead, channel, thread, inbound, draft };
}

const DRAFT_TEXT =
  "Hi Jane,\n\nThanks for getting back to me. The role is a full-time listing coordinator " +
  "supporting two top producers.\n\nWould Thursday at 2pm work for a quick call?\n\nBest,\nNicole";

/** What the composer sends for that draft: its plainTextToHtml, verbatim. */
function composerHtml(s: string): string {
  const esc = (t: string) =>
    t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  return s
    .split(/\n{2,}/)
    .map((para) => `<p>${esc(para).replace(/\n/g, "<br>") || "<br>"}</p>`)
    .join("");
}

async function post(threadId: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await route!.POST(
    new Request(`http://inbox.test/api/threads/${threadId}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ threadId }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/* ========================================================================== */
/* EmailBison                                                                  */
/* ========================================================================== */

test("emailbison: the composer's request goes out as /replies/{id}/reply and every row is written", { skip }, async () => {
  const { thread, draft } = seedThread("emailbison");
  const html = composerHtml(DRAFT_TEXT);

  const { status, json } = await post(thread.id, {
    body: html,
    content_type: "html",
    subject: "Re: Quick question about your team",
    subject_changed: false,
    to: [{ email_address: "jane@example.com", name: "Jane Doe" }],
    cc: [{ email_address: "nicole@brokerstaffer.com" }],
  });
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true });

  // ---- the provider request, exactly ----
  assert.deepEqual(
    db.providerCalls.map((c) => `${c.method} ${c.path}`),
    ["POST /api/workspaces/v1.1/switch-workspace", "POST /api/replies/5551/reply"],
  );
  assert.deepEqual(db.providerCalls[0].body, { team_id: 7 });
  assert.deepEqual(db.providerCalls[1].body, {
    message: html,
    content_type: "html",
    to_emails: [{ email_address: "jane@example.com", name: "Jane Doe" }],
    cc_emails: [{ email_address: "nicole@brokerstaffer.com" }],
    reply_all: false,
    inject_previous_email_body: true,
    sender_email_id: 42,
  });
  assert.equal(db.providerCalls[1].headers.get("authorization"), "Bearer test-emailbison-key");

  // ---- the outbound row ----
  const outbound = db.rows("messages").find((m) => m.direction === "outbound")!;
  assert.ok(outbound, "an outbound messages row was written");
  assert.equal(outbound.thread_id, thread.id);
  assert.equal(outbound.workspace_id, WORKSPACE);
  assert.equal(outbound.sender, "nicole@brokerstaffer.com");
  assert.equal(outbound.subject, "Re: Quick question about your team");
  assert.equal(outbound.body_html, html);
  assert.equal(outbound.body_text, html.replace(/<[^>]+>/g, ""));
  assert.equal(outbound.external_message_id, "eb:reply:987654");
  assert.equal(outbound.emailbison_reply_id, "987654");
  assert.deepEqual(outbound.recipients, { to: ["jane@example.com"], cc: ["nicole@brokerstaffer.com"], bcc: [] });

  // ---- the thread ----
  const t = db.rows("threads")[0];
  assert.equal(t.needs_reply, false);
  assert.equal(t.seen, true);
  assert.equal(t.last_message_at, outbound.sent_at);
  assert.equal(t.last_message_preview, (outbound.body_text as string).slice(0, 200));

  // ---- the learning loop: sent as written ----
  const fb = db.rows("os_reply_feedback");
  assert.equal(fb.length, 1);
  assert.equal(fb[0].draft_id, draft.id);
  assert.equal(fb[0].verdict, "as_written");

  // ---- the drafts, and the auto-save ----
  const d = db.rows("reply_drafts")[0];
  assert.equal(d.status, "sent");
  assert.ok(d.sent_at);
  assert.equal(db.rows("composer_drafts").length, 0, "the composer auto-save was deleted");
});

test("emailbison: a changed subject goes through /replies/new with the subject and the sender id", { skip }, async () => {
  const { thread } = seedThread("emailbison");
  const { status } = await post(thread.id, {
    body: "<p>New topic</p>",
    subject: "A different subject",
    subject_changed: true,
    to: [{ email_address: "jane@example.com" }],
  });
  assert.equal(status, 200);
  assert.deepEqual(
    db.providerCalls.map((c) => `${c.method} ${c.path}`),
    ["POST /api/workspaces/v1.1/switch-workspace", "POST /api/replies/new"],
  );
  assert.deepEqual(db.providerCalls[1].body, {
    subject: "A different subject",
    message: "<p>New topic</p>",
    sender_email_id: 42,
    content_type: "html",
    to_emails: [{ email_address: "jane@example.com" }],
  });
});

test("emailbison: a rewritten draft is graded and filed as a correction", { skip }, async () => {
  const { thread, inbound } = seedThread("emailbison");
  const rewritten =
    "<p>Hi Jane — happy to talk. The position is a listing coordinator role with a busy team " +
    "downtown; hours are flexible and the pay is strong. Could you do a call on Friday morning instead?</p>";
  const { status } = await post(thread.id, { body: rewritten, to: [{ email_address: "jane@example.com" }] });
  assert.equal(status, 200);
  assert.equal(db.rows("os_reply_feedback")[0].verdict, "rewritten");
  const ex = db.rows("os_reply_examples");
  assert.equal(ex.length, 1, "the rewrite was filed as a correction example");
  assert.equal(ex[0].source, "correction");
  assert.equal(ex[0].inbound_message_id, inbound.id);
});

test("emailbison: the route's own refusals are unchanged (no reply to hang off, provider error)", { skip }, async () => {
  const { thread } = seedThread("emailbison");
  db.rows("messages")[0].emailbison_reply_id = null;
  let r = await post(thread.id, { body: "<p>x</p>" });
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: "No inbound EmailBison reply found to reply to." });
  assert.equal(db.rows("messages").length, 1, "nothing written on refusal");

  seedThread("emailbison");
  const { thread: t2 } = seedThread("emailbison");
  db.nextProviderResponses.push({ status: 200, body: { data: { name: "team" } } }); // switch-workspace
  db.nextProviderResponses.push({ status: 422, body: { message: "The to_emails field is required." } });
  r = await post(t2.id, { body: "<p>x</p>", reply_all: true });
  assert.equal(r.status, 502);
  assert.equal(r.json.status, 422);
  assert.match(String(r.json.error), /422/);
  assert.match(String(r.json.detail), /to_emails field is required/);
  assert.equal(db.rows("messages").length, 1, "no outbound row after a provider rejection");
  assert.equal(db.rows("reply_drafts")[0].status, "pending", "the draft stays pending");
});

test("route: unknown thread is 404, bad input is 400, a bad sender channel is 400", { skip }, async () => {
  seedThread("emailbison");
  let r = await post("22222222-2222-4222-8222-222222222222", { body: "<p>x</p>" });
  assert.equal(r.status, 404);
  assert.deepEqual(r.json, { error: "Thread not found" });

  const { thread } = seedThread("emailbison");
  r = await post(thread.id, { body: "" });
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: "Reply body is required" });

  r = await post(thread.id, { body: "<p>x</p>", sender_channel_id: "33333333-3333-4333-8333-333333333333" });
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: "Selected sender channel not found in this workspace." });
  assert.equal(db.providerCalls.length, 0);
});

/* ========================================================================== */
/* Instantly                                                                   */
/* ========================================================================== */

test("instantly: the composer's request goes out as /emails/reply and every row is written", { skip }, async () => {
  const { thread, draft } = seedThread("instantly");
  const html = composerHtml(DRAFT_TEXT);

  const { status, json } = await post(thread.id, {
    body: html,
    content_type: "html",
    subject: "Re: Quick question about your team",
    subject_changed: false,
    to: [{ email_address: "jane@example.com", name: "Jane Doe" }],
    cc: [{ email_address: "nicole@brokerstaffer.com" }, { email_address: "team@client.example" }],
  });
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true });

  assert.deepEqual(
    db.providerCalls.map((c) => `${c.method} ${c.path}`),
    ["POST /emails/reply"],
  );
  assert.deepEqual(db.providerCalls[0].body, {
    reply_to_uuid: "in-email-5551",
    subject: "Re: Quick question about your team",
    body: { html },
    eaccount: "nicole@brokerstaffer.com",
    cc_address_email_list: "nicole@brokerstaffer.com,team@client.example",
    include_original_body: true,
  });
  assert.equal(db.providerCalls[0].headers.get("authorization"), "Bearer test-instantly-key");

  const outbound = db.rows("messages").find((m) => m.direction === "outbound")!;
  assert.equal(outbound.source_provider, "instantly");
  assert.equal(outbound.sender, "nicole@brokerstaffer.com");
  assert.equal(outbound.body_html, html);
  assert.equal(outbound.external_message_id, "in:email:instantly-email-uuid-1");
  assert.equal(outbound.instantly_email_id, "instantly-email-uuid-1");
  assert.deepEqual(outbound.recipients, {
    to: ["jane@example.com"],
    cc: ["nicole@brokerstaffer.com", "team@client.example"],
    bcc: [],
  });

  const t = db.rows("threads")[0];
  assert.equal(t.needs_reply, false);
  assert.equal(t.last_message_at, outbound.sent_at);

  assert.equal(db.rows("os_reply_feedback")[0].verdict, "as_written");
  assert.equal(db.rows("os_reply_feedback")[0].draft_id, draft.id);
  assert.equal(db.rows("reply_drafts")[0].status, "sent");
  assert.equal(db.rows("composer_drafts").length, 0);
});

test("instantly: a TO that is not the original sender is a forward through /emails/forward", { skip }, async () => {
  const { thread } = seedThread("instantly");
  const { status } = await post(thread.id, {
    body: "<p>FYI</p>",
    subject: "Fwd: Quick question about your team",
    to: [{ email_address: "colleague@brokerstaffer.com" }],
  });
  assert.equal(status, 200);
  assert.deepEqual(db.providerCalls.map((c) => c.path), ["/emails/forward"]);
  assert.deepEqual(db.providerCalls[0].body, {
    eaccount: "nicole@brokerstaffer.com",
    reply_to_uuid: "in-email-5551",
    to_address_email_list: "colleague@brokerstaffer.com",
    subject: "Fwd: Quick question about your team",
    body: { html: "<p>FYI</p>" },
    include_original_body: true,
  });
});

test("instantly: a text body goes out as text and the subject is passed exactly as given (this route's behaviour)", { skip }, async () => {
  const { thread } = seedThread("instantly");
  const { status } = await post(thread.id, { body: "Line one\nLine two\n\nPara two", content_type: "text", subject: "Re: x" });
  assert.equal(status, 200);
  // Unlike the OS's route, this one does not convert text to HTML or fall back
  // to the thread's subject — see lib/inbox/send-reply.ts. The agent never
  // takes this branch: it always sends the composer's HTML.
  assert.deepEqual(db.providerCalls[0].body, {
    reply_to_uuid: "in-email-5551",
    subject: "Re: x",
    body: { text: "Line one\nLine two\n\nPara two" },
    eaccount: "nicole@brokerstaffer.com",
    include_original_body: true,
  });
  const outbound = db.rows("messages").find((m) => m.direction === "outbound")!;
  assert.equal(outbound.body_html, null);
  assert.equal(outbound.body_text, "Line one\nLine two\n\nPara two");
});

test("instantly: the route's own refusals are unchanged (no reply to hang off, provider error)", { skip }, async () => {
  const { thread } = seedThread("instantly");
  db.rows("messages")[0].instantly_email_id = null;
  let r = await post(thread.id, { body: "<p>x</p>" });
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: "No inbound Instantly reply found to reply to." });

  const { thread: t2 } = seedThread("instantly");
  db.nextProviderResponses.push({ status: 400, body: { error: "body must have required property 'subject'" } });
  r = await post(t2.id, { body: "<p>x</p>" });
  assert.equal(r.status, 502);
  assert.equal(r.json.status, 400);
  assert.match(String(r.json.detail), /required property/);
  assert.equal(db.rows("messages").length, 1);
  assert.equal(db.rows("reply_drafts")[0].status, "pending");
});

test("nothing left the process: no request reached any host but the fakes", { skip }, async () => {
  assert.deepEqual(db.blocked, []);
  assert.ok(db.providerCalls.every((c) => c.url.startsWith("http://emailbison.test/") || c.url.startsWith("http://instantly.test/")));
  globalThis.fetch = realFetch;
});
