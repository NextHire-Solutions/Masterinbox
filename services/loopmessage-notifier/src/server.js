// HTTP entrypoint.
//
//   GET  /health                  -> liveness + counts (no secrets)
//   GET  /health/upstream         -> LoopMessage key check (token)
//   GET  /contacts                -> who is active / held / opted out (token)
//   POST /webhooks/introduction   -> lead.introduction from Masterinbox (token)
//   POST /webhooks/loopmessage    -> replies + delivery events from LoopMessage
//                                    (LOOPMESSAGE_WEBHOOK_SECRET)
//
// The introduction webhook's auth is a shared ?token=, matching the
// convention BISON_INTRODUCTION_WEBHOOK_URL already uses in this project;
// this endpoint is on a guessable Railway domain, so an open route would
// let anyone spend the LoopMessage balance. The caller fires inside
// next/server after() with a 10s timeout and ignores the response, so we
// ack once the payload is valid and work in the background. ?wait=1 blocks
// on the result instead, and &dry_run=1 previews without changing anything.
//
// LoopMessage's webhook is authenticated by the Authorization header value
// configured next to the URL in the LoopMessage dashboard (?token= also
// works). It disconnects after 15 seconds and retries up to 30 times.

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { parseClientList, processIntroduction, isSafeInitialText } from "./notify.js";
import { DEFAULT_BASE_URL, listSenders, sendMessage } from "./loopmessage.js";
import { normalizePhone } from "./phone.js";
import { Engine } from "./engine.js";
import { parseLoopEvent } from "./inbound.js";
import { FileStore } from "./store.js";

const env = process.env;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MAX_BODY_BYTES = 1_000_000;

function fatal(msg, fields = {}) {
  console.error(JSON.stringify({ level: "fatal", msg, ...fields }));
  process.exit(1);
}

function numberEnv(name, fallback, { min = 0 } = {}) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) fatal("invalid_env", { var: name, value: raw });
  return n;
}

const PORT = Number(env.PORT ?? 3000);
const API_KEY = env.LOOPMESSAGE_API_KEY;
const SENDER = env.LOOPMESSAGE_SENDER_ID ?? "";
const CHANNEL = env.LOOPMESSAGE_CHANNEL ?? "";
const BASE_URL = env.LOOPMESSAGE_BASE_URL || DEFAULT_BASE_URL;
const WEBHOOK_TOKEN = env.INTRO_WEBHOOK_TOKEN;
const LOOP_WEBHOOK_SECRET = env.LOOPMESSAGE_WEBHOOK_SECRET;
const DEFAULT_COUNTRY_CODE = env.DEFAULT_COUNTRY_CODE ?? "1";
const CLIENT_FILTER = parseClientList(env.NOTIFY_CLIENTS);
const TEST_RECIPIENT_OVERRIDE = env.TEST_RECIPIENT_OVERRIDE?.trim() || null;
const BRAND = env.WELCOME_BRAND?.trim() || "BrokerStaffer";
const TICK_MS = numberEnv("TICK_SECONDS", 15, { min: 1 }) * 1000;

const missing = [];
if (!API_KEY) missing.push("LOOPMESSAGE_API_KEY");
if (!WEBHOOK_TOKEN) missing.push("INTRO_WEBHOOK_TOKEN");
// Without it nobody's reply ever reaches us, so nobody is ever activated
// and every alert would sit held until it expired.
if (!LOOP_WEBHOOK_SECRET) missing.push("LOOPMESSAGE_WEBHOOK_SECRET");
if (missing.length > 0) fatal("missing_env", { vars: missing });

// A typo here would otherwise surface only as a failed test text.
if (
  TEST_RECIPIENT_OVERRIDE &&
  !normalizePhone(TEST_RECIPIENT_OVERRIDE, { defaultCountryCode: DEFAULT_COUNTRY_CODE }).ok
) {
  fatal("invalid_env", { var: "TEST_RECIPIENT_OVERRIDE" });
}

// The brand goes into every first message, where LoopMessage forbids
// emails, links, phone numbers and currencies.
if (!isSafeInitialText(BRAND)) fatal("invalid_env", { var: "WELCOME_BRAND" });

if (!CLIENT_FILTER.all && CLIENT_FILTER.size === 0) {
  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "no_clients_enabled",
      detail: "NOTIFY_CLIENTS is empty; every event will be skipped",
    }),
  );
}

// State has to survive redeploys (Railway redeploys on every variable
// change). On Railway that means a volume; RAILWAY_VOLUME_MOUNT_PATH is set
// when one is attached.
const VOLUME = env.RAILWAY_VOLUME_MOUNT_PATH;
const STATE_PATH =
  env.STATE_PATH ||
  (VOLUME ? join(VOLUME, "notifier-state.json") : join(process.cwd(), "data", "notifier-state.json"));
const STATE_PERSISTENT = Boolean(env.STATE_PATH || VOLUME);
if (!STATE_PERSISTENT) {
  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "state_not_persistent",
      detail: "no Railway volume attached; consent and pacing reset on every redeploy",
      path: STATE_PATH,
    }),
  );
}

const engine = new Engine({
  store: new FileStore(STATE_PATH),
  send: ({ contact, text, passthrough }) =>
    sendMessage({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      sender: SENDER,
      channel: CHANNEL,
      contact,
      text,
      passthrough,
    }),
  config: {
    initIntervalMs: numberEnv("INIT_INTERVAL_MINUTES", 15) * MINUTE,
    // Unset = LoopMessage's warm-up schedule (2/day rising to 50/day).
    initDailyCap: env.INIT_DAILY_CAP?.trim() ? numberEnv("INIT_DAILY_CAP", 2) : null,
    coldIntervalMs: numberEnv("COLD_SEND_INTERVAL_SECONDS", 120) * 1000,
    recentInboundMs: numberEnv("RECENT_INBOUND_HOURS", 24) * HOUR,
    holdTtlMs: numberEnv("HOLD_TTL_HOURS", 24) * HOUR,
    brand: BRAND,
  },
});

function logError(msg, err, fields = {}) {
  console.error(
    JSON.stringify({ level: "error", msg, ...fields, error: String(err?.message ?? err) }),
  );
}

function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  // timingSafeEqual throws on length mismatch; compare lengths separately so
  // the call itself never leaks via an exception path.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function hasAdminToken(req, url) {
  return constantTimeEquals(url.searchParams.get("token") ?? req.headers["x-webhook-token"], WEBHOOK_TOKEN);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    json(res, 413, { ok: false, error: String(err.message ?? err) });
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    json(res, 400, { ok: false, error: "invalid_json" });
    return undefined;
  }
}

async function handleIntroduction(req, res, url) {
  if (!hasAdminToken(req, url)) {
    console.warn(JSON.stringify({ level: "warn", msg: "unauthorized", route: "introduction", ip: req.socket.remoteAddress }));
    return json(res, 401, { ok: false, error: "unauthorized" });
  }

  const payload = await readJson(req, res);
  if (payload === undefined) return;

  const opts = {
    engine,
    defaultCountryCode: DEFAULT_COUNTRY_CODE,
    clientFilter: CLIENT_FILTER,
    testRecipientOverride: TEST_RECIPIENT_OVERRIDE,
    dryRun: url.searchParams.get("dry_run") === "1",
  };

  if (url.searchParams.get("wait") === "1") {
    const result = await processIntroduction(payload, opts);
    return json(res, result.ok ? 200 : 400, result);
  }

  processIntroduction(payload, opts).catch((err) => logError("introduction_failed", err));
  return json(res, 202, { ok: true, accepted: true });
}

async function handleLoopMessageWebhook(req, res, url) {
  const header = String(req.headers.authorization ?? "");
  const supplied =
    url.searchParams.get("token") ??
    (header.toLowerCase().startsWith("bearer ") ? header.slice(7) : header);
  if (!constantTimeEquals(supplied, LOOP_WEBHOOK_SECRET)) {
    console.warn(JSON.stringify({ level: "warn", msg: "unauthorized", route: "loopmessage", ip: req.socket.remoteAddress }));
    return json(res, 401, { ok: false, error: "unauthorized" });
  }

  const payload = await readJson(req, res);
  if (payload === undefined) return;

  const evt = parseLoopEvent(payload);
  try {
    if (evt.type === "inbound") {
      // Saves consent (fast) before answering; releasing held alerts runs
      // after, so LoopMessage's 15-second timeout isn't at risk.
      const outcome = await engine.handleInbound(evt);
      return json(res, 200, { ok: true, ...outcome, release: undefined });
    }
    if (evt.type === "status") {
      const outcome = await engine.handleStatusEvent(evt);
      return json(res, 200, { ok: true, ...outcome });
    }
    console.log(JSON.stringify({ level: "info", msg: "loopmessage_event_ignored", reason: evt.reason }));
    return json(res, 200, { ok: true, ignored: evt.reason });
  } catch (err) {
    // A 500 makes LoopMessage retry, which is what we want for a failure
    // on our side.
    logError("loopmessage_webhook_failed", err);
    return json(res, 500, { ok: false, error: "internal_error" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        service: "loopmessage-notifier",
        sender_configured: Boolean(SENDER),
        // Counts only: this route is unauthenticated.
        clients_enabled: CLIENT_FILTER.all ? "all" : CLIENT_FILTER.size,
        test_recipient_override: Boolean(TEST_RECIPIENT_OVERRIDE),
        state_persistent: STATE_PERSISTENT,
        ...engine.stats(),
      });
    }

    // Verifies the LoopMessage key end to end. Token-protected because it
    // makes an upstream call and reveals sender ids.
    if (req.method === "GET" && url.pathname === "/health/upstream") {
      if (!hasAdminToken(req, url)) return json(res, 401, { ok: false, error: "unauthorized" });
      const senders = await listSenders({ baseUrl: BASE_URL, apiKey: API_KEY });
      return json(res, senders.ok ? 200 : 502, {
        ok: senders.ok,
        status: senders.status,
        senders: senders.body,
      });
    }

    // Who has replied, who is waiting, who opted out. Names and numbers,
    // so token-protected.
    if (req.method === "GET" && url.pathname === "/contacts") {
      if (!hasAdminToken(req, url)) return json(res, 401, { ok: false, error: "unauthorized" });
      return json(res, 200, { ok: true, ...engine.stats(), contacts: engine.snapshot() });
    }

    if (req.method === "POST" && url.pathname === "/webhooks/introduction") {
      return await handleIntroduction(req, res, url);
    }

    if (req.method === "POST" && url.pathname === "/webhooks/loopmessage") {
      return await handleLoopMessageWebhook(req, res, url);
    }

    return json(res, 404, { ok: false, error: "not_found" });
  } catch (err) {
    logError("request_failed", err);
    if (!res.headersSent) return json(res, 500, { ok: false, error: "internal_error" });
  }
});

const timer = setInterval(() => {
  engine.tick().catch((err) => logError("tick_failed", err));
}, TICK_MS);

server.listen(PORT, () => {
  console.log(
    JSON.stringify({
      level: "info",
      msg: "listening",
      port: PORT,
      base_url: BASE_URL,
      sender_configured: Boolean(SENDER),
      clients_enabled: CLIENT_FILTER.all ? "all" : CLIENT_FILTER.size,
      test_recipient_override: Boolean(TEST_RECIPIENT_OVERRIDE),
      state_path: STATE_PATH,
      state_persistent: STATE_PERSISTENT,
      tick_ms: TICK_MS,
      ...engine.stats(),
    }),
  );
  engine.tick().catch((err) => logError("tick_failed", err));
});

// Railway sends SIGTERM on redeploy: stop scheduling, let in-flight work
// finish and save, then exit.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(JSON.stringify({ level: "info", msg: "shutting_down", signal }));
    clearInterval(timer);
    setTimeout(() => process.exit(0), 10_000).unref();
    engine
      .idle()
      .then(() => engine.persist())
      .finally(() => server.close(() => process.exit(0)));
  });
}
