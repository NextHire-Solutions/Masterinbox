/*
 * Copied from BrokerStaffer OS, deliberately.
 *
 * Both apps read the same database and must draft from the same corpus and
 * judge edits by the same rule, so this file is kept in step with
 * `src/lib/tools/master-inbox/ai/feedback.ts` in the workspace. If one changes, change
 * the other. There is no shared package between the two deployments.
 *
 * The only difference is how it reaches the database: the workspace goes
 * through its `osTable` allow-list, which exists to stop it writing to Master
 * Inbox tables by accident. This IS Master Inbox, so it uses the admin client
 * directly.
 */
import "server-only";

import { createAdminSupabase } from "@/lib/supabase/admin";
import { comparable, normaliseBody, qualityScore, verdictFor, type Verdict } from "./corpus-pure";
import { invalidatePool } from "./retrieval";

/*
 * What we did to the draft — measured, not asked for.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ON THE SERVER AND NOT IN THE COMPOSER
 *
 * The obvious place to notice an edit is the textarea: the draft arrives, the
 * person changes it, the component knows both strings. But the composer only
 * knows what it was HANDED. It does not see a draft the sync worker wrote
 * overnight, it does not see a reply sent from a second tab, and a person who
 * pastes over the whole box leaves it with no memory of what was replaced.
 *
 * The send route sees all of it. `reply_drafts.generated_body` is what the
 * agent wrote and `payload.body` is what actually went out, and they meet in
 * one function on the way to the provider. So the measurement is taken there,
 * once, for every send — however the draft got there and whoever sent it.
 *
 * ---------------------------------------------------------------------------
 * THE NUMBER THIS PRODUCES
 *
 * as_written / light_edit / rewritten, against a baseline that is not flattering
 * and is not meant to be: of the last 600 drafts the old agent wrote, 517 were
 * never sent at all, and of the 83 that were followed by a real reply, 82 had
 * been rewritten. Zero went out as written. Any honest measure of this work is
 * whether that first number moves.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE MAY BREAK A SEND
 *
 * Every function is best-effort and catches its own failures. A person pressing
 * Send is sending an email to a real estate agent; our bookkeeping about how
 * well a model wrote it is not a reason to fail that.
 */

/** The old agent's measured record, shown beside the new number. */
export const BASELINE = {
  drafts: 600,
  neverSent: 517,
  sent: 83,
  rewritten: 82,
  asWritten: 0,
} as const;

/*
 * A rewritten reply is only worth learning from if it is a reply — not "ok
 * thanks", not a one-line forward. Same floor the corpus builder uses.
 */
const MIN_CORRECTION_CHARS = 60;
const MAX_CORRECTION_CHARS = 4000;

export interface RecordSendInput {
  workspaceId: string;
  threadId: string;
  /** What actually went out. HTML or text; it is normalised either way. */
  sentBody: string;
  sentIsHtml: boolean;
  /** The outbound message row just written, when the caller has its id. */
  outboundMessageId?: string | null;
}

export interface RecordSendResult {
  verdict: Verdict;
  similarity: number;
  draftId: string;
  /** True when this send was also filed as a correction example. */
  corrected: boolean;
}

/**
 * Compare the agent's draft with what was sent, and remember the difference.
 *
 * Returns null when there was no draft to compare against — most sends are
 * typed from scratch and that is not a failure, it is simply nothing to learn.
 */
export async function recordSendFeedback(input: RecordSendInput): Promise<RecordSendResult | null> {
  try {
    const admin = createAdminSupabase();

    /*
     * The draft the person was looking at: the newest PENDING one on this
     * thread. Pending is the right filter — the send route marks drafts sent
     * immediately after this runs, so anything already 'sent' belongs to an
     * earlier reply on the same thread and comparing against it would score
     * this send against the wrong draft.
     */
    const { data: draft } = await admin
      .from("reply_drafts")
      .select("id, agent_id, generated_body, created_at")
      .eq("thread_id", input.threadId)
      .eq("status", "pending")
      .not("generated_body", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const draftBody = (draft?.generated_body as string | null) ?? "";
    if (!draft?.id || draftBody.trim().length === 0) return null;

    const sent = normaliseBody(
      input.sentIsHtml ? null : input.sentBody,
      input.sentIsHtml ? input.sentBody : null,
    );
    const drafted = normaliseBody(draftBody, null);
    if (sent.trim().length === 0) return null;

    const { verdict, similarity } = verdictFor(drafted, sent);

    /*
     * Upsert on draft_id — the migration puts a unique index there. One draft
     * yields one verdict however many times this runs, which matters because
     * the backfill and the live path can both reach the same row.
     */
    const { error } = await createAdminSupabase().from("os_reply_feedback").upsert(
      {
        workspace_id: input.workspaceId,
        thread_id: input.threadId,
        draft_id: draft.id as string,
        agent_id: (draft.agent_id as string | null) ?? null,
        draft_body: drafted.slice(0, 8000),
        sent_body: sent.slice(0, 8000),
        verdict,
        similarity,
      },
      { onConflict: "draft_id" },
    );
    if (error) {
      // Before migrations/0006 this table does not exist. Say so once, quietly,
      // and carry on: the email has already gone.
      console.warn("[ai:feedback] could not record verdict:", error.message);
      return null;
    }

    const corrected =
      verdict !== "as_written"
        ? await fileCorrection({ ...input, sent, admin })
        : false;

    return { verdict, similarity, draftId: draft.id as string, corrected };
  } catch (err) {
    console.warn("[ai:feedback] skipped:", err instanceof Error ? err.message : err);
    return null;
  }
}

/*
 * A reply somebody wrote themselves, added to the corpus as a correction.
 *
 * `qualityScore` already ranks corrections above mined history — a reply a
 * person took the trouble to write instead of accepting the draft is the most
 * instructive example we have, because it is the agent being told, in the house
 * voice, what it should have said.
 *
 * Stored with the outbound message's id so a later rebuild UPDATES this row
 * rather than duplicating the reply; corpus.ts skips ids that are already
 * filed as corrections, so the rebuild cannot demote it back to history.
 */
async function fileCorrection(args: {
  workspaceId: string;
  threadId: string;
  sent: string;
  outboundMessageId?: string | null;
  admin: ReturnType<typeof createAdminSupabase>;
}): Promise<boolean> {
  const reply = args.sent.trim();
  if (reply.length < MIN_CORRECTION_CHARS || reply.length > MAX_CORRECTION_CHARS) return false;

  try {
    // What was being answered. Without it there is no situation to match on,
    // and an example with no question is not retrievable.
    const { data: inbound } = await args.admin
      .from("messages")
      .select("id, body_text, body_html")
      .eq("thread_id", args.threadId)
      .eq("direction", "inbound")
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!inbound?.id) return false;

    /*
     * The outbound row for this send. The reply route inserts the message
     * before it touches the drafts, so by the time we run it is the newest
     * outbound on the thread — and having its id is what lets a later rebuild
     * UPDATE this example instead of filing the same reply a second time as
     * plain history.
     */
    let outboundId = args.outboundMessageId ?? null;
    if (!outboundId) {
      const { data: out } = await args.admin
        .from("messages")
        .select("id")
        .eq("thread_id", args.threadId)
        .eq("direction", "outbound")
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      outboundId = (out?.id as string | undefined) ?? null;
    }
    // Without an id the rebuild would duplicate this reply as history. Better
    // to skip the example than to poison retrieval with the same reply twice.
    if (!outboundId) return false;

    const inboundText = normaliseBody(
      (inbound.body_text as string | null) ?? null,
      (inbound.body_html as string | null) ?? null,
    );
    if (inboundText.trim().length < 10) return false;

    /*
     * The introduction macro is excluded from the corpus for a specific reason
     * — it has its own button, and left in it taught the agent to invent
     * contacts. A correction is no different: if what went out was an
     * introduction, it is a template, not a lesson.
     */
    if (/\bintroduce\s+(?:you|him|her|them)\b/i.test(reply)) return false;

    const { data: labelRow } = await args.admin
      .from("label_assignments")
      .select("label_id")
      .eq("target_type", "thread")
      .eq("target_id", args.threadId)
      .limit(1)
      .maybeSingle();
    let label: string | null = null;
    if (labelRow?.label_id) {
      const { data: l } = await args.admin
        .from("labels").select("name").eq("id", labelRow.label_id as string).maybeSingle();
      label = (l?.name as string | null) ?? null;
    }

    const now = new Date().toISOString();
    const { error } = await createAdminSupabase().from("os_reply_examples").upsert(
      {
        workspace_id: args.workspaceId,
        thread_id: args.threadId,
        inbound_message_id: inbound.id as string,
        outbound_message_id: outboundId,
        label,
        inbound_text: inboundText.slice(0, 4000),
        reply_text: reply.slice(0, 4000),
        sent_at: now,
        quality: qualityScore({ sentAt: now, label, source: "correction", replyText: reply }),
        source: "correction",
        /*
         * No embedding yet. Embedding here would mean decrypting the agent's
         * key and calling OpenAI while somebody waits for a send to complete.
         * The next rebuild embeds anything still missing one — see corpus.ts —
         * which costs a fraction of a cent and nobody's time.
         */
        updated_at: now,
      },
      { onConflict: "outbound_message_id" },
    );
    if (error) {
      console.warn("[ai:feedback] could not file correction:", error.message);
      return false;
    }
    // The retrieval pool is cached in process; a new example nobody can
    // retrieve until the TTL lapses is a confusing thing to debug.
    invalidatePool(args.workspaceId);
    return true;
  } catch (err) {
    console.warn("[ai:feedback] correction skipped:", err instanceof Error ? err.message : err);
    return false;
  }
}

/* ------------------------------------------------------------- the metric */

export interface FeedbackSummary {
  total: number;
  byVerdict: Record<Verdict | "discarded", number>;
  /** Of the drafts that were actually sent: the share that needed no edit. */
  asWrittenRate: number | null;
  lastAt: string | null;
  baseline: typeof BASELINE;
  /** False when migrations/0006 has not been run — the screen says so. */
  available: boolean;
}

export async function feedbackSummary(workspaceId: string): Promise<FeedbackSummary> {
  const byVerdict: Record<string, number> = { as_written: 0, light_edit: 0, rewritten: 0, discarded: 0 };
  const summary: FeedbackSummary = {
    total: 0, byVerdict: byVerdict as FeedbackSummary["byVerdict"],
    asWrittenRate: null, lastAt: null, baseline: BASELINE, available: false,
  };

  /*
   * DOES THE TABLE EXIST? ASK WITH A ROW READ, NOT A COUNT.
   *
   * This cost an afternoon. A counting query — `select("*", { count: "exact",
   * head: true })` — against a table PostgREST has never heard of comes back
   * 204 with `count: null` and NO ERROR. Measured, not assumed:
   *
   *     HEAD count on a missing table → count: null, error: null, status: 204
   *     GET one row on the same table → error: "Could not find the table
   *                                     'public.os_reply_feedback' in the
   *                                     schema cache", status: 404
   *
   * So a screen built on counts alone reports a confident "0 as written, 0
   * rewritten" for a table that does not exist — which is indistinguishable
   * from an agent whose drafts nobody has sent yet, and exactly the wrong thing
   * to tell somebody trying to work out why nothing is happening. One row read
   * settles it honestly.
   */
  const { error: probe } = await createAdminSupabase().from("os_reply_feedback").select("id").limit(1);
  if (probe) return summary; // available stays false — the screen says why
  summary.available = true;

  /*
   * Now the counts, with `head: true` per verdict rather than by reading rows:
   * there are already ~12,000 of these before a single new send, and the screen
   * wants four numbers, not twelve thousand bodies.
   */
  for (const verdict of Object.keys(byVerdict)) {
    const { count, error } = await createAdminSupabase().from("os_reply_feedback")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("verdict", verdict);
    if (error) return summary;
    byVerdict[verdict] = count ?? 0;
  }
  summary.total = Object.values(byVerdict).reduce((a, b) => a + b, 0);

  const sent = byVerdict.as_written + byVerdict.light_edit + byVerdict.rewritten;
  summary.asWrittenRate = sent > 0 ? Number((byVerdict.as_written / sent).toFixed(4)) : null;

  const { data: latest } = await createAdminSupabase().from("os_reply_feedback")
    .select("created_at").eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  summary.lastAt = (latest?.created_at as string | null) ?? null;

  return summary;
}

/** Exported for the tests: the comparison the verdict is taken over. */
export const compare = comparable;
