// Reply Agent — generates a draft response to an inbound reply. Provider-
// agnostic with the same shape as label.ts: OpenAI / Anthropic / OpenRouter /
// vLLM all behave consistently. The draft is plain-text so the composer can
// rewrap it as HTML on send.

import type { AiProvider } from "./label";

// Hard max completion tokens per known model. Reply drafts almost never
// need more than ~2k tokens, but if the user sets a higher budget we still
// have to respect the model's API cap to avoid 400s.
const MODEL_MAX_COMPLETION: Record<string, number> = {
  "gpt-4o-mini": 16_384,
  "gpt-4o": 16_384,
  "gpt-4.1-mini": 32_768,
  "gpt-4.1": 32_768,
  "gpt-5-mini": 128_000,
  "gpt-5": 128_000,
  "claude-haiku-4-5-20251001": 64_000,
  "claude-haiku-4-5": 64_000,
  "claude-sonnet-4-6": 64_000,
  "claude-opus-4-7": 32_000,
};

function clampMaxTokens(model: string, requested: number): number {
  const cap = MODEL_MAX_COMPLETION[model];
  if (cap && requested > cap) return cap;
  return requested;
}

// One turn in the email thread. Direction is from OUR perspective:
//   - inbound  = sent by the lead
//   - outbound = sent by us (BrokerStaffer)
/**
 * One thing we already know about this lead, ready to put in a prompt.
 *
 * A label/value pair rather than the raw custom_fields object: enrichment uses
 * keys like "office city" that read fine to a model, alongside "buy-side" and
 * "approx gci" that must never reach one.
 */
export interface LeadFact {
  label: string;
  value: string;
}

export interface ConversationTurn {
  direction: "inbound" | "outbound";
  sentAt: string | null;
  body: string;
}

export interface DraftInput {
  provider: AiProvider;
  apiKey: string;
  model: string;
  systemPrompt: string;
  tone: string;
  responseLength: "short" | "medium" | "long" | "variable";
  temperature: number;
  maxTokens: number;
  // Context the model needs to write a relevant reply.
  leadName: string | null;
  leadEmail: string | null;
  /*
   * WHAT WE ALREADY KNOW ABOUT THIS PERSON.
   *
   * Absent, the model asks for it. A real draft reached a real lead reading
   * "Can you confirm that (your phone number) is the best number to reach you?
   * Also, are you currently affiliated with a brokerage?" — while the record
   * held both. The parenthetical was not a broken template variable; it was
   * the model writing around a fact nobody had given it.
   */
  leadPhone?: string | null;
  leadCompany?: string | null;
  leadTitle?: string | null;
  leadFacts?: LeadFact[];
  ourName: string | null;
  ourEmail: string | null;
  subject: string | null;
  // Full thread history, oldest → newest. The last entry should be the
  // most recent inbound message (the one we're replying to).
  conversation: ConversationTurn[];
  /*
   * The house style, the objection playbook and the nearest real replies we
   * have sent, already rendered as prompt text by ai/retrieval.ts.
   *
   * Optional and empty-by-default on purpose: when the corpus has not been
   * built, or retrieval fails for any reason, this is "" and the prompt is
   * byte-for-byte what it was before this feature existed. There is no flag to
   * forget to set — absence IS the old behaviour.
   */
  guidance?: string;
}

export interface DraftResult {
  body: string;
  tokensPrompt: number | null;
  tokensCompletion: number | null;
}

export async function generateReplyDraft(input: DraftInput): Promise<DraftResult> {
  const userPrompt = renderUserPrompt(input);

  if (input.provider === "openai" || input.provider === "openrouter" || input.provider === "vllm") {
    return openaiCompatible(input, userPrompt);
  }
  return anthropic(input, userPrompt);
}

// Per-message body cap (chars). Long emails get truncated to keep the
// prompt under the model's effective context. Newest messages keep more
// room than older ones in the dropping logic below.
const PER_TURN_CAP = 3000;
// Total conversation cap (chars). If the formatted history exceeds this,
// we drop turns from the OLDEST end (but always keep the most recent
// inbound — that's what we're replying to).
const TOTAL_CONVERSATION_CAP = 24_000;

function renderUserPrompt(input: DraftInput): string {
  const lengthHint =
    input.responseLength === "short"
      ? "Keep it under 2 sentences."
      : input.responseLength === "long"
        ? "Use 2-3 short paragraphs."
        : input.responseLength === "variable"
          ? "Match the lead's message length and tone — keep it short if they were brief, expand if they wrote a longer message."
          : "One short paragraph (3-5 sentences).";

  const conversationBlock = formatConversation(input.conversation, input.leadName, input.ourName);

  return [
    `You are responding to a sales-outreach email thread. Below is the FULL conversation so far between us and the lead.`,
    `Tone: ${input.tone}.`,
    lengthHint,
    "Write ONLY the reply body — no greeting line, no sign-off, no subject line, no preamble.",
    "",
    `Lead name: ${input.leadName ?? "the lead"}`,
    ...renderKnownFacts(input),
    `Your name (the sender): ${input.ourName ?? "You"}`,
    `Subject thread: ${input.subject ?? "(no subject)"}`,
    "",
    conversationBlock,
    "",
    /*
     * Precedent goes AFTER the conversation and immediately BEFORE the
     * instruction to write. The nearest real reply is the most useful thing in
     * the prompt, and it should be the last thing read before writing.
     */
    ...(input.guidance && input.guidance.trim().length > 0 ? [input.guidance, ""] : []),
    "Now write OUR reply to the LAST message above. Use the full conversation as context — reference what was already discussed, do not repeat past pitches, and respond directly to the lead's most recent message.",
  ].join("\n");
}

// Build a chronological transcript the model can follow. Format favours
// clarity over compactness: each turn is delimited by a header row that
// names the speaker, the date, and the turn number, so the model can refer
// back ("as you mentioned in [2]…") naturally.
/**
 * What we already know, and what the model must do with it.
 *
 * Returns nothing when we know nothing beyond a name — an empty heading reads
 * as though the record is blank, which is a different and more alarming claim
 * than silence.
 *
 * NO EXAMPLE VALUE APPEARS IN THE INSTRUCTION. The first version of this
 * illustrated the rule with a real lead's number, and the model copied that
 * number verbatim into a draft for a different lead whose prompt never
 * contained it. An example in a prompt is not an illustration. It is content.
 */
function renderKnownFacts(input: DraftInput): string[] {
  const known: string[] = [];
  if (input.leadEmail) known.push(`Email: ${input.leadEmail}`);
  if (input.leadPhone) known.push(`Phone: ${input.leadPhone}`);
  if (input.leadCompany) known.push(`Company / brokerage: ${input.leadCompany}`);
  if (input.leadTitle) known.push(`Title: ${input.leadTitle}`);
  for (const fact of input.leadFacts ?? []) known.push(`${fact.label}: ${fact.value}`);

  if (!known.length) return [];

  return [
    "",
    "WHAT WE ALREADY KNOW ABOUT THIS LEAD:",
    ...known.map((k) => `  - ${k}`),
    "",
    "Do NOT ask for anything listed above — we already have it. Where such a detail matters to the " +
      "reply, repeat the exact value from the list so the lead can confirm or correct it, rather than " +
      "asking them to supply it. Never write a bracketed placeholder in place of a value: if a detail " +
      "is not in the list above, ask for it in plain words instead.",
  ];
}

function formatConversation(
  turns: ConversationTurn[],
  leadName: string | null,
  ourName: string | null,
): string {
  if (turns.length === 0) {
    return "Conversation so far: (no messages yet)";
  }

  // Cap each turn's body up-front so per-turn cost is bounded.
  const capped = turns.map((t) => ({
    direction: t.direction,
    sentAt: t.sentAt,
    body: (t.body ?? "").slice(0, PER_TURN_CAP).trim(),
  }));

  // Drop oldest turns until the formatted total fits the cap. Always keep
  // the final turn (the message we're replying to). If even the final
  // turn alone is over cap, the per-turn cap has already trimmed it.
  let working = capped.slice();
  while (working.length > 1 && formatChars(working) > TOTAL_CONVERSATION_CAP) {
    working.shift();
  }

  const leadLabel = leadName ?? "LEAD";
  const usLabel = ourName ?? "US";
  const lines: string[] = ["Conversation so far (oldest → newest):", ""];
  working.forEach((t, idx) => {
    const isLast = idx === working.length - 1;
    const who = t.direction === "inbound" ? leadLabel : usLabel;
    const tag = t.direction === "inbound" ? "LEAD" : "US";
    const when = t.sentAt ? ` — ${formatDate(t.sentAt)}` : "";
    const recent = isLast && t.direction === "inbound" ? " (most recent — reply to this)" : "";
    lines.push(`[${idx + 1}] ${tag} (${who})${when}${recent}:`);
    lines.push(t.body || "(empty body)");
    lines.push("");
  });
  return lines.join("\n");
}

function formatChars(turns: ConversationTurn[]): number {
  return turns.reduce((n, t) => n + (t.body?.length ?? 0) + 80, 0); // +80 for header overhead
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

async function openaiCompatible(input: DraftInput, userPrompt: string): Promise<DraftResult> {
  const baseUrl =
    input.provider === "openrouter"
      ? "https://openrouter.ai/api/v1"
      : "https://api.openai.com/v1";
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      temperature: input.temperature,
      max_tokens: clampMaxTokens(input.model, input.maxTokens),
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AI provider returned ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const body = (json.choices?.[0]?.message?.content ?? "").trim();
  return {
    body,
    tokensPrompt: json.usage?.prompt_tokens ?? null,
    tokensCompletion: json.usage?.completion_tokens ?? null,
  };
}

async function anthropic(input: DraftInput, userPrompt: string): Promise<DraftResult> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: clampMaxTokens(input.model, input.maxTokens),
      temperature: input.temperature,
      system: input.systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic returned ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const body = (json.content?.find((b) => b.type === "text")?.text ?? "").trim();
  return {
    body,
    tokensPrompt: json.usage?.input_tokens ?? null,
    tokensCompletion: json.usage?.output_tokens ?? null,
  };
}

export const DEFAULT_REPLY_SYSTEM_PROMPT = `You are an outbound-sales rep
responding to inbound replies from leads. Your goal is to keep momentum
toward a meeting without sounding pushy.

Guidelines:
- Be direct, warm, and concise.
- Mirror the lead's tone (formal vs casual).
- If the lead is interested, propose a concrete next step (e.g. 15-min
  intro call this week, calendar link, a deck).
- If the lead asks a factual question, answer it briefly before pivoting
  to the next step.
- If the lead is hesitant or asks for later, acknowledge and offer to
  reach back out at the requested time.
- Never repeat the original pitch verbatim.
- Plain text only. No subject, no greeting, no sign-off — just the body.`;
