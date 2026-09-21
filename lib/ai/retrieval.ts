/*
 * Copied from BrokerStaffer OS, deliberately.
 *
 * Both apps read the same database and must draft from the same corpus and
 * judge edits by the same rule, so this file is kept in step with
 * `src/lib/tools/master-inbox/ai/retrieval.ts` in the workspace. If one changes, change
 * the other. There is no shared package between the two deployments.
 *
 * The only difference is how it reaches the database: the workspace goes
 * through its `osTable` allow-list, which exists to stop it writing to Master
 * Inbox tables by accident. This IS Master Inbox, so it uses the admin client
 * directly.
 */
import "server-only";

import { createAdminSupabase } from "@/lib/supabase/admin";
import { ttlCache } from "@/lib/cache/ttl";
import { selectExamples, type Retrievable } from "./corpus-pure";
import { embedOne } from "./embeddings";
import { loadKnowledge } from "./knowledge";
import type { AiProvider } from "./label";

/*
 * What the agent gets to read before it writes.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS SOLVES
 *
 * The old agent wrote from a bare prompt and its record says so: of 600 drafts,
 * 517 were never sent, and of the 83 that were, 82 were rewritten by hand. Not
 * one went out as written. It was not a bad model — it simply had no idea how
 * this company answers people, so it invented a house style every time.
 *
 * Three things are put in front of it here, in order of how specific they are:
 *
 *   1. the thread itself      — already handled in reply.ts, which renders the
 *                               full conversation; nothing to add
 *   2. the nearest precedents — the real replies we sent to the most similar
 *                               inbound messages we have ever received
 *   3. the standing rules     — the distilled style guide and objection
 *                               playbook, which say what is true EVERY time
 *
 * ---------------------------------------------------------------------------
 * EVERYTHING HERE FAILS SOFT, ON PURPOSE
 *
 * This code sits on the path of a button a person is waiting on. An empty
 * corpus, an un-run migration, a missing OpenAI key or a slow embedding must
 * all degrade to "no extra context" — which is exactly today's behaviour — and
 * never to an error. `gatherGuidance` therefore catches everything and reports
 * what it managed in `source`, so the screen can say why a draft was thin
 * rather than leaving it to be guessed at.
 *
 * ---------------------------------------------------------------------------
 * WHY THE POOL IS HELD IN MEMORY
 *
 * Cosine is computed in process — there is no pgvector (see the migration for
 * why). That means every candidate's vector has to be here. The corpus is
 * ~1,300 examples at 1,536 dimensions, about 15 MB of JavaScript numbers, and
 * it only changes when somebody presses Rebuild. Fetching 15 MB of JSON per
 * draft would make the button slower than the model; loading it once per
 * process and refreshing every ten minutes costs one read an hour in practice.
 *
 * `staleMs` is set so the refresh never blocks a draft: past the TTL the last
 * pool is served immediately and the new one loads behind it.
 */

/** How many real replies to show the model. */
const DEFAULT_K = 5;
/** Longest inbound text worth embedding — beyond this it is a forwarded chain. */
const QUERY_CAP = 4000;

export interface GuidanceExample {
  label: string | null;
  inbound: string;
  reply: string;
  quality: number;
  /** similarity × quality, as `selectExamples` ranks it. */
  score: number;
}

export interface Guidance {
  examples: GuidanceExample[];
  styleGuide: string | null;
  objectionPlaybook: string | null;
  /*
   * How the examples were found:
   *   "embedding" — cosine over the embedded inbound message. The good path.
   *   "label"     — no embedding was possible, so the best examples for this
   *                 thread's situation were used instead. Coarse but real.
   *   "none"      — nothing was retrieved. The draft is written as it is today.
   */
  source: "embedding" | "label" | "none";
  /** Why, in a sentence, when `source` is not "embedding". Never shown to the model. */
  note: string | null;
  /** How many examples were in the pool that was searched. */
  poolSize: number;
}

export const EMPTY_GUIDANCE: Guidance = {
  examples: [],
  styleGuide: null,
  objectionPlaybook: null,
  source: "none",
  note: null,
  poolSize: 0,
};

/* ------------------------------------------------------------------- pool */

interface PoolRow extends Retrievable {
  label: string | null;
  inboundText: string;
  replyText: string;
  quality: number;
  embedding: number[] | null;
}

/*
 * Every embedded example for a workspace.
 *
 * Paged: PostgREST caps a response at 1,000 rows server-side and a Range header
 * can only shrink that cap, never raise it — the corpus is larger than one page
 * and asking for `.range(0, 5000)` would silently return the first thousand.
 */
async function readPool(workspaceId: string): Promise<PoolRow[]> {
  const out: PoolRow[] = [];
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await createAdminSupabase().from("os_reply_examples")
      .select("label, inbound_text, reply_text, quality, embedding")
      .eq("workspace_id", workspaceId)
      .not("embedding", "is", null)
      .order("quality", { ascending: false })
      .range(from, from + 999);
    /*
     * A missing table is the expected state before migrations/0006 has been
     * run, not an exception. Same for any other read failure: an empty pool is
     * a correct answer here — it means "no precedent available".
     */
    if (error) {
      console.warn("[ai:retrieval] corpus unreadable:", error.message);
      return out;
    }
    const rows = (data ?? []) as Array<{
      label: string | null; inbound_text: string; reply_text: string;
      quality: number; embedding: number[] | null;
    }>;
    for (const r of rows) {
      out.push({
        label: r.label,
        inboundText: r.inbound_text,
        replyText: r.reply_text,
        quality: Number(r.quality) || 0,
        embedding: Array.isArray(r.embedding) ? r.embedding : null,
      });
    }
    if (rows.length < 1000) break;
  }
  return out;
}

/*
 * Ten minutes. The corpus changes only when somebody presses Rebuild in the
 * workspace, and `invalidatePool()` is called there — so the TTL is a backstop
 * for other processes, not the primary freshness mechanism.
 *
 * The workspace's copy of this line also passes `staleMs`, which serves a stale
 * pool while refreshing behind it. This app's `ttlCache` has no such option,
 * and adding one would change a utility that live inbox code depends on for a
 * saving of a few hundred milliseconds once every ten minutes. Not worth it.
 * The only visible difference is that one draft per ten minutes waits for the
 * read instead of using a stale pool.
 */
const cachedPool = ttlCache(readPool, { ttlMs: 600_000, inflightTimeoutMs: 30_000 });

/** Drop the cached pool — called after a rebuild so the next draft sees it. */
export function invalidatePool(workspaceId?: string): void {
  if (workspaceId) cachedPool.invalidate(workspaceId);
  else cachedPool.invalidate();
}

/*
 * The thread's first label, or "".
 *
 * Two reads against Master Inbox's own tables, both SELECTs — this module never
 * writes to them. Deliberately called only from the fallback branch: on the
 * normal path cosine over the embedding is strictly better information, and
 * these queries would be pure cost on a button someone is waiting on.
 */
async function readThreadLabel(threadId: string | null | undefined): Promise<string> {
  if (!threadId) return "";
  try {
    const admin = createAdminSupabase();
    const { data: assigned } = await admin
      .from("label_assignments")
      .select("label_id")
      .eq("target_type", "thread")
      .eq("target_id", threadId)
      .limit(1)
      .maybeSingle();
    const labelId = (assigned?.label_id as string | undefined) ?? null;
    if (!labelId) return "";
    const { data: label } = await admin.from("labels").select("name").eq("id", labelId).maybeSingle();
    return (label?.name as string | undefined) ?? "";
  } catch {
    return "";
  }
}

/* -------------------------------------------------------------- gathering */

export interface GuidanceInput {
  workspaceId: string;
  /** The inbound message being answered, already normalised for reading. */
  inboundText: string;
  /*
   * The thread being answered. Only read on the FALLBACK path, to find the
   * thread's situation label — so the normal cosine path costs no extra query.
   */
  threadId?: string | null;
  /** The drafting agent's provider and key. Embeddings need an OpenAI key. */
  provider: AiProvider;
  apiKey: string | null;
  k?: number;
}

/**
 * Collect the precedent and the rules for one draft. Never throws.
 */
export async function gatherGuidance(input: GuidanceInput): Promise<Guidance> {
  const k = input.k ?? DEFAULT_K;
  let styleGuide: string | null = null;
  let objectionPlaybook: string | null = null;

  // The two documents are small and independent of the examples; a failure to
  // read them must not cost us the examples, so they are caught separately.
  try {
    const knowledge = await loadKnowledge(input.workspaceId);
    styleGuide = knowledge.styleGuide?.trim() || null;
    objectionPlaybook = knowledge.objectionPlaybook?.trim() || null;
  } catch (err) {
    console.warn("[ai:retrieval] knowledge unreadable:", err instanceof Error ? err.message : err);
  }

  let pool: PoolRow[] = [];
  try {
    pool = await cachedPool(input.workspaceId);
  } catch (err) {
    console.warn("[ai:retrieval] pool unreadable:", err instanceof Error ? err.message : err);
  }

  if (pool.length === 0) {
    return { ...EMPTY_GUIDANCE, styleGuide, objectionPlaybook, note: "the corpus is empty — run a rebuild" };
  }

  /*
   * Embedding needs an OpenAI key specifically. Both live agents are OpenAI, so
   * this is the normal path — but an agent pointed at Anthropic or OpenRouter
   * holds a key that api.openai.com would reject, and sending it there would
   * leak a credential to the wrong vendor as well as failing. So the provider
   * is checked, not attempted.
   */
  const canEmbed = input.provider === "openai" && !!input.apiKey;
  const query = input.inboundText.trim().slice(0, QUERY_CAP);

  if (canEmbed && query.length > 0) {
    try {
      const vector = await embedOne(input.apiKey!, query);
      if (vector) {
        const chosen = selectExamples(vector, pool, k);
        return {
          examples: chosen.map((c) => ({
            label: c.label, inbound: c.inboundText, reply: c.replyText,
            quality: c.quality, score: Number(c.score.toFixed(4)),
          })),
          styleGuide,
          objectionPlaybook,
          source: "embedding",
          note: null,
          poolSize: pool.length,
        };
      }
    } catch (err) {
      // A provider hiccup falls through to the label path rather than failing
      // the draft. The draft is what the person is waiting for.
      console.warn("[ai:retrieval] embedding failed:", err instanceof Error ? err.message : err);
    }
  }

  /*
   * The fallback: the best examples for this thread's situation.
   *
   * Much coarser than cosine — "Objection" covers a dozen different objections
   * — but it is still real precedent in the house voice, which is the thing the
   * old agent was missing entirely. Better than nothing by a wide margin.
   */
  const wanted = (await readThreadLabel(input.threadId)).trim().toLowerCase();
  const byLabel = wanted ? pool.filter((p) => (p.label ?? "").toLowerCase() === wanted) : [];
  const picked = (byLabel.length > 0 ? byLabel : pool).slice(0, k);
  return {
    examples: picked.map((p) => ({
      label: p.label, inbound: p.inboundText, reply: p.replyText,
      quality: p.quality, score: 0,
    })),
    styleGuide,
    objectionPlaybook,
    source: "label",
    note: canEmbed
      ? "the inbound message could not be embedded — fell back to the best examples for this situation"
      : `embeddings need an OpenAI key; this agent is ${input.provider} — fell back to the best examples for this situation`,
    poolSize: pool.length,
  };
}

/* --------------------------------------------------------------- prompting */

/** Longest example reply to show. Anything longer is an essay, not a model. */
const EXAMPLE_REPLY_CAP = 900;
const EXAMPLE_INBOUND_CAP = 600;

/**
 * The guidance as prompt text, or "" when there is none.
 *
 * Deliberately appended to the USER prompt rather than the system prompt: the
 * agent's own system prompt is configured per-agent on the Settings screen, and
 * quietly rewriting it would make that screen lie about what the agent is told.
 *
 * The examples come LAST, immediately before the instruction to write. Position
 * matters — the nearest real reply is the single most useful thing in the
 * prompt and it should be the last thing read before writing.
 */
export function renderGuidance(g: Guidance): string {
  const parts: string[] = [];

  if (g.styleGuide) {
    parts.push(
      "=== HOUSE STYLE — these rules are how we always write. Follow them. ===",
      g.styleGuide,
    );
  }
  if (g.objectionPlaybook) {
    parts.push(
      "=== OBJECTION PLAYBOOK — how we answer each kind of pushback. ===",
      g.objectionPlaybook,
    );
  }
  if (g.examples.length > 0) {
    parts.push(
      "=== REAL REPLIES WE HAVE SENT to messages like this one ===",
      /*
       * Said out loud because a model handed example text will otherwise lift
       * names, numbers and offers straight out of it. The old agent's worst
       * failure was exactly this: it invented a contact because an example had
       * one. Copy the MANNER, not the MATTER.
       */
      "Match their voice, length and structure. Do NOT copy their facts — names,",
      "companies, numbers and offers in these examples belong to other conversations.",
      "",
      ...g.examples.map((e, i) =>
        [
          `--- Precedent ${i + 1}${e.label ? ` (situation: ${e.label})` : ""}`,
          `THEY WROTE: ${e.inbound.replace(/\s+/g, " ").slice(0, EXAMPLE_INBOUND_CAP)}`,
          `WE REPLIED: ${e.reply.replace(/\s+/g, " ").slice(0, EXAMPLE_REPLY_CAP)}`,
        ].join("\n"),
      ),
    );
  }

  return parts.length > 0 ? parts.join("\n") : "";
}
