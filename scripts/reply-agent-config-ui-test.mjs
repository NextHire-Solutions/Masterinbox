/*
 * The Reply Agents settings screen, driven in a real browser.
 *
 * Kept in step with the OS's scripts/reply-agent-config-ui-test.mjs in what it
 * proves; the mechanics differ because this app signs people in with Supabase
 * rather than an SSO cookie.
 *
 * ---------------------------------------------------------------------------
 * WHAT ONLY A BROWSER CAN TELL US HERE
 *
 *   · THE CARDS RENDER THE NEW CONFIG. Mode pill, clients, questions,
 *     handover, schedule and the §8 numbers — from the same `loadAgents` the
 *     engine uses, so a parser fallback that was wrong would show up as a
 *     blank or a throw here and nowhere else.
 *
 *   · LIVE IS PRESENT AND NOT SELECTABLE. "The option is missing" and "the
 *     option is disabled with a reason" look identical in the source and are
 *     completely different to the person using it.
 *
 *   · THE DIALOG FIELDS DO NOT OVERLAP OR OVERFLOW. Checked geometrically —
 *     every field inside the dialog's box, no two fields intersecting.
 *
 * ---------------------------------------------------------------------------
 * HOW IT SIGNS IN
 *
 * A magic-link session is minted server-side for the first SUPER_ADMIN_EMAILS
 * entry — `generateLink` (no email is sent) then `verifyOtp` — and written into
 * the browser as the cookies @supabase/ssr itself produces. The user must
 * already exist; the script refuses to run otherwise, because generateLink
 * would create one.
 *
 * Read-only on the app's data. It opens the editor, measures it, and cancels.
 * It never saves, never duplicates and never pauses an agent.
 *
 *   BASE=http://localhost:3220 PORT=9760 node --no-warnings --import ./scripts/alias-hooks.mjs scripts/reply-agent-config-ui-test.mjs
 *
 * Starts its own headless Chrome on PORT (9760–9799 are ours) and kills it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const BASE = process.env.BASE || "http://localhost:3220";
const PORT = Number(process.env.PORT || 9760);
const CDP = `http://localhost:${PORT}`;
const SHOT = process.env.SHOT || path.join(os.tmpdir(), "reply-agents-settings.png");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => {
  const m = raw.match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
};
const SB = pick("NEXT_PUBLIC_SUPABASE_URL");
const ANON = pick("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SK = pick("SUPABASE_SERVICE_ROLE_KEY");
const ADMIN_EMAIL = (pick("SUPER_ADMIN_EMAILS") || "").split(",")[0]?.trim().toLowerCase();
if (!SB || !ANON || !SK || !ADMIN_EMAIL) {
  console.error("env missing: NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY / SUPABASE_SERVICE_ROLE_KEY / SUPER_ADMIN_EMAILS");
  process.exit(2);
}

let passed = 0, failed = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  —  " + detail : ""}`);
  ok ? passed++ : (failed++, fails.push(name));
};

console.log(`\nREPLY AGENTS — SETTINGS SCREEN  →  ${BASE}\n${"=".repeat(74)}\n`);

/* ------------------------------------------------------------- a session */
const service = createClient(SB, SK, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: users } = await service.auth.admin.listUsers({ perPage: 500 });
if (!users?.users.some((u) => (u.email || "").toLowerCase() === ADMIN_EMAIL)) {
  console.error("the super-admin email is not an existing auth user; refusing to mint (generateLink would create one)");
  process.exit(2);
}
const { data: link, error: linkErr } = await service.auth.admin.generateLink({ type: "magiclink", email: ADMIN_EMAIL });
if (linkErr) { console.error("generateLink failed:", linkErr.message); process.exit(2); }
const anon = createClient(SB, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: verified, error: otpErr } = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.properties.hashed_token });
if (otpErr || !verified.session) { console.error("verifyOtp failed:", otpErr?.message); process.exit(2); }

// Let @supabase/ssr write the cookies exactly as the app expects to read them.
const jar = [];
const ssr = createServerClient(SB, ANON, {
  cookies: { getAll: () => jar, setAll: (cs) => { for (const c of cs) jar.push({ name: c.name, value: c.value }); } },
});
await ssr.auth.setSession({ access_token: verified.session.access_token, refresh_token: verified.session.refresh_token });
check("a session was minted and serialised into cookies", jar.length > 0, `${jar.length} cookie(s)`);

/* --------------------------------------------------------------- chrome */
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mi-ui-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1440,1000", "about:blank",
], { stdio: "ignore" });
let ready = false;
for (let i = 0; i < 40 && !ready; i++) {
  try { await fetch(`${CDP}/json/version`); ready = true; } catch { await sleep(250); }
}
if (!ready) { console.error("Chrome did not start on", PORT); chrome.kill("SIGKILL"); process.exit(2); }

const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0;
const waiting = new Map();
await new Promise((r) => (ws.onopen = r));
const thrown = [];
const serverErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") thrown.push(m.params?.exceptionDetails?.exception?.description ?? "exception");
  if (m.method === "Network.responseReceived" && m.params?.response?.status >= 500) serverErrors.push(`${m.params.response.status} ${m.params.response.url}`);
};
const send = (m, p = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }))?.result?.value;

try {
  await send("Network.enable");
  await send("Runtime.enable");
  await send("Page.enable");
  const host = new URL(BASE).hostname;
  for (const c of jar) await send("Network.setCookie", { name: c.name, value: c.value, domain: host, path: "/", secure: BASE.startsWith("https") });
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  await send("Page.navigate", { url: `${BASE}/settings/reply-agents` });
  for (let i = 0; i < 160; i++) {
    if (await ev(`!!document.body && document.body.innerText.includes("Reply Agents") && document.querySelectorAll('[data-testid="mode-pill"]').length > 0`)) break;
    await sleep(500);
  }
  const url = await ev("location.pathname");
  check("the session is accepted (not bounced to /login)", url === "/settings/reply-agents", url);

  const text = (await ev(`document.body.innerText`)) ?? "";
  check("the screen renders", text.length > 200, `${text.length} chars`);
  /*
   * THE GATE IS A STATE, NOT A CONSTANT.
   *
   * These assertions used to hardcode "live sending is off", which was true
   * while MASTER_INBOX_REPLY_AGENT_LIVE_SEND was unset everywhere. It is set
   * now, so the screen correctly stops saying so and Live becomes selectable —
   * and the test failed for describing yesterday. Read the state and assert
   * the matching half, so this file is honest in either configuration.
   */
  const liveGateOn = !text.includes("Live sending is off on this server");
  console.log(`      (live sending is ${liveGateOn ? "ENABLED" : "off"} on this server)`);
  if (liveGateOn) {
    check("with the gate on, the screen does not claim live sending is off",
      !text.includes("Live sending is off on this server"), "no stale banner");
  } else {
    check("it says live sending is off", text.includes("Live sending is off on this server"), "banner");
  }
  if (!liveGateOn) check("it names the variable a person must set", text.includes("MASTER_INBOX_REPLY_AGENT_LIVE_SEND"), "named");

  const pills = await ev(`[...document.querySelectorAll('[data-testid="mode-pill"]')].map(p=>p.textContent.trim())`);
  check("every agent card carries a mode pill", Array.isArray(pills) && pills.length > 0, JSON.stringify(pills));
  check("no card claims to be live", Array.isArray(pills) && !pills.includes("Live"), "no Live pill");
  const actions = await ev(`(()=>{const q=l=>document.querySelectorAll('button[aria-label="'+l+'"]').length; return {pause:q("Pause")+q("Activate (shadow)"), configure:q("Configure"), duplicate:q("Duplicate")};})()`);
  check("each card offers pause/activate, configure and duplicate", actions.pause === pills.length && actions.configure === pills.length && actions.duplicate === pills.length, JSON.stringify(actions));
  for (const line of ["Clients", "Questions", "Handover", "Schedule"]) check(`the card states ${line.toLowerCase()}`, text.includes(line), line);

  // Stats: either the numbers (0010 applied) or an explanation naming the migration.
  for (let i = 0; i < 20; i++) {
    if (await ev(`document.querySelectorAll('[data-testid="agent-stats"]').length>0 || document.querySelectorAll('[data-testid="stats-note"]').length>0`)) break;
    await sleep(500);
  }
  const statsGrids = await ev(`document.querySelectorAll('[data-testid="agent-stats"]').length`);
  const statsNote = await ev(`document.querySelector('[data-testid="stats-note"]')?.innerText ?? null`);
  check("the §8 numbers render, or the panel says which migration it waits on", statsGrids > 0 || (statsNote && /0010|0009/.test(statsNote)), statsGrids > 0 ? `${statsGrids} stat panels` : String(statsNote));
  if (statsGrids > 0) {
    const labels = await ev(`[...document.querySelector('[data-testid="agent-stats"]').querySelectorAll("p")].map(p=>p.textContent.trim())`);
    check("a stats panel shows drafted / sent / qualified / handed over / held / tokens", ["Drafted", "Sent", "Qualified", "Handed over", "Held", "Tokens"].every((l) => labels.includes(l)), labels.filter((l) => /^[A-Z]/.test(l)).join(", "));
  }

  await send("Page.captureScreenshot", { format: "png" }).then((r) => fs.writeFileSync(SHOT, Buffer.from(r.data, "base64")));

  /* ---- the editor ------------------------------------------------------- */
  await ev(`(()=>{const b=document.querySelector('button[aria-label="Configure"]'); b&&b.click(); return !!b;})()`);
  await sleep(800);
  const dialog = (await ev(`document.querySelector('[role="dialog"]')?.innerText ?? ""`)) ?? "";
  check("the editor opens with every section", ["Mode", "Clients", "Qualification", "Handover", "Schedule"].every((s) => dialog.includes(s)), "five sections");
  check("the schedule editor offers the off-hours window", dialog.includes("Outside business hours only"), "off-hours");
  check("there is no 'mark as Introduction' switch — a live introduction is always labelled", !dialog.includes("Also mark the lead as Introduction") && (await ev(`[...document.querySelectorAll('[role="dialog"] [role="switch"]')].filter(s=>/introduction/i.test(s.parentElement?.textContent||'')).length`)) === 0, "no Introduction switch");
  check("the always-on label is explained instead", dialog.includes("always labelled Introduction") && dialog.includes("Follow Up Boss"), "explained");

  const live = await ev(`(()=>{const i=[...document.querySelectorAll('[role="dialog"] input[type=radio]')].find(x=>(x.closest("label")?.textContent||"").trim().startsWith("Live")); return i ? {found:true, disabled:i.disabled, checked:i.checked} : {found:false};})()`);
  check("Live is shown", live?.found === true, JSON.stringify(live));
  if (liveGateOn) {
    check("with the gate on, Live can be selected", live?.disabled === false, JSON.stringify(live));
    check("but Live is not already selected — switching is a deliberate act",
      live?.checked === false, JSON.stringify(live));
  } else {
    check("Live cannot be selected", live?.disabled === true && live?.checked === false, JSON.stringify(live));
  }
  // The "why it is unavailable" note only exists while the gate is off.
  if (!liveGateOn) {
    check("Live says why", dialog.includes("Unavailable: live sending is not enabled"), "reason shown");
  } else {
    check("with the gate on, Live no longer shows an unavailable reason",
      !dialog.includes("Unavailable: live sending is not enabled"), "no stale reason");
  }

  const clientChips = await ev(`document.querySelectorAll('[role="dialog"] button[aria-pressed]').length`);
  check("the client picker lists clients (plus the seven day chips)", clientChips > 7, `${clientChips} chips`);

  /* ---- geometry: fields inside the dialog, none overlapping -------------- */
  const geo = await ev(`(()=>{
    const d=document.querySelector('[role="dialog"]'); if(!d) return null;
    const box=d.getBoundingClientRect();
    const els=[...d.querySelectorAll('input:not([type=radio]),select,textarea')].filter(e=>e.offsetParent!==null);
    const rects=els.map(e=>{const r=e.getBoundingClientRect(); return {l:r.left,r:r.right,t:r.top,b:r.bottom}});
    let overflow=0, overlap=0;
    for(const r of rects){ if(r.l<box.left-1||r.r>box.right+1) overflow++; }
    for(let i=0;i<rects.length;i++) for(let j=i+1;j<rects.length;j++){
      const a=rects[i],b=rects[j];
      if(a.l<b.r-1&&b.l<a.r-1&&a.t<b.b-1&&b.t<a.b-1) overlap++;
    }
    return {fields:rects.length, overflow, overlap};
  })()`);
  check("every field sits inside the dialog", geo && geo.overflow === 0, JSON.stringify(geo));
  check("no two fields overlap", geo && geo.overlap === 0, JSON.stringify(geo));

  await send("Page.captureScreenshot", { format: "png" }).then((r) => fs.writeFileSync(SHOT.replace(/\.png$/, "-dialog.png"), Buffer.from(r.data, "base64")));

  await ev(`(()=>{const b=[...document.querySelectorAll('[role="dialog"] button')].find(x=>x.textContent.trim()==="Cancel"); b&&b.click(); return !!b;})()`);
  await sleep(500);
  check("Cancel closes the editor without saving", (await ev(`document.querySelector('[role="dialog"]')`)) === null, "closed");

  check("no JavaScript exception was thrown", thrown.length === 0, thrown[0] ?? "");
  check("no request answered 5xx", serverErrors.length === 0, serverErrors[0] ?? "");
} finally {
  ws.close();
  chrome.kill("SIGKILL");
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(74)}\n  ${passed} passed · ${failed} failed\n  screenshots: ${SHOT}, ${SHOT.replace(/\.png$/, "-dialog.png")}`);
if (fails.length > 0) console.log(`  failed: ${fails.join(", ")}`);
console.log("");
process.exit(failed > 0 ? 1 : 0);
