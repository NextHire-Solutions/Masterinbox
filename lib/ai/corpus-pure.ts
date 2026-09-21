/*
 * Copied from BrokerStaffer OS, deliberately.
 *
 * Both apps read the same database and must draft from the same corpus and
 * judge edits by the same rule, so this file is kept in step with
 * `src/lib/tools/master-inbox/ai/corpus-pure.ts` in the workspace. If one changes,
 * change the other. There is no shared package between the two deployments.
 *
 * The only difference is how it reaches the database: the workspace goes
 * through its `osTable` allow-list, which exists to stop it writing to Master
 * Inbox tables by accident. This IS Master Inbox, so it uses the admin client
 * directly.
 */
/*
 * Turning our sent mail into something an agent can learn from.
 *
 * Pure on purpose — every judgement about what belongs in the corpus and what
 * it is worth is decided here, with no database in sight, so each rule can be
 * tested against a real example rather than argued about.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE DATA LOOKS LIKE, AND WHY THESE RULES EXIST
 *
 * Measured on the live workspace: 23,888 replies we sent, 12,944 inbound,
 * 10,367 threads. Of the 600 most recent AI drafts, 517 were never sent and 82
 * of the 83 that were followed by a real reply had been rewritten. The agent
 * had no idea how we actually answer people — this is the fix for that.
 *
 * Three findings shaped the filters:
 *
 *   1. Replies are stored HTML-encoded. "you&#039;re" and "you're" are the
 *      same sentence; comparing them raw makes every send look like an edit.
 *   2. The introduction macro accounts for a large share of what we send and
 *      is pure template. Left in, it floods retrieval and teaches the agent to
 *      improvise introductions — which is exactly the failure observed: it
 *      invented a contact where the real reply named two by title.
 *   3. Most threads end in "Not Interested" or an unsubscribe. Those are worth
 *      learning to close politely, but they must not crowd out the handful of
 *      replies that actually advanced a deal.
 */

export interface RawTurn {
  id: string;
  direction: "inbound" | "outbound";
  bodyText: string | null;
  bodyHtml: string | null;
  sentAt: string | null;
}

export interface ExamplePair {
  inboundMessageId: string;
  outboundMessageId: string;
  inboundText: string;
  replyText: string;
  sentAt: string | null;
}

/* ------------------------------------------------------------------ text */

const ENTITIES: Array<[RegExp, string]> = [
  [/&#0?39;|&apos;|&rsquo;/g, "'"],
  [/&quot;|&ldquo;|&rdquo;/g, '"'],
  [/&nbsp;|&#160;/g, " "],
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&amp;/g, "&"],
];

/**
 * A message body as a person would read it.
 *
 * Decodes the entities the providers store, strips tags when only HTML is
 * held, drops quoted history and signatures, and collapses whitespace. The
 * same function is used when comparing a draft against what was sent, so a
 * difference in encoding can never be mistaken for a human edit.
 */
export function normaliseBody(text: string | null, html?: string | null): string {
  let s = (text ?? "").trim();
  if (!s && html) {
    s = html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, " ");
  }
  for (const [re, to] of ENTITIES) s = s.replace(re, to);
  s = s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

  // Quoted history: everything from the first "On <date> … wrote:" onwards,
  // and any run of lines beginning with ">".
  s = s.split(/^\s*On .{0,80}wrote:\s*$/m)[0] ?? s;
  s = s.split(/\n-{2,}\s*Original Message\s*-{2,}/i)[0] ?? s;
  s = s.replace(/^>.*$/gm, "");

  // A sign-off and everything after it is chrome, not content.
  s = s.split(/\n\s*(?:--\s*$|Unsubscribe\b|Sent from my \w+)/m)[0] ?? s;

  return s
    .replace(/[ \t]+/g, " ")
    // Stripping tags leaves spaces hugging the breaks it just made
    // ("Hi Sam\n\n Thursday works."); a reader would not see them.
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** For comparing two bodies: case, punctuation spacing and encoding removed. */
export function comparable(text: string | null, html?: string | null): string {
  return normaliseBody(text, html).replace(/\s+/g, " ").toLowerCase().trim();
}

/**
 * How alike two bodies are, 0..1, by shared 6-character runs.
 *
 * Cheap, needs no model, and good enough to tell "sent as written" from
 * "rewritten from scratch" — which is all the verdict needs.
 */
export function similarity(a: string, b: string): number {
  const A = comparable(a), B = comparable(b);
  if (!A && !B) return 1;
  if (!A || !B) return 0;
  if (A === B) return 1;
  const grams = (s: string) => {
    const out = new Set<string>();
    for (let i = 0; i + 6 <= s.length; i++) out.add(s.slice(i, i + 6));
    if (out.size === 0) out.add(s);
    return out;
  };
  const ga = grams(A), gb = grams(B);
  let hit = 0;
  for (const g of gb) if (ga.has(g)) hit++;
  const recall = hit / gb.size;
  // Penalise a short draft that happens to be contained in a long reply.
  const lengthRatio = Math.min(A.length, B.length) / Math.max(A.length, B.length);
  return recall * (0.5 + 0.5 * lengthRatio);
}

export type Verdict = "as_written" | "light_edit" | "rewritten";

/** What a person did to the draft before sending it. */
export function verdictFor(draft: string, sent: string): { verdict: Verdict; similarity: number } {
  const s = similarity(draft, sent);
  if (comparable(draft) === comparable(sent)) return { verdict: "as_written", similarity: 1 };
  if (s >= 0.75) return { verdict: "light_edit", similarity: s };
  return { verdict: "rewritten", similarity: s };
}

/* --------------------------------------------------------------- pairing */

/**
 * Every inbound message paired with the reply that followed it.
 *
 * Turns must arrive oldest first. Consecutive inbound messages collapse — a
 * lead who writes three times before we answer is one situation, and the last
 * message is the one we actually answered.
 */
export function pairTurns(turns: RawTurn[]): ExamplePair[] {
  const out: ExamplePair[] = [];
  let pendingInbound: RawTurn | null = null;
  for (const t of turns) {
    if (t.direction === "inbound") {
      pendingInbound = t;
      continue;
    }
    if (!pendingInbound) continue; // an outbound with nothing to answer: our own opener
    const inboundText = normaliseBody(pendingInbound.bodyText, pendingInbound.bodyHtml);
    const replyText = normaliseBody(t.bodyText, t.bodyHtml);
    out.push({
      inboundMessageId: pendingInbound.id,
      outboundMessageId: t.id,
      inboundText,
      replyText,
      sentAt: t.sentAt,
    });
    pendingInbound = null; // one reply per inbound; a follow-up is a new situation
  }
  return out;
}

/* -------------------------------------------------------------- filtering */

/** Labels whose threads teach nothing worth imitating. */
const USELESS_LABELS = new Set([
  "unsubscribe",
  "do not contact",
  "add to blocklist",
  "automated response",
  "ooo sequence",
  "cold-leads",
  "form",
]);

const AUTOMATED = /\b(out of office|automatic reply|auto-?reply|do not reply|delivery has failed|undeliverable|mailer-daemon|read receipt)\b/i;
/*
 * The introduction, in every phrasing it is actually sent in.
 *
 * The first version of this matched only "I'd like to introduce you to" and
 * let "I'd like to introduce you DIRECTLY to" and "I'm going to introduce you
 * to" straight through — four of the five highest-scoring examples in the
 * first dry run were introductions. Matching the verb and its object is what
 * catches the family.
 */
const INTRO_MACRO = /\bintroduce\s+(?:you|him|her|them)\b/i;

export interface ExampleCandidate extends ExamplePair {
  label: string | null;
}

export type RejectReason =
  | "reply-too-short"
  | "reply-too-long"
  | "inbound-too-short"
  | "automated"
  | "intro-macro"
  | "useless-label"
  | "not-a-reply";

/**
 * Is this pair worth learning from?
 *
 * Returns the reason when not, so the builder can report what it skipped and
 * why rather than silently dropping most of the mailbox.
 */
export function rejectExample(c: ExampleCandidate): RejectReason | null {
  const reply = c.replyText.trim();
  const inbound = c.inboundText.trim();
  if (reply.length < 40) return "reply-too-short";
  if (reply.length > 4000) return "reply-too-long";
  if (inbound.length < 10) return "inbound-too-short";
  if (AUTOMATED.test(inbound) || AUTOMATED.test(reply)) return "automated";
  /*
   * The introduction macro is a template with a button of its own now. Kept in
   * the corpus it would dominate retrieval and teach the agent to improvise
   * introductions — the exact failure this work exists to fix.
   */
  if (INTRO_MACRO.test(reply)) return "intro-macro";
  if (c.label && USELESS_LABELS.has(c.label.toLowerCase())) return "useless-label";
  return null;
}

/* ---------------------------------------------------------------- quality */

/** Labels that mean the conversation went somewhere. */
const GOOD_OUTCOMES = new Set(["interested", "meetings booked", "introduction", "broker/owner", "information request"]);

export interface QualityInput {
  sentAt: string | null;
  label: string | null;
  /** Every label the thread carries, for outcome detection. */
  threadLabels?: string[];
  source: "history" | "correction";
  replyText: string;
  now?: Date;
}

/**
 * What an example is worth, 0..1.
 *
 * Retrieval sorts by similarity × quality, so a merely similar example never
 * outranks one that is similar AND worked. Corrections — where a person
 * rewrote the agent — are the most instructive thing we have and start high.
 */
export function qualityScore(input: QualityInput): number {
  let score = 0.4;

  // Recency: a year-old reply is worth about half a fresh one. Our pitch and
  // our objections move.
  if (input.sentAt) {
    const days = ((input.now ?? new Date()).getTime() - new Date(input.sentAt).getTime()) / 86_400_000;
    if (Number.isFinite(days) && days >= 0) score += 0.25 * Math.exp(-days / 365);
  }

  // Did the conversation go anywhere?
  const labels = (input.threadLabels ?? []).map((l) => l.toLowerCase());
  if (input.label) labels.push(input.label.toLowerCase());
  if (labels.some((l) => GOOD_OUTCOMES.has(l))) score += 0.2;

  // A reply someone took the trouble to write themselves.
  if (input.source === "correction") score += 0.3;

  // Length sanity: one-liners and essays are both poor models.
  const len = input.replyText.trim().length;
  if (len >= 120 && len <= 1200) score += 0.1;

  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

/* ------------------------------------------------------------ de-duping */

/**
 * Collapse near-identical replies.
 *
 * The same close is sent hundreds of times. Left alone, retrieval returns the
 * same boilerplate for every query and the agent learns one sentence. Keeps
 * the best `perBucket` of each group, by quality.
 */
export function dedupe<T extends { replyText: string; quality: number }>(
  rows: T[],
  perBucket = 3,
): T[] {
  const buckets = new Map<string, T[]>();
  for (const r of rows) {
    // First 80 comparable characters is a good enough fingerprint for a
    // template: the opening is what repeats.
    const key = comparable(r.replyText).slice(0, 80);
    const list = buckets.get(key) ?? [];
    list.push(r);
    buckets.set(key, list);
  }
  const out: T[] = [];
  for (const list of buckets.values()) {
    list.sort((a, b) => b.quality - a.quality);
    out.push(...list.slice(0, perBucket));
  }
  return out;
}

/* --------------------------------------------------------- vector search */

/** Cosine similarity of two equal-length vectors. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface Retrievable {
  embedding: number[] | null;
  quality: number;
  replyText: string;
}

/**
 * The examples to put in front of the model.
 *
 * Ranked by similarity × (0.6 + 0.4 × quality): closeness leads, but a good
 * answer beats a merely close one. Examples whose replies are near-identical
 * to one already chosen are skipped, so the model sees range rather than the
 * same sentence five times.
 */
export function selectExamples<T extends Retrievable>(
  query: number[],
  pool: T[],
  k = 6,
): Array<T & { score: number }> {
  const scored = pool
    .filter((p) => Array.isArray(p.embedding) && p.embedding.length > 0)
    .map((p) => {
      const sim = cosine(query, p.embedding as number[]);
      return { ...p, score: sim * (0.6 + 0.4 * p.quality) };
    })
    .sort((a, b) => b.score - a.score);

  const chosen: Array<T & { score: number }> = [];
  for (const cand of scored) {
    if (chosen.length >= k) break;
    /*
     * 0.7, not 0.8: two replies that differ only by a trailing sentence score
     * around 0.76 and are the same lesson twice. With thousands of examples,
     * being firm about variety costs nothing.
     */
    if (chosen.some((c) => similarity(c.replyText, cand.replyText) > 0.7)) continue;
    chosen.push(cand);
  }
  return chosen;
}
