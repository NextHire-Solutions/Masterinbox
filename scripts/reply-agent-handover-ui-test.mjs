/*
 * The Handover section of the agent editor, read in a real browser.
 *
 * Sibling of scripts/reply-agent-config-ui-test.mjs and the same shape as the
 * workspace's scripts/reply-agent-handover-ui-test.mjs. What only a browser
 * can tell us: that the words a person sees say the handover is the
 * introduction — CC defaults to the client's contacts, the address field is
 * for EXTRA addresses, and an empty message means the macro.
 *
 * Read-only. Opens the editor, reads it, cancels. Never saves.
 *
 *   BASE=http://localhost:3220 PORT=9771 node scripts/reply-agent-handover-ui-test.mjs
 *
 * Starts its own headless Chrome on PORT and kills it on exit.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const BASE = process.env.BASE || "http://localhost:3220";
const PORT = Number(process.env.PORT || 9771);
const CDP = `http://localhost:${PORT}`;
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

console.log(`\nREPLY AGENTS — HANDOVER SECTION  →  ${BASE}\n${"=".repeat(74)}\n`);

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
const jar = [];
const ssr = createServerClient(SB, ANON, {
  cookies: { getAll: () => jar, setAll: (cs) => { for (const c of cs) jar.push({ name: c.name, value: c.value }); } },
});
await ssr.auth.setSession({ access_token: verified.session.access_token, refresh_token: verified.session.refresh_token });
check("a session was minted and serialised into cookies", jar.length > 0, `${jar.length} cookie(s)`);

/* --------------------------------------------------------------- chrome */
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mi-handover-ui-"));
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
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") thrown.push(m.params?.exceptionDetails?.exception?.description ?? "exception");
};
const send = (m, p = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }))?.result?.value;

try {
  await send("Runtime.enable");
  await send("Page.enable");
  const host = new URL(BASE).hostname;
  for (const c of jar) await send("Network.setCookie", { name: c.name, value: c.value, domain: host, path: "/", secure: BASE.startsWith("https") });
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  await send("Page.navigate", { url: `${BASE}/settings/reply-agents` });
  for (let i = 0; i < 240; i++) {
    if (await ev(`!!document.body && document.body.innerText.includes("Reply Agents") && document.querySelectorAll('[data-testid="mode-pill"]').length > 0`)) break;
    await sleep(500);
  }
  const url = await ev("location.pathname");
  check("the session is accepted (not bounced to /login)", url === "/settings/reply-agents", url);

  const text = (await ev(`document.body.innerText`)) ?? "";
  check("every agent card says the handover is the introduction with the client's contacts on CC",
    text.includes("Handover") && text.includes("Introduction, CC client contacts") && !text.includes("No CC set"),
    "card summary");

  const opened = await ev(`(()=>{const b=[...document.querySelectorAll("button")].find(x=>(x.getAttribute("title")||"").startsWith("Configure")||x.textContent.trim()==="Configure"); b&&b.click(); return !!b;})()`);
  check("the Configure button exists", opened === true);
  for (let i = 0; i < 20; i++) {
    if (await ev(`document.body.innerText.includes("Extra addresses to CC")`)) break;
    await sleep(250);
  }
  const dialog = (await ev(`document.body.innerText`)) ?? "";
  check("the editor opens with the Handover section", dialog.includes("Handover"), "section");
  check("it says the reply is the introduction, as the Introduce button makes it",
    dialog.includes("the reply is the introduction") && dialog.includes("Introduce button"), "section intro");
  check("it says CC defaults to the client's introduction contacts",
    dialog.includes("CC defaults to the client's introduction contacts"), "cc caption");
  check("the address field is presented as extra addresses",
    dialog.includes("Extra addresses to CC (optional)"), "field label");
  check("the message field says empty = introduction macro",
    dialog.includes("Message override (optional)") && dialog.includes("Empty means the introduction macro"), "message caption");

  const fields = await ev(`[...document.querySelectorAll('[role="dialog"] input, [role="dialog"] textarea')].map(e=>e.placeholder).filter(Boolean)`);
  check("the address field's placeholder is an extra address, not the client's",
    Array.isArray(fields) && fields.includes("extra@example.com") && !fields.some((p) => p.includes("client@example.com")),
    JSON.stringify(fields));
  check("the message field's placeholder says to leave it empty for the macro",
    Array.isArray(fields) && fields.includes("Leave empty to use the introduction macro."), "placeholder");
  check("there is no Introduction switch — a live introduction is always labelled, and the copy says so",
    !dialog.includes("Also mark the lead as Introduction") && dialog.includes("always labelled Introduction") && dialog.includes("guarded"), "label copy");

  await ev(`(()=>{const b=[...document.querySelectorAll('[role="dialog"] button')].find(x=>x.textContent.trim()==="Cancel"); b&&b.click(); return !!b;})()`);
  await sleep(300);
  check("nothing threw", thrown.length === 0, thrown.slice(0, 2).join(" | ") || "clean");
} finally {
  ws.close();
  chrome.kill("SIGKILL");
  fs.rmSync(profile, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(74)}\n  ${passed} passed · ${failed} failed`);
if (fails.length > 0) console.log(`  failed: ${fails.join(", ")}`);
console.log("");
process.exit(failed > 0 ? 1 : 0);
