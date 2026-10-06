/*
 * An opening line from the lead's own reply (client feedback, 6 Oct: "ideally
 * adapt the intro copy using the lead's most recent reply").
 *
 * Opt-in, from the composer, after the introduction is inserted: one sentence
 * that acknowledges something the lead actually said, placed under the
 * greeting. The operator reads it in the draft before anything is sent, and
 * the rest of the introduction is untouched. Pure — the route calls the model.
 */

export const OPENER_SYSTEM = `You write ONE opening sentence for a short email that introduces a real-estate agent (the lead) to a brokerage's team.

You are given the lead's most recent reply. Write a single warm, natural sentence (at most 25 words) that acknowledges something specific they said in it.

Rules:
- Only what the reply actually says. Never invent facts, numbers, places or names.
- No greeting, no sign-off, no question, no promise, no emoji, no quotation marks.
- Address the lead as "you" — do not use their name.
- Only acknowledge what they said. Do not mention yourself, the team, the introduction or what happens next — the rest of the email does that.
- Answer exactly NONE when the reply declines, says not interested, asks to be removed or to stop, is an out-of-office or auto-reply, or has nothing specific worth acknowledging (a bare "yes", "sure", "ok"). This line goes into an introduction, so it only fits a lead who wants to talk.`;

export function openerUserPrompt(reply: string): string {
  return `The lead's most recent reply:\n"""\n${reply.slice(0, 3000)}\n"""\n\nThe opening sentence:`;
}

/** The model's answer as one usable sentence, or null. */
export function cleanOpener(raw: string | null | undefined): string | null {
  let t = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!t || /^none\.?$/i.test(t)) return null;
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  if (/^(hi|hey|hello|dear)\b/i.test(t)) return null;
  if (t.length > 240 || t.includes("{{")) return null;
  // A safety net under the prompt: never a promise, and never a reply to a refusal.
  if (/\b(I|we)('ll| will| shall)\b|\bensure\b|\bremov|\bunsubscrib|\bnot interested\b|\b(your|our|the|my) (mailing )?list\b|\bstop\b/i.test(t)) return null;
  if (!/[.!]$/.test(t)) t += ".";
  return t;
}

/**
 * The introduction with the line placed under its greeting (the first line
 * that has text). Already there: unchanged, so pressing twice adds it once.
 */
export function withOpener(body: string, line: string): string {
  if (!line.trim() || body.includes(line)) return body;
  const lines = body.split("\n");
  const g = lines.findIndex((l) => l.trim());
  if (g < 0) return line;
  const rest = lines.slice(g + 1).join("\n").replace(/^\n+/, "");
  return [...lines.slice(0, g + 1), "", line, "", rest].join("\n").replace(/\n{3,}/g, "\n\n");
}
