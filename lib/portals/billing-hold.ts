import { cache } from "react";
import { createAdminSupabase } from "@/lib/supabase/admin";

/*
 * A portal held back for an unpaid invoice (BrokerStaffer OS, 6 Oct).
 *
 * The OS writes os_portal_blocks when Stripe has failed to collect an invoice
 * after its recovery attempts, and lifts the row when the invoice is paid.
 * This only READS it, and only rows with mode 'blocked' count — the OS writes
 * 'dry_run' rows until blocking is switched on there, and those change
 * nothing here.
 *
 * FAILS OPEN. Any error — the table not created yet, a timeout, anything —
 * means "not held": a portal must never close because a check could not run.
 */
export interface BillingHold {
  amount: number | null;
  payUrl: string | null;
  since: string;
}

/*
 * Live portals are in use, so the check must not slow them: the answer is
 * remembered for a minute per portal (a hold or a payment shows within one),
 * and a read that takes longer than 1.5s counts as "not held".
 */
const REMEMBER_MS = 60_000;
const memo = new Map<string, { at: number; hold: BillingHold | null }>();

export const portalBillingHold = cache(async function portalBillingHold(clientId: string): Promise<BillingHold | null> {
  const seen = memo.get(clientId);
  if (seen && Date.now() - seen.at < REMEMBER_MS) return seen.hold;
  try {
    const { data, error } = await createAdminSupabase()
      .from("os_portal_blocks")
      .select("amount, pay_url, blocked_at")
      .eq("mode", "blocked")
      .is("lifted_at", null)
      .contains("mi_client_ids", [clientId])
      .limit(1)
      .abortSignal(AbortSignal.timeout(1500));
    if (error) {
      // Not created yet, slow, anything: not held — and not asked again for a minute.
      memo.set(clientId, { at: Date.now(), hold: null });
      return null;
    }
    const r = (data?.[0] ?? null) as { amount: number | string | null; pay_url: string | null; blocked_at: string } | null;
    const hold = r ? { amount: r.amount === null ? null : Number(r.amount), payUrl: r.pay_url ?? null, since: r.blocked_at } : null;
    memo.set(clientId, { at: Date.now(), hold });
    return hold;
  } catch {
    memo.set(clientId, { at: Date.now(), hold: null });
    return null;
  }
});
