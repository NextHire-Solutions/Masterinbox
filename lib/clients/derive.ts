import { createAdminSupabase } from "@/lib/supabase/admin";

// Maps a campaign name (e.g. "Brooklyn Group (2) - The Arc New Rochelle")
// to the matching BrokerStaffer client (e.g. "Brooklyn Group"). Falls back to the
// "Unknown" client when nothing matches.
//
// Matching is TOKEN-based, not raw substring, so punctuation and spacing
// differences between how a name reads in Instantly/EmailBison vs in
// MasterInbox don't break it:
//   - "C21 Results - Elite Team"  ↔  "C21 Results Elite Team …"   (hyphen)
//   - "SERHANT."                  ↔  "Serhant …"                  (period)
//   - "Jeff Cook Real Estate"     ↔  "Jeff Cook …"                (extra words)
//
// A client matches a campaign when EITHER:
//   (a) the client's full normalised name appears as a contiguous token
//       run anywhere in the campaign, OR
//   (b) the campaign STARTS WITH the first 2+ tokens of the client's name
//       (campaigns are named "<client> - <suffix>", so a leading-token
//       overlap is a strong, low-false-positive signal).
// The match with the most overlapping tokens wins, so a longer/more
// specific client beats a shorter generic one.

interface ClientRow {
  id: string;
  name: string;
  slug: string;
  aliases: string[];
}

let cache: { rows: ClientRow[]; loadedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Lowercase, strip every non-alphanumeric run to a single space, trim →
// token array. "C21 Results - Elite Team" → ["c21","results","elite","team"]
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

// Score how well a needle (client name / alias) matches a campaign's
// tokens. Higher = better; 0 = no match.
function matchScore(needleTokens: string[], campaignTokens: string[]): number {
  if (needleTokens.length === 0 || campaignTokens.length === 0) return 0;

  // (a) full contiguous appearance anywhere in the campaign.
  const camp = ` ${campaignTokens.join(" ")} `;
  const need = ` ${needleTokens.join(" ")} `;
  if (camp.includes(need)) {
    // +0.5 so a full contiguous hit always outranks a leading-prefix hit
    // of the same token count.
    return needleTokens.length + 0.5;
  }

  // (b) leading-token overlap — campaign begins with the client's name.
  let i = 0;
  while (
    i < needleTokens.length &&
    i < campaignTokens.length &&
    needleTokens[i] === campaignTokens[i]
  ) {
    i++;
  }
  // A single shared leading token is too weak (e.g. "Realty"), UNLESS it
  // is the client's entire name (e.g. "SERHANT.").
  if (i >= 2) return i;
  if (i === 1 && needleTokens.length === 1) return 1;
  return 0;
}

async function loadClients(): Promise<ClientRow[]> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.rows;
  }
  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, slug, aliases");
  if (error || !data) {
    console.error("[clients] failed to load clients table", error);
    return cache?.rows ?? [];
  }
  const rows: ClientRow[] = data.map((d) => ({
    id: d.id as string,
    name: d.name as string,
    slug: d.slug as string,
    aliases: (d.aliases as string[] | null) ?? [],
  }));
  cache = { rows, loadedAt: Date.now() };
  return rows;
}

/**
 * The campaign a reply came from, as the thread stores it: EmailBison's
 * number, Instantly's UUID.
 */
export interface CampaignRef {
  platform: "emailbison" | "instantly";
  id: string | number | null | undefined;
}

/*
 * The portal chosen for this campaign, if one was (os_campaign_portals,
 * migration 0025 in the OS repo, 1 Oct). A client with several portals —
 * Properties & Estates has Boston and Florida — gets a portal per campaign,
 * chosen automatically once in the OS and changeable there. Without it the
 * name guess below sent Florida replies to the Boston portal.
 *
 * Read on every call, not cached: a change made in the OS must apply to the
 * very next reply. Any failure (table not created yet, network) means "no
 * choice", and the name guess runs exactly as it always has.
 */
async function chosenPortal(campaign: CampaignRef | undefined): Promise<string | null> {
  const id = campaign?.id == null ? "" : String(campaign.id).trim();
  if (!campaign || !id) return null;
  try {
    const { data, error } = await createAdminSupabase()
      .from("os_campaign_portals")
      .select("mi_client_id")
      .eq("platform", campaign.platform)
      .eq("campaign_id", id)
      .maybeSingle();
    if (error || !data) return null;
    return ((data as { mi_client_id?: string | null }).mi_client_id ?? null) || null;
  } catch {
    return null;
  }
}

export async function deriveClientIdFromCampaign(
  campaignName: string | null | undefined,
  campaign?: CampaignRef,
): Promise<string | null> {
  const rows = await loadClients();
  if (rows.length === 0) return null;

  // A portal chosen for this exact campaign wins over any guess — provided
  // that portal still exists.
  const chosen = await chosenPortal(campaign);
  if (chosen && rows.some((r) => r.id === chosen)) return chosen;

  // Always-resolvable fallback when nothing matches.
  const unknown = rows.find((r) => r.slug === "unknown") ?? null;
  if (!campaignName) return unknown?.id ?? null;

  const campaignTokens = tokenize(campaignName);
  if (campaignTokens.length === 0) return unknown?.id ?? null;

  // Exclude "Unknown" from the match scan — it's the fallback, not a target.
  const candidates = rows.filter((r) => r.slug !== "unknown");

  let bestClient: ClientRow | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    for (const raw of [c.name, ...(c.aliases ?? [])]) {
      if (!raw) continue;
      const score = matchScore(tokenize(raw), campaignTokens);
      if (score > bestScore) {
        bestScore = score;
        bestClient = c;
      }
    }
  }
  if (bestClient) return bestClient.id;
  return unknown?.id ?? null;
}

// Bypass the cache. Called after add/edit/delete on the clients table
// so the next webhook sees fresh data instead of waiting 5 minutes.
export function _invalidateClientCache(): void {
  cache = null;
}
