/*
 * Copied from BrokerStaffer OS, deliberately.
 *
 * Both apps read the same database and must draft from the same corpus and
 * judge edits by the same rule, so this file is kept in step with
 * `src/lib/tools/master-inbox/ai/embeddings.ts` in the workspace. If one changes,
 * change the other. There is no shared package between the two deployments.
 *
 * The only difference is how it reaches the database: the workspace goes
 * through its `osTable` allow-list, which exists to stop it writing to Master
 * Inbox tables by accident. This IS Master Inbox, so it uses the admin client
 * directly.
 */
import "server-only";

/*
 * Embeddings — turning a message into a vector so we can find the times we
 * have answered something like it before.
 *
 * `text-embedding-3-small`: 1536 dimensions, and about ten cents for the whole
 * 24,000-reply history. The dimension count is not hardcoded anywhere — the
 * comparison is cosine over whatever comes back — so switching model later
 * only means re-running the builder.
 *
 * Only the inbound message is embedded. We are matching on the SITUATION
 * ("they say they're happy where they are"), not on the answer; embedding our
 * own replies would retrieve things that sound like the draft rather than
 * things that fit the problem.
 */

const ENDPOINT = "https://api.openai.com/v1/embeddings";
const MODEL = "text-embedding-3-small";
/** The API's own cap is 8191 tokens; ~8k characters is comfortably inside it. */
const MAX_CHARS = 8000;

export async function embedBatch(apiKey: string, inputs: string[]): Promise<Array<number[] | null>> {
  if (inputs.length === 0) return [];

  const cleaned = inputs.map((t) => (t ?? "").trim().slice(0, MAX_CHARS) || " ");

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: cleaned }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`embeddings ${res.status}: ${detail.slice(0, 200)}`);
  }

  const json = (await res.json()) as { data?: Array<{ index: number; embedding: number[] }> };
  const out: Array<number[] | null> = new Array(inputs.length).fill(null);
  for (const row of json.data ?? []) {
    if (typeof row.index === "number" && Array.isArray(row.embedding)) out[row.index] = row.embedding;
  }
  return out;
}

export async function embedOne(apiKey: string, input: string): Promise<number[] | null> {
  const [v] = await embedBatch(apiKey, [input]);
  return v ?? null;
}

export const EMBEDDING_MODEL = MODEL;
