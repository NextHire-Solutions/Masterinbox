// What LoopMessage sends back to us: replies and delivery events.
//
// Configured per organization in the LoopMessage dashboard (webhook URL +
// an Authorization header value). Documented body, apidocs
// "Webhooks/Callbacks":
//
//   { "event": "message_inbound", "contact": "+13231112233", "text": "...",
//     "message_type": "text", "message_id": "...", "webhook_id": "...",
//     "api_version": "1.0" }
//
// Events: message_inbound, message_delivered, message_failed,
// message_scheduled, message_reaction, inbound_call, unknown. LoopMessage
// waits 15 seconds for a 200 and retries up to 30 times, so handling must
// be idempotent.
//
// The n8n integration's inbound hook (n8n-nodes-loopmessage) posts the
// same fields without `event`; it's accepted too, as an inbound message.

/**
 * @returns {{type:"inbound", contact:string, text:string, messageId:string|null}
 *         | {type:"status", event:string, messageId:string|null, errorCode:number|null}
 *         | {type:"ignore", reason:string}}
 */
export function parseLoopEvent(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { type: "ignore", reason: "not_an_object" };
  }
  // Group chats aren't a team member talking to the sender one-on-one.
  if (body.group) return { type: "ignore", reason: "group_message" };

  const event =
    body.event ??
    (typeof body.contact === "string" && typeof body.text === "string"
      ? "message_inbound"
      : null);

  if (event === "message_inbound") {
    if (typeof body.contact !== "string" || body.contact.trim() === "") {
      return { type: "ignore", reason: "inbound_without_contact" };
    }
    return {
      type: "inbound",
      contact: body.contact,
      text: typeof body.text === "string" ? body.text : "",
      messageId: body.message_id ?? null,
    };
  }

  if (event === "message_delivered" || event === "message_failed") {
    const code = Number(body.error_code);
    return {
      type: "status",
      event,
      messageId: body.message_id ?? null,
      errorCode: body.error_code == null || !Number.isFinite(code) ? null : code,
    };
  }

  return { type: "ignore", reason: `event_${event ?? "missing"}` };
}

// Opt-out / opt-in keywords. Carriers treat these as exact-match commands;
// a short message *containing* stop or unsubscribe is honoured too, since
// over-honouring an opt-out is cheap (they can text START) and ignoring one
// gets the sender reported. "end", "cancel" and "quit" only count on their
// own, because they open ordinary sentences.
const STOP_EXACT = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout"]);
const STOP_ANYWHERE_SHORT = new Set(["stop", "stopall", "unsubscribe", "optout"]);
const START_EXACT = new Set(["start", "unstop", "yes", "y", "subscribe"]);
const START_LEADING = new Set(["start", "unstop", "yes", "subscribe"]);

/** @returns {"stop" | "start" | "other"} */
export function classifyReply(text) {
  const words = String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "other";

  const joined = words.join("");
  if (STOP_EXACT.has(joined)) return "stop";
  const short = words.length <= 4;
  if (short && words.some((w) => STOP_ANYWHERE_SHORT.has(w))) return "stop";
  if (short && words.some((w, i) => w === "opt" && words[i + 1] === "out")) return "stop";

  if (START_EXACT.has(joined) || START_LEADING.has(words[0])) return "start";
  return "other";
}
