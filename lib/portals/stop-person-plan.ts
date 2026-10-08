// Pure planning for "stop contacting this person" (DNC, 8 Oct). No I/O here,
// so the rules are tested without a database or a provider.
//
// WHY THIS EXISTS. Blacklisting an address on EmailBison and Instantly stops
// that ADDRESS. An audit on 8 Oct found the gaps that were still reaching
// people a client had put on their DNC list:
//
//   - the same person under another address: a client listed her personal
//     address, our campaigns emailed her work address, and she replied from
//     the personal one;
//   - "remove me" replies that stopped only the campaign they answered while
//     other campaigns kept going (51 people in 45 days).
//
// So, on top of the blacklist, every inbox conversation we can tie to the
// person is stopped: EmailBison conversations are unsubscribed by their
// latest reply id (PATCH /api/replies/{id}/unsubscribe — "unsubscribes the
// contact associated with a specific reply from scheduled emails"), and the
// address a conversation was actually sent to is blocked too.
//
// A conversation found only because the person SENT a reply on it is
// someone else's conversation unless the names agree: on an introduced
// thread the client's own people reply too, and blocking the lead there
// would stop the very recruit the client is talking to. Those are left alone
// and listed for a person to review.

export interface PersonConversation {
  threadId: string;
  provider: string | null;
  /** The address our campaign emailed (the conversation's lead). */
  leadEmail: string | null;
  leadName: string | null;
  /** The newest inbound EmailBison reply id on the conversation, if any. */
  latestReplyId: string | null;
  /** Of the addresses looked up, those that sent a reply on this conversation. */
  senders: string[];
}

export interface Person {
  /** Every address known to be this person's. */
  emails: string[];
  name: string | null;
}

export interface StopPlan {
  /** EmailBison reply ids to unsubscribe — one per conversation, deduplicated. */
  unsubscribeReplyIds: string[];
  /** The person's OTHER addresses (not the ones given) to block on both platforms. */
  otherEmails: string[];
  /** Conversations the person replied on whose lead has another name: left alone. */
  review: Array<{ threadId: string; leadEmail: string | null; leadName: string | null }>;
}

export const normEmail = (e: string | null | undefined): string => (e ?? "").trim().toLowerCase();

/** Escapes LIKE wildcards so an address is matched exactly (case-insensitively). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const looksLikeEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

/**
 * An address we may put on a blocklist: a real-looking address that is not a
 * mail system's (bounces and auto-replies arrive from these, and blocking one
 * would block nobody useful).
 */
export function isBlockableAddress(e: string | null | undefined): boolean {
  const a = normEmail(e);
  if (!looksLikeEmail(a)) return false;
  return !/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?)([+.@-]|$)/.test(a);
}

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "pa", "realtor", "broker", "mba", "esq"]);
function nameTokens(name: string | null | undefined): string[] {
  return (name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s'-]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^['-]+|['-]+$/g, ""))
    .filter((t) => t.length > 1 && !SUFFIXES.has(t));
}

/**
 * Two names are the same person's when both have a first and a last name and
 * those agree. Deliberately strict — a miss is only left for review, a false
 * match would stop someone else.
 */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = nameTokens(a);
  const y = nameTokens(b);
  if (x.length < 2 || y.length < 2) return false;
  return x[0] === y[0] && x[x.length - 1] === y[y.length - 1];
}

export function planStop(person: Person, conversations: PersonConversation[]): StopPlan {
  const selves = new Set(person.emails.map(normEmail).filter(Boolean));
  const replyIds = new Set<string>();
  const others = new Set<string>();
  const review: StopPlan["review"] = [];
  for (const c of conversations) {
    const lead = normEmail(c.leadEmail);
    const viaLead = !!lead && selves.has(lead);
    const viaSender = c.senders.some((s) => selves.has(normEmail(s)));
    if (!viaLead && !viaSender) continue;
    if (!viaLead && !sameName(person.name, c.leadName)) {
      review.push({ threadId: c.threadId, leadEmail: c.leadEmail, leadName: c.leadName });
      continue;
    }
    if (c.provider === "emailbison" && c.latestReplyId && /^\d+$/.test(String(c.latestReplyId))) {
      replyIds.add(String(c.latestReplyId));
    }
    if (!viaLead && isBlockableAddress(lead)) others.add(lead);
  }
  return { unsubscribeReplyIds: [...replyIds], otherEmails: [...others].sort(), review };
}

/**
 * The labels that mean "stop contacting this person". "Hostile" was the only
 * one wired before 8 Oct; "Unsubscribe" — 547 conversations in 30 days, by the
 * AI and by people — did nothing on the sending platforms.
 */
const STOP_LABELS = new Set(["hostile", "unsubscribe", "do not contact", "add to blocklist"]);

export function isStopContactLabel(name: string | null | undefined): boolean {
  return STOP_LABELS.has((name ?? "").trim().toLowerCase());
}

/**
 * EmailBison answers 422 when an address is already on its blacklist. That is
 * the outcome we wanted, not a failure: the 8 Oct audit found every one of the
 * 381 rows marked "422" already on the list.
 */
export function alreadyBlacklisted(status: number | undefined, body: unknown): boolean {
  if (status !== 422) return false;
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  return /already|taken|exists|duplicate/i.test(text);
}
