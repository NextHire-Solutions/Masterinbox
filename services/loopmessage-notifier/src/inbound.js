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

// ---------------------------------------------------------------------------
// What a reply means
//
// Replies are free text, so they're read for what a mistake would cost:
//
// - After the welcome (which asks them to reply YES), only a reply that IS
//   a yes is consent: "Yes", "Sure thing!", "Ok 👍", "Hi! Yes please",
//   "Sounds good, thanks", a Like on the welcome. It may go on, as long as
//   nothing after it hedges ("Yes please! Excited to see who joins"). A yes
//   followed by doubt ("Sure, let me ask my broker first", "Ok but who is
//   this?"), and anything that isn't a yes at all, keeps their alerts held
//   and is logged for a person to follow up. A clear refusal ("No thanks",
//   "Wrong number", "Not Eddy") opts them out. A wrong guess can only hold
//   alerts back: a Team page can hold a mistyped number, and a stranger's
//   reply must never release a lead's name and phone.
// - Someone who texts the sender before any welcome has opted in by doing
//   so, unless they refuse or ask who we are.
// - Once someone gets alerts, only a clear request to stop these texts opts
//   them out: STOP and its synonyms as a sentence of their own ("Stop
//   please", "Thanks! Stop.", "Can you remove me?"), or a request aimed at
//   the texts ("stop texting me", "take me off this list", "I left the
//   team", "darme de baja"). Not the lead's words ("she said stop texting
//   me"), not a visit ("I'll stop by"), not a limit ("don't text me after
//   9pm"), not the email copy ("unsubscribe me from the emails"): those are
//   replies, logged as possible opt-outs.
// - Quoted text is someone else's words (ours in an iPhone reaction, a
//   lead's in a report) and is set aside before reading. A reaction never
//   opts anyone out.

// Replies are short; never scan a huge body.
const MAX_READ = 2000;

const NEGATIONS = new Set(["dont", "not", "never", "cant", "wont", "didnt", "doesnt", "isnt", "arent", "wasnt", "aint", "non"]);

// Spelling variants folded to one word before matching.
function fold(w) {
  if (/^s+t+o+p+$/.test(w) || w === "stp" || w === "sotp" || w === "stpo") return "stop";
  if (/^un+s+u+[bs]/.test(w) && !w.endsWith("ed")) return "unsubscribe"; // unsub, unsubcribe; not "she unsubscribed"
  if (/^y+e+s+$/.test(w) || /^ya+s+$/.test(w) || /^yes+s?i+r+$/.test(w) || ["yse", "yed", "yws", "tes", "ye", "yuh"].includes(w)) return "yes";
  if (/^m+h+m+$/.test(w) || /^m+m+h+m+$/.test(w)) return "yes"; // mhm
  if (/^ye+a+h*$/.test(w)) return "yeah";
  if (/^ye+p+$/.test(w) || /^yep+ers$/.test(w)) return "yep";
  if (/^yu+p+$/.test(w)) return "yup";
  if (/^o+k+(a+y+)?$/.test(w) || ["okey", "okie", "oki", "okk"].includes(w)) return "ok";
  if (/^alright+y?$/.test(w) || w === "allright" || w === "alrighty") return "alright";
  if (/^si+$/.test(w)) return "si";
  if (/^u+m+$/.test(w)) return "um";
  if (/^k+$/.test(w)) return "k";
  if (/^no+$/.test(w)) return "no";
  if (/^na+h+$/.test(w)) return "nah";
  if (/^no+pe+$/.test(w)) return "nope";
  if (/^(thx+|tx|ty|tysm|thanx|thanku)$/.test(w) || /^tha+n+k+s+$/.test(w)) return "thanks";
  if (/^ple+a+s+e+$/.test(w) || w === "pls" || w === "plz" || w === "plse") return "please";
  if (w === "ur") return "your";
  if (w === "u") return "you";
  if (w === "txt") return "text";
  if (w === "txting" || w === "txtng") return "texting";
  if (w === "msg") return "message";
  if (w === "msgs") return "messages";
  if (w === "msging" || w === "msgng") return "messaging";
  return w;
}

// Multi-word expressions that behave as one word.
const JOINS = [
  [["opt", "out"], "optout"],
  [["opting", "out"], "optout"],
  [["no", "more"], "nomore"],
  [["no", "mas"], "nomore"],
  [["leave", "me", "alone"], "leavemealone"],
  [["take", "me", "off"], "takemeoff"],
];

function normalizeText(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // más -> mas
    .replace(/[’‘`´]/g, "'");
}

function tokenize(text) {
  const raw = normalizeText(text)
    .replace(/(\p{L})'(\p{L})/gu, "$1$2") // don't -> dont, eddy's -> eddys
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
  let parts = raw.split(/\s+/).filter(Boolean);
  // Spelled out letter by letter: "S T O P".
  if (parts.length >= 3 && parts.every((p) => /^\p{L}$/u.test(p))) parts = [parts.join("")];
  const words = parts.map(fold);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const join = JOINS.find(([p]) => p.every((x, j) => words[i + j] === x));
    if (join) {
      out.push(join[1]);
      i += join[0].length - 1;
    } else {
      out.push(words[i]);
    }
  }
  return out;
}

// Sentences and phrases, split on punctuation, spaced dashes and emoji.
function clausesOf(text) {
  return String(text)
    .split(/[.,!?;:\n\r]+|\s[-–—]+\s|[—–]|[^\p{L}\p{N}\s'’‘`´#&-]+/u)
    .map(tokenize)
    .filter((w) => w.length > 0);
}

function starts(words, phrase) {
  const at = [];
  for (let i = 0; i + phrase.length <= words.length; i++) {
    if (phrase.every((p, j) => words[i + j] === p)) at.push(i);
  }
  return at;
}

// "don't stop", "don't ever stop", "non-stop".
function negated(words, i) {
  if (NEGATIONS.has(words[i - 1])) return true;
  return ["ever", "even", "really", "please"].includes(words[i - 1]) && NEGATIONS.has(words[i - 2]);
}

// Covers a clause with known phrases, single words and harmless fillers:
// how "Sure thing, thanks so much" is recognised as a yes. Returns the
// number of meaningful units, or -1 if anything is left over.
function cover(words, { phrases, units, fillers }) {
  let count = 0;
  for (let i = 0; i < words.length; ) {
    const p = phrases.find((ph) => ph.every((x, j) => words[i + j] === x));
    if (p) {
      count++;
      i += p.length;
    } else if (units.has(words[i])) {
      count++;
      i++;
    } else if (fillers.has(words[i])) {
      i++;
    } else {
      return -1;
    }
  }
  return count;
}

// Quoted text is someone else's words: ours in an iPhone reaction
// ('Liked "…"'), a lead's in a report ('she replied "stop texting me"').
const DOUBLE_QUOTED = /“[^“”]*”|„[^“”]*[“”]|«[^«»]*»|"[^"]*"/g;
const SINGLE_QUOTED = /(^|\s)['‘][^'‘’]{1,300}['’](?=[\s.,!?;:]|$)/g;

function withoutQuotes(raw) {
  return raw.replace(DOUBLE_QUOTED, " ").replace(SINGLE_QUOTED, "$1 ");
}

// iPhone tapbacks sent as SMS text: 'Liked “…”', 'Reacted 👍 to “…”',
// 'Le gustó “…”'. Read on the accent-stripped, lowercased text.
const REACTION = /^\s*(liked|loved|le gusto|le encanto|laughed at|emphasi[sz]ed|disliked|questioned)\s+[“"'«„]/;
const REACTED = /^\s*reacted\s+(\S{1,20})\s+to\s+[“"'«„]/;
const REMOVED_REACTION = /^\s*removed\s+an?\s+\S{1,20}\s+from\s+[“"'«„]/;

const POSITIVE_EMOJI = /[\u{1F197}\u{1F64B}\u{1F44D}\u{1F44C}\u{2705}\u{2714}\u{1F64F}\u{1F60A}\u{1F642}\u{263A}\u{1F600}\u{1F603}\u{1F604}\u{1F601}\u{1F44F}\u{1F4AF}\u{2764}\u{2665}\u{1F64C}\u{1F91D}\u{1F525}\u{1F4AA}\u{1F919}\u{1FAE1}\u{1F973}\u{1F389}\u{1F60E}\u{1F44A}\u{270C}\u{1F929}\u{1F60D}\u{1F970}\u{1F499}\u{1F49A}\u{1F49C}\u{1F9E1}\u{1F49B}]/u;
const NEGATIVE_EMOJI = /[\u{1F44E}\u{274C}\u{1F645}\u{1F621}\u{1F92C}\u{1F595}\u{1F620}\u{26D4}\u{1F6AB}\u{1F6D1}]/u;
const STOP_EMOJI = /^[\s\u{1F6D1}\u{26D4}\u{1F6AB}\u{FE0F}]+$/u; // 🛑 ⛔ 🚫 on their own

function parseReaction(raw) {
  const s = normalizeText(raw);
  if (REMOVED_REACTION.test(s)) return "removed";
  const m = s.match(REACTION);
  if (m) {
    if (["liked", "loved", "le gusto", "le encanto"].includes(m[1])) return "positive";
    if (m[1] === "disliked") return "negative";
    if (m[1] === "questioned") return "question";
    return "other"; // laughed at, emphasized
  }
  const r = s.match(REACTED);
  if (r) {
    if (NEGATIVE_EMOJI.test(r[1])) return "negative";
    if (POSITIVE_EMOJI.test(r[1])) return "positive";
    return "other";
  }
  return null;
}

// --- STOP ------------------------------------------------------------------

// A sentence made only of these and filler words is a stop request:
// "STOP", "Stop please", "Can you remove me?", "I'd like to opt out", "No
// more texts thanks", "take me off your list".
const STOP_KEYS = new Set([
  "stop", "stopall", "unsubscribe", "optout", "cancel", "end", "quit", "revoke", "remove", "nomore",
  "leavemealone", "takemeoff", "alto", "parar", "cancelar", "baja", "basta",
]);
const STOP_FILLERS = new Set([
  "please", "now", "ok", "k", "yes", "yeah", "yep", "sure", "cool", "thanks", "thank", "you", "sorry", "lol", "just",
  "it", "this", "these", "them", "that", "texts", "text", "texting", "messages", "message", "messaging", "alerts",
  "alert", "notifications", "me", "my", "number", "name", "all", "asap", "from", "of", "the", "list", "your", "any",
  "more", "sending", "send", "i", "want", "to", "be", "us", "here", "immediately", "again", "anymore", "hi", "hey",
  "and", "for", "good", "can", "could", "would", "id", "like", "omg", "wtf", "ugh", "dude", "bro", "man", "seriously",
  "yo", "already", "right", "away", "permanently", "forever", "completely", "rn", "guys", "off", "mensajes",
  "mensaje", "por", "favor",
]);
// Requests aimed at these texts, anywhere in a sentence. `tail: "filler"`
// means only if nothing but filler follows ("no more texts please", not
// "no more texts about her").
const DIRECTED_STOP = [
  ["stop", "texting", "me"], ["stop", "messaging", "me"], ["stop", "contacting", "me"],
  ["stop", "sending", "me", "these"], ["stop", "sending", "me", "texts"], ["stop", "sending", "me", "alerts"],
  ["stop", "sending", "me", "messages"], ["stop", "sending", "me", "this"],
  ["stop", "sending", "these"], ["stop", "sending", "texts"], ["stop", "sending", "alerts"],
  ["stop", "these", "texts"], ["stop", "these", "alerts"], ["stop", "these", "messages"],
  ["stop", "the", "texts"], ["stop", "the", "alerts"], ["stop", "the", "messages"],
  ["how", "do", "i", "stop"], ["how", "do", "i", "unsubscribe"], ["how", "do", "i", "optout"], ["how", "can", "i", "stop"],
  ["how", "to", "stop", "these"], ["how", "to", "unsubscribe"],
  ["i", "said", "stop"], ["asked", "you", "to", "stop"], ["told", "you", "to", "stop"],
  ["unsubscribe", "me"], ["opt", "me", "out"], ["optout", "of", "these"], ["optout", "of", "this", "list"],
  ["want", "to", "optout"], ["like", "to", "optout"], ["want", "to", "unsubscribe"], ["like", "to", "unsubscribe"],
  ["takemeoff", "this", "list"], ["takemeoff", "your", "list"], ["takemeoff", "the", "list"], ["takemeoff", "of"],
  ["takemeoff", "these"],
  ["remove", "me", "from", "this", "list"], ["remove", "me", "from", "your", "list"], ["remove", "me", "from", "the", "list"],
  ["remove", "me", "from", "these"], ["please", "remove", "me"],
  ["remove", "my", "number"], ["remove", "my", "name"], ["delete", "my", "number"], ["lose", "my", "number"],
  ["take", "my", "number", "off"],
  ["get", "off", "this", "list"], ["get", "off", "your", "list"], ["get", "off", "the", "list"],
  ["want", "off", "this", "list"], ["want", "off", "your", "list"], ["want", "off", "the", "list"],
  ["dont", "text", "me", "anymore"], ["dont", "text", "me", "again"], ["not", "text", "me", "anymore"],
  ["not", "text", "me", "again"], ["never", "text", "me", "again"], ["dont", "message", "me", "anymore"],
  ["dont", "contact", "me"], ["not", "contact", "me"],
  ["dont", "send", "me", "these"], ["not", "send", "me", "these"], ["dont", "send", "these"], ["not", "send", "these"],
  ["dont", "send", "me", "anymore"], ["no", "need", "to", "text", "me"],
  ["turn", "these", "off"], ["turn", "off", "these"], ["turn", "them", "off"], ["turn", "off", "the", "alerts"],
  ["turn", "off", "the", "texts"], ["turn", "off", "alerts"], ["turn", "off", "texts"],
  ["not", "interested", "in", "these"], ["leave", "me", "out", "of", "these"],
  ["quit", "sending", "me"], ["quit", "sending", "these"], ["quit", "texting", "me"], ["quit", "messaging", "me"],
  ["cancel", "my", "subscription"], ["no", "longer", "want"], ["no", "longer", "wish"],
  ["dont", "want", "to", "receive"], ["dont", "want", "to", "get", "these"],
  ["i", "no", "longer", "work"], ["im", "no", "longer", "with"], ["i", "am", "no", "longer", "with"],
  ["im", "no", "longer", "on"], ["no", "longer", "on", "the", "team"], ["no", "longer", "with", "the", "team"],
  ["i", "left", "the", "team"], ["i", "left", "the", "company"], ["i", "dont", "work", "there"],
  ["im", "not", "on", "this", "team"], ["im", "not", "on", "the", "team"], ["i", "am", "not", "on", "the", "team"],
  ["not", "on", "the", "team", "anymore"], ["not", "with", "the", "team"], ["im", "not", "part", "of", "the", "team"],
  ["dont", "need", "these", "alerts"], ["dont", "need", "these", "texts"], ["dont", "need", "these", "messages"],
  // Spanish
  ["no", "me", "manden"], ["no", "me", "envien"], ["dejen", "de", "enviarme"], ["dejen", "de", "mandarme"],
  ["darme", "de", "baja"], ["dar", "de", "baja"], ["quitenme", "de"], ["quitame", "de"], ["sacame", "de"],
  ["sacarme", "de"], ["ya", "no", "quiero"], ["ya", "no", "estoy", "con"], ["no", "quiero", "recibir"],
].map((p) => ({ p, tail: "any" })).concat(
  [
    ["nomore", "texts"], ["nomore", "messages"], ["nomore", "alerts"], ["nomore", "of", "these"],
    ["nomore", "notifications"], ["dont", "want", "these"], ["dont", "want", "any", "more"], ["dont", "need", "these"],
    ["please", "stop"], ["stop", "texting"], ["stop", "messaging"], ["stop", "sending", "me", "leads"],
    ["stop", "sending", "leads"], ["cancel", "these"], ["cancel", "the", "alerts"], ["cancel", "the", "texts"],
    ["enough", "with", "these"], ["enough", "with", "the", "texts"],
  ].map((p) => ({ p, tail: "filler" })),
);
// Someone else's request, reported: "she told me to stop texting her",
// "tell her to stop texting me", "she's not interested in these".
const THIRD_PERSON = new Set(["she", "he", "they", "shes", "hes", "theyre", "theyve", "theyd", "shed", "hed", "her", "him", "lead", "client"]);
// A limit, not an opt-out: "don't text me after 9pm", "turn these off on
// weekends", "stop texting me while I'm at work".
const TIME_WORDS = new Set([
  "weekend", "weekends", "night", "nights", "morning", "mornings", "noon", "midnight", "hours", "evening", "evenings",
  "saturday", "saturdays", "sunday", "sundays", "holidays", "vacation", "work", "dinner", "lunch", "bedtime", "oclock",
]);
function isLimited(after) {
  return after.some(
    (w, k) => /^\d+(am|pm)?$/.test(w) || TIME_WORDS.has(w) || ((w === "am" || w === "pm") && /^\d/.test(after[k - 1] ?? "")),
  );
}
// About the email copy, not these texts: "unsubscribe me from the email version".
const EMAIL = new Set(["email", "emails", "inbox", "gmail", "outlook", "mail"]);
// Words that make a reply worth a second look when it isn't read as a stop.
const STOP_MENTIONS = new Set([
  "stop", "stopall", "unsubscribe", "optout", "cancel", "quit", "revoke", "remove", "nomore", "leavemealone",
  "takemeoff", "baja", "alto", "pause", "spam", "block",
]);

function isStopSentence(words) {
  return (
    words.length <= 10 &&
    words.some((w, i) => STOP_KEYS.has(w) && !negated(words, i)) &&
    words.every((w) => STOP_KEYS.has(w) || STOP_FILLERS.has(w))
  );
}

function hasDirectedStop(words) {
  return DIRECTED_STOP.some(({ p, tail }) =>
    starts(words, p).some((i) => {
      const after = words.slice(i + p.length);
      return (
        !negated(words, i) &&
        !words.slice(0, i).some((w) => THIRD_PERSON.has(w)) &&
        !isLimited(after) &&
        !after.some((w) => EMAIL.has(w)) &&
        (tail === "any" || after.every((w) => STOP_FILLERS.has(w)))
      );
    }),
  );
}

function isStopRequest(clauses, unquoted) {
  if (clauses.length === 0) return STOP_EMOJI.test(unquoted);
  return clauses.some((c) => isStopSentence(c) || hasDirectedStop(c));
}

// --- YES -------------------------------------------------------------------

const YES_UNITS = new Set([
  "yes", "yeah", "yep", "yup", "ya", "yah", "y", "sure", "ok", "k", "kk", "alright", "aight", "absolutely",
  "definitely", "def", "certainly", "perfect", "great", "awesome", "cool", "nice", "amazing", "excellent", "fantastic",
  "wonderful", "sweet", "bet", "word", "done", "deal", "roger", "copy", "noted", "gotcha", "np", "fine", "si", "claro",
  "optin", "start", "subscribe", "unstop", "confirmed", "confirm", "agreed", "gladly", "totally", "indeed", "yay",
  "thanks", "ty", "gracias", "appreciated", "100", "fs", "good", "ready", "affirmative", "fasho", "ofc", "ight", "dale",
  "acepto", "perfecto", "proceed", "consent", "accept", "agree",
]);
const YES_PHRASES = [
  ["sure", "thing"], ["of", "course"], ["for", "sure"], ["sounds", "good"], ["sounds", "great"], ["sounds", "perfect"],
  ["sounds", "awesome"], ["sounds", "like", "a", "plan"], ["sign", "me", "up"], ["count", "me", "in"], ["im", "in"],
  ["i", "am", "in"], ["im", "down"], ["yes", "please"], ["please", "do"], ["go", "ahead"], ["go", "for", "it"],
  ["no", "problem"], ["not", "a", "problem"], ["no", "worries"], ["no", "prob"], ["no", "probs"], ["no", "problemo"],
  ["no", "sweat"], ["no", "doubt"], ["no", "brainer"], ["no", "complaints"], ["why", "not"], ["will", "do"],
  ["got", "it"], ["all", "good"], ["thats", "fine"], ["that", "is", "fine"], ["fine", "by", "me"], ["works", "for", "me"],
  ["that", "works"], ["love", "it"], ["love", "this"], ["love", "that"], ["lets", "do", "it"], ["lets", "go"],
  ["keep", "them", "coming"], ["keep", "em", "coming"], ["send", "them", "over"], ["send", "them"], ["send", "em"],
  ["send", "away"], ["happy", "to", "get", "these"], ["happy", "to", "receive", "these"], ["glad", "to", "get", "these"],
  ["looking", "forward", "to", "it"], ["looking", "forward"], ["cant", "wait"], ["opt", "in"], ["10", "4"],
  ["roger", "that"], ["copy", "that"], ["hell", "yes"], ["heck", "yes"], ["yes", "sir"], ["yes", "maam"],
  ["por", "supuesto"], ["thank", "you", "for", "reaching", "out"], ["thank", "you"], ["appreciate", "it"],
  ["im", "good", "with", "that"], ["im", "good", "with", "getting", "these"], ["good", "with", "that"], ["good", "with", "me"],
  ["add", "me", "to", "the", "list"], ["add", "me", "to", "your", "list"], ["add", "me"], ["opt", "me", "in"],
  ["keep", "me", "posted"], ["keep", "me", "in", "the", "loop"], ["please", "proceed"], ["please", "enroll", "me"],
  ["enroll", "me"], ["i", "consent"], ["i", "accept"], ["i", "agree"], ["i", "am", "agree"], ["am", "agree"], ["i", "confirm"],
  ["i", "would", "like", "that"], ["i", "would", "like", "to", "receive", "these"], ["i", "would", "appreciate"],
  ["that", "would", "be", "great"], ["would", "be", "great"], ["very", "well"], ["this", "is", "great"],
  ["thats", "great"], ["that", "is", "great"], ["thats", "me"], ["say", "less"], ["hell", "yeah"], ["heck", "yeah"],
  ["is", "ok", "for", "me"], ["is", "ok"], ["is", "fine"], ["esta", "bien"], ["de", "acuerdo"], ["claro", "que", "si"],
  ["si", "por", "favor"], ["sounds", "good", "to", "me"], ["fine", "with", "me"],
];
const YES_FILLERS = new Set([
  "please", "thanks", "thank", "you", "so", "much", "very", "a", "lot", "again", "it", "lol", "haha", "just", "really",
  "and", "sir", "maam", "gracias", "muchas", "man", "dude", "bro", "guys", "then", "too", "also", "for", "the", "heads",
  "up", "info", "here", "now", "absolutely", "definitely", "kindly", "dokie", "lmao", "to", "getting", "receiving",
  "receive", "these", "them", "alerts", "messages", "texts", "text", "por", "favor", "that",
]);
// Opening sentences that greet or introduce, before the answer: "Hi!",
// "Good morning", "Eddy here", "This is Eddy".
const GREETING = new Set([
  "hi", "hey", "hello", "yo", "good", "morning", "afternoon", "evening", "there", "oh", "ah", "ahh", "um", "uh", "well",
  "lol", "haha", "hehe", "hiya", "howdy", "this", "is", "its", "it", "here", "im", "i", "am", "sir", "maam", "hola",
  "buenos", "dias", "buenas", "tardes",
]);
// Words that open a sentence without being its answer: "Oh ok", "Hi, yes
// please", "Good morning yes". (Not "I'm": "I'm good" is a polite no.)
const INTERJECTIONS = new Set([
  "hi", "hey", "hello", "yo", "oh", "ah", "ahh", "um", "uh", "well", "lol", "lmao", "haha", "hehe", "hiya", "howdy",
  "hola", "good", "morning", "afternoon", "evening", "there", "sir", "maam",
]);
// After the yes, these mean it isn't one yet: "but", "if", "first",
// "later", "not sure", "who"...
const DOUBT = new Set([
  "not", "no", "nah", "naw", "nope", "never", "dont", "cant", "wont", "isnt", "doesnt", "didnt", "aint", "but", "though",
  "although", "however", "unless", "except", "if", "first", "later", "maybe", "perhaps", "wait", "before", "until",
  "unsure", "idk", "hmm", "eh", "scam", "spam", "wrong", "stop", "unsubscribe", "optout", "cancel", "quit", "pause",
  "block", "report", "remove", "let", "yet", "think", "check", "ask", "takemeoff", "nomore",
]);
const QUESTION_OPENERS = new Set(["who", "whos", "why", "how", "what", "whats", "where", "which"]);
// In a question after the yes, these mean it's about who we are, not about
// the alerts: "Ok. And you are?", "Sure, how did you get my number?". A
// question about the alerts ("Yes! Do these come in real time?") is fine.
const DOUBTFUL_QUESTION = new Set([
  "you", "your", "yours", "who", "whos", "whom", "why", "scam", "spam", "legit", "bot", "number", "sign",
  "signed", "know", "huh", "wym",
]);
// "Yeah no", "sure not", "ok no thanks": the yes is taken back.
const TAKEN_BACK = new Set(["no", "nah", "not", "nope", "never"]);
// Harmless phrases that contain doubt words: "let me know", "can't wait".
const NOT_DOUBT = [
  ["let", "me", "know", "if"], ["let", "me", "know"], ["cant", "wait"], ["no", "problem"], ["no", "worries"], ["why", "not"],
  ["not", "a", "problem"], ["cant", "hurt"], ["no", "questions"], ["no", "need", "to", "ask"], ["no", "need", "to", "call"],
  ["dont", "want", "to", "miss"],
];

const yesShape = { phrases: YES_PHRASES, units: YES_UNITS, fillers: YES_FILLERS };

function isYesSentence(words) {
  return cover(words, yesShape) > 0;
}

function hedges(words) {
  // "Who…", "Why…", or "What…"/"How…" about us rather than the alerts.
  if (IDENTITY_QUESTIONS.some((p) => hasPhraseIn(words, p))) return true;
  if (QUESTION_OPENERS.has(words[0]) && words.some((w) => DOUBTFUL_QUESTION.has(w))) return true;
  let rest = words;
  for (const p of NOT_DOUBT) {
    for (const i of starts(rest, p).reverse()) rest = [...rest.slice(0, i), ...rest.slice(i + p.length)];
  }
  return rest.some((w) => DOUBT.has(w));
}

function firstNameOf(name) {
  return tokenize(String(name ?? "").trim().split(/\s+/)[0] ?? "")[0] ?? null;
}

// A greeting needs a greeting in it, or their own name: "I'm good" isn't one.
const GREETING_CORE = new Set(["hi", "hey", "hello", "yo", "morning", "afternoon", "evening", "hiya", "howdy", "hola", "dias", "tardes"]);

// The reply's answer, after any greeting ("Hi!", "Eddy here", "Oh ok"):
// its first sentence, and what follows it.
function answerOf(clauses, name) {
  const own = firstNameOf(name);
  const greeting = (c) =>
    !isYesSentence(c) && c.every((w) => GREETING.has(w) || w === own) && c.some((w) => GREETING_CORE.has(w) || w === own);
  let i = 0;
  while (i < clauses.length && greeting(clauses[i])) i++;
  if (i >= clauses.length) return null;
  const whole = clauses[i];
  let s = 0;
  while (s < whole.length - 1 && INTERJECTIONS.has(whole[s]) && !isYesSentence(whole.slice(s))) s++; // "oh ok", "hi yes please"
  return { first: whole.slice(s), whole, rest: clauses.slice(i + 1) };
}

// The reply's questions: sentences ending in "?" (or opening with "¿").
function questionsIn(raw) {
  return (raw.match(/[^.!?\n]*\?+/g) ?? []).map(tokenize).filter((q) => q.length > 0);
}

function doubtfulQuestion(q) {
  return (
    q.some((w) => DOUBTFUL_QUESTION.has(w) || DOUBT.has(w)) ||
    IDENTITY_QUESTIONS.some((p) => hasPhraseIn(q, p))
  );
}

// Is the answer a yes, and does anything after it hedge?
function readYes(clauses, raw, name) {
  if (clauses.length === 0) return { opener: false, consent: POSITIVE_EMOJI.test(raw) && !NEGATIVE_EMOJI.test(raw) };
  const answer = answerOf(clauses, name);
  if (!answer || !isYesSentence(answer.first)) return { opener: false, consent: false };
  const rest = answer.rest;
  // "Yes?", "Ok??", "Sure, really?": the answer itself is a question.
  const asked =
    raw.includes("?") &&
    (clauses.flat().length <= 3 || raw.includes("??") || (/^[^.!]*\?/.test(raw.trim()) && answer.rest.length === 0));
  const doubtful =
    asked ||
    questionsIn(raw).some(doubtfulQuestion) ||
    NEGATIVE_EMOJI.test(raw) ||
    rest.some((c) => !isYesSentence(c) && hedges(c));
  return { opener: true, consent: !doubtful };
}

// --- REFUSALS --------------------------------------------------------------

const DECLINE_PHRASES = [
  ["no", "thanks"], ["no", "thank", "you"], ["thanks", "but", "no", "thanks"], ["not", "interested"],
  ["not", "really", "interested"], ["no", "im", "good"], ["im", "good"], ["i", "am", "good"], ["im", "all", "set"],
  ["ill", "pass"], ["hard", "pass"], ["hell", "no"], ["hell", "nah"], ["heck", "no"], ["absolutely", "not"],
  ["definitely", "not"], ["no", "way"], ["not", "for", "me"], ["id", "rather", "not"], ["rather", "not"],
  ["please", "dont"], ["no", "need"], ["not", "needed"], ["yeah", "nah"], ["yeah", "no"], ["claro", "que", "no"],
  ["i", "dont", "think", "so"], ["dont", "think", "so"], ["i", "dont", "want", "these"], ["dont", "want", "these"],
  ["i", "do", "not", "want", "these"], ["not", "me"],
];
const DECLINE_UNITS = new Set(["no", "nope", "nah", "naw", "nay", "n", "nty", "pass"]);
const DECLINE_FILLERS = new Set([
  "thanks", "thank", "you", "sorry", "lol", "really", "please", "appreciate", "it", "though", "but", "man", "sir", "maam",
  "gracias", "im", "good", "all", "set", "yeah", "ok", "um", "uh", "well", "hmm", "honestly",
]);
const declineShape = { phrases: DECLINE_PHRASES, units: DECLINE_UNITS, fillers: DECLINE_FILLERS };
// A "no" that's really "not yet": "No, not yet — let me talk to my broker first".
const DEFERRAL = new Set(["yet", "later", "first", "let", "think", "check", "ask", "talk", "maybe", "wait", "until", "before", "after"]);

const WRONG_PHRASES = [
  ["not", "the", "right", "number"], ["not", "the", "right", "person"], ["my", "number", "now"], ["belongs", "to", "me"],
  ["not", "meant", "for", "me"], ["isnt", "meant", "for", "me"], ["not", "who", "you"], ["dont", "know", "you"],
  ["do", "not", "know", "you"], ["dont", "know", "who"], ["never", "heard", "of"], ["no", "idea", "who"],
  ["ion", "know"], ["meant", "to", "text", "someone"], ["typed", "the", "number"],
];
// First names that are everyday words: too risky to read as a name.
const COMMON_WORD_NAMES = new Set([
  "will", "bill", "may", "june", "april", "august", "hope", "grace", "joy", "rose", "mark", "sky", "faith", "chase",
  "hunter", "summer", "dawn", "art", "pat", "sue", "jack", "frank", "rich", "gene", "don", "ray", "rob", "jean",
  "chuck", "sandy", "crystal", "amber", "ruby", "pearl", "ivy", "holly", "lily", "angel", "autumn", "winter", "star",
  "sunny", "max", "bob", "guy", "carol", "dale", "glen", "rusty", "miles", "wade", "drew", "lance", "cliff", "brook",
  "reed", "penny", "ginger", "honey", "destiny", "harmony", "melody", "chance", "mercy", "king", "prince", "major",
  "price", "west", "can", "bud",
]);

// The reply denies being the person we greeted: "not Eddy", "this isn't
// Eddy's phone", "no Eddy here", "I don't know an Eddy", "Eddy doesn't
// have this number". Never "this is Eddy" or "Eddy here".
function deniesName(words, name) {
  const n = firstNameOf(name);
  if (!n || n.length < 2 || COMMON_WORD_NAMES.has(n)) return false;
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== n && words[i] !== `${n}s`) continue;
    const prev = words[i - 1];
    const next = words[i + 1];
    if (["not", "isnt", "aint", "no", "wrong"].includes(prev)) return true;
    if (prev === "longer" && words[i - 2] === "no") return true;
    const know = prev === "know" ? i - 1 : ["an", "any", "a"].includes(prev) && words[i - 2] === "know" ? i - 2 : -1;
    if (know >= 1 && (NEGATIONS.has(words[know - 1]) || words[know - 1] === "ion")) return true;
    if (prev === "of" && words[i - 2] === "heard" && words[i - 3] === "never") return true;
    if (["doesnt", "isnt", "changed", "moved"].includes(next)) return true;
    if (next === "no" && words[i + 2] === "longer") return true;
    if (next === "got" && ["a", "new"].includes(words[i + 2])) return true;
  }
  return false;
}

// "This is spam", "scam": a short statement, not a question about it.
function callsItSpam(words, raw) {
  return (
    words.length <= 4 &&
    !raw.includes("?") &&
    words.some((w, i) => (w === "spam" || w.startsWith("scam")) && !negated(words, i) && words[i - 1] !== "no")
  );
}

function refusalOf(clauses, raw, name) {
  if (clauses.length === 0) return NEGATIVE_EMOJI.test(raw) && !POSITIVE_EMOJI.test(raw) ? "declined" : null;
  const all = clauses.flat();
  if (all.some((w, i) => w === "wrong" && !negated(all, i) && !["go", "nothing", "anything"].includes(all[i - 1]))) {
    return "wrong_number";
  }
  if (all.includes("incorrect") || WRONG_PHRASES.some((p) => hasPhraseIn(all, p))) return "wrong_number";
  if (deniesName(all, name)) return "wrong_number";
  // A decline is a sentence of its own, not "no idea what this is" or "no
  // need to call me, text is fine"; and not followed by "not yet" or "let
  // me check first".
  const answer = answerOf(clauses, name);
  if (
    answer &&
    (cover(answer.whole, declineShape) > 0 || cover(answer.first, declineShape) > 0) &&
    !answer.rest.flat().some((w) => DEFERRAL.has(w)) &&
    !raw.includes("?")
  ) {
    return "declined";
  }
  if (callsItSpam(all, raw)) return "declined";
  return null;
}

function hasPhraseIn(words, phrase) {
  return starts(words, phrase).length > 0;
}

// --- QUESTIONS -------------------------------------------------------------

// Asking who we are or whether this is real.
const IDENTITY_QUESTIONS = [
  ["who", "is", "this"], ["whos", "this"], ["who", "this"], ["who", "are", "you"], ["who", "r", "you"], ["who", "dis"],
  ["who", "is", "that"], ["whos", "that"], ["who", "sent"], ["who", "gave"], ["who", "is", "brokerstaffer"],
  ["whos", "brokerstaffer"], ["how", "did", "you", "get"], ["howd", "you", "get"], ["how", "do", "you", "have"],
  ["where", "did", "you", "get"], ["what", "is", "this"], ["whats", "this"], ["what", "is", "brokerstaffer"],
  ["is", "this", "real"], ["is", "this", "legit"], ["do", "i", "know", "you"], ["which", "team"], ["what", "team"],
  ["what", "company"], ["what", "brokerage"], ["when", "did", "i", "sign"], ["didnt", "sign", "up"],
  ["never", "signed", "up"], ["did", "i", "sign", "up"], ["is", "this", "spam"], ["is", "this", "a", "scam"], ["wym"],
  ["what", "are", "these"], ["what", "is", "it"], ["for", "what"], ["and", "you", "are"],
];

function asksWhoWeAre(clauses, raw) {
  const all = clauses.flat();
  if (IDENTITY_QUESTIONS.some((p) => hasPhraseIn(all, p))) return true;
  if (raw.includes("??")) return true;
  if (raw.includes("?") && all.length <= 2) return true; // "Who?", "Yes?", "Huh?"
  return all.length <= 3 && all.some((w) => ["who", "whos", "huh", "what", "wut", "wat"].includes(w));
}

// --- Putting it together ---------------------------------------------------

/**
 * What a reply says, independent of who sent it.
 * @returns {{ reaction: string|null, stop: boolean, yes: boolean, opener: boolean,
 *   refusal: "declined"|"wrong_number"|null, question: boolean, empty: boolean,
 *   mentionsStop: boolean }}
 */
export function readReply(text, { name = null } = {}) {
  const raw = String(text ?? "").slice(0, MAX_READ);
  const reaction = parseReaction(raw);
  if (reaction) {
    return {
      reaction,
      stop: false,
      yes: reaction === "positive",
      opener: reaction === "positive",
      refusal: reaction === "negative" ? "declined" : null,
      question: reaction === "question",
      empty: false,
      mentionsStop: false,
    };
  }
  const unquoted = withoutQuotes(raw);
  const clauses = clausesOf(unquoted);
  const stop = isStopRequest(clauses, unquoted);
  const { opener, consent } = readYes(clauses, unquoted, name);
  // A yes somewhere in it ("Don't know who set this up but sure") makes a
  // refusal a mixed reply: held for a person, not opted out.
  const all = clauses.flat();
  const saysYes = all.some((w, i) => ["yes", "yeah", "yep", "yup", "sure", "ok"].includes(w) && !negated(all, i) && !TAKEN_BACK.has(all[i + 1]));
  const refusal = refusalOf(clauses, unquoted, name);
  return {
    reaction: null,
    stop,
    yes: consent,
    // A whole-sentence "no" ("Yeah I don't think so", "Ok no thanks") stays
    // a refusal whatever filler it starts with.
    opener: opener || (saysYes && refusal !== "declined"),
    refusal,
    question: asksWhoWeAre(clauses, unquoted),
    // No words and nothing affirmative: an attachment, "...", "🤔".
    empty: clauses.length === 0 && !POSITIVE_EMOJI.test(raw),
    mentionsStop: !stop && clauses.some((c) => c.some((w) => STOP_MENTIONS.has(w)) || hasPhraseIn(c, ["dont", "text"]) || hasPhraseIn(c, ["turn", "off"])),
  };
}

const RESUME_UNITS = new Set(["start", "unstop", "resume", "subscribe", "yes", "yeah", "yep", "y", "optin"]);
const RESUME_FILLERS = new Set(["please", "again", "me", "back", "now", "ok", "thanks", "thank", "you", "in", "up", "sign", "i", "want", "to", "id", "like"]);
const resumeShape = { phrases: [["opt", "in"], ["sign", "me", "up"], ["sign", "up"]], units: RESUME_UNITS, fillers: RESUME_FILLERS };

/**
 * What to do with a reply.
 *
 * `stage`: "welcome" (sent the welcome, waiting for a YES), "first_contact"
 * (texting the sender before any welcome), "active" (getting alerts) or
 * "opted_out".
 *
 * @returns {{ action: "opt_out"|"consent"|"resume"|"hold"|"reply",
 *   reason: string|null, mentionsStop: boolean }}
 */
export function interpretReply(text, { name = null, stage }) {
  const r = readReply(text, { name });
  const out = (action, reason = null) => ({ action, reason, mentionsStop: r.mentionsStop });

  if (stage === "active") {
    if (r.stop) return out("opt_out", "stop");
    // A reassigned number: "Wrong number, there's no Eddy here", "this
    // isn't Eddy anymore, he changed numbers". Only with the number itself
    // mentioned, and only a real denial of the name.
    const words = clausesOf(withoutQuotes(String(text ?? "").slice(0, MAX_READ))).flat();
    const aboutTheNumber = ["number", "numbers", "phone", "anymore", "changed", "longer"].some((w) => words.includes(w));
    if (r.refusal === "wrong_number" && aboutTheNumber && deniesName(words, name)) return out("opt_out", "wrong_number");
    return out("reply");
  }
  if (stage === "opted_out") {
    if (r.stop || r.question || r.reaction) return out("hold");
    const raw = withoutQuotes(String(text ?? "").slice(0, MAX_READ));
    const words = clausesOf(raw).flat();
    return !raw.includes("?") && cover(words, resumeShape) > 0 ? out("resume") : out("hold");
  }

  if (r.stop) return out("opt_out", "stop");
  if (r.reaction) {
    if (r.reaction === "negative") return out("opt_out", "declined");
    return r.reaction === "positive" && stage === "welcome" ? out("consent") : out("hold");
  }
  if (r.refusal && !r.opener) return out("opt_out", r.refusal);
  if (stage === "first_contact") {
    // They texted us first: that's opting in, unless they're asking who we
    // are or sent nothing readable.
    return r.question || r.refusal || r.empty ? out("hold") : out("consent");
  }
  // After the welcome: only a clear yes, with nothing hedging it.
  return r.yes ? out("consent") : out("hold");
}
