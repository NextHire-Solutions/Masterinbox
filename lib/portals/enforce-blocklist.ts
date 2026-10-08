import { createEmailBisonClient, EmailBisonError } from "@/lib/emailbison/client";
import { createInstantlyClient } from "@/lib/instantly/client";
import { alreadyBlacklisted } from "@/lib/portals/stop-person-plan";
import { selectBrokerStafferWorkspace } from "@/lib/portals/stop-person";

// Pushes an email to Instantly and EmailBison blocklists. Used when a
// client adds an entry to their DNC list or their own-agent roster —
// either way the address should never receive outreach again.
//
// This is the per-email counterpart to lib/inbox/dnc.ts's per-thread
// markThreadLeadDoNotContact (which has full channel/team context). For
// client-level entries we don't know the channel, so we push to:
//   - Instantly  → POST /block-lists-entries (global per workspace)
//   - EmailBison → POST /api/blacklisted-emails, in BrokerStaffer's
//                  workspace (the blacklist is scoped to the API user's
//                  active workspace, and that user can reach three).
//
// Both attempts are best-effort and swallow their own errors. Per-provider
// success is reported back so the caller can mark the DB row. EmailBison's
// 422 "already on the list" is reported as pushed — it is.
//
// The blacklist stops the ADDRESS. Callers then run stopEntries
// (lib/portals/stop-person.ts) after responding, which also stops the
// person's existing conversations and their other addresses.

export interface BlocklistResult {
  pushedInstantly: boolean;
  pushedEmailBison: boolean;
  error: string | null;
}

export async function enforceBlocklist(email: string): Promise<BlocklistResult> {
  const addr = email.trim().toLowerCase();
  if (!addr) {
    return { pushedInstantly: false, pushedEmailBison: false, error: "missing email" };
  }

  const errors: string[] = [];
  let pushedInstantly = false;
  let pushedEmailBison = false;

  try {
    const inst = createInstantlyClient();
    await inst.blockEmail(addr);
    pushedInstantly = true;
  } catch (err) {
    errors.push(`instantly: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const eb = createEmailBisonClient();
    // A failed switch leaves the active workspace as before (it is BrokerStaffer's today).
    await selectBrokerStafferWorkspace(eb).catch(() => undefined);
    await eb.blacklistEmail(addr);
    pushedEmailBison = true;
  } catch (err) {
    if (err instanceof EmailBisonError && alreadyBlacklisted(err.status, err.body)) pushedEmailBison = true;
    else errors.push(`emailbison: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    pushedInstantly,
    pushedEmailBison,
    error: errors.length > 0 ? errors.join(" · ") : null,
  };
}

// Lower-case + strip leading `www.`, `@`, or any protocol/path the user
// might paste. Returns null if nothing useful remains.
export function normalizeDomain(raw: string): string | null {
  let v = raw.trim().toLowerCase();
  if (!v) return null;
  // Strip a leading protocol (https://example.com → example.com).
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  // Strip a leading `@` if the client typed "@example.com".
  v = v.replace(/^@/, "");
  // Strip a leading `www.`.
  v = v.replace(/^www\./, "");
  // Drop anything after the first slash — example.com/foo → example.com.
  v = v.split("/")[0] ?? v;
  // Must contain a dot to be a plausible domain.
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(v)) return null;
  return v;
}

// Domain-level counterpart for company DNC entries — pushes the whole
// domain to Instantly's wildcard block + EmailBison's domain blacklist
// in one go. Same best-effort / per-provider tally shape so the caller
// can mark the row.
export async function enforceDomainBlocklist(domain: string): Promise<BlocklistResult> {
  const d = normalizeDomain(domain);
  if (!d) {
    return { pushedInstantly: false, pushedEmailBison: false, error: "missing domain" };
  }

  const errors: string[] = [];
  let pushedInstantly = false;
  let pushedEmailBison = false;

  try {
    const inst = createInstantlyClient();
    await inst.blockDomain(d);
    pushedInstantly = true;
  } catch (err) {
    errors.push(`instantly: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const eb = createEmailBisonClient();
    // A failed switch leaves the active workspace as before (it is BrokerStaffer's today).
    await selectBrokerStafferWorkspace(eb).catch(() => undefined);
    await eb.blacklistDomain(d);
    pushedEmailBison = true;
  } catch (err) {
    if (err instanceof EmailBisonError && alreadyBlacklisted(err.status, err.body)) pushedEmailBison = true;
    else errors.push(`emailbison: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    pushedInstantly,
    pushedEmailBison,
    error: errors.length > 0 ? errors.join(" · ") : null,
  };
}
