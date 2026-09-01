import type { Metadata } from "next";
import { resolvePortalClient } from "@/lib/portals/token";
import { clientHasFeature } from "@/lib/portals/feature-flags";
import {
  loadPipelineEntries,
  loadTeamMembers,
  resolveStageLabels,
  safeStageLabelsFor,
  visibleStagesFor,
  type PipelineStage,
} from "@/lib/portals/portal-data";
import {
  MANAGE_STAGES_FLAG,
  resolveStageDefs,
  type StageDef,
} from "@/lib/portals/stage-config";
import { loadClientStageRows } from "@/lib/portals/load-stages";
import {
  PipelineHeader,
  PipelineFooterInfo,
} from "@/components/portals/pipeline-header";
import { PipelineBoard } from "@/components/portals/pipeline-board";
import { PortalLogo } from "@/components/portals/portal-logo";
import { WelcomeRedirect } from "@/components/portals/welcome-redirect";
import {
  StageLabelsProvider,
  VisibleStagesProvider,
  StageDefsProvider,
} from "@/components/portals/stage-labels-context";

// The Recruiting Pipeline IS the portal home now. Every Introduction
// (legacy MasterInbox feed + new Postgres-triggered label assignments)
// lands as a client_pipeline_entries row — see migration 0027 — so this
// page renders the full lead list with stage management, notes, and the
// "needs replacement" toggle in one place. The old standalone
// /pipeline subroute redirects here.

export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await props.params;
  const client = await resolvePortalClient(token);
  return {
    title: client
      ? `${client.name} — Recruiting Pipeline`
      : "Portal not found",
    robots: { index: false, follow: false },
  };
}

export default async function PortalRoot(props: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await props.params;
  const client = await resolvePortalClient(token);
  if (!client) return <PortalNotFound />;

  const [entries, teamMembers] = await Promise.all([
    loadPipelineEntries(client.id),
    loadTeamMembers(client.id),
  ]);

  const fullLabels = resolveStageLabels(client.stage_label_overrides);
  // Per-client visible stage list. Real clients get the canonical
  // 8 stages; flag-enabled clients (Demo Portal) get the additional
  // interview_scheduled tile. Computed server-side and shared
  // across every nested component via VisibleStagesProvider.
  //
  // NOTE: `let` because the manage_stages block below may re-derive these
  // from the client's saved stage config. Every real client keeps the exact
  // values computed here (the block is gated + fail-open).
  let visibleStages = visibleStagesFor(client);
  // safeStageLabelsFor masks hidden stages' human labels with the
  // raw enum key BEFORE the prop crosses the server→client boundary,
  // so real clients' View Source never carries "Interview Scheduled"
  // in the SSR hydration payload. Demo Portal (with the flag) gets the
  // full labels through.
  let stageLabels = safeStageLabelsFor(fullLabels, visibleStages);

  // manage_stages (Demo Portal only): drive the CANONICAL stages' ORDER,
  // LABELS, and VISIBILITY from the client's saved stage config. Fail-open —
  // no rows yet, or any load error, leaves the exact defaults above untouched.
  // Custom stages are NOT rendered here (a later step). The board component is
  // unchanged; only the data it receives (visibleStages order + labels) differs.
  const manageStagesEnabled = clientHasFeature(client, MANAGE_STAGES_FLAG);
  let manageStages: StageDef[] | undefined;
  if (manageStagesEnabled) {
    const defs = resolveStageDefs(client, await loadClientStageRows(client.id));
    manageStages = defs; // full list (incl. hidden) for the Manage Stages editor
    const orderedCanonical = defs
      .filter((d) => d.kind === "canonical" && !d.hidden && d.canonicalStage)
      .map((d) => d.canonicalStage as PipelineStage);
    if (orderedCanonical.length > 0) {
      const cfgLabels = { ...fullLabels };
      for (const d of defs) {
        if (d.canonicalStage) cfgLabels[d.canonicalStage] = d.label;
      }
      visibleStages = orderedCanonical;
      stageLabels = safeStageLabelsFor(cfgLabels, visibleStages);
    }
  }

  return (
    <StageLabelsProvider value={stageLabels}>
      <VisibleStagesProvider value={visibleStages}>
        <StageDefsProvider value={manageStagesEnabled ? manageStages ?? null : null}>
        <WelcomeRedirect token={token} />
        <PipelineHeader clientName={client.name} />
        <PipelineBoard
          token={token}
          entries={entries}
          teamMembers={teamMembers}
          stageLabels={stageLabels}
          stageLabelOverrides={client.stage_label_overrides}
          fubConnected={client.fub_api_key_set}
          csvUploadEnabled={clientHasFeature(client, "pipeline_csv_upload")}
          kanbanViewEnabled={clientHasFeature(client, "pipeline_kanban_view")}
          sourceSplitEnabled={clientHasFeature(client, "pipeline_source_split")}
          boardEnhanced={clientHasFeature(client, "pipeline_board_enhanced")}
          manageStagesEnabled={manageStagesEnabled}
          manageStages={manageStages}
        />
        <PipelineFooterInfo />
        </StageDefsProvider>
      </VisibleStagesProvider>
    </StageLabelsProvider>
  );
}

function PortalNotFound() {
  return (
    <div className="min-h-screen bg-[#f4f7fb] flex items-center justify-center px-6">
      <div className="text-center max-w-sm">
        <PortalLogo className="h-12 w-auto mx-auto" />
        <h1 className="mt-5 text-lg font-semibold text-[#15181e]">
          Portal not found
        </h1>
        <p className="mt-1.5 text-sm text-[#5b6370]">
          This portal link is invalid or has been turned off. Please check the
          link, or contact BrokerStaffer for an updated one.
        </p>
      </div>
    </div>
  );
}
