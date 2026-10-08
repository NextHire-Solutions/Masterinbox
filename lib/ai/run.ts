import { createAdminSupabase } from "@/lib/supabase/admin";
import { loadAiConfigWithKey } from "@/lib/ai/config";
import { classifyReply, DEFAULT_SYSTEM_PROMPT } from "@/lib/ai/label";
import { isHostileLabel, markThreadLeadDoNotContact, stopThreadPerson } from "@/lib/inbox/dnc";
import { isStopContactLabel } from "@/lib/portals/stop-person-plan";
import {
  isInterestedLabel,
  isNotInterestedLabel,
  markEmailBisonReplyInterested,
} from "@/lib/inbox/interest";

interface LabelInboundInput {
  workspaceId: string;
  threadId: string;
  messageId: string;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  // When true, ignore the workspace's `enabled` flag and the
  // `relabel_ongoing` gate. Used by the backfill endpoint so explicit
  // "Run" clicks always do work.
  force?: boolean;
}

export type LabelResult =
  | { status: "labeled"; label: string }
  | { status: "skipped_disabled" | "skipped_no_key" | "skipped_no_config" }
  | { status: "skipped_already_labeled" }
  | { status: "skipped_user_labeled" }
  | { status: "skipped_no_labels" }
  | { status: "skipped_model_returned_none" }
  | { status: "skipped_no_match"; raw: string }
  | { status: "errored"; error: string };

// Labels a single inbound message. Fetches the workspace's AI config +
// candidate labels, calls the provider, upserts a thread label_assignment
// with assigned_by='ai'.
//
// Returns a discriminated result so callers can report *why* a thread
// wasn't labeled rather than just "nothing happened".
export async function labelInboundMessage(input: LabelInboundInput): Promise<LabelResult> {
  const cfg = await loadAiConfigWithKey(input.workspaceId);
  if (!cfg) return { status: "skipped_no_config" };
  if (!cfg.api_key) return { status: "skipped_no_key" };
  if (!cfg.enabled && !input.force) return { status: "skipped_disabled" };

  const admin = createAdminSupabase();

  // Skip if the thread already has an AI label and relabel_ongoing is off
  // (unless force=true — backfill always re-labels for visibility).
  if (!cfg.relabel_ongoing && !input.force) {
    const { data: existing } = await admin
      .from("label_assignments")
      .select("id")
      .eq("target_type", "thread")
      .eq("target_id", input.threadId)
      .eq("assigned_by", "ai")
      .limit(1);
    if (existing && existing.length > 0) return { status: "skipped_already_labeled" };
  }

  // Pull candidate labels for this workspace. category_set narrows the pick
  // list; without it we expose every label.
  const { data: labelRows } = await admin
    .from("labels")
    .select("id, name")
    .eq("workspace_id", input.workspaceId)
    .order("sort_order", { ascending: true });
  if (!labelRows || labelRows.length === 0) return { status: "skipped_no_labels" };

  const candidateNames = cfg.category_set.length > 0
    ? cfg.category_set
    : labelRows.map((l) => l.name);

  let chosen: string | null = null;
  try {
    chosen = await classifyReply({
      provider: cfg.provider,
      apiKey: cfg.api_key,
      model: cfg.model,
      systemPrompt: cfg.use_custom_prompt && cfg.custom_prompt
        ? cfg.custom_prompt
        : DEFAULT_SYSTEM_PROMPT,
      candidateLabels: candidateNames,
      subject: input.subject,
      body: input.bodyText ?? stripHtml(input.bodyHtml ?? ""),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown classify error";
    console.error("[ai] classifyReply failed", err);
    return { status: "errored", error: msg };
  }

  // Fallback semantics (May 2026 client decision): if the model
  // can't classify (returned NONE) or returned a string that doesn't
  // match any of the workspace's labels, pin the thread to "Unable
  // to Categorize" instead of leaving it unlabeled. That label
  // becomes the universal queue for manual triage; the operator
  // never has to hunt for "untagged" threads. If the workspace
  // doesn't have an "Unable to Categorize" label, we keep the prior
  // skipped_* status so the run report still surfaces it.
  const findFallback = () =>
    labelRows.find((l) => l.name.toLowerCase() === "unable to categorize") ?? null;

  let labelRow = chosen
    ? labelRows.find((l) => l.name.toLowerCase() === chosen.toLowerCase()) ?? null
    : null;
  if (!labelRow) {
    const fallback = findFallback();
    if (!fallback) {
      return !chosen
        ? { status: "skipped_model_returned_none" }
        : { status: "skipped_no_match", raw: chosen };
    }
    labelRow = fallback;
  }

  // AI never touches a thread that already has a label. Covers two
  // cases at once:
  //   • assigned_by='user' — operator already decided, AI defers.
  //   • assigned_by='system' — pinned labels like Introduction (the
  //     "lead has been introduced" marker we don't ever want
  //     auto-relabeled away). The June 2026 Introduction-wipe
  //     incident was caused by AI re-classifying these out.
  // Only manual UI actions can change a labeled thread now.
  const { count: anyLabel } = await admin
    .from("label_assignments")
    .select("id", { head: true, count: "exact" })
    .eq("target_type", "thread")
    .eq("target_id", input.threadId);
  if ((anyLabel ?? 0) > 0) {
    return { status: "skipped_user_labeled" };
  }

  // No user verdict on this thread — single-label-per-thread rules
  // still apply, so wipe every other AI assignment before upserting
  // the new one. We never touch rows whose assigned_by='user' (the
  // skip above guards that path anyway).
  await admin
    .from("label_assignments")
    .delete()
    .eq("target_type", "thread")
    .eq("target_id", input.threadId)
    .eq("assigned_by", "ai")
    .neq("label_id", labelRow.id);

  await admin.from("label_assignments").upsert(
    {
      workspace_id: input.workspaceId,
      label_id: labelRow.id,
      target_type: "thread",
      target_id: input.threadId,
      assigned_by: "ai",
    },
    { onConflict: "label_id,target_type,target_id" },
  );

  // Hostile → auto Do-Not-Contact: push the lead onto the source
  // platform's blocklist so the sequencer stops emailing them.
  if (isHostileLabel(labelRow.name)) {
    await markThreadLeadDoNotContact(input.threadId);
  }
  // Hostile, Unsubscribe, Do Not Contact, Add to Blocklist → stop the person
  // everywhere (both platforms, every conversation). Live replies only — the
  // workspace backfill below stays Hostile-only. Not awaited; never throws.
  if (isStopContactLabel(labelRow.name)) {
    void stopThreadPerson(input.threadId);
  }

  // Interested / Not Interested → mirror the verdict to EmailBison so the
  // reply's interested flag round-trips to EmailBison's smart lists +
  // sequence rules — parity with what the MANUAL label routes already do.
  // Fire-and-forget: the EmailBison client has no request timeout, so we
  // must NOT let a slow/hung call block message sync. The helper is
  // idempotent, self-filters to EmailBison threads with a reply id, and
  // never throws (all errors caught), so a bare `void` is safe (no
  // unhandled rejection). A missed push is recovered by the next relabel
  // or the /api/admin/backfill-interested one-off.
  if (isInterestedLabel(labelRow.name)) {
    void markEmailBisonReplyInterested(input.threadId, true);
  } else if (isNotInterestedLabel(labelRow.name)) {
    void markEmailBisonReplyInterested(input.threadId, false);
  }

  await admin.rpc("ai_labeling_touch_run", { p_workspace: input.workspaceId });
  return { status: "labeled", label: labelRow.name };
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface BackfillResult {
  scanned: number;
  labeled: number;
  no_inbound: number;
  skipped_already_labeled: number;
  skipped_user_labeled: number;
  skipped_disabled: number;
  skipped_no_key: number;
  skipped_no_config: number;
  skipped_no_labels: number;
  skipped_model_returned_none: number;
  skipped_no_match: number;
  errors: number;
  sample_labels: Array<{ thread_id: string; label: string }>;
  sample_errors: Array<{ thread_id: string; error: string }>;
}

// Streaming progress event the route emits between batches. The shape
// matches the BackfillResult tally fields so the client can render a
// progress bar + live counters without reinventing the schema.
export interface BackfillProgress {
  scanned: number;
  total: number;
  labeled: number;
  no_inbound: number;
  skipped_already_labeled: number;
  skipped_no_match: number;
  skipped_model_returned_none: number;
  errors: number;
}

// Bulk-label every open thread's most recent inbound. Always runs in force
// mode — the user explicitly clicked Run.
//
// Performance note: the per-thread `labelInboundMessage` path re-fetches
// the workspace config + label list on every call. Multiply by 500
// threads at concurrency 5 and the route burns ~2500 redundant Supabase
// round-trips and hits the 300s `maxDuration` cap. This implementation
// hoists those reads to the start of the run, bulk-deletes existing AI
// assignments in one query, and updates `last_run_at` once at the end —
// leaving only the OpenAI call + the per-thread upsert in the hot loop.
//
// `onProgress` (optional) fires once per concurrency batch so a streaming
// route can flush a JSON line to the browser and drive a progress bar.
export async function backfillLabelsForWorkspace(
  workspaceId: string,
  onProgress?: (p: BackfillProgress) => void,
): Promise<BackfillResult> {
  const admin = createAdminSupabase();

  const result: BackfillResult = {
    scanned: 0,
    labeled: 0,
    no_inbound: 0,
    skipped_already_labeled: 0,
    skipped_user_labeled: 0,
    skipped_disabled: 0,
    skipped_no_key: 0,
    skipped_no_config: 0,
    skipped_no_labels: 0,
    skipped_model_returned_none: 0,
    skipped_no_match: 0,
    errors: 0,
    sample_labels: [],
    sample_errors: [],
  };

  // 1) One-time setup: cfg + labels.
  const cfg = await loadAiConfigWithKey(workspaceId);
  if (!cfg) {
    result.skipped_no_config = 1;
    return result;
  }
  if (!cfg.api_key) {
    result.skipped_no_key = 1;
    return result;
  }

  const { data: labelRows } = await admin
    .from("labels")
    .select("id, name")
    .eq("workspace_id", workspaceId)
    .order("sort_order", { ascending: true });
  if (!labelRows || labelRows.length === 0) {
    result.skipped_no_labels = 1;
    return result;
  }
  const candidateNames = cfg.category_set.length > 0
    ? cfg.category_set
    : labelRows.map((l) => l.name);
  const labelByName = new Map(labelRows.map((l) => [l.name.toLowerCase(), l]));
  // Fallback label used when the model returns NONE or a name that
  // doesn't match a candidate — see comment in labelInboundMessage.
  const fallbackLabel = labelByName.get("unable to categorize") ?? null;
  const systemPrompt =
    cfg.use_custom_prompt && cfg.custom_prompt ? cfg.custom_prompt : DEFAULT_SYSTEM_PROMPT;

  // Pull all open threads + the set of thread_ids that already have an
  // AI label. We then process only the UNLABELED slice. This fixes two
  // bugs the client hit:
  //   1. "500 remaining" appeared on every Run because the previous
  //      implementation wiped the existing AI labels at the start of
  //      each run and re-classified from scratch — net progress
  //      stayed flat.
  //   2. The 500 cap was applied BEFORE filtering, so the same 500
  //      most-recent threads were processed each time and any threads
  //      outside that window never got labeled.
  // The cap now applies AFTER the unlabeled filter, so 500 represents
  // genuine remaining work per run.
  const { data: openRows } = await admin
    .from("threads")
    .select("id, subject")
    .eq("workspace_id", workspaceId)
    .eq("status", "open");
  const openThreads = (openRows ?? []) as Array<{ id: string; subject: string | null }>;

  // Skip threads with ANY existing label — drops the assigned_by='ai'
  // filter so that user-assigned AND system-assigned (e.g. pinned
  // Introduction) labels are protected from re-classification. The
  // backfill only fires on truly unlabeled threads now.
  const { data: existingRows } = await admin
    .from("label_assignments")
    .select("target_id")
    .eq("workspace_id", workspaceId)
    .eq("target_type", "thread");
  const alreadyLabeled = new Set(
    ((existingRows ?? []) as Array<{ target_id: string }>).map((r) => r.target_id),
  );

  const list = openThreads.filter((t) => !alreadyLabeled.has(t.id)).slice(0, 1000);
  result.skipped_already_labeled = openThreads.length - list.length;
  if (list.length === 0) return result;

  // Emit a zero-progress event up-front so the UI shows the total
  // immediately on click instead of waiting for the first batch to
  // finish (~2-3s with OpenAI in the loop).
  onProgress?.({
    scanned: 0,
    total: list.length,
    labeled: 0,
    no_inbound: 0,
    skipped_already_labeled: result.skipped_already_labeled,
    skipped_no_match: 0,
    skipped_model_returned_none: 0,
    errors: 0,
  });

  // 3) Hot loop: pull the latest inbound + classify + upsert, with cfg /
  //    labels / systemPrompt already in scope.
  type ThreadOutcome =
    | { kind: "no_inbound" }
    | { kind: "result"; threadId: string; result: LabelResult };

  async function classifyThread(t: {
    id: string;
    subject: string | null;
  }): Promise<ThreadOutcome> {
    const { data: msg } = await admin
      .from("messages")
      .select("id, subject, body_text, body_html")
      .eq("thread_id", t.id)
      .eq("direction", "inbound")
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!msg) return { kind: "no_inbound" };

    let chosen: string | null = null;
    let lastErr: string | null = null;
    // One retry with brief backoff — OpenAI returns transient 429s and
    // 503s under burst load. The user's last run saw ~4% errors on a
    // 500-thread backfill from rate limiting; a single retry catches
    // most of them without lengthening the happy path.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        chosen = await classifyReply({
          provider: cfg!.provider,
          apiKey: cfg!.api_key!,
          model: cfg!.model,
          systemPrompt,
          candidateLabels: candidateNames,
          subject: (msg.subject as string | null) ?? t.subject,
          body: (msg.body_text as string | null) ?? stripHtml((msg.body_html as string | null) ?? ""),
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : "Unknown classify error";
        if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
      }
    }
    if (lastErr) {
      return { kind: "result", threadId: t.id, result: { status: "errored", error: lastErr } };
    }

    // Same fallback as the single-thread path: NONE / no-match maps
    // to "Unable to Categorize" so every backfilled thread ends up
    // with exactly one chip and operators have a single manual-triage
    // queue.
    let labelRow = chosen ? labelByName.get(chosen.toLowerCase()) ?? null : null;
    if (!labelRow) {
      if (!fallbackLabel) {
        return chosen
          ? { kind: "result", threadId: t.id, result: { status: "skipped_no_match", raw: chosen } }
          : { kind: "result", threadId: t.id, result: { status: "skipped_model_returned_none" } };
      }
      labelRow = fallbackLabel;
    }

    // AI never touches a thread that already has ANY label — same
    // guard as the single-thread path. Protects user-assigned AND
    // system-assigned (pinned Introduction) labels from being
    // overwritten.
    const { count: anyLabel } = await admin
      .from("label_assignments")
      .select("id", { head: true, count: "exact" })
      .eq("target_type", "thread")
      .eq("target_id", t.id);
    if ((anyLabel ?? 0) > 0) {
      return {
        kind: "result",
        threadId: t.id,
        result: { status: "skipped_user_labeled" },
      };
    }

    // No user verdict — single-label-per-thread rules still apply,
    // so wipe every other AI assignment before upserting the new one.
    await admin
      .from("label_assignments")
      .delete()
      .eq("target_type", "thread")
      .eq("target_id", t.id)
      .eq("assigned_by", "ai")
      .neq("label_id", labelRow.id);

    const { error: upsertErr } = await admin.from("label_assignments").upsert(
      {
        workspace_id: workspaceId,
        label_id: labelRow.id,
        target_type: "thread",
        target_id: t.id,
        assigned_by: "ai",
      },
      { onConflict: "label_id,target_type,target_id" },
    );
    if (upsertErr) {
      return {
        kind: "result",
        threadId: t.id,
        result: { status: "errored", error: upsertErr.message },
      };
    }

    // Hostile → auto Do-Not-Contact (kept inline; cheap when it doesn't fire).
    if (isHostileLabel(labelRow.name)) {
      await markThreadLeadDoNotContact(t.id);
    }

    return {
      kind: "result",
      threadId: t.id,
      result: { status: "labeled", label: labelRow.name },
    };
  }

  // Concurrency 8 — most per-thread time is the OpenAI call. A previous
  // run at 12 saw ~4% rate-limit errors; 8 keeps comfortably inside the
  // workspace's tier-1 limits while still finishing 500 threads in
  // ~60-80s. Combined with the one-shot retry inside classifyThread,
  // transient 429s/503s no longer fail the row.
  const CONCURRENCY = 8;
  for (let i = 0; i < list.length; i += CONCURRENCY) {
    const batch = await Promise.all(list.slice(i, i + CONCURRENCY).map(classifyThread));
    for (const outcome of batch) {
      result.scanned++;
      if (outcome.kind === "no_inbound") {
        result.no_inbound++;
        continue;
      }
      const r = outcome.result;
      const t = { id: outcome.threadId };
      switch (r.status) {
      case "labeled":
        result.labeled++;
        if (result.sample_labels.length < 10) {
          result.sample_labels.push({ thread_id: t.id, label: r.label });
        }
        break;
      case "skipped_already_labeled":
        result.skipped_already_labeled++;
        break;
      case "skipped_user_labeled":
        result.skipped_user_labeled++;
        break;
      case "skipped_disabled":
        result.skipped_disabled++;
        break;
      case "skipped_no_key":
        result.skipped_no_key++;
        break;
      case "skipped_no_config":
        result.skipped_no_config++;
        break;
      case "skipped_no_labels":
        result.skipped_no_labels++;
        break;
      case "skipped_model_returned_none":
        result.skipped_model_returned_none++;
        break;
      case "skipped_no_match":
        result.skipped_no_match++;
        if (result.sample_errors.length < 10) {
          result.sample_errors.push({
            thread_id: t.id,
            error: `Model returned "${r.raw}" — not in your label set`,
          });
        }
        break;
        case "errored":
          result.errors++;
          if (result.sample_errors.length < 10) {
            result.sample_errors.push({ thread_id: t.id, error: r.error });
          }
          break;
      }
    }
    onProgress?.({
      scanned: result.scanned,
      total: list.length,
      labeled: result.labeled,
      no_inbound: result.no_inbound,
      skipped_already_labeled: result.skipped_already_labeled,
      skipped_no_match: result.skipped_no_match,
      skipped_model_returned_none: result.skipped_model_returned_none,
      errors: result.errors,
    });
  }

  // 4) Single touch_run at the end instead of one per thread.
  await admin.rpc("ai_labeling_touch_run", { p_workspace: workspaceId });

  return result;
}
