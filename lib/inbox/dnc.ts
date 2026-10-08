import { createAdminSupabase } from "@/lib/supabase/admin";
import { createEmailBisonClient } from "@/lib/emailbison/client";
import { createInstantlyClient } from "@/lib/instantly/client";
import { blockAddressEverywhere, stopPeople } from "@/lib/portals/stop-person";
import { isBlockableAddress, normEmail, sameName } from "@/lib/portals/stop-person-plan";

// "Do Not Contact" — pushes a thread's lead onto the source platform's
// blocklist so the sequencer stops emailing them. Wired to the "Hostile"
// label: whenever that label lands on a thread (AI labeler OR a manual
// add), the lead is auto-blacklisted.
//
// EmailBison  → POST /api/blacklisted-emails  { email }
// Instantly   → POST /block-lists-entries     { bl_value: email }
//
// Returns a DncResult so callers (and the bulk backfill script) can
// report exactly what happened per lead. Errors are caught — a blocklist
// hiccup must never break labeling or a webhook ack.

export interface DncResult {
  ok: boolean;
  email: string | null;
  platform: "emailbison" | "instantly" | null;
  // blocked → pushed to the blocklist; the rest are why it didn't happen.
  status: "blocked" | "no_lead" | "no_email" | "unsupported_provider" | "error";
  error?: string;
}

export async function markThreadLeadDoNotContact(threadId: string): Promise<DncResult> {
  let email: string | null = null;
  let platform: "emailbison" | "instantly" | null = null;
  try {
    const admin = createAdminSupabase();
    const { data: thread } = await admin
      .from("threads")
      .select("id, source_provider, lead_id, channel_id")
      .eq("id", threadId)
      .maybeSingle();
    if (!thread?.lead_id) {
      return { ok: false, email: null, platform: null, status: "no_lead" };
    }

    const { data: lead } = await admin
      .from("leads")
      .select("email")
      .eq("id", thread.lead_id)
      .maybeSingle();
    email = (lead?.email as string | null)?.trim() ?? null;
    if (!email) {
      return { ok: false, email: null, platform: null, status: "no_email" };
    }

    platform = (thread.source_provider as "emailbison" | "instantly" | null) ?? null;

    if (platform === "emailbison") {
      const eb = createEmailBisonClient();
      // The blacklist is team-scoped — switch into the thread's team
      // first so the address is blocked in the right place.
      if (thread.channel_id) {
        const { data: ch } = await admin
          .from("channels")
          .select("emailbison_team_id")
          .eq("id", thread.channel_id)
          .maybeSingle();
        const teamId = ch?.emailbison_team_id as number | null;
        if (teamId) await eb.switchWorkspace(teamId);
      }
      await eb.blacklistEmail(email);
      console.log(`[dnc] blacklisted ${email} on EmailBison`);
      return { ok: true, email, platform, status: "blocked" };
    }

    if (platform === "instantly") {
      const inst = createInstantlyClient();
      await inst.blockEmail(email);
      console.log(`[dnc] blocked ${email} on Instantly`);
      return { ok: true, email, platform, status: "blocked" };
    }

    return { ok: false, email, platform, status: "unsupported_provider" };
  } catch (err) {
    console.error("[dnc] markThreadLeadDoNotContact failed", err);
    return {
      ok: false,
      email,
      platform,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Case-insensitive check used by the label hooks.
export function isHostileLabel(name: string | null | undefined): boolean {
  return (name ?? "").trim().toLowerCase() === "hostile";
}

/**
 * The labels that mean "stop contacting this person" — Hostile, Unsubscribe,
 * Do Not Contact, Add to Blocklist (8 Oct; isStopContactLabel). Until then
 * only Hostile did anything, and only on the thread's own platform, so a
 * "remove me" reply stopped the campaign it answered while other campaigns
 * kept emailing (51 people in 45 days).
 *
 * The lead's address — plus any address they replied from under the same
 * name — is blocked on BOTH platforms, then every conversation we have with
 * them is unsubscribed by reply id (lib/portals/stop-person.ts). Replies
 * from other people on the thread (the client's team after an introduction)
 * are never touched.
 *
 * Run it without awaiting: it is several provider calls and never throws.
 */
export async function stopThreadPerson(threadId: string): Promise<void> {
  try {
    const admin = createAdminSupabase();
    const { data: thread } = await admin.from("threads").select("lead_id").eq("id", threadId).maybeSingle();
    if (!thread?.lead_id) return;
    const { data: lead } = await admin.from("leads").select("email, full_name").eq("id", thread.lead_id).maybeSingle();
    const leadEmail = normEmail(lead?.email as string | null);
    if (!isBlockableAddress(leadEmail)) return;
    const name = (lead?.full_name as string | null) ?? null;

    const emails = new Set([leadEmail]);
    const { data: msgs } = await admin
      .from("messages")
      .select("sender, sender_name")
      .eq("thread_id", threadId)
      .eq("direction", "inbound")
      .limit(200);
    for (const m of (msgs ?? []) as Array<{ sender: string | null; sender_name: string | null }>) {
      const from = normEmail(m.sender);
      if (from !== leadEmail && isBlockableAddress(from) && sameName(name, m.sender_name)) emails.add(from);
    }

    const errors: string[] = [];
    for (const e of emails) await blockAddressEverywhere(e, errors);
    const r = await stopPeople([{ emails: [...emails], name }]);
    console.log(
      `[dnc] stop thread ${threadId}: blocked ${emails.size} address(es) on both platforms, unsubscribed ${r.unsubscribed} conversation(s)` +
        (r.otherAddresses.length ? `, blocked ${r.otherAddresses.length} other address(es)` : "") +
        (errors.length ? ` · ${errors.length} error(s): ${errors.slice(0, 3).join(" | ")}` : ""),
    );
  } catch (err) {
    console.error("[dnc] stopThreadPerson failed", err instanceof Error ? err.message : String(err));
  }
}
