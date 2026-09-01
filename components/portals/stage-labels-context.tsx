"use client";

import { createContext, useContext } from "react";
import {
  DEFAULT_STAGE_LABELS,
  STAGE_ORDER,
  type PipelineStage,
} from "@/lib/portals/portal-data";
import type { StageDef } from "@/lib/portals/stage-config";

// Per-client-resolved labels for the pipeline_stage enum. Provided
// once at the top of the pipeline UI tree (see
// [components/portals/pipeline-board.tsx]) and consumed by every
// nested component that renders a stage name — badges, dropdowns,
// the move-to menu, toast text. Pulling these via context instead
// of prop drilling keeps the 8 read sites tidy and means the
// editor's Save reflects everywhere in one re-render.

const StageLabelsContext = createContext<Record<PipelineStage, string>>(
  DEFAULT_STAGE_LABELS,
);

export function StageLabelsProvider({
  value,
  children,
}: {
  value: Record<PipelineStage, string>;
  children: React.ReactNode;
}) {
  return (
    <StageLabelsContext.Provider value={value}>
      {children}
    </StageLabelsContext.Provider>
  );
}

export function useStageLabels(): Record<PipelineStage, string> {
  return useContext(StageLabelsContext);
}

// Per-client *visible* stage list. STAGE_ORDER is the canonical
// universe; this context narrows that down to what THIS client
// should see in dropdowns / chips / legend. Real clients get the
// pre-Interview-Scheduled list (8 stages); Demo Portal (with the
// interview_scheduled_stage flag) gets the full 9.
//
// Default falls back to STAGE_ORDER so any component rendered
// outside a provider stays compatible — but the pipeline tree
// always provides the per-client value via VisibleStagesProvider
// at the page root.
const VisibleStagesContext = createContext<PipelineStage[]>(STAGE_ORDER);

export function VisibleStagesProvider({
  value,
  children,
}: {
  value: PipelineStage[];
  children: React.ReactNode;
}) {
  return (
    <VisibleStagesContext.Provider value={value}>
      {children}
    </VisibleStagesContext.Provider>
  );
}

export function useVisibleStages(): PipelineStage[] {
  return useContext(VisibleStagesContext);
}

// Full per-client stage config (canonical + custom, ordered, colored) — present
// ONLY for clients with the manage_stages flag (Demo). null for everyone else, so
// deep components like StageSelector fall back to the canonical enum path.
const StageDefsContext = createContext<StageDef[] | null>(null);

export function StageDefsProvider({
  value,
  children,
}: {
  value: StageDef[] | null;
  children: React.ReactNode;
}) {
  return (
    <StageDefsContext.Provider value={value}>
      {children}
    </StageDefsContext.Provider>
  );
}

export function useStageDefs(): StageDef[] | null {
  return useContext(StageDefsContext);
}
