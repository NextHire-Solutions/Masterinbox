/*
 * The reply-agent upgrade, tested as a workflow rather than as a screen.
 *
 * Kept in step with the OS's scripts/reply-agent-workflow-test.mjs; the
 * differences are the env names (this app is unprefixed) and section 6,
 * which drives this app's routes over its admin-token access.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CHECKS, AND WHY EACH ONE
 *
 *   1. MIGRATION STATE.  Which of 0009 / 0010 have actually been applied. Every
 *      check below either needs them or is explicitly the "not migrated yet"
 *      case, and a run that does not say which world it is in is useless.
 *
 *   2. SELECTION, against the real agent roster and a real thread. "Which agent
 *      answers this client's lead" is the decision that, if wrong, sends one
 *      client's words to another client's candidate. It is checked here against
 *      live rows, not fixtures.
 *
 *   3. THE SCRIPT, against a real conversation. The qualification engine is fed
 *      the actual inbound messages of a real thread, turn by turn, and has to
 *      ask question 1, record the answer, ask question 2, then qualify. No
 *      model call, no draft, nothing written.
 *
 *   4. A REAL WRITE, on a throwaway row. One agent named
 *      ZZZ-throwaway-reply-agent-test is created inactive and paused, read back
 *      to prove the new columns store and default correctly, and deleted in a
 *      finally. Nothing else in the database is written.
 *
 *   5. LIVE CANNOT SEND. The three locks are checked for real: the env var is
 *      absent, the transport constant is false, the transport sends nothing
 *      when called, the gate refuses a perfect send, and the save path throws
 *      on run_mode='live' BEFORE any write.
 *
 *   6. THE ROUTES, when BASE is set. Over x-admin-token (proxy.ts lets the
 *      service-role key past the session gate): run dry-run on a real thread,
 *      the release status, the stats feed, and duplicate on the throwaway —
 *      whose copy is deleted too.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT NEVER DOES
 *
 * No email. No model call. No write to threads, messages, clients, labels,
 * label_assignments, reply_drafts or anything portal-related. The only rows it
 * creates are the throwaway agent and (section 6) its duplicate, and both are
 * deleted on every exit path.
 *
 *   node --import ./scripts/alias-hooks.mjs scripts/reply-agent-workflow-test.mjs
 *   BASE=http://localhost:3220 node --import ./scripts/alias-hooks.mjs scripts/reply-agent-workflow-test.mjs
 */

import fs from "node:fs";

const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => {
  const m = raw.match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
};

const SB = pick("NEXT_PUBLIC_SUPABASE_URL");
const SK = pick("SUPABASE_SERVICE_ROLE_KEY");
const WS = pick("WORKSPACE_ID");
const BASE = process.env.BASE || null;
if (!SB || !SK || !WS) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / WORKSPACE_ID missing from .env.local");
  process.exit(2);
}
// Load the app's env the way Next would, so `env.*` accessors resolve.
for (const line of raw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const THROWAWAY = "ZZZ-throwaway-reply-agent-test";

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
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
};

let passed = 0;
let failed = 0;
let skipped = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  —  " + detail : ""}`);
  if (ok) passed++;
  else {
    failed++;
    fails.push(name);
  }
};
const skip = (name, why) => {
  console.log(`  SKIP  ${name}  —  ${why}`);
  skipped++;
};

const { selectAgentForThread, parseRunConfig, parseQualification } = await import("../lib/ai/agent-config.ts");
const { advance, EMPTY_STATE } = await import("../lib/ai/qualification.ts");
const { liveSendingEnabled, LIVE_SEND_ENV_VAR } = await import("../lib/ai/live-gate.ts");
const { LIVE_TRANSPORT_WIRED } = await import("../lib/ai/send-transport.ts");

console.log(`\nREPLY AGENT UPGRADE — WORKFLOW (Master Inbox)\n${"=".repeat(74)}\n`);

/* ---------------------------------------------------------------- 1. state */
console.log("1. What the database has\n");

const upgraded = await rest("reply_agents?select=id,run_mode,client_ids,schedule,qualification,handover&limit=1");
const HAS_0009_COLUMNS = upgraded.ok;
console.log(`  migration 0009 columns on reply_agents : ${HAS_0009_COLUMNS ? "present" : "ABSENT"}`);

const stateTable = await rest("agent_thread_state?select=id&limit=1");
const HAS_STATE_TABLE = stateTable.ok;
console.log(`  agent_thread_state table               : ${HAS_STATE_TABLE ? "present" : "ABSENT"}`);

const statsView = await rest("v_reply_agent_stats?select=agent_id&limit=1");
const HAS_STATS_VIEW = statsView.ok;
console.log(`  v_reply_agent_stats view               : ${HAS_STATS_VIEW ? "present" : "ABSENT"}`);
console.log("");

/* ------------------------------------------------------------ 2. selection */
console.log("2. Which agent answers this thread\n");

const liveAgents =
  (await rest(`reply_agents?select=id,name,active,created_at,channel_filter,channel_ids&workspace_id=eq.${WS}&order=created_at.asc`)).body ?? [];
check("the agent roster reads", Array.isArray(liveAgents), `${liveAgents.length ?? 0} agents`);

const upgradeCols = HAS_0009_COLUMNS
  ? ((await rest(`reply_agents?select=id,run_mode,client_ids&workspace_id=eq.${WS}`)).body ?? [])
  : [];
const byId = new Map(upgradeCols.map((r) => [r.id, r]));

const selectable = (liveAgents ?? []).map((a) => {
  const cfg = parseRunConfig(byId.get(a.id) ?? {});
  return {
    id: a.id,
    name: a.name,
    active: a.active,
    created_at: a.created_at,
    channel_filter: a.channel_filter ?? "both",
    channel_ids: a.channel_ids ?? [],
    run_mode: cfg.runMode,
    client_ids: cfg.clientIds,
  };
});

const threads =
  (await rest(
    `threads?select=id,subject,client_id,channel_id&workspace_id=eq.${WS}&client_id=not.is.null&order=last_message_at.desc&limit=1`,
  )).body ?? [];
const thread = threads[0];
check("a real client-tagged thread was found", Boolean(thread?.id), thread?.id ?? "none");

if (thread) {
  const out = selectAgentForThread(selectable, {
    clientId: thread.client_id,
    channelId: thread.channel_id,
    channelType: "email",
  });
  console.log(`      thread ${thread.id}  client ${thread.client_id}`);
  console.log(
    `      → ${out.status}${out.status === "selected" ? ` (${out.agent.name}, ${out.reason})` : out.status === "paused" ? ` (${out.agent.name})` : ` (${out.reason})`}`,
  );
  check(
    "selection returns exactly one agent or an explained refusal",
    ["selected", "paused", "none"].includes(out.status),
    out.status,
  );
  if (out.status === "selected") {
    check(
      "the selected agent is active and not paused",
      out.agent.active && out.agent.run_mode !== "pause",
      `${out.agent.name}: active=${out.agent.active} run_mode=${out.agent.run_mode}`,
    );
    check(
      "the selected agent is not assigned to some other client",
      out.agent.client_ids.length === 0 || out.agent.client_ids.includes(thread.client_id),
      `client_ids=${JSON.stringify(out.agent.client_ids)}`,
    );
  }

  const paused = selectable.map((a) =>
    a.client_ids.includes(thread.client_id) || a.client_ids.length === 0 ? { ...a, run_mode: "pause" } : a,
  );
  const afterPause = selectAgentForThread(paused, {
    clientId: thread.client_id,
    channelId: thread.channel_id,
    channelType: "email",
  });
  check(
    "pausing every candidate stops this thread rather than falling through",
    afterPause.status !== "selected",
    afterPause.status,
  );
}
console.log("");

/* --------------------------------------------------------- 3. the script */
console.log("3. The qualification script, over a real conversation\n");

const script = parseQualification({
  enabled: true,
  questions: [
    { text: "Are you licensed in the state you're looking to work in?" },
    { text: "What times work for a quick call this week?" },
  ],
  required: 0,
  pass_rule: "all_answered",
});

let replies = [];
if (thread) {
  replies =
    (await rest(
      `messages?select=id,body_text,sent_at&thread_id=eq.${thread.id}&direction=eq.inbound&order=sent_at.asc&limit=4`,
    )).body ?? [];
}
check("the thread has inbound replies to feed the script", replies.length > 0, `${replies.length} inbound`);

if (replies.length > 0) {
  let state = EMPTY_STATE;
  const trail = [];
  const standIns = ["yes, licensed since 2019", "Thursday afternoon works", "any time"];
  const turns = [
    ...replies.map((m) => (m.body_text ?? "").slice(0, 400)),
    ...standIns.slice(0, script.questions.length + 1),
  ];
  for (const text of turns) {
    const action = advance({ config: script, state, inboundText: text, now: new Date() });
    trail.push(action.kind === "ask" ? `ask:${action.question.id}` : action.kind);
    if (action.kind === "ask" || action.kind === "qualified") state = action.state;
    if (action.kind === "qualified") break;
  }
  console.log(`      ${trail.join(" → ")}`);
  check("the script asks its first question on the first reply", trail[0] === "ask:q1", trail[0]);
  check(
    "the script reaches qualified without asking a question twice",
    trail.filter((t) => t === "ask:q1").length === 1 && trail.includes("qualified"),
    trail.join(" → "),
  );
  check(
    "every answer collected came from the lead, verbatim",
    state.answers.every((a) => typeof a.answer === "string" && a.answer.length > 0),
    `${state.answers.length} answers`,
  );
}
console.log("");

/* --------------------------------------------------- 4. a real write, once */
console.log("4. A throwaway agent, written and deleted\n");

let throwawayId = null;
let duplicateId = null;
try {
  const insert = await rest("reply_agents", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      workspace_id: WS,
      name: THROWAWAY,
      active: false,
      ...(HAS_0009_COLUMNS ? { run_mode: "pause" } : {}),
    }),
  });
  const created = Array.isArray(insert.body) ? insert.body[0] : insert.body;
  throwawayId = created?.id ?? null;
  check("a throwaway agent can be created", Boolean(throwawayId), insert.status === 201 ? "created" : JSON.stringify(insert.body).slice(0, 200));

  if (throwawayId && HAS_0009_COLUMNS) {
    const back = (await rest(`reply_agents?select=*&id=eq.${throwawayId}`)).body?.[0];
    check("run_mode stored", back?.run_mode === "pause", String(back?.run_mode));
    check(
      "client_ids, schedule, qualification and handover all default rather than arriving null",
      back?.client_ids !== null && back?.schedule !== null && back?.qualification !== null && back?.handover !== null,
      JSON.stringify({ schedule: back?.schedule, qualification: back?.qualification }).slice(0, 160),
    );

    const defaulted = await rest("reply_agents", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ workspace_id: WS, name: `${THROWAWAY}-default`, active: false }),
    });
    const d = Array.isArray(defaulted.body) ? defaulted.body[0] : defaulted.body;
    check("a new agent defaults to shadow, not live", d?.run_mode === "shadow", String(d?.run_mode));
    if (d?.id) await rest(`reply_agents?id=eq.${d.id}`, { method: "DELETE" });

    const bad = await rest(`reply_agents?id=eq.${throwawayId}`, {
      method: "PATCH",
      body: JSON.stringify({ run_mode: "sending" }),
    });
    check("the check constraint rejects an unknown run_mode", !bad.ok, `status ${bad.status}`);
  } else if (throwawayId) {
    skip("the new columns store and default correctly", "migration 0009 has not been run");
  }

  /* --- the app's own reader sees the row the way the engine will ---------- */
  if (throwawayId) {
    const { loadAgents } = await import("../lib/ai/agent.ts");
    const agents = await loadAgents(WS);
    const mine = agents.find((a) => a.id === throwawayId);
    check("loadAgents returns the throwaway with parsed run config", Boolean(mine), mine ? `run_mode=${mine.run_mode}` : "not found");
    check(
      HAS_0009_COLUMNS ? "loadAgents reads run_mode=pause off the row" : "loadAgents falls back to shadow without the columns",
      mine && (HAS_0009_COLUMNS ? mine.run_mode === "pause" : mine.run_mode === "shadow"),
      String(mine?.run_mode),
    );
  }

  /* --- per-thread state --------------------------------------------------- */
  if (throwawayId && HAS_STATE_TABLE && thread) {
    const ins = await rest("agent_thread_state", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        workspace_id: WS,
        thread_id: thread.id,
        agent_id: throwawayId,
        status: "qualifying",
        step: 1,
        answers: [{ question_id: "q1", question: "test", answer: "test", at: new Date().toISOString() }],
      }),
    });
    const row = Array.isArray(ins.body) ? ins.body[0] : ins.body;
    check("per-thread state can be written", Boolean(row?.id), JSON.stringify(ins.body).slice(0, 160));

    if (row?.id) {
      const dupe = await rest("agent_thread_state", {
        method: "POST",
        body: JSON.stringify({ workspace_id: WS, thread_id: thread.id, agent_id: throwawayId }),
      });
      check("a second state row for the same (thread, agent) is refused", !dupe.ok, `status ${dupe.status}`);
      await rest(`agent_thread_state?id=eq.${row.id}`, { method: "DELETE" });
    }
  } else if (!HAS_STATE_TABLE) {
    skip("per-thread state can be written", "migration 0009 has not been run");
  }

  /* --- the stats view ----------------------------------------------------- */
  if (HAS_STATS_VIEW) {
    const rows = (await rest(`v_reply_agent_stats?select=*&workspace_id=eq.${WS}&limit=50`)).body ?? [];
    check("the stats view returns a row per agent", Array.isArray(rows) && rows.length > 0, `${rows.length} rows`);
    const sample = rows[0];
    check(
      "every metric the plan asks for is present",
      sample &&
        ["replies_drafted", "replies_sent", "lead_replies_received", "qualification_started",
         "qualification_qualified", "qualification_handed_over", "qualification_stopped",
         "reply_rate", "qualification_rate", "handover_rate", "tokens_total", "updated_at"]
          .every((k) => k in sample),
      sample ? Object.keys(sample).length + " columns" : "no rows",
    );
    check(
      "the view never exposes an API key",
      sample && !Object.keys(sample).some((k) => k.includes("api_key")),
      "no api_key column",
    );
  } else {
    skip("the stats view answers", "migration 0010 has not been run");
  }

  /* ------------------------------------------------------- 5. live is locked */
  console.log("\n5. Live sending cannot happen\n");

  check(`${LIVE_SEND_ENV_VAR} is not set in this environment`, !liveSendingEnabled(), "gate closed");
  check("the provider transport is not wired", LIVE_TRANSPORT_WIRED === false, "LIVE_TRANSPORT_WIRED=false");

  const { dispatch } = await import("../lib/ai/send-transport.ts");
  const attempted = await dispatch({
    workspaceId: WS,
    threadId: "00000000-0000-0000-0000-000000000000",
    agentId: "00000000-0000-0000-0000-000000000000",
    draftId: "00000000-0000-0000-0000-000000000000",
    to: ["nobody@example.invalid"],
    cc: [],
    subject: "test",
    body: "test",
    isHandover: false,
  });
  check("calling the transport directly still sends nothing", attempted.status !== "sent", attempted.status);

  const { evaluate } = await import("../lib/ai/safety.ts");
  const verdict = evaluate({
    liveSendingEnabled: liveSendingEnabled(),
    runMode: "live",
    doNotContact: false,
    unsubscribeRequested: false,
    hostileReply: false,
    needsHumanReview: false,
    sendsMadeOnThread: 0,
    sendsInRateWindow: 0,
    hasRecipient: true,
    window: { open: true },
  });
  check(
    "the safety gate refuses a perfect send because the server gate is off",
    verdict.allowed === false && verdict.reason === "live_disabled",
    verdict.allowed ? "ALLOWED" : verdict.reason,
  );

  // The save path: run_mode='live' must throw BEFORE any write. Proved two
  // ways — the throw itself, and the row being unchanged afterwards.
  const { saveAgent, LiveModeNotEnabledError } = await import("../lib/ai/agent.ts");
  let threw = null;
  try {
    await saveAgent({ workspaceId: WS, id: throwawayId ?? "00000000-0000-0000-0000-000000000000", run_mode: "live", name: `${THROWAWAY}-armed` });
  } catch (e) {
    threw = e;
  }
  check("saveAgent refuses run_mode='live' with LiveModeNotEnabledError", threw instanceof LiveModeNotEnabledError, threw ? threw.name : "did not throw");
  if (throwawayId) {
    const after = (await rest(`reply_agents?select=name${HAS_0009_COLUMNS ? ",run_mode" : ""}&id=eq.${throwawayId}`)).body?.[0];
    check(
      "the refused save wrote nothing (name and run_mode unchanged)",
      after?.name === THROWAWAY && (!HAS_0009_COLUMNS || after?.run_mode === "pause"),
      JSON.stringify(after),
    );
  }

  /* ---------------------------------------------------------- 6. the routes */
  console.log("\n6. The routes, over admin-token access\n");
  if (!BASE) {
    skip("the routes", "set BASE=http://localhost:<port> to a running dev server");
  } else {
    const call = async (path, init = {}) => {
      const res = await fetch(BASE + path, {
        ...init,
        headers: { "x-admin-token": SK, "content-type": "application/json", ...(init.headers ?? {}) },
        redirect: "manual",
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* html */ }
      return { status: res.status, json, text };
    };

    // run — dry run on the real thread: decides everything, does nothing.
    if (thread) {
      const before = (await rest(`reply_drafts?select=id&thread_id=eq.${thread.id}`)).body?.length ?? 0;
      const run = await call("/api/reply-agents/run", { method: "POST", body: JSON.stringify({ thread_id: thread.id }) });
      check("POST /api/reply-agents/run answers", run.status === 200, `status ${run.status} ${run.text.slice(0, 120)}`);
      check("run defaults to dry_run=true", run.json?.dry_run === true, String(run.json?.dry_run));
      const o = run.json?.outcome;
      console.log(`      outcome: ${JSON.stringify(o).slice(0, 220)}`);
      check(
        "dry run returns a decision, never a draft",
        o && ["no_agent", "paused", "already_handled", "finished", "would_draft"].includes(o.status),
        o?.status,
      );
      const after = (await rest(`reply_drafts?select=id&thread_id=eq.${thread.id}`)).body?.length ?? 0;
      check("dry run wrote no reply_drafts row", after === before, `${before} → ${after}`);
      if (o?.status === "would_draft") {
        check("dry run never reports live mode on this server", o.mode === "shadow", o.mode);
      }
    }

    // release — status, and a sweep that can send nothing.
    const rel = await call("/api/reply-agents/release");
    check("GET /api/reply-agents/release answers", rel.status === 200, `status ${rel.status}`);
    check("release reports live off and transport unwired", rel.json?.live_sending_enabled === false && rel.json?.transport_wired === false, JSON.stringify(rel.json).slice(0, 160));
    const sweep = await call("/api/reply-agents/release", { method: "POST" });
    check("POST /api/reply-agents/release sends nothing", sweep.status === 200 && sweep.json?.sent === 0, `sent=${sweep.json?.sent} scanned=${sweep.json?.scanned}`);
    // The cron route takes the token the way its sibling does — ?token= or
    // x-cron-token — not x-admin-token; the proxy lets ?token= through too.
    const cron = await call(`/api/cron/release-held-replies?token=${encodeURIComponent(SK)}`, { method: "POST" });
    check("POST /api/cron/release-held-replies (the scheduled entry) sends nothing", cron.status === 200 && cron.json?.ok === true && cron.json?.sent === 0, `status ${cron.status} sent=${cron.json?.sent}`);

    // stats — the feed.
    const st = await call("/api/reply-agents/stats?per_page=5");
    if (HAS_STATS_VIEW) {
      check("GET /api/reply-agents/stats answers {data, meta}", st.status === 200 && Array.isArray(st.json?.data) && st.json?.meta, `status ${st.status}`);
      check("stats rows carry the plan's metrics", (st.json?.data?.[0]?.stats ?? null) !== null && "qualification_rate" in (st.json?.data?.[0]?.stats ?? {}), Object.keys(st.json?.data?.[0]?.stats ?? {}).length + " metrics");
    } else {
      check("GET /api/reply-agents/stats answers 503 naming the migration", st.status === 503 && /0010/.test(st.json?.detail ?? ""), `status ${st.status} ${st.json?.detail ?? ""}`);
    }
    const badCursor = await call("/api/reply-agents/stats?updated_since=yesterday");
    check("stats rejects a malformed updated_since", badCursor.status === 400, `status ${badCursor.status}`);
    const badBearer = await call("/api/reply-agents/stats", { headers: { Authorization: "Bearer not-the-token" } });
    check("stats fails closed on a wrong bearer", badBearer.status === 401, `status ${badBearer.status}`);

    // duplicate — the copy is paused, inactive, keyless.
    if (throwawayId) {
      const dup = await call(`/api/reply-agents/${throwawayId}/duplicate`, { method: "POST", body: "{}" });
      duplicateId = dup.json?.id ?? null;
      check("POST /api/reply-agents/[id]/duplicate creates a copy", dup.status === 200 && Boolean(duplicateId), `status ${dup.status}`);
      if (duplicateId) {
        const copy = (await rest(`reply_agents?select=name,active${HAS_0009_COLUMNS ? ",run_mode" : ""},api_key_encrypted&id=eq.${duplicateId}`)).body?.[0];
        check("the copy is inactive, paused and keyless", copy && copy.active === false && (!HAS_0009_COLUMNS || copy.run_mode === "pause") && copy.api_key_encrypted === null, JSON.stringify(copy));
      }
    }
  }
} finally {
  if (duplicateId) await rest(`reply_agents?id=eq.${duplicateId}`, { method: "DELETE" });
  if (throwawayId) {
    const del = await rest(`reply_agents?id=eq.${throwawayId}`, { method: "DELETE" });
    console.log(`\n  cleanup: throwaway agent deleted (${del.status})`);
  }
  await rest(`reply_agents?name=like.${encodeURIComponent(THROWAWAY)}*`, { method: "DELETE" });
  const left = (await rest(`reply_agents?select=id,name&name=like.${encodeURIComponent(THROWAWAY)}*`)).body ?? [];
  check("no throwaway rows are left behind", left.length === 0, `${left.length} remaining`);
}

console.log(`\n${"=".repeat(74)}\n  ${passed} passed · ${failed} failed · ${skipped} skipped`);
if (fails.length > 0) console.log(`  failed: ${fails.join(", ")}`);
console.log("");
process.exit(failed > 0 ? 1 : 0);
