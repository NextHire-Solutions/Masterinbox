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
  /**
   * The name on that mailbox ("Nicole Collins"), which signs the introduction
   * — see introSignOffName. Null when there is no usable mailbox, or when the
   * platform stores only the address as the name.
   */
  name: string | null;
  /** Why there is none, in words for the composer. */
  problem: string | null;
}

/** A display name that is a person's name, not an address standing in for one. */
function personName(displayName: string | null): string | null {
  const v = (displayName ?? "").trim();
  return v && !v.includes("@") ? v : null;
}

/*
 * Who signs an introduction (14 Oct): whoever it goes out FROM.
 *
 * The macro ends "Best,\n{{sender.name}}", and {{sender.name}} was the name of
 * the campaign mailbox that first emailed the lead ("Lydia Reed") — so an
 * introduction sent from Nicole's address was signed by somebody else. When it
 * goes from Nicole's mailbox it is signed with her name; when it cannot (no
 * usable mailbox on this platform, so it goes from the campaign mailbox), the
 * campaign mailbox's name stays, matching its From.
 */
export function introSignOffName(sender: IntroSender | null | undefined, campaignName: string | null): string | null {
  return sender?.channelId && sender.name ? sender.name : campaignName;
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
  if (live.length) return { email, channelId: live[0].id, name: personName(live[0].display_name), problem: null };
  return {
    email,
    channelId: null,
    name: null,
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
