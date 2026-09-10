// Client-portal policy: a candidate can only be moved into the
// "No Show / No Response" stage within 24 hours of their Introduction. After
// that window the move is blocked in the portal (server-enforced, with the UI
// reflecting it). MasterInbox is unaffected — this governs only the portal
// pipeline routes; the inbox "No Show / No Response" LABEL is separate and does
// not set the pipeline stage.

export const NO_SHOW_STAGE = "no_show";
export const NO_SHOW_WINDOW_HOURS = 24;

const WINDOW_MS = NO_SHOW_WINDOW_HOURS * 60 * 60 * 1000;

export const NO_SHOW_WINDOW_MESSAGE =
  "No Show / No Response can only be set within 24 hours of introduction.";

// Whether moving an entry into No Show is still allowed, given when it was
// introduced. FAIL-OPEN: a missing or unparseable introduced_at returns true,
// so a data gap can never wrongly block a client. `now` is injectable for
// deterministic tests.
export function noShowMoveAllowed(
  introducedAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!introducedAt) return true;
  const t = new Date(introducedAt).getTime();
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t <= WINDOW_MS;
}

// Milliseconds left in the No Show window; 0 once closed or when there is no
// usable introduced_at (so no countdown is shown for a data gap).
export function noShowMsRemaining(
  introducedAt: string | null | undefined,
  now: Date = new Date(),
): number {
  if (!introducedAt) return 0;
  const t = new Date(introducedAt).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, t + WINDOW_MS - now.getTime());
}

// Human "Xh Ym" / "Ym" for a remaining-ms value (whole minutes).
export function formatNoShowRemaining(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
