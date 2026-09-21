/*
 * The handover-as-introduction, run against the real database.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT PROVES
 *
 *   1. THE ENGINE RESOLVES THE CLIENT. For a real thread whose client has
 *      introduction details, `assembleRunInput` — the exact read the engine
 *      makes before it drafts — finds the roster record, its contacts and the
 *      lead's values, and `planHandover` turns them into the body the
 *      Introduce button would insert and the CC list it would copy.
 *
 *   2. NO DETAILS, NO INVENTION. For a real thread whose client has none, the
 *      same path produces a stop with `no_introduction_details`, not a body.
 *
 *   3. THE WHOLE ENGINE, DRY. A throwaway agent — active, shadow, assigned to
 *      that client, restricted to a channel id that does not exist so no real
 *      inbound can ever select it — plus a throwaway state row one answer
 *      short of qualifying, and `runReplyAgentOnInbound({ dryRun: true })` on
 *      the real thread. It must report `would_draft` / `handover` with the CC
 *      list, or `would_stop` for the client with no details. No model call,
 *      no draft row, no state write.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT NEVER DOES
 *
 * No email. No model call. No write to threads, messages, clients, labels,
 * label_assignments, reply_drafts, os_clients or anything portal-related. The
 * only rows it creates are the throwaway agent and its state row, deleted on
 * every exit path.
 *
 *   node --import ./scripts/alias-hooks.mjs scripts/reply-agent-handover-test.mjs
 */

import fs from "node:fs";

/* ---- env: loaded into process.env so the app's own Supabase client works. Never printed. */
const raw = fs.readFileSync(".env.local", "utf8");
for (const line of raw.split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) {
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WS = process.env.WORKSPACE_ID;
if (!SB || !SK || !WS) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / _SERVICE_ROLE_KEY / _WORKSPACE_ID missing from .env.local");
  process.exit(2);
}

const THROWAWAY = "ZZZ-throwaway-handover-test";
const FAKE_CHANNEL = "00000000-0000-4000-8000-00000000c0de";

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
const mask = (email) => email.replace(/^(.).*?(@.*)$/, "$1…$2");

const { assembleRunInput, runReplyAgentOnInbound } = await import(
  "../lib/ai/runtime.ts"
);
const { planHandover } = await import("../lib/ai/qualification");
const { parseHandover } = await import("../lib/ai/agent-config");
const { renderIntroMacroTemplate, introContactEmails } = await import(
  "../lib/inbox/intro-macro.ts"
);
const { substituteVariables } = await import(
  "../lib/inbox/template-variables.ts"
);
const { liveSendingEnabled, LIVE_SEND_ENV_VAR } = await import(
  "../lib/ai/live-gate.ts"
);
const { LIVE_TRANSPORT_WIRED } = await import("../lib/ai/send-transport");

console.log(`\nREPLY AGENT — HANDOVER IS THE INTRODUCTION\n${"=".repeat(74)}\n`);

/* ------------------------------------------------- 0. pick two real threads */
const roster =
  (await rest(
    "os_clients?select=mi_client_id,name,contact_name,contact_role,contact_email,contact2_email,contact3_email&mi_client_id=not.is.null",
  )).body ?? [];
check("the roster reads", Array.isArray(roster), `${roster.length} clients with a Master Inbox id`);

const withDetails = roster.filter((c) => c.contact_name?.trim() && c.contact_role?.trim());
const withoutDetails = roster.filter((c) => !(c.contact_name?.trim() && c.contact_role?.trim()));
console.log(`      ${withDetails.length} with introduction details, ${withoutDetails.length} without\n`);

async function latestThreadFor(clientIds) {
  if (clientIds.length === 0) return null;
  const list = clientIds.map((id) => `"${id}"`).join(",");
  const rows =
    (await rest(
      `threads?select=id,subject,client_id,channel_id,lead_id&workspace_id=eq.${WS}&client_id=in.(${list})&lead_id=not.is.null&order=last_message_at.desc&limit=1`,
    )).body ?? [];
  return rows[0] ?? null;
}

const threadWith = await latestThreadFor(withDetails.map((c) => c.mi_client_id));
const threadWithout = await latestThreadFor(withoutDetails.map((c) => c.mi_client_id));

const variablesFor = (input) => ({
  lead: {
    name: input.leadName,
    email: input.leadEmail,
    phone: input.leadPhone,
    company: input.leadCompany,
    title: input.leadTitle,
  },
  thread: { subject: input.subject },
  sender: { name: input.senderName, email: input.ourEmail },
});

const extras = parseHandover({
  cc_emails: ["extra@example.invalid"],
  message: "",
  mark_introduction: false,
});

/* -------------------------------------- 1. a client WITH introduction details */
console.log("1. A real thread whose client has introduction details\n");
let inputWith = null;
if (!threadWith) {
  skip("a thread for a client with details", "none found");
} else {
  const client = withDetails.find((c) => c.mi_client_id === threadWith.client_id);
  console.log(`      thread ${threadWith.id}\n      client ${client.name}`);
  inputWith = await assembleRunInput(WS, threadWith.id);
  check("assembleRunInput reads the thread", Boolean(inputWith), inputWith ? "ok" : "null");
  if (inputWith) {
    check(
      "the engine resolved the client's roster record",
      inputWith.introduction.client !== null,
      inputWith.introduction.unavailableReason ?? inputWith.introduction.client?.name,
    );
    check(
      "the resolved record is the roster's, contact and role intact",
      inputWith.introduction.client?.contactName === client.contact_name &&
        inputWith.introduction.client?.contactRole === client.contact_role,
      `${inputWith.introduction.client?.contactName}, ${inputWith.introduction.client?.contactRole}`,
    );
    console.log(
      `      lead: ${inputWith.leadName ?? "(no name)"} · phone ${inputWith.leadPhone ? "known" : "unknown"} · company ${inputWith.leadCompany ?? "unknown"} · sender ${inputWith.senderName ?? "(no display name)"}`,
    );

    const plan = planHandover(extras, {
      client: inputWith.introduction.client,
      unavailableReason: inputWith.introduction.unavailableReason,
      variables: variablesFor(inputWith),
    });
    check("the handover is an introduction, not a stop", plan.kind === "introduce", plan.kind);
    if (plan.kind === "introduce") {
      const expectedCc = [...introContactEmails(inputWith.introduction.client), "extra@example.invalid"];
      console.log(`      CC it WOULD use: ${plan.cc.map(mask).join(", ")}`);
      check(
        "the CC list is the client's contacts, then the extra address",
        JSON.stringify(plan.cc) === JSON.stringify(expectedCc),
        `${plan.cc.length} address(es)`,
      );
      check(
        "at least one address comes from the client record, not the agent",
        plan.cc.length >= 2,
        `${plan.cc.length - 1} from the client`,
      );
      const buttonWouldInsert = substituteVariables(
        renderIntroMacroTemplate(inputWith.introduction.client),
        variablesFor(inputWith),
      );
      check("the body is exactly what the Introduce button would insert", plan.body === buttonWouldInsert);
      check("no placeholder survives", !plan.body.includes("{{"));
      console.log(`      first lines:\n        ${plan.body.split("\n").slice(0, 3).join("\n        ")}`);
    }
  }
}
console.log("");

/* ------------------------------------- 2. a client WITHOUT introduction details */
console.log("2. A real thread whose client has no introduction details\n");
let inputWithout = null;
if (!threadWithout) {
  skip("a thread for a client without details", "every client on the roster has details");
} else {
  const client = withoutDetails.find((c) => c.mi_client_id === threadWithout.client_id);
  console.log(`      thread ${threadWithout.id}\n      client ${client.name}`);
  inputWithout = await assembleRunInput(WS, threadWithout.id);
  check("assembleRunInput reads the thread", Boolean(inputWithout));
  if (inputWithout) {
    const plan = planHandover(extras, {
      client: inputWithout.introduction.client,
      unavailableReason: inputWithout.introduction.unavailableReason,
      variables: variablesFor(inputWithout),
    });
    check("the handover is a stop, not a body", plan.kind === "stop", plan.kind);
    check(
      "the stop reason says why",
      plan.kind === "stop" && plan.reason === "no_introduction_details",
      plan.kind === "stop" ? `${plan.reason} — ${plan.detail}` : "",
    );
    check("nothing was invented", !("body" in plan));
  }
}
console.log("");

/* ------------------------- 3. the whole engine, dry, on a throwaway agent */
console.log("3. The engine end to end, dry run, with a throwaway agent\n");

const cols = await rest("reply_agents?select=id,run_mode,client_ids,channel_ids,qualification&limit=1");
const HAS_0009 = cols.ok;
const stateTable = await rest("agent_thread_state?select=id&limit=1");
const HAS_STATE = stateTable.ok;

let throwawayId = null;
try {
  if (!HAS_0009 || !HAS_STATE) {
    skip("the dry run", "migration 0009 has not been run");
  } else {
    for (const [label, input, expect] of [
      ["with details", inputWith, "would_draft"],
      ["without details", inputWithout, "would_stop"],
    ]) {
      if (!input) {
        skip(`dry run ${label}`, "no thread");
        continue;
      }
      /*
       * A real agent already assigned to this client would be older, and
       * therefore chosen over the throwaway. That is the selection rule
       * working, not a failure — but it means this run cannot be isolated.
       */
      const assigned =
        (await rest(
          `reply_agents?select=id,name&workspace_id=eq.${WS}&active=is.true&client_ids=cs.{${input.clientId}}`,
        )).body ?? [];
      if (assigned.length > 0) {
        skip(`dry run ${label}`, `client already has an assigned agent (${assigned[0].name})`);
        continue;
      }

      const ins = await rest("reply_agents", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          workspace_id: WS,
          name: THROWAWAY,
          active: true,
          run_mode: "shadow",
          client_ids: [input.clientId],
          // A channel that does not exist: no real inbound can select this agent.
          channel_ids: [FAKE_CHANNEL],
          channel_filter: "both",
          qualification: {
            enabled: true,
            questions: [{ id: "q1", text: "Are you licensed?" }],
            required: 0,
            pass_rule: "all_answered",
          },
          handover: { cc_emails: ["extra@example.invalid"], message: "", mark_introduction: false },
        }),
      });
      const created = Array.isArray(ins.body) ? ins.body[0] : ins.body;
      throwawayId = created?.id ?? null;
      check(`a throwaway agent exists (${label})`, Boolean(throwawayId), ins.ok ? "created" : JSON.stringify(ins.body).slice(0, 160));
      if (!throwawayId) continue;

      // One question asked, none answered: the next inbound answers it and qualifies.
      const st = await rest("agent_thread_state", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          workspace_id: WS,
          thread_id: input.threadId,
          agent_id: throwawayId,
          status: "qualifying",
          step: 1,
          answers: [],
        }),
      });
      check(`a throwaway state row exists (${label})`, st.ok, st.ok ? "step 1, awaiting the answer" : JSON.stringify(st.body).slice(0, 160));

      const outcome = await runReplyAgentOnInbound({
        ...input,
        channelId: FAKE_CHANNEL,
        inboundText: input.inboundText || "yes, licensed since 2019",
        dryRun: true,
      });
      console.log(`      → ${outcome.status}${outcome.intent ? ` / ${outcome.intent}` : ""}${outcome.reason ? ` / ${outcome.reason}` : ""}`);
      check(`the throwaway agent was the one selected (${label})`, outcome.agentId === throwawayId, outcome.agentName ?? outcome.status);
      check(`dry run ${label} reports ${expect}`, outcome.status === expect, outcome.status);
      if (outcome.status === "would_draft") {
        check("the intent is the handover", outcome.intent === "handover", outcome.intent);
        check("the handover carries its CC list", Array.isArray(outcome.handover?.cc) && outcome.handover.cc.length >= 2, `${outcome.handover?.cc?.length ?? 0} address(es)`);
        console.log(`      CC it WOULD use: ${(outcome.handover?.cc ?? []).map(mask).join(", ")}`);
        check("it is the macro, not an override", outcome.handover?.source === "macro");
        check("no prompt guidance — the introduction is fixed, not model-written", outcome.guidance === null);
      }
      if (outcome.status === "would_stop") {
        check("the stop reason is no_introduction_details", outcome.reason === "no_introduction_details", outcome.detail);
      }

      // Nothing was written by the dry run.
      const drafts = (await rest(`reply_drafts?select=id&agent_id=eq.${throwawayId}`)).body ?? [];
      check(`the dry run wrote no draft (${label})`, drafts.length === 0, `${drafts.length} drafts`);
      const state = (await rest(`agent_thread_state?select=status,step,stop_reason&agent_id=eq.${throwawayId}`)).body ?? [];
      check(`the dry run moved no state (${label})`, state.length === 1 && state[0].status === "qualifying" && state[0].step === 1 && state[0].stop_reason === null, JSON.stringify(state[0] ?? null));

      await rest(`agent_thread_state?agent_id=eq.${throwawayId}`, { method: "DELETE" });
      await rest(`reply_agents?id=eq.${throwawayId}`, { method: "DELETE" });
      throwawayId = null;
    }
  }
} finally {
  if (throwawayId) {
    await rest(`agent_thread_state?agent_id=eq.${throwawayId}`, { method: "DELETE" });
    await rest(`reply_agents?id=eq.${throwawayId}`, { method: "DELETE" });
  }
  await rest(`reply_agents?name=like.${encodeURIComponent(THROWAWAY)}*`, { method: "DELETE" });
  const left = (await rest(`reply_agents?select=id&name=like.${encodeURIComponent(THROWAWAY)}*`)).body ?? [];
  check("no throwaway rows are left behind", left.length === 0, `${left.length} remaining`);
}
console.log("");

/* ------------------------------------------------------- 4. live is locked */
console.log("4. Live sending is still locked\n");
check(`${LIVE_SEND_ENV_VAR} is not set in this environment`, !liveSendingEnabled(), "gate closed");
check("the provider transport is not wired", LIVE_TRANSPORT_WIRED === false, "LIVE_TRANSPORT_WIRED=false");

console.log(`\n${"=".repeat(74)}\n  ${passed} passed · ${failed} failed · ${skipped} skipped`);
if (fails.length > 0) console.log(`  failed: ${fails.join(", ")}`);
console.log("");
process.exit(failed > 0 ? 1 : 0);
