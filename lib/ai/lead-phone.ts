import type { ConversationTurn } from "@/lib/ai/reply";

/*
 * The lead's own phone number, taken from the conversation.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CONVERSATION BEATS THE RECORD
 *
 * The enrichment payload's number was scraped from a listing and can be a
 * years-old office line. When a lead writes back, their signature carries the
 * number they actually answer — and if they typed one into the body, that is
 * the number they are asking to be called on. The record is the fallback, not
 * the source.
 *
 * ---------------------------------------------------------------------------
 * THE TRAP: AN INBOUND MESSAGE CONTAINS OUR OWN WORDS
 *
 * Email clients quote the message being replied to, so an inbound body very
 * often ends with our previous email — signature and all. Measured on real
 * threads, one inbound message contained "Can you confirm that (602) 625-4675
 * is the best number to reach you", which is OUR agent's own sentence about
 * someone else's number, sitting inside the lead's reply.
 *
 * So two defences, both necessary:
 *   1. quoted blocks are stripped before scanning
 *   2. any number that also appears in an OUTBOUND turn is discarded outright
 *
 * Getting this wrong does not throw. It puts a stranger's phone number in an
 * email to a client's prospect.
 *
 * ---------------------------------------------------------------------------
 * LABELS DECIDE WHICH NUMBER, WHEN THERE ARE SEVERAL
 *
 * A realtor's signature routinely carries three: "Cell 770 654-0956 Office 770
 * 271-5555", "m. 919-449-8020 o. 954-799-5182", "Main: 804-270-9440 Direct:
 * 804-967-2778". The one to ring is the mobile, so a labelled mobile wins, a
 * labelled office loses to it, and an unlabelled number sits between them.
 */

/*
 * North-American shapes, which is all this estate sends to.
 *
 * SEPARATORS ARE SPACE, DOT AND HYPHEN — deliberately not \s, which matches a
 * NEWLINE. With \s this fused a licence number and a street number on adjacent
 * lines ("*CalBRE # *01316711" / "6641 West Broad St") into "1316711 6641" and
 * offered it to a lead as their phone number.
 *
 * The lookarounds stop a ten-digit run being cut out of a longer one, which is
 * how an order number or a tracking code becomes a phone call.
 */
const PHONE = /(?<!\d)(?:\+?1[ .\-]?)?\(?(\d{3})\)?[ .\-]?(\d{3})[ .\-]?(\d{4})(?!\d)/g;

const MOBILE_LABEL = /\b(cell|mobile|mob|direct|c|m)\b[\s.:]*$/i;
const OFFICE_LABEL = /\b(office|main|fax|o|tel|phone)\b[\s.:]*$/i;

export interface FoundPhone {
  /** As it should be written back to the lead — their own formatting, kept. */
  phone: string;
  /** Digits only, for comparison. */
  digits: string;
  source: "lead-message" | "lead-signature" | "record";
  /** What labelled it, when something did. */
  label: "mobile" | "office" | null;
}

/** Ten digits, or eleven starting with a US country code. */
export function normalisePhone(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d;
}

/**
 * Everything the lead did not write: quoted replies, forwarded blocks, and the
 * signature we attached to our own message underneath theirs.
 *
 * Conservative on purpose. Cutting too much loses a number the lead typed;
 * cutting too little keeps ours. Both are bad, so this only removes what is
 * unambiguously a quotation marker.
 */
export function stripQuoted(body: string): string {
  const lines = body.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    // "On Mon, 21 Sept 2026, 23:44, Alex Williams wrote:" and its variants.
    if (/^on\s.{4,120}\swrote:\s*$/i.test(t)) break;
    // Outlook's block, and forwarded headers.
    if (/^-{2,}\s*(original message|forwarded message)\s*-{2,}$/i.test(t)) break;
    if (/^(from|sent|to|subject):\s/i.test(t) && kept.length > 2) break;
    // Quoted lines.
    if (t.startsWith(">")) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

function labelBefore(text: string, index: number): "mobile" | "office" | null {
  // The 14 characters before a number carry "Cell", "m.", "Office:", "o."
  const before = text.slice(Math.max(0, index - 14), index);
  if (MOBILE_LABEL.test(before)) return "mobile";
  if (OFFICE_LABEL.test(before)) return "office";
  return null;
}

/**
 * The best phone number for this lead, or null.
 *
 * `recordPhone` is whatever the lead row holds and is used only when the
 * conversation offers nothing.
 */
export function findLeadPhone(
  conversation: ConversationTurn[],
  recordPhone?: string | null,
): FoundPhone | null {
  /*
   * Ours first, so it can be excluded. Taken from the FULL outbound body,
   * unstripped — our signature is exactly what we are trying to recognise.
   */
  const ours = new Set<string>();
  for (const turn of conversation) {
    if (turn.direction !== "outbound") continue;
    for (const m of String(turn.body ?? "").matchAll(PHONE)) {
      ours.add(normalisePhone(m[0]));
    }
  }

  const candidates: FoundPhone[] = [];
  // Newest first: a number given in the latest reply supersedes an older one.
  for (const turn of [...conversation].reverse()) {
    if (turn.direction !== "inbound") continue;
    const body = stripQuoted(String(turn.body ?? ""));
    for (const m of body.matchAll(PHONE)) {
      const digits = normalisePhone(m[0]);
      if (digits.length !== 10) continue;
      if (ours.has(digits)) continue; // our own number, quoted back at us
      if (candidates.some((c) => c.digits === digits)) continue;
      candidates.push({
        phone: m[0].trim(),
        digits,
        source: "lead-signature",
        label: labelBefore(body, m.index ?? 0),
      });
    }
    /*
     * One message at a time. The newest inbound that offers ANY number wins;
     * scanning further back only to prefer an older office line would be worse
     * than taking the unlabelled number they just sent.
     */
    if (candidates.length) break;
  }

  if (candidates.length) {
    const mobile = candidates.find((c) => c.label === "mobile");
    const unlabelled = candidates.find((c) => c.label === null);
    return mobile ?? unlabelled ?? candidates[0];
  }

  if (recordPhone && normalisePhone(recordPhone).length >= 10) {
    return {
      phone: recordPhone,
      digits: normalisePhone(recordPhone),
      source: "record",
      label: null,
    };
  }
  return null;
}
