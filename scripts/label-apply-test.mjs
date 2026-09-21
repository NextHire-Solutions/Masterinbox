/*
 * Applying a label through ONE guarded path — the route and the reply agent.
 *
 * The labels route's core is now `applyLabelToThread` (lib/inbox/apply-label.ts),
 * and the reply agent's live handover labels its own introduction through it
 * (lib/ai/live.ts). Three things are worth proving with real rows rather than
 * asserting:
 *
 *   1. THE ROUTE STILL BEHAVES: 200, exactly one assignment by the signed-in
 *      user, and a repeat call is still 200 with still one assignment.
 *   2. THE AGENT ACTOR: writes assigned_by='system' with no user, registers
 *      exactly the three announcements once, and honours the already-carries
 *      guard — proven with a recording `defer`, then again with no `defer`
 *      (the agent's inline path), which must not throw.
 *   3. THE POST-SEND HOOK (lib/ai/live.ts): resolves the label and applies it;
 *      a workspace with no Introduction label is recorded on the thread state,
 *      not thrown.
 *
 * This app has no outbox, so a repeat route call's silence cannot be observed
 * from outside the process; the guard that decides it is the same line the
 * function test exercises with the recording `defer`.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT NEVER DOES
 *
 * Nothing real is labelled and nobody is told anything. Every thread here is a
 * throwaway with no client, no lead and no messages: the 0023 trigger opens no
 * pipeline entry for a client-less thread, and every notifier (n8n, Slack,
 * Follow Up Boss) loads pipeline entries by thread and returns when there are
 * none. No email, no model call. Every row this creates is deleted on every
 * exit path.
 *
 *   BASE=http://localhost:3225 node --experimental-transform-types --import ./scripts/alias-hooks.mjs scripts/label-apply-test.mjs
 *
 * Without BASE the route section is skipped; the rest needs only .env.local.
 * The route section signs in as the first SUPER_ADMIN_EMAILS user the way
 * scripts/reply-agent-config-ui-test.mjs does (magic link → session cookies).
 */
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const raw = fs.readFileSync(".env.local", "utf8");
for (const line of raw.split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) {
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WS = process.env.WORKSPACE_ID;
const ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAILS || "").split(",")[0]?.trim().toLowerCase();
const BASE = process.env.BASE || null;
if (!SB || !SK || !WS) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / WORKSPACE_ID missing from .env.local");
  process.exit(2);
}

const THROWAWAY = "ZZZ-throwaway-label-apply-test";
const FAKE_CHANNEL = "00000000-0000-4000-8000-00000000c0de";
const NO_SUCH_WORKSPACE = "00000000-0000-4000-8000-0000000000ff";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rest = async (path, init = {}) => {
  const res = await fetch(`${SB}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SK,
      Authorization: `Bearer ${SK}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, ok: res.ok, body };
};

let passed = 0, failed = 0, skipped = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  —  " + detail : ""}`);
  if (ok) passed++; else { failed++; fails.push(name); }
};
const skip = (name, why) => { console.log(`  SKIP  ${name}  —  ${why}`); skipped++; };

const { applyLabelToThread } = await import("../lib/inbox/apply-label.ts");
const { createAdminSupabase } = await import("../lib/supabase/admin.ts");
const {
  markIntroduction,
  labelIntroductionAfterSend,
  recordIntroductionOutcome,
  INTRODUCTION_LABEL_MISSING,
} = await import("../lib/ai/live.ts");
const { liveSendingEnabled, LIVE_SEND_ENV_VAR } = await import("../lib/ai/live-gate.ts");
const { LIVE_TRANSPORT_WIRED, dispatch } = await import("../lib/ai/send-transport.ts");

console.log(`\nAPPLYING A LABEL — ONE GUARDED PATH${BASE ? `  →  ${BASE}` : ""}\n${"=".repeat(74)}\n`);

/* --------------------------------------------------------------- helpers */
const assignments = async (threadId) =>
  (await rest(`label_assignments?select=id,label_id,assigned_by,assigned_user_id&target_type=eq.thread&target_id=eq.${threadId}`)).body ?? [];
const threadState = async (threadId, agentId) =>
  ((await rest(`agent_thread_state?select=status,stop_reason,hold_reason&thread_id=eq.${threadId}&agent_id=eq.${agentId}`)).body ?? [])[0] ?? null;

const threads = [];
async function newThread(tag) {
  const ins = await rest("threads", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    // No client, no lead, no channel: nothing downstream has anything to act on.
    body: JSON.stringify({ workspace_id: WS, subject: `${THROWAWAY} ${tag}`, status: "archived", folder: "spam" }),
  });
  const id = (Array.isArray(ins.body) ? ins.body[0] : ins.body)?.id ?? null;
  if (id) threads.push(id);
  return id;
}

const intro = ((await rest(`labels?select=id,name&workspace_id=eq.${WS}&name=ilike.introduction&limit=1`)).body ?? [])[0];
check("the workspace has an Introduction label", Boolean(intro?.id), intro?.name ?? "missing");
if (!intro?.id) { console.log("\n  nothing to test without it\n"); process.exit(1); }
const LABEL = intro.id;

let agentId = null;
try {
  /* -------------------------------------------------- 1. the route, as a user */
  console.log("\n1. The route, signed in as a person\n");
  if (!BASE) {
    skip("the route", "set BASE=http://localhost:<port> to a dev server running this tree");
  } else if (!ANON || !ADMIN_EMAIL) {
    skip("the route", "NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPER_ADMIN_EMAILS missing — cannot mint a session");
  } else {
    const service = createClient(SB, SK, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: users } = await service.auth.admin.listUsers({ perPage: 500 });
    const adminUser = users?.users.find((u) => (u.email || "").toLowerCase() === ADMIN_EMAIL) ?? null;
    check("the super-admin is an existing auth user (never created here)", Boolean(adminUser), adminUser ? "found" : "missing");
    let cookie = null;
    if (adminUser) {
      const { data: link, error: linkErr } = await service.auth.admin.generateLink({ type: "magiclink", email: ADMIN_EMAIL });
      const anon = createClient(SB, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data: verified, error: otpErr } = linkErr
        ? { data: null, error: linkErr }
        : await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.properties.hashed_token });
      if (!otpErr && verified?.session) {
        const jar = [];
        const ssr = createServerClient(SB, ANON, {
          cookies: { getAll: () => jar, setAll: (cs) => { for (const c of cs) jar.push({ name: c.name, value: c.value }); } },
        });
        await ssr.auth.setSession({ access_token: verified.session.access_token, refresh_token: verified.session.refresh_token });
        cookie = jar.map((c) => `${c.name}=${c.value}`).join("; ");
      }
      check("a session was minted", Boolean(cookie), otpErr?.message ?? "cookies ready");
    }
    const call = (threadId, body) =>
      fetch(`${BASE}/api/threads/${threadId}/labels`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "manual",
      });

    const t = cookie ? await newThread("route") : null;
    check("a throwaway thread exists", Boolean(t), t ?? (cookie ? "insert failed" : "no session"));
    if (t) {
      const bad = await call(t, { label_id: "not-a-uuid" });
      check("invalid input is still a 400", bad.status === 400, `status ${bad.status} ${(await bad.text()).slice(0, 60)}`);

      const r1 = await call(t, { label_id: LABEL });
      const b1 = await r1.text();
      check("POST answers 200 { ok: true }", r1.status === 200 && b1 === '{"ok":true}', `${r1.status} ${b1.slice(0, 80)}`);
      await sleep(2500); // after() runs once the response has gone
      const a1 = await assignments(t);
      check("exactly one assignment, by the user", a1.length === 1 && a1[0].assigned_by === "user" && a1[0].label_id === LABEL, JSON.stringify(a1));
      check("assigned_user_id is the signed-in user", a1[0]?.assigned_user_id === adminUser.id, `${a1[0]?.assigned_user_id === adminUser.id}`);

      const r2 = await call(t, { label_id: LABEL });
      const b2 = await r2.text();
      check("a repeat POST still answers 200 { ok: true }", r2.status === 200 && b2 === '{"ok":true}', `${r2.status} ${b2.slice(0, 80)}`);
      await sleep(2500);
      check("still exactly one assignment", (await assignments(t)).length === 1, "1");
    }
  }

  /* ---------------------------------------- 2. the shared function, as the agent */
  console.log("\n2. The shared function with the agent actor (dry: no request, no session)\n");
  const admin = createAdminSupabase();
  const t2 = await newThread("agent");
  check("a throwaway thread exists", Boolean(t2), t2 ?? "insert failed");
  if (t2) {
    const AGENT = "00000000-0000-4000-8000-00000000a6e7";
    // A recording `defer`: the route would hand these to after(); here they are
    // counted and NOT run, so the announcement decision is observable.
    const recorded = [];
    const first = await applyLabelToThread({
      supabase: admin, workspaceId: WS, threadId: t2, labelId: LABEL,
      actor: { kind: "agent", agentId: AGENT }, defer: (task) => recorded.push(task),
    });
    check("it applies", first.ok === true, JSON.stringify(first));
    check("it recognised the label as Introduction and announced it", first.ok && first.isIntroduction && first.announced && !first.alreadyCarriedThisLabel, JSON.stringify(first));
    // Four, not three: the notes-restore task is registered for every
    // Introduction apply (the snapshot is an empty object, never null), exactly
    // as the route always has. The three announcements are the difference
    // between this and the repeat call below.
    check("the three announcements plus the notes restore were registered", recorded.length === 4, `${recorded.length} deferred task(s)`);
    const a = await assignments(t2);
    check("one assignment, assigned_by='system', no user", a.length === 1 && a[0].assigned_by === "system" && a[0].assigned_user_id === null, JSON.stringify(a));

    const recordedAgain = [];
    const again = await applyLabelToThread({
      supabase: admin, workspaceId: WS, threadId: t2, labelId: LABEL,
      actor: { kind: "agent", agentId: AGENT }, defer: (task) => recordedAgain.push(task),
    });
    check("a repeat call succeeds silently", again.ok === true && again.alreadyCarriedThisLabel === true && again.announced === false, JSON.stringify(again));
    check("no second announcement — only the notes restore is registered again", recordedAgain.length === 1 && recorded.length - recordedAgain.length === 3, `${recordedAgain.length} deferred task(s)`);
    check("still one assignment", (await assignments(t2)).length === 1, "1");

    // The agent's real path: no `defer`, side effects inline. Must not throw.
    const t2b = await newThread("agent-inline");
    let threw = null;
    let inline = null;
    try {
      inline = await applyLabelToThread({ supabase: admin, workspaceId: WS, threadId: t2b, labelId: LABEL, actor: { kind: "agent", agentId: AGENT } });
    } catch (e) { threw = e; }
    check("with no defer the three notifiers run inline and nothing throws", threw === null && inline?.ok === true && inline.announced === true, threw ? String(threw) : JSON.stringify(inline));
    check("and the row is written", (await assignments(t2b)).length === 1, "1");

    // A user re-applying over the agent's label: the row becomes theirs, still one.
    const user = await applyLabelToThread({ supabase: admin, workspaceId: WS, threadId: t2, labelId: LABEL, actor: { kind: "user", userId: null }, defer: () => {} });
    const au = await assignments(t2);
    check("a person re-applying takes the row over without announcing", user.ok && !user.announced && au.length === 1 && au[0].assigned_by === "user", JSON.stringify(au));
  }

  /* --------------------------------------------- 3. the post-send hook, lib/ai/live.ts */
  console.log("\n3. lib/ai/live.ts — the post-send hook\n");
  const src = fs.readFileSync("lib/ai/live.ts", "utf8");
  const sentBranch = src.slice(src.indexOf('if (result.status === "sent")'), src.indexOf("// gated / not_wired"));
  check("the sent branch labels every handover — no switch, no config read", sentBranch.includes("if (input.isHandover) {") && sentBranch.includes("labelIntroductionAfterSend(") && !sentBranch.includes("markIntroduction"), "attemptLiveSend");
  check("the hook is unreachable today: the transport is not wired and the gate is closed", !liveSendingEnabled() && LIVE_TRANSPORT_WIRED === false, `${LIVE_SEND_ENV_VAR} unset, LIVE_TRANSPORT_WIRED=false`);
  const d = await dispatch({ workspaceId: WS, threadId: "x", agentId: "x", draftId: "x", to: ["nobody@example.invalid"], cc: [], subject: null, body: "x", isHandover: true });
  check("dispatch() sends nothing", d.status === "gated", d.status);

  const ins = await rest("reply_agents", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      workspace_id: WS, name: THROWAWAY, active: false, run_mode: "pause",
      client_ids: [], channel_ids: [FAKE_CHANNEL], channel_filter: "both",
      qualification: { enabled: false, questions: [], required: 0, pass_rule: "all_answered" },
      handover: { cc_emails: [], message: "" },
    }),
  });
  agentId = (Array.isArray(ins.body) ? ins.body[0] : ins.body)?.id ?? null;
  check("a throwaway agent exists (pause, inactive, on a channel that does not exist)", Boolean(agentId), ins.ok ? "created" : JSON.stringify(ins.body).slice(0, 160));

  const t3 = await newThread("live");
  if (agentId && t3) {
    const m1 = await markIntroduction(WS, t3, agentId);
    check("markIntroduction resolves the workspace's label and applies it", m1.status === "applied" && m1.labelId === LABEL, JSON.stringify(m1));
    const a3 = await assignments(t3);
    check("the row is the agent's: assigned_by='system'", a3.length === 1 && a3[0].assigned_by === "system", JSON.stringify(a3));
    const m2 = await markIntroduction(WS, t3, agentId);
    check("a second call is already_introduced", m2.status === "already_introduced", JSON.stringify(m2));

    const none = await markIntroduction(NO_SUCH_WORKSPACE, t3, agentId);
    check("a workspace with no Introduction label → no_label, nothing thrown, nothing invented", none.status === "no_label", JSON.stringify(none));
    const labelsNow = (await rest(`labels?select=id&workspace_id=eq.${NO_SUCH_WORKSPACE}`)).body ?? [];
    check("no label was created for it", labelsNow.length === 0, `${labelsNow.length}`);

    // The hook end to end on a fresh thread: applied, and nothing recorded.
    const t4 = await newThread("hook");
    const h = await labelIntroductionAfterSend({ workspaceId: WS, threadId: t4, agentId });
    check("labelIntroductionAfterSend applies the label", h.status === "applied", JSON.stringify(h));
    check("a success leaves no stop_reason behind", (await threadState(t4, agentId)) === null, "no state row written");

    // The record, when the label could not be applied.
    await recordIntroductionOutcome({ workspaceId: WS, threadId: t3, agentId }, { status: "no_label" });
    const st = await threadState(t3, agentId);
    check("a missing label is recorded on the thread state as stop_reason", st?.stop_reason === INTRODUCTION_LABEL_MISSING, JSON.stringify(st));
    check("and NOT as hold_reason — the release job must not re-send", st?.hold_reason === null, String(st?.hold_reason));
    await recordIntroductionOutcome({ workspaceId: WS, threadId: t3, agentId }, { status: "failed", labelId: LABEL, error: "boom" });
    const st2 = await threadState(t3, agentId);
    check("a failed write is recorded with its error", st2?.stop_reason === "introduction_label_failed: boom", String(st2?.stop_reason));
  } else {
    skip("the hook", "no throwaway agent or thread");
  }
} catch (e) {
  check("the run completed", false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  console.log("\n  cleaning up…");
  for (const id of threads) {
    await rest(`agent_thread_state?thread_id=eq.${id}`, { method: "DELETE" });
    await rest(`label_assignments?target_type=eq.thread&target_id=eq.${id}`, { method: "DELETE" });
    await rest(`thread_reply_label_touch?thread_id=eq.${id}`, { method: "DELETE" });
    await rest(`deleted_reply_label_tombstone?thread_id=eq.${id}`, { method: "DELETE" });
    await rest(`threads?id=eq.${id}`, { method: "DELETE" });
  }
  if (agentId) {
    await rest(`agent_thread_state?agent_id=eq.${agentId}`, { method: "DELETE" });
    await rest(`reply_agents?id=eq.${agentId}`, { method: "DELETE" });
  }
  await rest(`reply_agents?name=eq.${encodeURIComponent(THROWAWAY)}`, { method: "DELETE" });
  await rest(`threads?subject=like.${encodeURIComponent(THROWAWAY)}*`, { method: "DELETE" });
  const leftT = (await rest(`threads?select=id&subject=like.${encodeURIComponent(THROWAWAY)}*`)).body ?? [];
  const leftA = (await rest(`reply_agents?select=id&name=eq.${encodeURIComponent(THROWAWAY)}`)).body ?? [];
  check("no throwaway rows are left behind", leftT.length === 0 && leftA.length === 0, `${leftT.length} threads, ${leftA.length} agents`);
}

console.log(`\n${"=".repeat(74)}\n  ${passed} passed · ${failed} failed · ${skipped} skipped`);
if (fails.length > 0) console.log(`  failed: ${fails.join(", ")}`);
console.log("");
process.exit(failed > 0 ? 1 : 0);
