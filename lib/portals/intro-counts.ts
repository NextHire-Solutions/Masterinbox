/*
 * How many introductions a client has had — the one definition behind every
 * introductions figure in the OS (15 Oct).
 *
 * It used to be "conversations labelled Introduction", which disagreed with
 * the client's own portal both ways (54 Realty: 34 in the OS, 50 in the
 * portal, 53 in truth):
 *   - The portal holds introductions that have no conversation in Master
 *     Inbox: the ones made before the client's conversations were synced,
 *     loaded into the portal when it opened (19 of 54 Realty's).
 *   - Some introductions never reached the portal: labelled while their
 *     conversation had no client, which the database skipped and never
 *     revisited (132 across all clients, May–Sept 2026). Migration 0078 makes
 *     that impossible from 15 Oct on; the old ones were not backfilled (user
 *     decision), so they are counted here and shown as "not in the portal".
 *
 * So an introduction is: every entry WE put in a client's portal (anything but
 * the client's own "Client Entry" candidates), plus every conversation labelled
 * Introduction that has no such entry. A labelled conversation the client had
 * already added themselves is in the portal, so it counts as in the portal.
 *
 * WHICH NUMBER IS SHOWN (15 Oct, second pass): the OS must agree with the
 * portal ("C21, Chucktown and FAST are not showing the same numbers"). So the
 * headline `count` is the introductions IN the portal; the ones that never
 * reached it are `notInPortal`, shown beside it, never added in. The Client
 * Portals list shows `candidates` — exactly the portal's own "N of N
 * candidates", the client's own included.
 */

/** What a client adds to their own portal. Their candidates, not our introductions. */
export const CLIENT_ENTRY_SOURCE = "Client Entry";

export interface PortalEntryRow {
  client_id: string | null;
  thread_id: string | null;
  source: string | null;
  introduced_at: string | null;
}

export interface LabelledIntro {
  client_id: string;
  thread_id: string;
  /** When the Introduction label was applied. */
  assigned_at: string;
}

export interface IntroCount {
  /** The headline: our introductions in the client's portal (= inPortal). */
  count: number;
  lastAt: string | null;
  /** Introductions the client can see in their portal. */
  inPortal: number;
  /** Introductions made but never in the client's portal — shown beside `count`, not in it. */
  notInPortal: number;
  /** Every candidate in the portal, the client's own too — the portal's own "N of N candidates". */
  candidates: number;
}

const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

export function countIntroductions(entries: readonly PortalEntryRow[], labelled: readonly LabelledIntro[]): Map<string, IntroCount> {
  const out = new Map<string, IntroCount>();
  const row = (clientId: string) => {
    let r = out.get(clientId);
    if (!r) out.set(clientId, (r = { count: 0, lastAt: null, inPortal: 0, notInPortal: 0, candidates: 0 }));
    return r;
  };

  // Every conversation that has a portal entry of any kind, anywhere.
  const inSomePortal = new Set(entries.map((e) => e.thread_id).filter((t): t is string => !!t));
  // The conversations behind OUR entries.
  const ours = new Set<string>();

  for (const e of entries) {
    if (!e.client_id) continue;
    row(e.client_id).candidates += 1;
    if (e.source === CLIENT_ENTRY_SOURCE) continue;
    if (e.thread_id) ours.add(e.thread_id);
    const r = row(e.client_id);
    r.inPortal += 1;
    r.lastAt = later(r.lastAt, e.introduced_at);
  }

  const counted = new Set<string>();
  for (const l of labelled) {
    if (ours.has(l.thread_id) || counted.has(l.thread_id)) continue;
    counted.add(l.thread_id);
    const r = row(l.client_id);
    // Labelled, and the client added them themselves: it IS in their portal.
    if (inSomePortal.has(l.thread_id)) r.inPortal += 1;
    else r.notInPortal += 1;
    r.lastAt = later(r.lastAt, l.assigned_at);
  }

  for (const r of out.values()) r.count = r.inPortal;
  return out;
}
