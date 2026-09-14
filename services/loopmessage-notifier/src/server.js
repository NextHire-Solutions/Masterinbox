// HTTP entrypoint.
//
//   GET  /health                      -> liveness (no secrets in the body)
//   POST /webhooks/introduction       -> lead.introduction from Masterinbox
//
// Auth is a shared secret, matching the ?token= convention already used by
// BISON_INTRODUCTION_WEBHOOK_URL in this project. Unlike the n8n webhook it
// replaces, this endpoint is on a guessable Railway domain, so an
// unauthenticated route would let anyone spend the LoopMessage balance.
//
// The caller (lib/webhooks/n8n-introduction.ts) fires inside next/server
// after() with a 10s timeout and ignores the response, so we ack as soon as
// the payload is valid and do the sending in the background. Pass ?wait=1
// to block on the sends instead — used by the smoke test.

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { DedupeStore, parseClientList, processIntroduction } from "./notify.js";
import { DEFAULT_BASE_URL, listSenders } from "./loopmessage.js";
import { normalizePhone } from "./phone.js";

const PORT = Number(process.env.PORT ?? 3000);
const API_KEY = process.env.LOOPMESSAGE_API_KEY;
const SENDER = process.env.LOOPMESSAGE_SENDER_ID ?? "";
const CHANNEL = process.env.LOOPMESSAGE_CHANNEL ?? "";
const BASE_URL = process.env.LOOPMESSAGE_BASE_URL ?? DEFAULT_BASE_URL;
const WEBHOOK_TOKEN = process.env.INTRO_WEBHOOK_TOKEN;
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE ?? "1";
const DRY_RUN = process.env.DRY_RUN === "1";
const CLIENT_FILTER = parseClientList(process.env.NOTIFY_CLIENTS);
const TEST_RECIPIENT_OVERRIDE = process.env.TEST_RECIPIENT_OVERRIDE?.trim() || null;
const MAX_BODY_BYTES = 1_000_000;

const missing = [];
if (!API_KEY) missing.push("LOOPMESSAGE_API_KEY");
if (!WEBHOOK_TOKEN) missing.push("INTRO_WEBHOOK_TOKEN");
if (missing.length > 0) {
  console.error(
    JSON.stringify({ level: "fatal", msg: "missing_env", vars: missing }),
  );
  process.exit(1);
}

// A typo here would otherwise surface only as a failed test text.
if (
  TEST_RECIPIENT_OVERRIDE &&
  !normalizePhone(TEST_RECIPIENT_OVERRIDE, { defaultCountryCode: DEFAULT_COUNTRY_CODE }).ok
) {
  console.error(
    JSON.stringify({
      level: "fatal",
      msg: "invalid_env",
      var: "TEST_RECIPIENT_OVERRIDE",
    }),
  );
  process.exit(1);
}

if (!CLIENT_FILTER.all && CLIENT_FILTER.size === 0) {
  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "no_clients_enabled",
      detail: "NOTIFY_CLIENTS is empty; every event will be skipped",
    }),
  );
}

const dedupe = new DedupeStore();

function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  // timingSafeEqual throws on length mismatch; compare lengths separately so
  // the call itself never leaks via an exception path.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
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

async function handleIntroduction(req, res, url) {
  const supplied = url.searchParams.get("token") ?? req.headers["x-webhook-token"];
  if (!constantTimeEquals(supplied, WEBHOOK_TOKEN)) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "unauthorized",
        ip: req.socket.remoteAddress,
      }),
    );
    return json(res, 401, { ok: false, error: "unauthorized" });
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    return json(res, 413, { ok: false, error: String(err.message ?? err) });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json(res, 400, { ok: false, error: "invalid_json" });
  }

  const opts = {
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    sender: SENDER,
    channel: CHANNEL,
    defaultCountryCode: DEFAULT_COUNTRY_CODE,
    clientFilter: CLIENT_FILTER,
    testRecipientOverride: TEST_RECIPIENT_OVERRIDE,
    dedupe,
    // Per-request dry run, so a live config can be checked without texting.
    dryRun: DRY_RUN || url.searchParams.get("dry_run") === "1",
  };

  // ?wait=1 blocks on the sends and returns per-recipient results.
  if (url.searchParams.get("wait") === "1") {
    const result = await processIntroduction(payload, opts);
    return json(res, result.ok ? 200 : 400, result);
  }

  // Fast ack. Run the plan first so an obviously bad payload still gets a
  // 400 the operator can see, then fan out in the background.
  const pending = processIntroduction(payload, opts);
  pending.catch((err) =>
    console.error(
      JSON.stringify({ level: "error", msg: "unhandled", error: String(err) }),
    ),
  );

  return json(res, 202, { ok: true, accepted: true });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        service: "loopmessage-notifier",
        sender_configured: Boolean(SENDER),
        dry_run: DRY_RUN,
        // Counts only: this route is unauthenticated.
        clients_enabled: CLIENT_FILTER.all ? "all" : CLIENT_FILTER.size,
        test_recipient_override: Boolean(TEST_RECIPIENT_OVERRIDE),
      });
    }

    // Verifies the LoopMessage key end to end. Token-protected because it
    // makes an upstream call and reveals sender ids.
    if (req.method === "GET" && url.pathname === "/health/upstream") {
      const supplied = url.searchParams.get("token") ?? req.headers["x-webhook-token"];
      if (!constantTimeEquals(supplied, WEBHOOK_TOKEN)) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }
      const senders = await listSenders({ baseUrl: BASE_URL, apiKey: API_KEY });
      return json(res, senders.ok ? 200 : 502, {
        ok: senders.ok,
        status: senders.status,
        senders: senders.body,
      });
    }

    if (req.method === "POST" && url.pathname === "/webhooks/introduction") {
      return await handleIntroduction(req, res, url);
    }

    return json(res, 404, { ok: false, error: "not_found" });
  } catch (err) {
    console.error(
      JSON.stringify({ level: "error", msg: "request_failed", error: String(err) }),
    );
    return json(res, 500, { ok: false, error: "internal_error" });
  }
});

server.listen(PORT, () => {
  console.log(
    JSON.stringify({
      level: "info",
      msg: "listening",
      port: PORT,
      base_url: BASE_URL,
      sender_configured: Boolean(SENDER),
      dry_run: DRY_RUN,
      clients_enabled: CLIENT_FILTER.all ? "all" : CLIENT_FILTER.size,
      test_recipient_override: Boolean(TEST_RECIPIENT_OVERRIDE),
    }),
  );
});

// Railway sends SIGTERM on redeploy; finish in-flight requests first.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(JSON.stringify({ level: "info", msg: "shutting_down", signal }));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
