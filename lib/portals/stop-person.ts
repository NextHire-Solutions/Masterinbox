import { createAdminSupabase } from "@/lib/supabase/admin";
import { createEmailBisonClient, EmailBisonError } from "@/lib/emailbison/client";
import { createInstantlyClient } from "@/lib/instantly/client";
import {
  alreadyBlacklisted,
  isBlockableAddress,
  normEmail,
  planStop,
  type Person,
  type PersonConversation,
} from "@/lib/portals/stop-person-plan";

// "Stop contacting this person" beyond the address blacklist (DNC, 8 Oct).
// The rules and the reasons are in stop-person-plan.ts; this file does the I/O.
//
// Nothing here throws. Every failure is collected and returned, so a DNC
// entry or a label is always saved even when a provider call fails. Callers
// run it after their response (it never delays the portal or the inbox).

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** EmailBison rate-limits bursts (a CSV of hundreds); back off and retry a 429 twice. */
async function ebCall<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt < 2 && err instanceof EmailBisonError && err.status === 429) {
        await wait(2000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

/**
 * BrokerStaffer's EmailBison workspace: the one team every connected channel
 * is on. Read from the channels table and remembered for ten minutes. If the
 * channels ever span more than one team we do not guess — the active
 * workspace is then left as it is (the behaviour before 8 Oct).
 */
let teamCache: { id: number | null; at: number } | null = null;
export async function brokerStafferTeamId(): Promise<number | null> {
  if (teamCache && Date.now() - teamCache.at < 10 * 60_000) return teamCache.id;
  const { data, error } = await createAdminSupabase()
    .from("channels")
    .select("emailbison_team_id")
    .eq("provider", "emailbison")
    .not("emailbison_team_id", "is", null)
    .limit(1000);
  if (error) return teamCache?.id ?? null;
  const ids = new Set(
    ((data ?? []) as Array<{ emailbison_team_id: number | null }>)
      .map((r) => Number(r.emailbison_team_id))
      .filter((n) => Number.isFinite(n) && n > 0),
  );
  teamCache = { id: ids.size === 1 ? [...ids][0] : null, at: Date.now() };
  return teamCache.id;
}

/**
 * Select BrokerStaffer's workspace before a team-scoped EmailBison call. The
 * blacklist and reply endpoints act on the API user's ACTIVE workspace, and
 * that user can reach three; the send path already switches the same way.
 * Switching is idempotent, so one switch a minute covers a CSV's burst.
 */
let switchedAt = 0;
export async function selectBrokerStafferWorkspace(eb: ReturnType<typeof createEmailBisonClient>): Promise<void> {
  if (Date.now() - switchedAt < 60_000) return;
  const team = await brokerStafferTeamId();
  if (!team) return;
  await ebCall(() => eb.switchWorkspace(team));
  switchedAt = Date.now();
}

// PostgREST `or=(…)` filter of case-insensitive matches. Values are quoted;
// `_`, `%` and `*` stay wildcards there, so every row is re-checked for an
// exact match after it comes back.
const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const anyIlike = (column: string, values: string[]) => values.map((v) => `${column}.ilike.${quote(v)}`).join(",");

/** Newest inbound EmailBison reply id per conversation. */
async function latestReplyIds(threadIds: string[]): Promise<Map<string, string>> {
  const admin = createAdminSupabase();
  const latest = new Map<string, string>();
  for (const batch of chunks(threadIds, 50)) {
    const { data, error } = await admin
      .from("messages")
      .select("thread_id, emailbison_reply_id, sent_at")
      .in("thread_id", batch)
      .eq("direction", "inbound")
      .not("emailbison_reply_id", "is", null)
      .order("sent_at", { ascending: false })
      .limit(1000);
    if (error) throw new Error(`replies: ${error.message}`);
    for (const m of (data ?? []) as Array<{ thread_id: string; emailbison_reply_id: string | number | null }>) {
      if (m.emailbison_reply_id != null && !latest.has(m.thread_id)) latest.set(m.thread_id, String(m.emailbison_reply_id));
    }
  }
  return latest;
}

// The sender lookup scans messages (sender has no index). Labels can arrive
// in bulk — select fifty conversations, label them Unsubscribe — so lookups
// run at most two at a time and the rest queue, keeping the live inbox's
// database unhurried.
let lookupsRunning = 0;
const lookupQueue: Array<() => void> = [];
async function oneOfTwo<T>(fn: () => Promise<T>): Promise<T> {
  if (lookupsRunning >= 2) await new Promise<void>((resolve) => lookupQueue.push(resolve));
  lookupsRunning++;
  try {
    return await fn();
  } finally {
    lookupsRunning--;
    lookupQueue.shift()?.();
  }
}

/**
 * Every inbox conversation tied to these addresses: as the lead our campaign
 * emailed, or as the sender of a reply. Batched — a CSV of hundreds costs a
 * few queries, not hundreds (messages.sender has no index; leads.email is
 * citext, so `in` is already case-insensitive).
 */
export function findConversations(addresses: string[]): Promise<PersonConversation[]> {
  return oneOfTwo(() => lookUpConversations(addresses));
}

async function lookUpConversations(addresses: string[]): Promise<PersonConversation[]> {
  const want = new Set(addresses.map(normEmail).filter((a) => isBlockableAddress(a)));
  if (!want.size) return [];
  const admin = createAdminSupabase();

  const leadIds = new Set<string>();
  const senders = new Map<string, Set<string>>();
  for (const batch of chunks([...want], 25)) {
    const [leadsRes, sentRes] = await Promise.all([
      admin.from("leads").select("id").in("email", batch).limit(1000),
      admin.from("messages").select("thread_id, sender").eq("direction", "inbound").or(anyIlike("sender", batch)).limit(1000),
    ]);
    if (leadsRes.error) throw new Error(`leads: ${leadsRes.error.message}`);
    if (sentRes.error) throw new Error(`messages: ${sentRes.error.message}`);
    for (const l of (leadsRes.data ?? []) as Array<{ id: string }>) leadIds.add(l.id);
    for (const m of (sentRes.data ?? []) as Array<{ thread_id: string; sender: string | null }>) {
      const from = normEmail(m.sender);
      if (!want.has(from)) continue;
      if (!senders.has(m.thread_id)) senders.set(m.thread_id, new Set());
      senders.get(m.thread_id)!.add(from);
    }
  }
  const threadIds = new Set(senders.keys());
  for (const batch of chunks([...leadIds], 100)) {
    const { data, error } = await admin.from("threads").select("id").in("lead_id", batch).limit(1000);
    if (error) throw new Error(`threads: ${error.message}`);
    for (const t of (data ?? []) as Array<{ id: string }>) threadIds.add(t.id);
  }
  if (!threadIds.size) return [];

  const threads: Array<{ id: string; source_provider: string | null; lead_id: string | null }> = [];
  for (const batch of chunks([...threadIds], 100)) {
    const { data, error } = await admin.from("threads").select("id, source_provider, lead_id").in("id", batch);
    if (error) throw new Error(`threads: ${error.message}`);
    threads.push(...((data ?? []) as typeof threads));
  }
  const latest = await latestReplyIds(threads.map((t) => t.id));
  const leads = new Map<string, { email: string | null; full_name: string | null }>();
  for (const batch of chunks([...new Set(threads.map((t) => t.lead_id).filter((x): x is string => !!x))], 100)) {
    const { data, error } = await admin.from("leads").select("id, email, full_name").in("id", batch);
    if (error) throw new Error(`leads: ${error.message}`);
    for (const l of (data ?? []) as Array<{ id: string; email: string | null; full_name: string | null }>) leads.set(l.id, l);
  }
  return threads.map((t) => {
    const lead = t.lead_id ? leads.get(t.lead_id) : undefined;
    return {
      threadId: t.id,
      provider: t.source_provider,
      leadEmail: lead?.email ?? null,
      leadName: lead?.full_name ?? null,
      latestReplyId: latest.get(t.id) ?? null,
      senders: [...(senders.get(t.id) ?? [])],
    };
  });
}

export interface StopResult {
  /** EmailBison conversations unsubscribed by reply id. */
  unsubscribed: number;
  /** Other addresses of the same people that were blocked on both platforms. */
  otherAddresses: string[];
  /** Conversations they replied on whose lead has another name — left alone. */
  review: number;
  errors: string[];
}

/** Blacklist one address on both platforms (EmailBison's "already listed" counts as done). */
export async function blockAddressEverywhere(address: string, errors: string[]): Promise<void> {
  try {
    await createInstantlyClient().blockEmail(address);
  } catch (err) {
    errors.push(`instantly ${address}: ${errText(err)}`);
  }
  try {
    const eb = createEmailBisonClient();
    await selectBrokerStafferWorkspace(eb).catch(() => undefined);
    await ebCall(() => eb.blacklistEmail(address));
  } catch (err) {
    if (!(err instanceof EmailBisonError && alreadyBlacklisted(err.status, err.body))) {
      errors.push(`emailbison ${address}: ${errText(err)}`);
    }
  }
}

/** Unsubscribe EmailBison conversations by reply id. */
async function unsubscribeReplies(replyIds: string[], errors: string[]): Promise<number> {
  if (!replyIds.length) return 0;
  let eb: ReturnType<typeof createEmailBisonClient>;
  try {
    eb = createEmailBisonClient();
  } catch (err) {
    errors.push(`emailbison: ${errText(err)}`);
    return 0;
  }
  // A failed switch leaves the active workspace as it was (BrokerStaffer's today).
  await selectBrokerStafferWorkspace(eb).catch((err) => errors.push(`emailbison workspace: ${errText(err)}`));
  let done = 0;
  for (const id of replyIds) {
    try {
      await ebCall(() => eb.unsubscribeReply(id));
      done++;
    } catch (err) {
      errors.push(`emailbison unsubscribe reply ${id}: ${errText(err)}`);
    }
  }
  return done;
}

/**
 * Stop every conversation we have with these people: unsubscribe their
 * EmailBison conversations by reply id, and block the other addresses those
 * conversations were sent to (when the names agree — see planStop). The
 * people's own addresses are blocked by the caller.
 */
export async function stopPeople(people: Person[]): Promise<StopResult> {
  const errors: string[] = [];
  let conversations: PersonConversation[];
  try {
    conversations = await findConversations(people.flatMap((p) => p.emails));
  } catch (err) {
    errors.push(`lookup: ${errText(err)}`);
    console.error("[dnc] stop lookup failed", errText(err));
    return { unsubscribed: 0, otherAddresses: [], review: 0, errors };
  }
  const replyIds = new Set<string>();
  const others = new Set<string>();
  const review = new Set<string>();
  for (const person of people) {
    const plan = planStop(person, conversations);
    plan.unsubscribeReplyIds.forEach((id) => replyIds.add(id));
    plan.otherEmails.forEach((e) => others.add(e));
    plan.review.forEach((r) => review.add(r.threadId));
  }
  const unsubscribed = await unsubscribeReplies([...replyIds], errors);
  for (const other of others) await blockAddressEverywhere(other, errors);
  if (replyIds.size || others.size || review.size || errors.length) {
    console.log(
      `[dnc] stop ${people.length} person(s): unsubscribed ${unsubscribed}/${replyIds.size} conversation(s), blocked ${others.size} other address(es), ${review.size} left for review` +
        (errors.length ? ` · ${errors.length} error(s): ${errors.slice(0, 3).join(" | ")}` : ""),
    );
  }
  return { unsubscribed, otherAddresses: [...others], review: review.size, errors };
}

/**
 * Run the stop for portal DNC entries (people, not companies — a company's
 * domain blacklist already covers everyone there), after the blacklist push.
 * Never throws.
 */
export async function stopEntries(entries: Array<{ email: string | null | undefined; name: string | null | undefined }>): Promise<void> {
  try {
    const people: Person[] = [];
    const seen = new Set<string>();
    for (const e of entries) {
      const email = normEmail(e.email);
      if (!isBlockableAddress(email) || seen.has(email)) continue;
      seen.add(email);
      people.push({ emails: [email], name: e.name ?? null });
    }
    for (const batch of chunks(people, 200)) await stopPeople(batch);
  } catch (err) {
    console.error("[dnc] stopEntries failed", errText(err));
  }
}
