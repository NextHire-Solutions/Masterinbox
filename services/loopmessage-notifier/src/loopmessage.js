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
// confirmed via message-status (or a LoopMessage webhook, which we don't
// subscribe to). Don't let a 200 here be reported as "the agent got it".

export const DEFAULT_BASE_URL =
  "https://n8n-api.loopmessage.com/api/v1/integrations/n8n";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

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
 * Queue one outbound message. Retries network errors and transient statuses;
 * a 4xx is returned as-is, since retrying a rejected number never helps.
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

      if (!RETRYABLE_STATUS.has(res.status) || attempt === retries + 1) {
        return {
          ok: false,
          attempts: attempt,
          status: res.status,
          error: res.body?.message ?? res.raw?.slice(0, 300) ?? "send_failed",
          body: res.body,
        };
      }

      lastError = `http_${res.status}`;
    } catch (err) {
      lastError = err?.name === "TimeoutError" ? "timeout" : String(err?.message ?? err);
      if (attempt === retries + 1) {
        return { ok: false, attempts: attempt, status: null, error: lastError };
      }
    }

    await sleep(backoffMs * 2 ** (attempt - 1));
  }

  return { ok: false, attempts: retries + 1, status: null, error: lastError };
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
