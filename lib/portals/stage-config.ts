// Client-customizable pipeline stages — the shared, pure model used by the portal
// board, the Manage Stages editor, and the move API. NO I/O here (DB reads happen in
// the page / route); this module only defines the shape and resolves DB rows into the
// StageDef list the UI renders.
//
// SAFETY: this is a DISPLAY OVERLAY on the frozen `pipeline_stage` enum. A StageDef is
// either `canonical` (backed by a real enum value — drives the funnel/webhooks) or
// `custom` (a display-only workflow bucket that never touches the enum). All of this is
// only consulted when the `manage_stages` feature flag is on (Demo portal only); with
// the flag off, callers use the existing hardcoded path unchanged.

import type { PipelineStage } from "./portal-data";
import {
  STAGE_ORDER,
  resolveStageLabels,
  visibleStagesFor,
} from "./portal-data";

export const MANAGE_STAGES_FLAG = "manage_stages";

// A single stage as the board should render it.
export interface StageDef {
  key: string; // canonical: the enum value; custom: 'custom_<slug>'
  label: string;
  color: string; // hex; rendered via inline style so it's Tailwind-purge-safe
  kind: "canonical" | "custom";
  canonicalStage: PipelineStage | null; // canonical: the enum value; custom: null
  hidden: boolean;
}

// Shape of a `client_pipeline_stages` row (migration 0074).
export interface ClientStageRow {
  key: string;
  label: string;
  color: string | null;
  sort_order: number;
  kind: "canonical" | "custom";
  canonical_stage: PipelineStage | null;
  hidden: boolean;
}

type StageClient =
  | {
      feature_flags?: Record<string, unknown> | null;
      stage_label_overrides?: Record<string, unknown> | null;
    }
  | null
  | undefined;

// Default hex per canonical stage — mirrors STAGE_STYLE in pipeline-board.tsx so the
// board looks identical whether it renders from code or from seeded rows.
export const CANONICAL_STAGE_COLOR: Record<PipelineStage, string> = {
  introduction: "#1976d2",
  phone_screen_scheduled: "#7689e0",
  phone_screen: "#4f63d2",
  interview_scheduled: "#a98ff8",
  interview: "#7c4dff",
  hired: "#10a05d",
  keep_warm: "#f5a623",
  we_they_rejected: "#e23a3a",
  no_show: "#8b95a3",
};

// Preset palette the client picks a custom-stage color from. First entries match the
// canonical hues; the rest are distinct additions. Kept small so boards stay legible.
export const STAGE_COLOR_PALETTE: readonly string[] = [
  "#1976d2", // blue
  "#4f63d2", // indigo
  "#7c4dff", // purple
  "#10a05d", // green
  "#f5a623", // amber
  "#e23a3a", // red
  "#0891b2", // cyan
  "#db2777", // pink
  "#65a30d", // lime
  "#8b95a3", // gray
];

// Canonical stages must stay in the pipeline (they carry side-effects). They can be
// renamed / reordered / hidden, but never deleted.
export const STRUCTURAL_CANONICAL_STAGES: readonly PipelineStage[] = [
  "introduction",
  "hired",
  "no_show",
];

// The stage list a client sees TODAY (off-flag path + the seed source): the canonical
// stages, current labels, current visibility. Produces the same rendering as the
// existing hardcoded path.
export function canonicalStageDefs(client: StageClient): StageDef[] {
  const visible = new Set(visibleStagesFor(client));
  const labels = resolveStageLabels(client?.stage_label_overrides);
  return STAGE_ORDER.map((s) => ({
    key: s,
    label: labels[s],
    color: CANONICAL_STAGE_COLOR[s],
    kind: "canonical" as const,
    canonicalStage: s,
    hidden: !visible.has(s),
  }));
}

// The rows to seed into `client_pipeline_stages` the first time a client opens Manage
// Stages, so their canonical stages carry over exactly as they render now.
export function seedRowsForClient(
  client: StageClient,
): Array<Omit<ClientStageRow, never>> {
  return canonicalStageDefs(client).map((d, i) => ({
    key: d.key,
    label: d.label,
    color: d.color,
    sort_order: i,
    kind: d.kind,
    canonical_stage: d.canonicalStage,
    hidden: d.hidden,
  }));
}

// Resolve the client's effective stage list. When rows exist (feature in use) they win;
// otherwise fall back to the canonical defaults. Ordered by sort_order.
export function resolveStageDefs(
  client: StageClient,
  rows: ClientStageRow[] | null | undefined,
): StageDef[] {
  if (!rows || rows.length === 0) return canonicalStageDefs(client);
  return [...rows]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((r) => ({
      key: r.key,
      label: r.label,
      color:
        r.color ??
        (r.canonical_stage
          ? CANONICAL_STAGE_COLOR[r.canonical_stage]
          : STAGE_COLOR_PALETTE[0]),
      kind: r.kind,
      canonicalStage: r.canonical_stage,
      hidden: r.hidden,
    }));
}
