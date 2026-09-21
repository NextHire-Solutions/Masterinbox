/*
 * Copied from BrokerStaffer OS, deliberately.
 *
 * Both apps read the same database and must run the reply agent by the same
 * rules, so this file is kept in step with
 * `src/lib/tools/master-inbox/ai/release.ts` in the workspace. If one changes,
 * change the other. There is no shared package between the two deployments.
 */
import { createAdminSupabase } from "@/lib/supabase/admin";

import { loadAgents } from "./agent";
import { attemptLiveSend } from "./live";
import { planHandover } from "./qualification";
import { assembleRunInput } from "./runtime";
import { sendWindow } from "./schedule";
import { loadHeldStates, upsertThreadState, type StoredThreadState } from "./thread-state";

/*
 * The release job: replies a live agent wrote inside business hours and was
 * not allowed to send yet.
 *
 * ---------------------------------------------------------------------------
 * WHY A JOB AND NOT A TIMER
 *
 * Plan §5: an off-hours agent drafts during the day and "a background job
 * releases the held replies when the window opens". The obvious
 * implementation — sleep until 6pm — does not survive a deploy, and this app
 * redeploys several times a day. So the state lives in the database
 * (`agent_thread_state.hold_reason` / `held_draft_id` / `held_at`) and this
 * function is a sweep: it asks what is waiting, and sends whatever is now
 * allowed. A missed run delays a reply; it never loses one.
 *
 * ---------------------------------------------------------------------------
 * IT RE-RUNS THE WHOLE GATE, NOT JUST THE SCHEDULE
 *
 * The temptation is to check "is the window open now?" and send. But a held
 * reply can be hours old, and in those hours the lead may have unsubscribed,
 * the thread may have been labelled Hostile, or a person may have already
 * replied by hand. So a release is an ordinary send attempt through
 * `attemptLiveSend`, with every check applied again from scratch. Age is a
 * reason to be more careful, not less.
 *
 * ---------------------------------------------------------------------------
 * HOW IT IS DRIVEN
 *
 * This app has no in-process scheduler; its recurring work is a route under
 * app/api/cron/ hit by an external scheduler with the service-role token (see
 * app/api/cron/sync-external-intros for the pattern). The release sweep is
 * registered the same way at app/api/cron/release-held-replies — schedule it
 * every five minutes — and POST /api/reply-agents/release is the same sweep
 * behind a workspace session, for a person. It is claim-free and idempotent:
 * two overlapping runs on the same held reply both go through the gate, and
 * the second finds the hold already cleared.
 *
 * ---------------------------------------------------------------------------
 * A RELEASED HANDOVER CARRIES ITS CC
 *
 * The `reply_drafts` row holds only the body; the CC list — the client's
 * introduction contacts — is not stored anywhere. So a released handover
 * resolves it exactly as the runtime did when it wrote the draft: the same
 * `assembleRunInput` read and the same `planHandover` call. An introduction
 * that copies nobody is not an introduction, so if the client has lost its
 * details in the meantime the plan says stop, and so does this.
 */

export interface ReleaseOutcome {
  threadId: string;
  agentId: string;
  result: "sent" | "still_held" | "cleared" | "skipped";
  reason: string;
}

export interface ReleaseReport {
  scanned: number;
  sent: number;
  stillHeld: number;
  cleared: number;
  skipped: number;
  outcomes: ReleaseOutcome[];
}

export async function releaseHeldReplies(
  workspaceId: string,
  now: Date = new Date(),
  limit = 50,
): Promise<ReleaseReport> {
  const report: ReleaseReport = { scanned: 0, sent: 0, stillHeld: 0, cleared: 0, skipped: 0, outcomes: [] };
  const held = await loadHeldStates(workspaceId, limit);
  if (held.length === 0) return report;

  const agents = await loadAgents(workspaceId);
  const admin = createAdminSupabase();

  for (const state of held) {
    report.scanned++;
    const record = (result: ReleaseOutcome["result"], reason: string) => {
      report.outcomes.push({ threadId: state.threadId, agentId: state.agentId, result, reason });
      if (result === "sent") report.sent++;
      else if (result === "still_held") report.stillHeld++;
      else if (result === "cleared") report.cleared++;
      else report.skipped++;
    };

    const agent = agents.find((a) => a.id === state.agentId);
    if (!agent) {
      record("skipped", "agent no longer exists");
      continue;
    }
    /*
     * The agent has been paused, put back into shadow, or deactivated since
     * the reply was held. That is a person deciding, after the fact, that this
     * should not go — so the hold is cleared rather than released, and the
     * draft stays in the composer for them to send by hand if they want it.
     */
    if (!agent.active || agent.run_mode !== "live") {
      await clearHold(state, `agent is ${agent.active ? agent.run_mode : "inactive"}`);
      record("cleared", `agent is ${agent.active ? agent.run_mode : "inactive"}`);
      continue;
    }
    if (state.status === "stopped" || state.status === "handed_over") {
      record("skipped", `thread state is ${state.status}`);
      continue;
    }
    // Cheap pre-check so a sweep during business hours does not run a dozen
    // full gate evaluations to be told the same thing. The gate still runs.
    if (!sendWindow(agent.schedule, now).open) {
      record("still_held", "outside the send window");
      continue;
    }

    // ---- the draft we are holding ----------------------------------------
    if (!state.heldDraftId) {
      await clearHold(state, "no held draft");
      record("cleared", "no held draft");
      continue;
    }
    const { data: draft } = await admin
      .from("reply_drafts")
      .select("id, generated_body, status")
      .eq("id", state.heldDraftId)
      .maybeSingle();
    if (!draft?.generated_body) {
      await clearHold(state, "held draft is gone or empty");
      record("cleared", "held draft is gone or empty");
      continue;
    }
    /*
     * Somebody replied by hand while this was waiting — the send route marks
     * every pending draft on the thread as sent. Releasing now would send a
     * second reply to a conversation a person has already answered.
     */
    if (draft.status !== "pending") {
      await clearHold(state, `a reply was already sent on this thread (draft ${draft.status})`);
      record("cleared", "a person already replied");
      continue;
    }

    // ---- who we are replying to, and to what ------------------------------
    // Read the way the runtime reads, so the release sees what the draft saw.
    const ctx = await assembleRunInput(workspaceId, state.threadId);
    if (!ctx) {
      await clearHold(state, "thread is gone");
      record("cleared", "thread is gone");
      continue;
    }

    const isHandover = state.status === "qualified";
    let cc: string[] = [];
    if (isHandover) {
      const plan = planHandover(agent.handover, {
        client: ctx.introduction.client,
        unavailableReason: ctx.introduction.unavailableReason,
        variables: {
          lead: {
            name: ctx.leadName,
            email: ctx.leadEmail,
            phone: ctx.leadPhone,
            company: ctx.leadCompany,
            title: ctx.leadTitle,
          },
          thread: { subject: ctx.subject },
          sender: { name: ctx.senderName, email: ctx.ourEmail },
        },
      });
      if (plan.kind === "stop") {
        // The runtime would have stopped here too. Same state, same reason.
        await upsertThreadState({
          workspaceId,
          threadId: state.threadId,
          agentId: state.agentId,
          status: "stopped",
          stopReason: plan.reason,
          holdReason: null,
          heldDraftId: null,
          heldAt: null,
          lastActionAt: now.toISOString(),
        });
        console.warn(
          `[agent-release] stopped thread=${state.threadId} agent=${state.agentId} reason=${plan.reason} — ${plan.detail}`,
        );
        record("cleared", `${plan.reason}: ${plan.detail}`);
        continue;
      }
      cc = plan.cc;
    }

    const result = await attemptLiveSend({
      agent,
      workspaceId,
      threadId: state.threadId,
      draftId: state.heldDraftId,
      body: draft.generated_body as string,
      subject: ctx.subject,
      toEmail: ctx.leadEmail,
      lastInboundText: ctx.inboundText,
      isHandover,
      cc,
      leadName: ctx.leadName,
      state,
      now,
    });

    if (result.status === "sent") record("sent", "released");
    else record("still_held", `${result.reason}: ${result.detail}`);
  }

  return report;
}

async function clearHold(state: StoredThreadState, reason: string): Promise<void> {
  await upsertThreadState({
    workspaceId: state.workspaceId,
    threadId: state.threadId,
    agentId: state.agentId,
    holdReason: null,
    heldDraftId: null,
    heldAt: null,
  });
  console.log(`[agent-release] cleared hold on thread=${state.threadId} — ${reason}`);
}
