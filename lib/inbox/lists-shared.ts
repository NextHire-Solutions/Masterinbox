// Pure types + helpers — no server imports (safe to import from client code).

export interface ListRow {
  id: string;
  name: string;
  icon: string | null;
  sort_order: number;
  shared: boolean;
}

// Client health status, sourced from the external /api/clients/status feed.
export type ClientStatus = "active" | "paused" | "churned";

export const CLIENT_STATUS_EMOJI: Record<ClientStatus, string> = {
  active: "🟢",
  paused: "🟡",
  churned: "🔴",
};

// The status feed and MasterInbox track the same clients under slightly
// different display names (case, dashes, punctuation — e.g. "C21 Results -
// Elite Team" vs "C21 Results Elite Team"). Since the two systems have
// different ids, NAME is the only join key, so we match on a normalized form:
// lowercased, stripped of every non-alphanumeric character.
export function normalizeClientName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}
