"use client";

import { useState } from "react";
import { Calendar } from "lucide-react";
import type { PipelineEntry, PipelineStage } from "@/lib/portals/portal-data";
import type { StageDef } from "@/lib/portals/stage-config";
import { SourceBadge } from "@/components/portals/source-badge";
import { cn } from "@/lib/utils";

// A rendered Kanban column. `dotClass` (Tailwind) drives the canonical dot on the
// unchanged path; `dotHex` (inline) drives custom-stage dots. Exactly one is set.
type KanbanColumn = { key: string; label: string; dotClass?: string; dotHex?: string };

// The display bucket for an entry: its custom-stage overlay if set (manage_stages),
// otherwise its canonical enum stage. Always the enum stage for real clients.
function displayKeyOf(e: PipelineEntry): string {
  return e.custom_stage_key ?? e.stage;
}

// Kanban renderer for the Recruiting Pipeline. Same entries the table
// already shows, grouped into one column per visible stage. Card click
// fires onCardClick which the parent wires to the existing
// EditLeadDialog — so every stage change still flows through one
// source of truth (the dialog's Stage dropdown), no parallel state
// machine and no drag-and-drop wiring yet.
//
// Visibility rules mirror the table:
//   • columns come from visibleStages (per-client gated; real clients
//     drop in-flight stages, Demo Portal sees the full set)
//   • labels come from stageLabels (the SSR-sanitised map — hidden
//     stages already mask their human label as the enum key)
//   • STAGE_STYLE is duplicated here on purpose so the Kanban column
//     dot stays single-source-of-truth with the table chip colour.
//     If those diverge later we should pull both from a shared
//     constant.

// Sales volume lives in the merged custom_fields under a "sales volume" key
// (values look like "$2,345,000"). Parse to a whole-dollar number; null when
// the field is absent or unparseable — those agents are simply skipped.
function salesVolumeOf(entry: PipelineEntry): number | null {
  const cf = (entry.lead_detail as { custom_fields?: Record<string, unknown> } | null)
    ?.custom_fields;
  if (!cf) return null;
  for (const [k, v] of Object.entries(cf)) {
    if (/sales\s*volume/i.test(k)) {
      const n = Number(String(v).replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) && n > 0 ? n : null;
    }
  }
  return null;
}

// Compact USD: $45.2M, $980K, $1.2B. Whole dollars under 1K.
function abbrevUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return `$${Math.round(n)}`;
}

const COLUMN_STYLE: Record<PipelineStage, { dot: string; chip: string }> = {
  introduction:           { dot: "bg-[#1976d2]", chip: "bg-[#1976d2]" },
  phone_screen_scheduled: { dot: "bg-[#7689e0]", chip: "bg-[#7689e0]" },
  phone_screen:           { dot: "bg-[#4f63d2]", chip: "bg-[#4f63d2]" },
  interview_scheduled:    { dot: "bg-[#a98ff8]", chip: "bg-[#a98ff8]" },
  interview:              { dot: "bg-[#7c4dff]", chip: "bg-[#7c4dff]" },
  hired:                  { dot: "bg-[#10a05d]", chip: "bg-[#10a05d]" },
  keep_warm:              { dot: "bg-[#f5a623]", chip: "bg-[#f5a623]" },
  we_they_rejected:       { dot: "bg-[#e23a3a]", chip: "bg-[#e23a3a]" },
  no_show:                { dot: "bg-[#8b95a3]", chip: "bg-[#8b95a3]" },
};

interface Props {
  entries: PipelineEntry[];
  visibleStages: PipelineStage[];
  stageLabels: Record<PipelineStage, string>;
  // manage_stages (Demo only): when provided, columns come from this config
  // (canonical + custom, ordered, with per-stage colors) instead of visibleStages.
  // Undefined for real clients → the unchanged visibleStages path renders.
  stageDefs?: StageDef[];
  onCardClick: (entry: PipelineEntry) => void;
  // Drag-and-drop stage change. Drop a card on a column → parent updates the entry
  // (canonical stage move, or a display-only custom-stage placement). The key is a
  // stage key (enum value or custom key); the parent routes it.
  onStageChange?: (entryId: string, nextStage: string) => void;
  // When true, the Source row is included in the card footer.
  // Driven by clients.feature_flags.pipeline_source_split — real
  // clients without the flag never get this as true so the source
  // value never enters the rendered HTML.
  showSource?: boolean;
  // Demo-only enhancements (clients.feature_flags.pipeline_board_enhanced):
  // fixed-height columns that scroll internally, plus per-stage total sales
  // volume in the header and each agent's sales volume on the card. Real
  // clients never get this true, so their board is byte-identical to before.
  enhanced?: boolean;
}

export function PipelineKanban({
  entries,
  visibleStages,
  stageLabels,
  stageDefs,
  onCardClick,
  onStageChange,
  showSource = false,
  enhanced = false,
}: Props) {
  // Track the currently-dragging entry id + the column the cursor is
  // hovering over so we can highlight the drop target. dragOverStage
  // gets cleared on dragleave + drop.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);

  // Columns come from the manage_stages config when present (canonical + custom,
  // ordered, per-stage colors); otherwise the unchanged visibleStages path.
  const columns: KanbanColumn[] = stageDefs
    ? stageDefs
        .filter((d) => !d.hidden)
        .map((d) => ({ key: d.key, label: d.label, dotHex: d.color }))
    : visibleStages.map((s) => ({
        key: s,
        label: stageLabels[s],
        dotClass: COLUMN_STYLE[s].dot,
      }));

  const grouped = new Map<string, PipelineEntry[]>();
  for (const c of columns) grouped.set(c.key, []);
  for (const e of entries) {
    const arr = grouped.get(displayKeyOf(e));
    if (arr) arr.push(e);
  }

  return (
    <div
      className={cn(
        "flex gap-3 overflow-x-auto pb-3",
        // Fixed to the viewport height so the board stops growing with the
        // record count; each column scrolls internally instead. Columns
        // stretch to this height (flex row, items-stretch default).
        enhanced && "h-[calc(100dvh-220px)] min-h-[360px] items-stretch",
      )}
    >
      {columns.map((c) => {
        const col = grouped.get(c.key) ?? [];
        const isDropTarget = dragOverStage === c.key;
        const colVolume = enhanced
          ? col.reduce((sum, e) => sum + (salesVolumeOf(e) ?? 0), 0)
          : 0;
        return (
          <div
            key={c.key}
            // Drop-target plumbing. preventDefault on dragOver is
            // required by the HTML5 DnD spec — without it, drop()
            // never fires. We highlight the column on dragEnter and
            // clear the highlight on dragLeave / drop.
            onDragOver={(event) => {
              if (!onStageChange || !draggingId) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDragEnter={() => {
              if (!onStageChange || !draggingId) return;
              setDragOverStage(c.key);
            }}
            onDragLeave={(event) => {
              // Only clear when the cursor leaves the column entirely,
              // not when it enters a child element (relatedTarget will
              // still be inside the column in the latter case).
              const cur = event.currentTarget;
              const next = event.relatedTarget as Node | null;
              if (next && cur.contains(next)) return;
              if (dragOverStage === c.key) setDragOverStage(null);
            }}
            onDrop={(event) => {
              if (!onStageChange) return;
              event.preventDefault();
              const id =
                event.dataTransfer.getData("application/x-pipeline-entry-id") ||
                draggingId;
              setDragOverStage(null);
              setDraggingId(null);
              if (!id) return;
              // No-op when the card is dropped on its current column.
              const cur = entries.find((e) => e.id === id);
              if (cur && displayKeyOf(cur) === c.key) return;
              onStageChange(id, c.key);
            }}
            className={cn(
              "flex w-[280px] shrink-0 flex-col rounded-xl border bg-[#fafbfc] transition-colors",
              isDropTarget
                ? "border-[#1565C0] ring-2 ring-[#eaf2fd]"
                : "border-[#ebecf0]",
            )}
          >
            <div className="flex items-center gap-2 border-b border-[#ebecf0] px-3 py-2.5">
              <span
                className={cn("size-2 rounded-full", c.dotClass)}
                style={c.dotHex ? { backgroundColor: c.dotHex } : undefined}
              />
              <span className="truncate text-[12.5px] font-semibold text-[#0f1320]">
                {c.label}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-2">
                {enhanced && colVolume > 0 ? (
                  <span
                    className="text-[11px] font-semibold tabular-nums text-[#1565C0]"
                    title="Total sales volume in this stage"
                  >
                    {abbrevUsd(colVolume)}
                  </span>
                ) : null}
                <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium tabular-nums text-[#5b6472] ring-1 ring-[#ebecf0]">
                  {col.length}
                </span>
              </span>
            </div>
            <div
              className={cn(
                "flex flex-1 flex-col gap-2 p-2",
                enhanced && "min-h-0 overflow-y-auto",
              )}
            >
              {col.length === 0 ? (
                <div className="rounded-md border border-dashed border-[#ebecf0] px-3 py-6 text-center text-[11.5px] text-[#9aa0ab]">
                  No candidates
                </div>
              ) : (
                col.map((e) => {
                  const sv = enhanced ? salesVolumeOf(e) : null;
                  return (
                  <button
                    key={e.id}
                    type="button"
                    draggable={Boolean(onStageChange)}
                    onDragStart={(event) => {
                      if (!onStageChange) return;
                      setDraggingId(e.id);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData(
                        "application/x-pipeline-entry-id",
                        e.id,
                      );
                    }}
                    onDragEnd={() => {
                      setDraggingId(null);
                      setDragOverStage(null);
                    }}
                    onClick={() => onCardClick(e)}
                    className={cn(
                      "flex flex-col gap-1.5 rounded-lg border border-[#ebecf0] bg-white p-2.5 text-left shadow-sm transition-colors hover:border-[#bcd5f1] hover:bg-[#fcfdff]",
                      onStageChange ? "cursor-grab active:cursor-grabbing" : "",
                      draggingId === e.id ? "opacity-50" : "",
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[#0f1320]">
                        {e.lead_name ?? "(no name)"}
                      </div>
                      {sv != null ? (
                        <span className="shrink-0 text-[12px] font-semibold tabular-nums text-[#1565C0]">
                          {abbrevUsd(sv)}
                        </span>
                      ) : null}
                    </div>
                    {e.current_brokerage ? (
                      <div className="truncate text-[11.5px] text-[#5b6472]">
                        {e.current_brokerage}
                      </div>
                    ) : null}
                    <div className="flex items-center gap-1.5 text-[11px] text-[#9aa0ab]">
                      <Calendar className="size-3" />
                      {e.introduced_at
                        ? new Date(e.introduced_at).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                          })
                        : "—"}
                      {showSource ? (
                        <SourceBadge value={e.source} className="ml-auto" />
                      ) : null}
                    </div>
                  </button>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
