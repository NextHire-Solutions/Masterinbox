import type { SupabaseClient } from "@supabase/supabase-js";

/*
 * Who an introduction is sent FROM (Eddy, 5 Oct: "intro action should
 * automatically use nicole").
 *
 * A reply normally goes out from the campaign mailbox that emailed the lead.
 * An introduction instead goes from the business's own address,
 * nicole.c@brokerstaffer.com (override: MASTER_INBOX_INTRO_SENDER_EMAIL),
 * through the platform the conversation is on — a send cannot cross from
 * EmailBison to Instantly.
 *
 * Only a mailbox the inbox can actually send from is chosen: one on file for
 * this platform, not marked disconnected. When there is none — Nicole's
 * Instantly mailbox has been disconnected in Instantly since 26 Sep — the
 * reason comes back instead, and the composer says so rather than letting a
 * send fail.
 */

export function introSenderEmail(): string {
  return (process.env.MASTER_INBOX_INTRO_SENDER_EMAIL ?? "nicole.c@brokerstaffer.com").trim().toLowerCase();
}

export interface IntroSender {
  email: string;
  /** channels.id to send from, or null when there is no usable mailbox. */
  channelId: string | null;
  /** Why there is none, in words for the composer. */
  problem: string | null;
}

type ChannelRow = {
  id: string;
  provider: string | null;
  status: string | null;
  display_name: string | null;
  instantly_account_id: string | null;
  external_account_id: string | null;
};

/** The pure choice, so it is tested: a channel for this platform whose address is the intro sender's. */
export function pickIntroChannel(rows: ChannelRow[], provider: string | null, email: string): IntroSender {
  const platform = provider === "instantly" ? "Instantly" : "EmailBison";
  const mine = rows.filter((c) =>
    (c.provider ?? "") === (provider ?? "emailbison") &&
    [c.instantly_account_id, c.external_account_id, c.display_name].some((v) => (v ?? "").trim().toLowerCase() === email),
  );
  const live = mine.filter((c) => (c.status ?? "connected") !== "disconnected");
  if (live.length) return { email, channelId: live[0].id, problem: null };
  return {
    email,
    channelId: null,
    problem: mine.length
      ? `${email} is disconnected in ${platform} — reconnect it there to send introductions from it on ${platform} conversations.`
      : `${email} is not connected in ${platform}, so this ${platform} conversation cannot be answered from it.`,
  };
}

export async function introSenderFor(admin: SupabaseClient, workspaceId: string, provider: string | null): Promise<IntroSender> {
  const email = introSenderEmail();
  const { data } = await admin
    .from("channels")
    .select("id, provider, status, display_name, instantly_account_id, external_account_id")
    .eq("workspace_id", workspaceId)
    .or(`instantly_account_id.ilike.${email},external_account_id.ilike.${email},display_name.ilike.${email}`);
  return pickIntroChannel((data ?? []) as ChannelRow[], provider, email);
}
