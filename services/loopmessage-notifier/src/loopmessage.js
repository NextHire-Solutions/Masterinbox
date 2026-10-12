// LoopMessage client.
//
// Talks to the same integration API the official n8n community node uses
// (n8n-nodes-loopmessage), so behaviour matches what you'd get by wiring
// the node up by hand:
//
//   POST {base}/message/send/         -> queue an outbound message
//   GET  {base}/message-status/{id}/  -> poll delivery state
//   GET  {base}/sender-name-list/     -> sender ids (used by the health check)
//
// Auth is a bare X-API-KEY header — no Bearer prefix.
//
// A 200 from send/ means *queued*, not delivered. Delivery is only
// confirmed via message-status or LoopMessage's delivery webhook. Don't let
// a 200 here be reported as "the agent got it".
//
// A send is only retried when LoopMessage provably didn't act on it: a
// 408/425/429, or a connection that was never made. After a timeout or a
// 5xx without a LoopMessage error code the message may already be queued,
// so the result is marked `ambiguous` and never resent here; resending
// would text the person twice, and a second first message costs a slot of
// the daily cap.

export const DEFAULT_BASE_URL =
  "https://n8n-api.loopmessage.com/api/v1/integrations/n8n";

const RETRYABLE_STATUS = new Set([408, 425, 429]);

// Connection errors that happen before any of the request is sent.
const NOT_SENT_ERRORS = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(
  { baseUrl, apiKey, path, method = "GET", body, timeoutMs = 15000, fetchImpl = fetch },
) {
  const res = await fetchImpl(`${baseUrl}${path}`, {
    method,
    headers: {
      "X-API-KEY": apiKey,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body (proxy error page, etc.) — keep the raw text for logs.
  }

  return { status: res.status, ok: res.ok, body: parsed, raw: text };
}

/**
 * Queue one outbound message. Retries only what LoopMessage can't have
 * acted on; a refusal is returned with its code, and anything that may
 * have gone out is returned with `ambiguous: true`.
 */
export async function sendMessage({
  baseUrl = DEFAULT_BASE_URL,
  apiKey,
  contact,
  text,
  sender,
  passthrough,
  channel,
  timeoutMs = 15000,
  retries = 2,
  backoffMs = 500,
  fetchImpl = fetch,
}) {
  const body = { contact, text };
  // Only send optional fields when actually set. The n8n node posts empty
  // strings for these; omitting them avoids relying on the API treating ""
  // as absent — notably `sender`, whose node default is the literal "None".
  if (sender) body.sender = sender;
  if (passthrough) body.passthrough = passthrough;
  if (channel) body.channel = channel;

  let lastError = null;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const res = await request({
        baseUrl,
        apiKey,
        path: "/message/send/",
        method: "POST",
        body,
        timeoutMs,
        fetchImpl,
      });

      // The API can return HTTP 200 with {"success": false} — treat the
      // body as authoritative, not the status line.
      const succeeded = res.ok && res.body?.success !== false;

      if (succeeded) {
        return {
          ok: true,
          attempts: attempt,
          status: res.status,
          messageId: res.body?.message_id ?? null,
          body: res.body,
        };
      }

      // LoopMessage's numeric error code (apidocs/error-codes) decides what
      // happens next: opted out, invalid number, rate limited...
      const rawCode = res.body?.code;
      const code = rawCode != null && Number.isFinite(Number(rawCode)) ? Number(rawCode) : null;

      if (!RETRYABLE_STATUS.has(res.status) || attempt === retries + 1) {
        return {
          ok: false,
          // A 5xx without a code is a proxy or server failure that may have
          // happened after the message was queued.
          ambiguous: res.status >= 500 && code === null,
          attempts: attempt,
          status: res.status,
          code,
          error: res.body?.message ?? res.raw?.slice(0, 300) ?? "send_failed",
          body: res.body,
        };
      }

      lastError = `http_${res.status}`;
    } catch (err) {
      // fetch wraps the socket error: TypeError("fetch failed") with the
      // real code on `cause`.
      const errCode = err?.cause?.code ?? err?.code ?? null;
      const notSent = NOT_SENT_ERRORS.has(errCode);
      lastError = err?.name === "TimeoutError" ? "timeout" : String(errCode ?? err?.message ?? err);
      if (!notSent || attempt === retries + 1) {
        return { ok: false, ambiguous: !notSent, attempts: attempt, status: null, code: null, error: lastError };
      }
    }

    await sleep(backoffMs * 2 ** (attempt - 1));
  }

  return { ok: false, ambiguous: false, attempts: retries + 1, status: null, code: null, error: lastError };
}

export async function getMessageStatus({
  baseUrl = DEFAULT_BASE_URL,
  apiKey,
  messageId,
  timeoutMs = 15000,
  fetchImpl = fetch,
}) {
  return await request({
    baseUrl,
    apiKey,
    path: `/message-status/${encodeURIComponent(messageId)}/`,
    timeoutMs,
    fetchImpl,
  });
}

export async function listSenders({
  baseUrl = DEFAULT_BASE_URL,
  apiKey,
  timeoutMs = 10000,
  fetchImpl = fetch,
}) {
  return await request({ baseUrl, apiKey, path: "/sender-name-list/", timeoutMs, fetchImpl });
}
