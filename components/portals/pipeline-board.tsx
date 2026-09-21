"use client";

import { useMemo, useState, useTransition, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  Check,
  Search,
  StickyNote,
  Loader2,
  Plus,
  Trash2,
  Pencil,
  Download,
  Upload,
  FileText,
  Phone as PhoneIcon,
  MessageSquare,
  Globe,
  Mail,
  Calendar,
  Workflow,
  X,
  Repeat,
  Send,
  CircleCheck,
  TriangleAlert,
  Copy,
} from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  type PipelineEntry,
  type PipelineStage,
  type TeamMember,
} from "@/lib/portals/portal-data";
import {
  useStageLabels,
  useVisibleStages,
  useStageDefs,
} from "@/components/portals/stage-labels-context";
import { StageLabelEditor } from "@/components/portals/stage-label-editor";
import { StageManager } from "@/components/portals/stage-manager";
import type { StageDef } from "@/lib/portals/stage-config";
import {
  PortalEmpty,
  Avatar,
  useMounted,
  PaginationFooter,
  PORTAL_PAGE_SIZE,
  SelectAllAcrossPagesBanner,
} from "@/components/portals/portal-ui";
import { PipelineDetailInline } from "@/components/portals/pipeline-detail-inline";
import { PipelineKanban } from "@/components/portals/pipeline-kanban";
import {
  pickFirstString,
  PHONE_KEYS,
} from "@/components/portals/custom-field-helpers";
import { PipelineDetailSheet } from "@/components/portals/pipeline-detail-sheet";
import { ConversationSheet } from "@/components/portals/conversation-sheet";
import { SourceBadge } from "@/components/portals/source-badge";
import {
  parseCsv,
  csvRowToPipeline,
  type PipelineCsvRow,
} from "@/lib/portals/csv";
import { formatPhoneDisplay } from "@/lib/portals/phone";

// Stage → coloured chip. Tone matches the Google Sheets pipeline board:
// saturated fill, white text — readable at a glance across a long table.
// Exported so the StageLabelEditor card on the same page can render
// matching color dots beside its inputs — single source of truth.
export const STAGE_STYLE: Record<PipelineStage, { bg: string; text: string }> = {
  introduction:           { bg: "bg-[#1976d2]", text: "text-white" },
  // Workflow gradient reads:
  //   intro-blue → phone-scheduled-light-indigo → phone-indigo
  //   → interview-scheduled-light-purple → interview-purple → hired-green.
  phone_screen_scheduled: { bg: "bg-[#7689e0]", text: "text-white" },
  phone_screen:           { bg: "bg-[#4f63d2]", text: "text-white" },
  interview_scheduled:    { bg: "bg-[#a98ff8]", text: "text-white" },
  interview:              { bg: "bg-[#7c4dff]", text: "text-white" },
  hired:                  { bg: "bg-[#10a05d]", text: "text-white" },
  keep_warm:              { bg: "bg-[#f5a623]", text: "text-white" },
  we_they_rejected:       { bg: "bg-[#e23a3a]", text: "text-white" },
  no_show:                { bg: "bg-[#8b95a3]", text: "text-white" },
};

// Two small extractors, one per copyable field. Split out per July
// 2026 spec: the client wanted separate buttons per field so a
// dialer paste doesn't drag a name along with it. Phone resolution
// mirrors what the pipeline row displays: snapshot column first
// (edit-dialog target), fall back to leads.custom_fields via the
// same PHONE_KEYS list the display uses.
function getLeadCopyName(entry: PipelineEntry): string {
  return (entry.lead_name || entry.lead_email || "").trim();
}
function getLeadCopyPhone(entry: PipelineEntry): string {
  const cf = ((entry.lead_detail as { custom_fields?: Record<string, unknown> } | null)
    ?.custom_fields ?? {}) as Record<string, unknown>;
  const phone = entry.lead_phone || pickFirstString(cf, PHONE_KEYS);
  return (phone ?? "").trim();
}

// Keys that are NOT shown in the editable "Custom fields" section of
// the Edit dialog — either because they already have a dedicated input
// (name / email / phone / company / agent profile) or because they're
// machine noise the detail card also hides. Mirrors the dedup + CF_SKIP
// logic in pipeline-detail-inline.tsx so the dialog's editable set
// matches exactly what the card renders in its generic grid.
const CUSTOM_FIELD_SKIP = new Set([
  "email",
  "phone", "phone number", "phonenumber", "phone_number", "mobile", "cell",
  "name", "first_name", "last_name", "full_name", "firstname", "lastname", "fullname",
  "company", "companyname", "company_name", "brokerage", "current_brokerage",
  "title", "jobtitle", "job_title",
  "location",
  "website", "url",
  // Machine noise (kept in sync with CF_SKIP in the detail card):
  "campaign", "campaign_id", "campaignid", "step", "variant",
  "email_id", "emailid", "is_first", "isfirst", "unibox_url", "uniboxurl",
  "source",
]);

// Returns the [key, value] pairs a client may edit for an entry —
// every custom_fields key except the dedicated / noise ones above and
// any "* Profile" alias (handled by the dedicated Agent profile input).
// Values are stringified; null/undefined become "".
function editableCustomFields(entry: PipelineEntry): Array<[string, string]> {
  const cf = ((entry.lead_detail as { custom_fields?: Record<string, unknown> } | null)
    ?.custom_fields ?? {}) as Record<string, unknown>;
  return Object.entries(cf)
    .filter(([k]) => {
      const lk = k.toLowerCase();
      if (CUSTOM_FIELD_SKIP.has(lk)) return false;
      if (/profile$/i.test(k)) return false;
      return true;
    })
    .map(([k, v]) => [k, v == null ? "" : String(v)] as [string, string]);
}

// Field-label prettifier — identical to prettyKey() in
// pipeline-detail-inline.tsx so a field reads the same in the Edit
// dialog as it does on the detail card ("buy-side" → "Buy-side",
// "salesVolume" → "Sales Volume").
function prettyFieldLabel(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

type EditTarget = { mode: "create" } | { mode: "edit"; entry: PipelineEntry };

export function PipelineBoard({
  token,
  entries: initial,
  teamMembers,
  stageLabels,
  stageLabelOverrides,
  fubConnected,
  csvUploadEnabled = false,
  kanbanViewEnabled = false,
  sourceSplitEnabled = false,
  boardEnhanced = false,
  manageStagesEnabled = false,
  manageStages,
}: {
  token: string;
  entries: PipelineEntry[];
  // Pulled from client_team_members for this client. Powers the
  // row-level "Assigned" pill + the bulk "Assign to…" dropdown.
  // Passed in (not fetched here) so the page can dedupe with other
  // surfaces and stay fully server-rendered.
  teamMembers: TeamMember[];
  // Per-client stage names resolved server-side (defaults merged with
  // overrides). Drives every chip, dropdown, and menu through the
  // StageLabelsProvider below.
  stageLabels: Record<PipelineStage, string>;
  // Raw overrides jsonb — seeds the StageLabelEditor card so the
  // form knows which keys are customised vs. default.
  stageLabelOverrides: Record<string, unknown>;
  // True when the client has saved a Follow Up Boss API key. Drives
  // whether the per-row "Push to Follow Up Boss" chip renders
  // enabled or with a "Connect in Settings" hint.
  fubConnected: boolean;
  // Per-client feature flags, resolved server-side from
  // clients.feature_flags. Each defaults to false so real clients
  // without the flag never see the gated UI and the relevant
  // strings ("Upload CSV", "Kanban", "Source", "Client Entry")
  // never enter the SSR hydration payload.
  csvUploadEnabled?: boolean;
  kanbanViewEnabled?: boolean;
  sourceSplitEnabled?: boolean;
  // Demo-only board enhancements (fixed-height scrolling columns + sales-volume
  // totals). Real clients default false → their board view is unchanged.
  boardEnhanced?: boolean;
  // Demo-only (manage_stages): renders the Manage Stages editor in place of the
  // rename card, seeded with the full stage config (incl. hidden). Real clients
  // default false / undefined → the existing StageLabelEditor renders unchanged
  // and no manage-stages strings enter the SSR payload.
  manageStagesEnabled?: boolean;
  manageStages?: StageDef[];
}) {
  const router = useRouter();
  const mounted = useMounted();
  // Per-client list of stages this client is allowed to see in the
  // UI (filter chips, bulk move-to menu). Real clients are missing
  // the in-flight stages (e.g. Interview Scheduled); Demo Portal sees
  // the full set via the feature_flags.interview_scheduled_stage
  // flag. STAGE_ORDER stays as the canonical universe for Record
  // initialisers + type exhaustiveness.
  const visibleStages = useVisibleStages();
  // Local copy lets us update optimistically — the server is the source
  // of truth on the next router.refresh().
  const [entries, setEntries] = useState(initial);
  useEffect(() => setEntries(initial), [initial]);

  const [search, setSearch] = useState("");
  // Holds display keys — a canonical stage OR a custom_stage_key — so custom
  // stages get filter bubbles too.
  const [stageFilter, setStageFilter] = useState<Set<string>>(new Set());
  const [replaceOnly, setReplaceOnly] = useState(false);
  const [openNotes, setOpenNotes] = useState<PipelineEntry | null>(null);
  const [openConversation, setOpenConversation] = useState<PipelineEntry | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  // Kanban card click opens this read-first sheet showing the full
  // lead detail (custom variables, brokerage, intro date, notes).
  // Distinct from editTarget — that one drives the EditLeadDialog
  // form for actual writes. "Edit details" inside the sheet hands
  // off to editTarget so changes ride the existing edit flow.
  const [detailTarget, setDetailTarget] = useState<PipelineEntry | null>(null);
  const [csvOpen, setCsvOpen] = useState(false);
  // List ↔ Kanban view toggle. Default "list" for SSR. After mount,
  // hydrate from localStorage so the choice persists per portal token.
  // Real clients without the kanbanViewEnabled flag never see the
  // toggle; their view stays locked to "list" via the conditional
  // render below (they couldn't toggle even if state somehow drifted).
  const [viewMode, setViewMode] = useState<"list" | "kanban">("list");
  useEffect(() => {
    if (!kanbanViewEnabled) return;
    try {
      const v = window.localStorage.getItem(`portal:${token}:pipeline-view`);
      if (v === "kanban" || v === "list") setViewMode(v);
    } catch {
      // localStorage blocked → silently stay on default.
    }
  }, [token, kanbanViewEnabled]);
  function changeView(next: "list" | "kanban") {
    setViewMode(next);
    try {
      window.localStorage.setItem(`portal:${token}:pipeline-view`, next);
    } catch {
      // no-op
    }
  }
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (stageFilter.size > 0 && !stageFilter.has(e.custom_stage_key ?? e.stage))
        return false;
      if (replaceOnly && e.stage !== "no_show") return false;
      if (q) {
        const hay = [e.lead_name, e.lead_email, e.current_brokerage, e.lead_phone]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [entries, search, stageFilter, replaceOnly]);

  // Reset the pager whenever the active filter set shrinks the result
  // count below the current page's range.
  useEffect(() => setPage(1), [search, stageFilter, replaceOnly]);

  const pageItems = useMemo(() => {
    const start = (page - 1) * PORTAL_PAGE_SIZE;
    return filtered.slice(start, start + PORTAL_PAGE_SIZE);
  }, [filtered, page]);

  // Per-display-stage counts for the filter chips, keyed by the SAME display
  // key the board groups by (custom_stage_key ?? stage), so a candidate parked
  // in a custom stage is counted under that custom stage, not its enum stage.
  const stageCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of entries) {
      const k = e.custom_stage_key ?? e.stage;
      m[k] = (m[k] ?? 0) + 1;
    }
    return m;
  }, [entries]);

  // The stages that get a filter bubble: the full manage_stages list (canonical
  // + custom, non-hidden) when available, else the canonical visible set. This
  // is what surfaces custom stages as filter bubbles. Colour is a hex for custom
  // stages (applied inline) and a Tailwind class for canonical ones.
  const filterStages = useMemo<
    Array<{ key: string; label: string; hex: string | null; canonical: boolean }>
  >(() => {
    if (manageStagesEnabled && manageStages && manageStages.length > 0) {
      return manageStages
        .filter((d) => !d.hidden)
        .map((d) => ({
          key: d.key,
          label: d.label,
          hex: d.kind === "custom" ? d.color : null,
          canonical: d.kind === "canonical",
        }));
    }
    return visibleStages.map((s) => ({
      key: s,
      label: stageLabels[s],
      hex: null,
      canonical: true,
    }));
  }, [manageStagesEnabled, manageStages, visibleStages, stageLabels]);

  async function patch(id: string, body: Partial<PipelineEntry>) {
    const res = await fetch(`/api/portal/${token}/pipeline/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? "Update failed");
      router.refresh();
      return false;
    }
    return true;
  }

  function toggleStageFilter(s: string) {
    setStageFilter((cur) => {
      const next = new Set(cur);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  function changeStage(id: string, stage: PipelineStage) {
    setEntries((cur) => cur.map((e) => (e.id === id ? { ...e, stage } : e)));
    void patch(id, { stage });
  }

  // Kanban drop handler that understands custom stages (manage_stages / Demo).
  // A custom column sets the display-only overlay (no enum change, no side-effects);
  // a canonical column moves the enum stage and clears the overlay. For real clients
  // (no manageStages) every key is canonical, so this behaves exactly like changeStage.
  function changeDisplayStage(id: string, key: string) {
    const isCustom = (manageStages ?? []).some(
      (d) => d.kind === "custom" && d.key === key,
    );
    if (isCustom) {
      setEntries((cur) =>
        cur.map((e) => (e.id === id ? { ...e, custom_stage_key: key } : e)),
      );
      void patch(id, { custom_stage_key: key });
    } else {
      setEntries((cur) =>
        cur.map((e) =>
          e.id === id ? { ...e, stage: key as PipelineStage, custom_stage_key: null } : e,
        ),
      );
      void patch(id, { stage: key as PipelineStage });
    }
  }

  function applyEntryEdit(id: string, patchEdits: Partial<PipelineEntry>) {
    setEntries((cur) => cur.map((e) => (e.id === id ? { ...e, ...patchEdits } : e)));
  }

  function toggleSelect(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    // Select-all targets the rows actually on screen (this page).
    // Bulk delete then chunks the union, so flipping through pages
    // and adding more is non-destructive.
    if (pageItems.every((e) => selected.has(e.id))) {
      setSelected((cur) => {
        const next = new Set(cur);
        for (const e of pageItems) next.delete(e.id);
        return next;
      });
    } else {
      setSelected((cur) => {
        const next = new Set(cur);
        for (const e of pageItems) next.add(e.id);
        return next;
      });
    }
  }

  // CHUNK is tuned for the PostgREST URL cap, not the zod limit.
  // 1000 UUIDs in a `.in("id", …)` URL exceeds Node's 16 KB header
  // cap on the server's PostgREST call; ~300 keeps every request
  // under ~11 KB with headroom. Sequential is fine — a 5k selection
  // is 17 round trips and we want a deterministic toast.
  const BULK_CHUNK = 300;

  async function bulkDelete() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} candidate${selected.size === 1 ? "" : "s"}? This cannot be undone.`)) return;
    setBulkBusy(true);
    const ids = Array.from(selected);
    setEntries((cur) => cur.filter((e) => !selected.has(e.id)));
    setSelected(new Set());
    for (let i = 0; i < ids.length; i += BULK_CHUNK) {
      const slice = ids.slice(i, i + BULK_CHUNK);
      const res = await fetch(`/api/portal/${token}/pipeline`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", ids: slice }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error ?? "Bulk delete failed");
        setBulkBusy(false);
        router.refresh();
        return;
      }
    }
    setBulkBusy(false);
    toast.success(`${ids.length.toLocaleString()} candidate${ids.length === 1 ? "" : "s"} removed`);
  }

  async function bulkStage(stage: PipelineStage) {
    if (selected.size === 0) return;
    setBulkBusy(true);
    const ids = Array.from(selected);
    setEntries((cur) => cur.map((e) => (selected.has(e.id) ? { ...e, stage } : e)));
    setSelected(new Set());
    for (let i = 0; i < ids.length; i += BULK_CHUNK) {
      const slice = ids.slice(i, i + BULK_CHUNK);
      const res = await fetch(`/api/portal/${token}/pipeline`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stage", ids: slice, stage }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error ?? "Bulk stage update failed");
        setBulkBusy(false);
        router.refresh();
        return;
      }
    }
    setBulkBusy(false);
    toast.success(`Moved ${ids.length.toLocaleString()} to ${stageLabels[stage]}`);
  }

  // Per-row assignment mutation: optimistic local update + single
  // PATCH. Same shape the stage picker uses. Pass null to unassign.
  async function assignOne(entry: PipelineEntry, memberId: string | null) {
    const member = memberId ? teamMembers.find((m) => m.id === memberId) ?? null : null;
    setEntries((cur) =>
      cur.map((e) =>
        e.id === entry.id
          ? {
              ...e,
              assigned_team_member_id: memberId,
              assigned_team_member: member ? { id: member.id, name: member.name } : null,
            }
          : e,
      ),
    );
    const res = await fetch(`/api/portal/${token}/pipeline/${entry.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assigned_team_member_id: memberId }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? "Assignment failed");
      router.refresh();
    }
  }

  // Bulk assignment — same chunked pattern as bulkStage.
  async function bulkAssign(memberId: string | null) {
    if (selected.size === 0) return;
    setBulkBusy(true);
    const ids = Array.from(selected);
    const member = memberId ? teamMembers.find((m) => m.id === memberId) ?? null : null;
    setEntries((cur) =>
      cur.map((e) =>
        selected.has(e.id)
          ? {
              ...e,
              assigned_team_member_id: memberId,
              assigned_team_member: member ? { id: member.id, name: member.name } : null,
            }
          : e,
      ),
    );
    setSelected(new Set());
    for (let i = 0; i < ids.length; i += BULK_CHUNK) {
      const slice = ids.slice(i, i + BULK_CHUNK);
      const res = await fetch(`/api/portal/${token}/pipeline`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "assign",
          ids: slice,
          assigned_team_member_id: memberId,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error ?? "Bulk assignment failed");
        setBulkBusy(false);
        router.refresh();
        return;
      }
    }
    setBulkBusy(false);
    toast.success(
      memberId
        ? `Assigned ${ids.length.toLocaleString()} to ${member?.name ?? "team member"}`
        : `Unassigned ${ids.length.toLocaleString()}`,
    );
  }

  function bulkExport() {
    const rows = selected.size > 0
      ? entries.filter((e) => selected.has(e.id))
      : filtered;
    if (rows.length === 0) return;
    // Collect the union of custom-field keys across the exported rows so every
    // one gets its own column. Uses the SAME filter as the card / edit dialog
    // (editableCustomFields drops dedicated + machine-noise keys), and matches
    // case-insensitively — a field seen as "Sales Volume" on one row and
    // "sales volume" on another is one column. First-seen casing wins the
    // header label; each row's value is looked up case-insensitively.
    const customKeys: string[] = [];
    const seenKeys = new Set<string>();
    const customByRow = new Map<string, Record<string, string>>();
    for (const r of rows) {
      const map: Record<string, string> = {};
      for (const [k, v] of editableCustomFields(r)) {
        const lk = k.toLowerCase();
        map[lk] = v;
        if (!seenKeys.has(lk)) {
          seenKeys.add(lk);
          customKeys.push(k);
        }
      }
      customByRow.set(r.id, map);
    }
    const cols = [
      "Name",
      "Email",
      "Phone",
      "Company",
      "Agent profile",
      "Location",
      "Stage",
      "Assigned",
      "Introduced",
      ...customKeys.map(prettyFieldLabel),
    ];
    const lines = [cols.join(",")];
    for (const r of rows) {
      const cm = customByRow.get(r.id) ?? {};
      const row = [
        r.lead_name ?? "",
        r.lead_email ?? "",
        r.lead_phone ?? "",
        r.current_brokerage ?? "",
        r.agent_profile_url ?? "",
        r.lead_location ?? "",
        stageLabels[r.stage],
        r.assigned_team_member?.name ?? "",
        r.introduced_at ? new Date(r.introduced_at).toISOString().slice(0, 10) : "",
        ...customKeys.map((k) => cm[k.toLowerCase()] ?? ""),
      ];
      lines.push(row.map(csvCell).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pipeline-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Shared clipboard write — every copy path routes through this so
  // toast wording + error handling stay consistent. Never throws.
  async function copyToClipboard(text: string, label: string) {
    if (!text) {
      toast.error("Nothing to copy");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success(label);
    } catch {
      toast.error("Could not access clipboard");
    }
  }

  // Per-row buttons — one per field.
  function copyLeadName(entry: PipelineEntry) {
    const name = getLeadCopyName(entry);
    void copyToClipboard(name, name ? `Copied: ${name}` : "");
  }
  function copyLeadPhone(entry: PipelineEntry) {
    const phone = getLeadCopyPhone(entry);
    void copyToClipboard(phone, phone ? `Copied: ${phone}` : "");
  }

  // Bulk copy — one function per field. When nothing is selected, both
  // fall through to the visible filter set (mirrors bulkExport so the
  // button always has a sensible payload).
  async function bulkCopyNames() {
    const rows = selected.size > 0
      ? entries.filter((e) => selected.has(e.id))
      : filtered;
    const lines = rows.map(getLeadCopyName).filter((s) => s.length > 0);
    await copyToClipboard(
      lines.join("\n"),
      lines.length === 1 ? `Copied: ${lines[0]}` : `Copied ${lines.length} names`,
    );
  }
  async function bulkCopyPhones() {
    const rows = selected.size > 0
      ? entries.filter((e) => selected.has(e.id))
      : filtered;
    const lines = rows.map(getLeadCopyPhone).filter((s) => s.length > 0);
    await copyToClipboard(
      lines.join("\n"),
      lines.length === 1 ? `Copied: ${lines[0]}` : `Copied ${lines.length} phone numbers`,
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 pb-12 pt-6 sm:px-6">
      {manageStagesEnabled && manageStages ? (
        <StageManager token={token} stages={manageStages} />
      ) : (
        <StageLabelEditor token={token} savedOverrides={stageLabelOverrides} />
      )}
      {entries.length === 0 ? (
        <div className="space-y-3">
          <PortalEmpty
            title="No introductions yet"
            hint="New candidates appear here automatically as introductions land in the inbox. You can also add one manually."
          />
          <div className="flex justify-center">
            <Button onClick={() => setEditTarget({ mode: "create" })}>
              <Plus className="mr-1.5 size-4" /> Add a candidate
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* Filter row */}
          <div className="mb-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[#9aa0ab]" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search candidates…"
                  className="h-9 w-full rounded-lg border border-[#ebecf0] bg-white pl-8 pr-3 text-[13px] placeholder:text-[#9aa0ab] focus:border-[#bcd5f1] focus:outline-none focus:ring-2 focus:ring-[#eaf2fd] sm:w-64"
                />
              </div>
              <label className="inline-flex h-9 items-center gap-2 rounded-md border border-[#ebecf0] bg-white px-3 text-[13px] text-[#5b6472]">
                <input
                  type="checkbox"
                  checked={replaceOnly}
                  onChange={(e) => setReplaceOnly(e.target.checked)}
                  className="size-3.5 accent-[#1565C0]"
                />
                Replacements only
              </label>
              <Button
                size="sm"
                onClick={() => setEditTarget({ mode: "create" })}
                className="h-9"
              >
                <Plus className="mr-1 size-4" /> Add candidate
              </Button>
              {csvUploadEnabled ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setCsvOpen(true)}
                  className="h-9"
                >
                  <Upload className="mr-1 size-4" /> Upload CSV
                </Button>
              ) : null}
              {kanbanViewEnabled ? (
                <div className="inline-flex items-center gap-2">
                  <span className="text-[12px] text-[#5b6472]">View as:</span>
                  <div className="inline-flex h-9 overflow-hidden rounded-md border border-[#ebecf0] bg-white">
                    <button
                      type="button"
                      onClick={() => changeView("list")}
                      className={cn(
                        "px-3 text-[12px] font-medium transition-colors",
                        viewMode === "list"
                          ? "bg-[#eaf2fd] text-[#1565C0]"
                          : "text-[#5b6472] hover:bg-[#f6f7f9]",
                      )}
                    >
                      List
                    </button>
                    {/* Internal state key stays "kanban" so existing
                        localStorage entries written before the rename
                        still resolve to this view — only the label
                        flipped to "Board" per Stephanie's note. */}
                    <button
                      type="button"
                      onClick={() => changeView("kanban")}
                      className={cn(
                        "border-l border-[#ebecf0] px-3 text-[12px] font-medium transition-colors",
                        viewMode === "kanban"
                          ? "bg-[#eaf2fd] text-[#1565C0]"
                          : "text-[#5b6472] hover:bg-[#f6f7f9]",
                      )}
                    >
                      Board
                    </button>
                  </div>
                </div>
              ) : null}
              <span className="ml-auto text-[12px] text-[#9aa0ab]">
                {filtered.length.toLocaleString()} of {entries.length.toLocaleString()} candidates
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {filterStages.map((st) => {
                const active = stageFilter.has(st.key);
                const style = st.canonical
                  ? STAGE_STYLE[st.key as PipelineStage]
                  : null;
                return (
                  <button
                    key={st.key}
                    type="button"
                    onClick={() => toggleStageFilter(st.key)}
                    style={active && st.hex ? { backgroundColor: st.hex } : undefined}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-all",
                      active
                        ? st.hex
                          ? "border-transparent text-white"
                          : `${style?.bg ?? "bg-[#8b95a3]"} ${style?.text ?? "text-white"} border-transparent`
                        : "border-[#ebecf0] bg-white text-[#5b6472] hover:bg-[#f6f7f9]",
                    )}
                  >
                    {st.label}
                    <span className={cn("tabular-nums", active ? "" : "text-[#9aa0ab]")}>
                      {stageCounts[st.key] ?? 0}
                    </span>
                  </button>
                );
              })}
              {stageFilter.size > 0 ? (
                <button
                  type="button"
                  onClick={() => setStageFilter(new Set())}
                  className="text-[11.5px] font-medium text-[#1565C0] hover:underline"
                >
                  Clear filter
                </button>
              ) : null}
            </div>
          </div>

          {/* Bulk-action bar — always rendered so the affordance is
              discoverable. When nothing is selected the buttons are
              disabled and the leading label nudges the user to tick a
              row. When at least one row is selected the bar lights up
              and the label switches to a live count. */}
          <div
            className={cn(
              "mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-[12.5px] transition-colors",
              selected.size > 0
                ? "border-[#d4e4f8] bg-[#eaf2fd]"
                : "border-[#ebecf0] bg-white",
            )}
          >
            <span
              className={cn(
                "font-medium",
                selected.size > 0 ? "text-[#1565C0]" : "text-[#5b6472]",
              )}
            >
              {selected.size > 0
                ? `${selected.size} selected`
                : "Bulk actions — tick rows below to enable"}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={bulkBusy || selected.size === 0}
                    >
                      Move to… <ChevronDown className="ml-1 size-3.5" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" className="w-48">
                  {visibleStages.map((s) => (
                    <DropdownMenuItem key={s} onClick={() => bulkStage(s)}>
                      <span className={cn("mr-2 inline-block size-2.5 rounded-full", STAGE_STYLE[s].bg)} />
                      {stageLabels[s]}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              {/* Bulk-assign: shows the active team-member roster.
                  "Unassigned" at the top clears the field. Hidden
                  entirely when the brokerage has no team members yet
                  (avoids dangling an empty dropdown). */}
              {teamMembers.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={bulkBusy || selected.size === 0}
                      >
                        Assign to… <ChevronDown className="ml-1 size-3.5" />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem onClick={() => bulkAssign(null)}>
                      <span className="text-[#9aa0ab]">Unassigned</span>
                    </DropdownMenuItem>
                    {teamMembers
                      .filter((m) => m.active)
                      .map((m) => (
                        <DropdownMenuItem
                          key={m.id}
                          onClick={() => bulkAssign(m.id)}
                        >
                          {m.name}
                        </DropdownMenuItem>
                      ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                onClick={bulkCopyNames}
                disabled={bulkBusy || selected.size === 0}
                title="Copy selected leads' names (one per line)"
              >
                <Copy className="mr-1 size-3.5" /> Copy names
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={bulkCopyPhones}
                disabled={bulkBusy || selected.size === 0}
                title="Copy selected leads' phone numbers (one per line)"
              >
                <Copy className="mr-1 size-3.5" /> Copy phones
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={bulkExport}
                disabled={bulkBusy || selected.size === 0}
              >
                <Download className="mr-1 size-3.5" /> Export CSV
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={bulkDelete}
                disabled={bulkBusy || selected.size === 0}
                className={cn(selected.size > 0 ? "text-[#e23a3a]" : "")}
              >
                <Trash2 className="mr-1 size-3.5" /> Delete
              </Button>
              {selected.size > 0 ? (
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              ) : null}
            </div>
          </div>

          {/* Cross-page select-all CTA. Acts on the filtered set
              (which already reflects search + stage filters), so
              "Select all 336 leads" excludes anyone the user has
              filtered out. */}
          <SelectAllAcrossPagesBanner
            visiblePageFullySelected={
              pageItems.length > 0 && pageItems.every((e) => selected.has(e.id))
            }
            selectedCount={selected.size}
            totalCount={filtered.length}
            noun="leads"
            onSelectAll={() => setSelected(new Set(filtered.map((e) => e.id)))}
            onClear={() => setSelected(new Set())}
          />

          {kanbanViewEnabled && viewMode === "kanban" ? (
            <div
              className={cn(
                "transition-opacity duration-500",
                mounted ? "opacity-100" : "opacity-0",
              )}
            >
              {filtered.length === 0 ? (
                <div className="rounded-2xl border border-[#ebecf0] bg-white p-12 text-center text-sm text-[#9aa0ab]">
                  No candidates match the current filters.
                </div>
              ) : (
                <PipelineKanban
                  entries={filtered}
                  visibleStages={visibleStages}
                  stageLabels={stageLabels}
                  stageDefs={manageStagesEnabled ? manageStages : undefined}
                  showSource={sourceSplitEnabled}
                  enhanced={boardEnhanced}
                  onCardClick={(e) => setDetailTarget(e)}
                  onStageChange={changeDisplayStage}
                />
              )}
            </div>
          ) : null}

          {/* Table (md+) — scrolls horizontally if container shrinks. */}
          <div
            className={cn(
              "hidden overflow-hidden rounded-2xl border border-[#ebecf0] bg-white shadow-sm transition-opacity duration-500",
              kanbanViewEnabled && viewMode === "kanban" ? "" : "md:block",
              mounted ? "opacity-100" : "opacity-0",
            )}
          >
            <div className="grid grid-cols-[36px_1.4fr_1.1fr_140px_130px_200px_60px] items-center gap-3 border-b border-[#ebecf0] bg-[#fafbfc] px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-wide text-[#9aa0ab]">
              <div>
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={pageItems.length > 0 && pageItems.every((e) => selected.has(e.id))}
                  onChange={toggleSelectAll}
                  className="size-3.5 accent-[#1565C0]"
                />
              </div>
              <div>Candidate</div>
              <div>Company</div>
              <div>Phone</div>
              <div>Introduced</div>
              <div>Stage</div>
              <div className="text-right">Notes</div>
            </div>
            {filtered.length === 0 ? (
              <div className="p-12 text-center text-sm text-[#9aa0ab]">
                No candidates match the current filters.
              </div>
            ) : (
              <div className="divide-y divide-[#f0f1f4]">
                {pageItems.map((e) => {
                  const expanded = expandedId === e.id;
                  return (
                    <div key={e.id}>
                      <PipelineRow
                        entry={e}
                        expanded={expanded}
                        selected={selected.has(e.id)}
                        onToggleSelect={() => toggleSelect(e.id)}
                        onStage={(s) => changeDisplayStage(e.id, s)}
                        onAssign={(memberId) => assignOne(e, memberId)}
                        teamMembers={teamMembers}
                        onOpenNotes={() => setOpenNotes(e)}
                        onOpenConversation={() => setOpenConversation(e)}
                        onEdit={() => setEditTarget({ mode: "edit", entry: e })}
                        onToggleExpand={() =>
                          setExpandedId((cur) => (cur === e.id ? null : e.id))
                        }
                        onCopyName={() => copyLeadName(e)}
                        onCopyPhone={() => copyLeadPhone(e)}
                        token={token}
                        fubConnected={fubConnected}
                        sourceSplitEnabled={sourceSplitEnabled}
                        onLocalUpdate={(p) => applyEntryEdit(e.id, p)}
                      />
                      {expanded ? (
                        <div className="border-t border-[#ebecf0] bg-[#fafbfc]">
                          <PipelineDetailInline
                            entry={e}
                            token={token}
                            onLocalUpdate={(p) => applyEntryEdit(e.id, p)}
                            showSource={sourceSplitEnabled}
                          />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Card list (mobile). Same actions, vertical layout.
              Hidden entirely on mobile when Kanban view is active —
              the Kanban renderer is responsive and stacks horizontally
              for a swipe gesture, so we don't want both rendering. */}
          <div
            className={cn(
              "space-y-3",
              kanbanViewEnabled && viewMode === "kanban" ? "hidden" : "md:hidden",
            )}
          >
            {filtered.length === 0 ? (
              <div className="rounded-2xl border border-[#ebecf0] bg-white p-8 text-center text-sm text-[#9aa0ab]">
                No candidates match the current filters.
              </div>
            ) : (
              pageItems.map((e) => (
                <PipelineMobileCard
                  key={e.id}
                  entry={e}
                  expanded={expandedId === e.id}
                  selected={selected.has(e.id)}
                  onToggleSelect={() => toggleSelect(e.id)}
                  onStage={(s) => changeDisplayStage(e.id, s)}
                  onAssign={(memberId) => assignOne(e, memberId)}
                  teamMembers={teamMembers}
                  onOpenNotes={() => setOpenNotes(e)}
                  onOpenConversation={() => setOpenConversation(e)}
                  onEdit={() => setEditTarget({ mode: "edit", entry: e })}
                  onToggleExpand={() =>
                    setExpandedId((cur) => (cur === e.id ? null : e.id))
                  }
                  onCopyName={() => copyLeadName(e)}
                  onCopyPhone={() => copyLeadPhone(e)}
                  token={token}
                  onLocalUpdate={(p) => applyEntryEdit(e.id, p)}
                  fubConnected={fubConnected}
                  sourceSplitEnabled={sourceSplitEnabled}
                />
              ))
            )}
          </div>

          <PaginationFooter
            page={page}
            pageSize={PORTAL_PAGE_SIZE}
            total={filtered.length}
            onPageChange={setPage}
            label="candidates"
          />
        </>
      )}

      {openNotes ? (
        <NotesSheet
          token={token}
          entry={openNotes}
          onClose={() => setOpenNotes(null)}
          onApply={(notes_log) => applyEntryEdit(openNotes.id, { notes_log })}
        />
      ) : null}

      {openConversation ? (
        <ConversationSheet
          token={token}
          entry={openConversation}
          onClose={() => setOpenConversation(null)}
        />
      ) : null}

      {detailTarget ? (
        <PipelineDetailSheet
          entry={detailTarget}
          token={token}
          onClose={() => setDetailTarget(null)}
          onEdit={() => {
            const entry = detailTarget;
            setDetailTarget(null);
            setEditTarget({ mode: "edit", entry });
          }}
          onLocalUpdate={(p) => applyEntryEdit(detailTarget.id, p)}
          showSource={sourceSplitEnabled}
        />
      ) : null}

      {editTarget ? (
        <EditLeadDialog
          token={token}
          target={editTarget}
          onClose={() => setEditTarget(null)}
          onApply={(idOrNew, patchEdits, full) => {
            if (editTarget.mode === "create" && full) {
              setEntries((cur) => [full, ...cur]);
            } else {
              applyEntryEdit(idOrNew, patchEdits);
            }
          }}
        />
      ) : null}

      {csvOpen ? (
        <CsvUploadDialog
          token={token}
          onClose={() => setCsvOpen(false)}
          onUploaded={() => {
            // Refresh from the server so the inserted rows show up
            // with their server-resolved source value + enrichment.
            router.refresh();
            setCsvOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

// Matches the Agents / DNC / Team CSV importer pattern: dashed
// drop-zone, fuzzy header matching via lib/portals/csv.ts, preview
// table after parse, JSON post of `{ rows }` so the server doesn't
// re-parse what the client already parsed. Single source of truth
// for the CSV parser sits in lib/portals/csv.ts.
function CsvUploadDialog({
  token,
  onClose,
  onUploaded,
}: {
  token: string;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<PipelineCsvRow[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    | { inserted: number; skipped: Array<{ row: number; reason: string }> }
    | null
  >(null);

  function handleFile(file: File | undefined | null) {
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const parsed = parseCsv(text);
      const mapped = parsed
        .map(csvRowToPipeline)
        .filter((r): r is PipelineCsvRow => Boolean(r));
      setRows(mapped);
    };
    reader.readAsText(file);
  }

  async function submit() {
    if (!rows || rows.length === 0) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/portal/${token}/pipeline/csv`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(j.error ?? "Import failed");
        setSubmitting(false);
        return;
      }
      const r = j as {
        inserted: number;
        skipped: Array<{ row: number; reason: string }>;
      };
      setResult(r);
      if (r.inserted > 0) {
        toast.success(
          `Imported ${r.inserted} candidate${r.inserted === 1 ? "" : "s"}${
            r.skipped.length > 0 ? `, skipped ${r.skipped.length}` : ""
          }`,
        );
      } else if (r.skipped.length > 0) {
        toast.error(`Skipped ${r.skipped.length} row${r.skipped.length === 1 ? "" : "s"}`);
      }
      // Re-fetch the pipeline once the user closes via the "Close"
      // button — keeps the dialog open so they can read the
      // skipped-row list without it slamming shut.
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import candidates from CSV</DialogTitle>
        </DialogHeader>
        {!rows ? (
          <div>
            <div
              onClick={() => fileRef.current?.click()}
              className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[#ebecf0] bg-[#fafbfc] px-6 py-12 text-center transition-colors hover:border-[#bcd5f1] hover:bg-[#f4f8fd]"
            >
              <FileText className="size-7 text-[#aab0ba]" />
              <div className="text-sm font-medium">Click to choose a CSV file</div>
              <div className="text-[12px] text-[#9aa0ab]">
                Columns we recognise: <code>name</code>, <code>email</code>,{" "}
                <code>phone</code>, <code>brokerage</code>
                <br />
                Headers don&apos;t need to match exactly &mdash; e.g.{" "}
                <code>Full Name</code>, <code>Email Address</code>,{" "}
                <code>Phone Number</code> all work.
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
          </div>
        ) : (
          <div>
            <div className="mb-2 flex items-center justify-between text-[12px]">
              <span className="font-medium">
                {fileName} &mdash;{" "}
                <span className="text-[#5b6472]">{rows.length} ready to import</span>
              </span>
              <button
                type="button"
                onClick={() => {
                  setRows(null);
                  setFileName(null);
                  setResult(null);
                }}
                className="text-[#1565C0] hover:underline"
              >
                Choose a different file
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-[#ebecf0]">
              <div className="grid grid-cols-[1.4fr_1.4fr_140px] border-b border-[#ebecf0] bg-[#fafbfc] px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[#9aa0ab]">
                <div>Name</div>
                <div>Email</div>
                <div>Phone</div>
              </div>
              {rows.slice(0, 50).map((r, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[1.4fr_1.4fr_140px] gap-2 border-b border-[#f0f1f4] px-3 py-1.5 text-[12.5px] last:border-0"
                >
                  <div className="truncate font-medium">{r.lead_name}</div>
                  <div className="truncate text-[#5b6472]">{r.lead_email ?? "—"}</div>
                  <div className="truncate text-[#5b6472]">{r.lead_phone ?? "—"}</div>
                </div>
              ))}
              {rows.length > 50 ? (
                <div className="px-3 py-1.5 text-center text-[11.5px] text-[#9aa0ab]">
                  &hellip;and {rows.length - 50} more
                </div>
              ) : null}
            </div>
            {result ? (
              <div className="mt-3 rounded-md bg-[#e9f7ef] px-3 py-2 text-[12px] text-[#0c8a4e]">
                Imported {result.inserted.toLocaleString()} candidate{result.inserted === 1 ? "" : "s"}.
                {result.skipped.length > 0 ? (
                  <ul className="mt-1 max-h-32 list-disc overflow-y-auto pl-4 text-[#9a3a3a]">
                    {result.skipped.map((s, i) => (
                      <li key={i}>Row {s.row}: {s.reason}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <p className="mt-3 text-[11.5px] leading-relaxed text-[#9aa0ab]">
                Each row creates a new candidate. The stage column defaults
                to <code>introduction</code> when blank.
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              if (result) onUploaded();
              else onClose();
            }}
          >
            {result ? "Close" : "Cancel"}
          </Button>
          {rows && !result ? (
            <Button onClick={submit} disabled={submitting || rows.length === 0}>
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                `Import ${rows.length} candidate${rows.length === 1 ? "" : "s"}`
              )}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PipelineRow({
  entry,
  expanded,
  selected,
  onToggleSelect,
  onStage,
  onAssign,
  teamMembers,
  onOpenNotes,
  onOpenConversation,
  onEdit,
  onToggleExpand,
  onCopyName,
  onCopyPhone,
  token,
  fubConnected,
  sourceSplitEnabled = false,
  onLocalUpdate,
}: {
  entry: PipelineEntry;
  expanded: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onStage: (s: string) => void;
  onAssign: (memberId: string | null) => void;
  teamMembers: TeamMember[];
  onOpenNotes: () => void;
  onOpenConversation: () => void;
  onEdit: () => void;
  onToggleExpand: () => void;
  onCopyName: () => void;
  onCopyPhone: () => void;
  token: string;
  fubConnected: boolean;
  sourceSplitEnabled?: boolean;
  onLocalUpdate: (patch: Partial<PipelineEntry>) => void;
}) {
  // Snapshot column `entry.lead_phone` is the source of truth (the
  // Edit dialog writes to it); custom_fields is a fallback for the
  // case where the intro trigger missed phone because EB used a key
  // name like "Phone Number" the trigger doesn't recognise. `||` so
  // a literal empty-string snapshot also falls through.
  const cf =
    ((entry.lead_detail as { custom_fields?: Record<string, unknown> } | null)
      ?.custom_fields ?? {}) as Record<string, unknown>;
  const phone = entry.lead_phone || pickFirstString(cf, PHONE_KEYS) || null;
  return (
    <div
      className={cn(
        "grid grid-cols-[36px_1.4fr_1.1fr_140px_130px_200px_60px] items-start gap-3 px-4 py-3 transition-colors",
        expanded ? "bg-[#fafbfc]" : "hover:bg-[#fafbfc]",
        selected ? "bg-[#eaf2fd] hover:bg-[#eaf2fd]" : "",
      )}
    >
      <div className="pt-1">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="size-3.5 accent-[#1565C0]"
          aria-label="Select"
        />
      </div>
      {/* Candidate cell — a div-button rather than a real <button> so
          the agent-profile <a> below can sit inside it without
          producing invalid nested-interactive markup. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggleExpand}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggleExpand();
          }
        }}
        className="flex min-w-0 cursor-pointer items-start gap-3 text-left"
        title={expanded ? "Hide lead details" : "Show lead details"}
        aria-expanded={expanded}
      >
        <Avatar name={entry.lead_name ?? entry.lead_email ?? "?"} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                "truncate text-[13.5px] font-medium",
                expanded ? "text-[#1565C0]" : "hover:text-[#1565C0]",
              )}
            >
              {entry.lead_name || entry.lead_email || "Unknown"}
            </span>
            {/* Copy just the lead name. stopPropagation so it doesn't
                also trigger the row-expand click. */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCopyName();
              }}
              title="Copy name"
              aria-label="Copy name"
              className="inline-flex size-5 shrink-0 items-center justify-center rounded text-[#9aa0ab] hover:bg-[#eef0f3] hover:text-[#5b6472]"
            >
              <Copy className="size-3.5" />
            </button>
            {entry.stage === "no_show" || entry.needs_replacement ? (
              // Discreet replacement marker: muted Repeat icon with a
              // hover tooltip so the brokerage understands this intro
              // will be replaced without the row screaming red at them.
              <span
                title="This introduction will be replaced."
                aria-label="This introduction will be replaced."
                className="inline-flex size-4 shrink-0 items-center justify-center text-[#9aa0ab]"
              >
                <Repeat className="size-3.5" />
              </span>
            ) : null}
            <ChevronDown
              className={cn(
                "size-3 shrink-0 text-[#9aa0ab] transition-transform",
                expanded ? "rotate-180 text-[#1565C0]" : "",
              )}
            />
          </div>
          {entry.lead_email ? (
            <div className="truncate text-[11.5px] text-[#9aa0ab]">{entry.lead_email}</div>
          ) : null}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            {entry.agent_profile_url ? (
              <a
                href={normalizeUrl(entry.agent_profile_url)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex max-w-full items-center gap-1 truncate text-[11.5px] text-[#1565C0] hover:underline"
                title={trimUrl(entry.agent_profile_url)}
              >
                <Globe className="size-3 shrink-0" />
                <span className="truncate">Agent profile</span>
              </a>
            ) : null}
            {entry.thread_id ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenConversation();
                }}
                className="inline-flex items-center gap-1 text-[11.5px] text-[#1565C0] hover:underline"
                title="View the email conversation with this candidate"
              >
                <Mail className="size-3 shrink-0" />
                <span>Conversation</span>
              </button>
            ) : null}
            <PushToFubChip
              entry={entry}
              token={token}
              fubConnected={fubConnected}
              onLocalUpdate={onLocalUpdate}
            />
            {sourceSplitEnabled ? <SourceBadge value={entry.source} /> : null}
          </div>
        </div>
      </div>
      <div className="min-w-0 text-[13px] text-[#5b6472]">
        <div className="truncate">{entry.current_brokerage ?? "—"}</div>
      </div>
      <div className="text-[12.5px] tabular-nums text-[#5b6472]">
        {phone ? (
          <div className="flex flex-col items-start gap-0.5">
            <span>{formatPhoneDisplay(phone)}</span>
            <div className="inline-flex items-center gap-1">
              <a
                href={`tel:${phone.replace(/[^+\d]/g, "")}`}
                className="inline-flex h-5 items-center gap-1 rounded border border-[#d4e4f8] bg-white px-1.5 text-[10.5px] font-medium text-[#1565C0] hover:bg-[#eaf2fd]"
                aria-label={`Call ${phone}`}
                title="Call"
              >
                <PhoneIcon className="size-3" />
                Call
              </a>
              <a
                href={`sms:${phone.replace(/[^+\d]/g, "")}`}
                className="inline-flex h-5 items-center gap-1 rounded border border-[#d4e4f8] bg-white px-1.5 text-[10.5px] font-medium text-[#1565C0] hover:bg-[#eaf2fd]"
                aria-label={`Text ${phone}`}
                title="Text"
              >
                <MessageSquare className="size-3" />
                Text
              </a>
              {/* Copy just the phone number. Matches the subtle
                  gray icon-only style used by the name-copy button
                  so the two copy actions read as one system. */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCopyPhone();
                }}
                aria-label="Copy phone"
                title="Copy phone"
                className="inline-flex size-5 shrink-0 items-center justify-center rounded text-[#9aa0ab] hover:bg-[#eef0f3] hover:text-[#5b6472]"
              >
                <Copy className="size-3.5" />
              </button>
            </div>
          </div>
        ) : (
          "—"
        )}
      </div>
      <div className="text-[12.5px] text-[#5b6472]">{fmtDate(entry.introduced_at)}</div>
      <div className="flex flex-col items-start gap-1.5">
        <StageSelector value={entry.custom_stage_key ?? entry.stage} onChange={onStage} />
        <AssignedSelector
          value={entry.assigned_team_member}
          members={teamMembers}
          onChange={onAssign}
        />
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-[#d4e4f8] bg-white px-2 text-[11.5px] font-medium text-[#1565C0] hover:bg-[#eaf2fd]"
          title="Edit name, company, phone, agent profile, intro date"
        >
          <Pencil className="size-3" />
          Edit
        </button>
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onOpenNotes}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors",
            entry.notes_log.length > 0
              ? "border-[#d4e4f8] bg-[#eaf2fd] text-[#1565C0] hover:bg-[#dbe9fa]"
              : "border-[#ebecf0] bg-white text-[#9aa0ab] hover:bg-[#f6f7f9]",
          )}
          title={entry.notes_log.length > 0 ? `${entry.notes_log.length} notes` : "Add notes"}
        >
          <StickyNote className="size-3.5" />
          {entry.notes_log.length > 0 ? entry.notes_log.length : "Add"}
        </button>
      </div>
    </div>
  );
}

function PipelineMobileCard({
  entry,
  expanded,
  selected,
  onToggleSelect,
  onStage,
  onAssign,
  teamMembers,
  onOpenNotes,
  onOpenConversation,
  onEdit,
  onToggleExpand,
  onCopyName,
  onCopyPhone,
  token,
  onLocalUpdate,
  fubConnected,
  sourceSplitEnabled = false,
}: {
  entry: PipelineEntry;
  expanded: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onStage: (s: string) => void;
  onAssign: (memberId: string | null) => void;
  teamMembers: TeamMember[];
  onOpenNotes: () => void;
  onOpenConversation: () => void;
  onEdit: () => void;
  onToggleExpand: () => void;
  onCopyName: () => void;
  onCopyPhone: () => void;
  token: string;
  onLocalUpdate: (patch: Partial<PipelineEntry>) => void;
  fubConnected: boolean;
  sourceSplitEnabled?: boolean;
}) {
  // Mobile card: same resolution rules as the desktop row — snapshot
  // wins (Edit dialog's target), cf is the fallback when snapshot is
  // empty.
  const cf =
    ((entry.lead_detail as { custom_fields?: Record<string, unknown> } | null)
      ?.custom_fields ?? {}) as Record<string, unknown>;
  const phone = entry.lead_phone || pickFirstString(cf, PHONE_KEYS) || null;
  return (
    <div
      className={cn(
        "rounded-2xl border bg-white p-3 shadow-sm",
        selected ? "border-[#1565C0] bg-[#eaf2fd]" : "border-[#ebecf0]",
      )}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="mt-1 size-3.5 accent-[#1565C0]"
          aria-label="Select"
        />
        <Avatar name={entry.lead_name ?? entry.lead_email ?? "?"} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[14px] font-medium">
              {entry.lead_name || entry.lead_email || "Unknown"}
            </span>
            {/* Copy just the lead name — same behaviour as desktop row. */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCopyName();
              }}
              title="Copy name"
              aria-label="Copy name"
              className="inline-flex size-5 shrink-0 items-center justify-center rounded text-[#9aa0ab] hover:bg-[#eef0f3] hover:text-[#5b6472]"
            >
              <Copy className="size-3.5" />
            </button>
            {entry.stage === "no_show" || entry.needs_replacement ? (
              <span
                title="This introduction will be replaced."
                aria-label="This introduction will be replaced."
                className="inline-flex size-4 shrink-0 items-center justify-center text-[#9aa0ab]"
              >
                <Repeat className="size-3.5" />
              </span>
            ) : null}
          </div>
          {entry.lead_email ? (
            <div className="truncate text-[12px] text-[#9aa0ab]">{entry.lead_email}</div>
          ) : null}
          {entry.current_brokerage ? (
            <div className="mt-1 text-[12.5px] text-[#5b6472]">{entry.current_brokerage}</div>
          ) : null}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            {entry.agent_profile_url ? (
              <a
                href={normalizeUrl(entry.agent_profile_url)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex max-w-full items-center gap-1 truncate text-[12px] text-[#1565C0] hover:underline"
                title={trimUrl(entry.agent_profile_url)}
              >
                <Globe className="size-3 shrink-0" />
                <span className="truncate">Agent profile</span>
              </a>
            ) : null}
            {entry.thread_id ? (
              <button
                type="button"
                onClick={onOpenConversation}
                className="inline-flex items-center gap-1 text-[12px] text-[#1565C0] hover:underline"
                title="View the email conversation with this candidate"
              >
                <Mail className="size-3 shrink-0" />
                <span>Conversation</span>
              </button>
            ) : null}
            <PushToFubChip
              entry={entry}
              token={token}
              fubConnected={fubConnected}
              onLocalUpdate={onLocalUpdate}
            />
            {sourceSplitEnabled ? <SourceBadge value={entry.source} /> : null}
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StageSelector value={entry.custom_stage_key ?? entry.stage} onChange={onStage} />
        <AssignedSelector
          value={entry.assigned_team_member}
          members={teamMembers}
          onChange={onAssign}
        />
        {phone ? (
          <div className="inline-flex h-8 items-center gap-1 rounded-md border border-[#ebecf0] bg-white pl-2 pr-1 text-[12px] text-[#5b6472]">
            <span className="tabular-nums">{formatPhoneDisplay(phone)}</span>
            <a
              href={`tel:${phone.replace(/[^+\d]/g, "")}`}
              className="inline-flex size-6 items-center justify-center rounded text-[#1565C0] hover:bg-[#eaf2fd]"
              aria-label={`Call ${phone}`}
              title="Call"
            >
              <PhoneIcon className="size-3.5" />
            </a>
            <a
              href={`sms:${phone.replace(/[^+\d]/g, "")}`}
              className="inline-flex size-6 items-center justify-center rounded text-[#1565C0] hover:bg-[#eaf2fd]"
              aria-label={`Text ${phone}`}
              title="Text"
            >
              <MessageSquare className="size-3.5" />
            </a>
            {/* Copy just the phone number. Same subtle gray icon
                treatment as the name-copy button. */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCopyPhone();
              }}
              aria-label="Copy phone"
              title="Copy phone"
              className="inline-flex size-5 shrink-0 items-center justify-center rounded text-[#9aa0ab] hover:bg-[#eef0f3] hover:text-[#5b6472]"
            >
              <Copy className="size-3.5" />
            </button>
          </div>
        ) : null}
        <span className="text-[11.5px] text-[#9aa0ab]">
          Introduced {fmtDate(entry.introduced_at)}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-[#d4e4f8] bg-white px-2 text-[12px] font-medium text-[#1565C0]"
            title="Edit name, company, phone, agent profile, intro date"
          >
            <Pencil className="size-3.5" />
            Edit
          </button>
          <button
            type="button"
            onClick={onOpenNotes}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-[12px]",
              entry.notes_log.length > 0
                ? "border-[#d4e4f8] bg-[#eaf2fd] text-[#1565C0]"
                : "border-[#ebecf0] bg-white text-[#9aa0ab]",
            )}
          >
            <StickyNote className="size-3.5" />
            {entry.notes_log.length > 0 ? entry.notes_log.length : "Notes"}
          </button>
        </div>
      </div>
      <button
        type="button"
        onClick={onToggleExpand}
        className="mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-[#ebecf0] py-1.5 text-[11.5px] text-[#9aa0ab]"
      >
        {expanded ? "Hide details" : "Show details"}
        <ChevronDown className={cn("size-3 transition-transform", expanded ? "rotate-180" : "")} />
      </button>
      {expanded ? (
        <div className="mt-2 rounded-lg bg-[#fafbfc]">
          <PipelineDetailInline
            entry={entry}
            token={token}
            onLocalUpdate={onLocalUpdate}
            showSource={sourceSplitEnabled}
          />
        </div>
      ) : null}
    </div>
  );
}

// Recruiter-ownership picker — mirrors StageSelector's pill+dropdown
// look so the two pills sit cleanly side-by-side. Empty state ("Assign…")
// uses a muted outline; filled state ("Sarah ▾") gets the same blue
// accent the Edit pill uses so all "edit my row" affordances read as
// one family.
function AssignedSelector({
  value,
  members,
  onChange,
}: {
  value: { id: string; name: string } | null;
  members: TeamMember[];
  onChange: (memberId: string | null) => void;
}) {
  const active = members.filter((m) => m.active);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className={cn(
              "inline-flex h-7 max-w-[140px] items-center gap-1 rounded-md border px-2 text-[11.5px] font-medium transition-colors",
              value
                ? "border-[#d4e4f8] bg-[#eaf2fd] text-[#1565C0] hover:bg-[#dbe9fa]"
                : "border-[#ebecf0] bg-white text-[#9aa0ab] hover:bg-[#f6f7f9]",
            )}
            title={value ? `Assigned to ${value.name}` : "Assign a recruiter"}
          >
            <span className="truncate">{value ? value.name : "Assign…"}</span>
            <ChevronDown className="size-3 shrink-0 opacity-70" />
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem
          onClick={() => onChange(null)}
          className="flex items-center justify-between gap-2"
        >
          <span className="text-[#9aa0ab]">Unassigned</span>
          {!value ? <Check className="size-3.5 text-[#1565C0]" /> : null}
        </DropdownMenuItem>
        {active.length === 0 ? (
          <DropdownMenuItem disabled>
            <span className="text-[11.5px] text-[#9aa0ab]">
              No active team members
            </span>
          </DropdownMenuItem>
        ) : (
          active.map((m) => (
            <DropdownMenuItem
              key={m.id}
              onClick={() => onChange(m.id)}
              className="flex items-center justify-between gap-2"
            >
              <span className="truncate text-[13px]">{m.name}</span>
              {value?.id === m.id ? (
                <Check className="size-3.5 text-[#1565C0]" />
              ) : null}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StageSelector({
  value,
  onChange,
}: {
  // Display key: a canonical enum value, or (manage_stages) a custom stage key.
  value: string;
  onChange: (s: string) => void;
}) {
  const stageLabels = useStageLabels();
  // Per-client visible stages. If the current entry is in a stage hidden for this
  // client, we still include it so the operator can move it out — never trap a row.
  const visibleStages = useVisibleStages();
  // Full stage config for manage_stages clients (Demo); null for everyone else,
  // in which case this is exactly the canonical enum path.
  const defs = useStageDefs();

  const defByKey = defs ? new Map(defs.map((d) => [d.key, d])) : null;
  const baseOptions: string[] = defs
    ? defs.filter((d) => !d.hidden).map((d) => d.key)
    : visibleStages;
  const dropdownStages = baseOptions.includes(value)
    ? baseOptions
    : [...baseOptions, value];

  const labelOf = (key: string): string =>
    defByKey?.get(key)?.label ?? stageLabels[key as PipelineStage] ?? key;
  const customHexOf = (key: string): string | null => {
    const d = defByKey?.get(key);
    return d && d.kind === "custom" ? d.color : null;
  };
  const valHex = customHexOf(value);
  const valStyle = STAGE_STYLE[value as PipelineStage];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className={cn(
              "inline-flex items-center justify-between gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition-all hover:brightness-95",
              valHex ? "text-white" : cn(valStyle?.bg, valStyle?.text),
            )}
            style={valHex ? { backgroundColor: valHex } : undefined}
          >
            <span className="truncate">{labelOf(value)}</span>
            <ChevronDown className="size-3 shrink-0 opacity-70" />
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-48">
        {dropdownStages.map((s) => (
          <DropdownMenuItem
            key={s}
            onClick={() => onChange(s)}
            className="flex items-center justify-between gap-2"
          >
            <span className="text-[13px]">{labelOf(s)}</span>
            {s === value ? <Check className="size-3.5 text-[#1565C0]" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Slides in from the right when the user clicks the Notes pill on a
// row. Layout: a sticky lead-summary card on top (avatar, name, the
// quick-contact bits), then the note composer + numbered note cards
// underneath. Replaces the older modal dialog so the row stays
// visually anchored on the left while notes are managed on the right.
function NotesSheet({
  token,
  entry,
  onClose,
  onApply,
}: {
  token: string;
  entry: PipelineEntry;
  onClose: () => void;
  onApply: (notes: PipelineEntry["notes_log"]) => void;
}) {
  const [notes, setNotes] = useState(entry.notes_log);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const stageLabels = useStageLabels();
  const stageDefs = useStageDefs();

  async function addNote() {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    const res = await fetch(`/api/portal/${token}/pipeline/${entry.id}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? "Could not save note");
      return;
    }
    const j = (await res.json()) as { note: PipelineEntry["notes_log"][number] };
    const next = [j.note, ...notes];
    setNotes(next);
    onApply(next);
    setDraft("");
  }

  async function saveEdit(noteId: string) {
    const body = editDraft.trim();
    if (!body) return;
    setBusy(true);
    const res = await fetch(`/api/portal/${token}/pipeline/${entry.id}/notes/${noteId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? "Could not update note");
      return;
    }
    const next = notes.map((n) =>
      n.id === noteId ? { ...n, body, updated_at: new Date().toISOString() } : n,
    );
    setNotes(next);
    onApply(next);
    setEditing(null);
  }

  async function deleteNote(noteId: string) {
    if (!confirm("Delete this note?")) return;
    setBusy(true);
    const res = await fetch(`/api/portal/${token}/pipeline/${entry.id}/notes/${noteId}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? "Could not delete note");
      return;
    }
    const next = notes.filter((n) => n.id !== noteId);
    setNotes(next);
    onApply(next);
  }

  // Detail bottom sheet (Kanban detail view): same resolution rules
  // as the desktop row + mobile card — snapshot wins, cf fallback.
  const cf =
    ((entry.lead_detail as { custom_fields?: Record<string, unknown> } | null)
      ?.custom_fields ?? {}) as Record<string, unknown>;
  const phone = entry.lead_phone || pickFirstString(cf, PHONE_KEYS);
  const isReplacement = entry.stage === "no_show" || entry.needs_replacement;
  // Display stage: custom overlay if set (manage_stages), else the canonical stage.
  // Flag-off entries always resolve to the canonical badge (identical to before).
  const dispKey = entry.custom_stage_key ?? entry.stage;
  const dispDef = stageDefs ? stageDefs.find((d) => d.key === dispKey) : null;
  const dispHex = dispDef && dispDef.kind === "custom" ? dispDef.color : null;
  const dispLabel = dispDef?.label ?? stageLabels[entry.stage];
  const stageStyle = STAGE_STYLE[dispKey as PipelineStage];

  // Detail row icons — uniform 32px gray-bg rounded squares to the
  // left of every fact so the sheet reads as a tidy list.
  const detailRows: Array<{
    // `null` icon → render the same 32px slot but blank, so the
    // KV-list alignment matches the icon'd rows. Used by Location
    // after the June 2026 request to drop the MapPin icon.
    icon: typeof Mail | null;
    label: string;
    body: React.ReactNode;
    visible: boolean;
  }> = [
    {
      icon: Workflow,
      label: "Stage",
      visible: true,
      body: (
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-semibold",
            dispHex ? "text-white" : cn(stageStyle?.bg, stageStyle?.text),
          )}
          style={dispHex ? { backgroundColor: dispHex } : undefined}
        >
          <span className="size-1.5 rounded-full bg-white/80" />
          {dispLabel}
        </span>
      ),
    },
    {
      icon: Mail,
      label: "Email",
      visible: !!entry.lead_email,
      body: entry.lead_email ? (
        <a
          href={`mailto:${entry.lead_email}`}
          className="break-all text-[#1565C0] hover:underline"
        >
          {entry.lead_email}
        </a>
      ) : null,
    },
    {
      icon: PhoneIcon,
      label: "Phone",
      visible: !!phone,
      body: phone ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="tabular-nums text-[#0f1320]">{formatPhoneDisplay(phone)}</span>
          <a
            href={`tel:${phone.replace(/[^+\d]/g, "")}`}
            className="inline-flex h-6 items-center gap-1 rounded border border-[#d4e4f8] bg-white px-1.5 text-[10.5px] font-medium text-[#1565C0] hover:bg-[#eaf2fd]"
            title="Call"
          >
            <PhoneIcon className="size-3" />
            Call
          </a>
          <a
            href={`sms:${phone.replace(/[^+\d]/g, "")}`}
            className="inline-flex h-6 items-center gap-1 rounded border border-[#d4e4f8] bg-white px-1.5 text-[10.5px] font-medium text-[#1565C0] hover:bg-[#eaf2fd]"
            title="Text"
          >
            <MessageSquare className="size-3" />
            Text
          </a>
        </div>
      ) : null,
    },
    {
      icon: Globe,
      label: "Agent profile",
      visible: !!entry.agent_profile_url,
      body: entry.agent_profile_url ? (
        // Truncate on a single line with ellipsis instead of letting
        // long realtor.com URLs wrap mid-token and break the row's
        // grid alignment. Full URL stays available via the tooltip
        // + the anchor's href (right-click → copy still works).
        <a
          href={normalizeUrl(entry.agent_profile_url)}
          target="_blank"
          rel="noopener noreferrer"
          title={trimUrl(entry.agent_profile_url)}
          className="block max-w-full truncate text-[#1565C0] hover:underline"
        >
          {trimUrl(entry.agent_profile_url)}
        </a>
      ) : null,
    },
    {
      // Location: no icon — request from June 2026 client review. The
      // value still renders in the KV list as plain text, with a small
      // bullet stand-in so the row alignment matches the icon'd rows
      // above and below.
      icon: null,
      label: "Location",
      visible: !!entry.lead_location,
      body: entry.lead_location,
    },
    {
      icon: Calendar,
      label: "Introduced",
      visible: !!entry.introduced_at,
      body: fmtDate(entry.introduced_at),
    },
  ];

  return (
    <Sheet open onOpenChange={(v) => !v && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 bg-white p-0 sm:max-w-md"
        showCloseButton={false}
      >
        {/* Identity header — large avatar + name + company subline. The
            built-in close button is hidden so we can place ours where the
            mockup put it (top-right of the header). */}
        <header className="relative shrink-0 px-5 pt-5 pb-4">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 inline-flex size-8 items-center justify-center rounded-md border border-[#ebecf0] bg-white text-[#5b6472] hover:bg-[#f6f7f9]"
          >
            <X className="size-4" />
          </button>
          <div className="flex items-center gap-3">
            <Avatar
              name={entry.lead_name ?? entry.lead_email ?? "?"}
              className="size-12 text-[15px]"
            />
            <div className="min-w-0 flex-1 pr-10">
              <div className="flex flex-wrap items-center gap-1.5">
                <h2 className="truncate text-[17px] font-semibold leading-tight text-[#0f1320]">
                  {entry.lead_name || entry.lead_email || "Unknown"}
                </h2>
                {isReplacement ? (
                  <span
                    title="This introduction will be replaced."
                    aria-label="This introduction will be replaced."
                    className="inline-flex size-5 shrink-0 items-center justify-center text-[#9aa0ab]"
                  >
                    <Repeat className="size-4" />
                  </span>
                ) : null}
              </div>
              {entry.current_brokerage ? (
                <div className="mt-0.5 truncate text-[13px] text-[#5b6472]">
                  {entry.current_brokerage}
                </div>
              ) : null}
            </div>
          </div>
        </header>

        {/* Body: details + notes. One scroller so the floating composer
            at the bottom stays anchored regardless of content length. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          <section className="border-t border-[#ebecf0] pt-4">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[#9aa0ab]">
              Details
            </div>
            <ul className="mt-3 space-y-3">
              {detailRows
                .filter((r) => r.visible)
                .map((r, i, arr) => {
                  const Icon = r.icon;
                  return (
                    <li key={r.label} className="flex items-start gap-3">
                      <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#f6f7f9] text-[#5b6472]">
                        {Icon ? <Icon className="size-3.5" /> : null}
                      </span>
                      <div
                        className={cn(
                          "min-w-0 flex-1 pb-3 text-[13px]",
                          i < arr.length - 1 ? "border-b border-[#f0f1f4]" : "",
                        )}
                      >
                        <div className="text-[10.5px] font-semibold uppercase tracking-wide text-[#aab0ba]">
                          {r.label}
                        </div>
                        <div className="mt-1 text-[#0f1320]">{r.body}</div>
                      </div>
                    </li>
                  );
                })}
            </ul>
          </section>

          <section className="mt-6">
            <div className="flex items-center gap-2">
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[#9aa0ab]">
                Notes
              </div>
              <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[#eaf2fd] px-1.5 text-[11px] font-semibold text-[#1565C0]">
                {notes.length}
              </span>
            </div>
            {notes.length === 0 ? (
              <div className="mt-3 rounded-xl border border-dashed border-[#ebecf0] bg-[#fafbfc] px-4 py-8 text-center text-[12.5px] text-[#9aa0ab]">
                No notes yet. Add the first one below.
              </div>
            ) : (
              <ol className="mt-3 space-y-3">
                {notes.map((n) => (
                  <li
                    key={n.id}
                    className="rounded-xl border border-[#ebecf0] bg-[#fafbfc] p-3"
                  >
                    {editing === n.id ? (
                      <div className="space-y-2">
                        <Textarea
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          rows={3}
                          className="text-[13px]"
                        />
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                            Cancel
                          </Button>
                          <Button size="sm" onClick={() => saveEdit(n.id)} disabled={busy}>
                            Save
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-[#0f1320]">
                          {n.body}
                        </p>
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <div className="text-[11px] text-[#9aa0ab]">
                            {fmtDateTime(n.created_at)}
                            {n.updated_at && n.updated_at !== n.created_at
                              ? ` · edited`
                              : ""}
                          </div>
                          <div className="flex gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                setEditing(n.id);
                                setEditDraft(n.body);
                              }}
                              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] font-medium text-[#1565C0] hover:bg-[#eaf2fd]"
                            >
                              <Pencil className="size-3" />
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => deleteNote(n.id)}
                              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] font-medium text-[#c0392b] hover:bg-[#fef0ee]"
                            >
                              <Trash2 className="size-3" />
                              Delete
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        {/* Sticky composer — always reachable without scrolling, even on
            a long thread of notes. Big Add Note button so the action is
            unmistakable. */}
        <footer className="shrink-0 border-t border-[#ebecf0] bg-white px-5 py-4">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a note about this candidate…"
            rows={2}
            // Cap at ~10 lines and scroll internally. Without this the
            // shared <Textarea> has `field-sizing-content` so a long
            // paste grows the field unboundedly and pushes the Save
            // button below the viewport with no scroll escape.
            className="max-h-40 overflow-y-auto text-[13px]"
          />
          <Button
            onClick={addNote}
            disabled={busy || !draft.trim()}
            className="mt-2 h-11 w-full text-[14px] font-semibold"
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <>
                <Plus className="mr-1 size-4" />
                Add note
              </>
            )}
          </Button>
        </footer>
      </SheetContent>
    </Sheet>
  );
}

function EditLeadDialog({
  token,
  target,
  onClose,
  onApply,
}: {
  token: string;
  target: EditTarget;
  onClose: () => void;
  onApply: (
    idOrNew: string,
    patchEdits: Partial<PipelineEntry>,
    fullNew?: PipelineEntry,
  ) => void;
}) {
  const initial = target.mode === "edit" ? target.entry : null;
  const [name, setName] = useState(initial?.lead_name ?? "");
  const [email, setEmail] = useState(initial?.lead_email ?? "");
  const [phone, setPhone] = useState(initial?.lead_phone ?? "");
  const [company, setCompany] = useState(initial?.current_brokerage ?? "");
  const [website, setWebsite] = useState(initial?.agent_profile_url ?? "");
  const [introducedAt, setIntroducedAt] = useState<string>(
    initial?.introduced_at
      ? toLocalDateInput(initial.introduced_at)
      : toLocalDateInput(new Date().toISOString()),
  );
  // Manual "Replacement" tag. The pill renders whenever this flag is
  // true OR the stage is No-Show; this checkbox is how the client
  // flips it on for leads in any other stage.
  const [needsReplacement, setNeedsReplacement] = useState<boolean>(
    initial?.needs_replacement ?? false,
  );
  // Editable custom fields (Sales Volume, MLS Affiliation, etc.). Only
  // in edit mode — a brand-new manual candidate has no enrichment yet.
  // `initialCustom` is frozen at open so we can compute which fields
  // the client actually changed and send ONLY those (untouched fields
  // keep flowing live from Bison).
  const initialCustom = useMemo<Array<[string, string]>>(
    () => (initial ? editableCustomFields(initial) : []),
    [initial],
  );
  const [customValues, setCustomValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(initialCustom),
  );
  // Brand-new custom fields the user adds via "+ Add field". Each row is an
  // independent {name, value}; only rows with a non-empty name are saved, and
  // they flow through the SAME custom_fields patch as edited existing fields.
  const [addedFields, setAddedFields] = useState<
    Array<{ id: string; name: string; value: string }>
  >([]);
  const nextFieldId = useRef(0);
  function addCustomField() {
    setAddedFields((cur) => [
      ...cur,
      { id: `new-${nextFieldId.current++}`, name: "", value: "" },
    ]);
  }
  // Existing manual fields the user marked for deletion this session. Only
  // manually-added fields are deletable — an enrichment field would just
  // reload from Bison, so those aren't offered a delete control.
  const [removedKeys, setRemovedKeys] = useState<string[]>([]);
  const manualKeySet = useMemo(
    () =>
      new Set(
        (initial?.manual_custom_field_keys ?? []).map((k) => k.toLowerCase()),
      ),
    [initial],
  );
  const [pending, startTransition] = useTransition();

  async function submit() {
    // Typed column edits — kept in named locals so the create-mode
    // optimistic row below reads them directly (not from an untyped
    // request body).
    const columnEdits = {
      lead_name: name.trim() || null,
      lead_email: email.trim() || null,
      lead_phone: phone.trim() || null,
      current_brokerage: company.trim() || null,
      agent_profile_url: website.trim() || null,
      introduced_at: introducedAt
        ? new Date(introducedAt + "T12:00:00Z").toISOString()
        : null,
      needs_replacement: needsReplacement,
    };

    // Delta: only custom fields whose value the client changed from the
    // value shown when the dialog opened. Untouched fields are omitted
    // so they keep flowing from the Bison enrichment (and stay fresh on
    // re-sync); the endpoint merges this patch into the override map.
    const customFieldsDelta: Record<string, string> = {};
    for (const [k, original] of initialCustom) {
      if (removedKeys.includes(k)) continue; // being deleted — skip its value
      const next = customValues[k] ?? "";
      if (next !== original) customFieldsDelta[k] = next;
    }
    const newlyAddedKeys: string[] = [];

    // Fold in brand-new fields. Validate client-side so the user gets a clear
    // message instead of a 400 (mirrors the route's ≤120 key / ≤2000 value /
    // ≤60 keys limits), and guard against built-in and duplicate keys. A row
    // with an empty name is simply ignored.
    const existingKeysLower = new Set(initialCustom.map(([k]) => k.toLowerCase()));
    const seenNew = new Set<string>();
    for (const f of addedFields) {
      const key = f.name.trim();
      if (!key) continue;
      const lk = key.toLowerCase();
      if (key.length > 120) {
        toast.error(`Field name is too long (max 120 characters).`);
        return;
      }
      if (f.value.length > 2000) {
        toast.error(`Value for "${prettyFieldLabel(key)}" is too long (max 2000).`);
        return;
      }
      if (CUSTOM_FIELD_SKIP.has(lk) || /profile$/i.test(key)) {
        toast.error(`"${prettyFieldLabel(key)}" is a built-in field — use the fields above.`);
        return;
      }
      if (existingKeysLower.has(lk) || seenNew.has(lk)) {
        toast.error(`"${prettyFieldLabel(key)}" already exists.`);
        return;
      }
      seenNew.add(lk);
      customFieldsDelta[key] = f.value;
      newlyAddedKeys.push(key);
    }
    if (Object.keys(customFieldsDelta).length > 60) {
      toast.error("Too many custom fields changed at once (max 60).");
      return;
    }

    const hasCustomEdits = Object.keys(customFieldsDelta).length > 0;
    const hasRemovals = removedKeys.length > 0;

    const body: Record<string, unknown> = {
      ...columnEdits,
      ...(hasCustomEdits ? { custom_fields: customFieldsDelta } : {}),
      ...(hasRemovals ? { custom_fields_remove: removedKeys } : {}),
    };

    if (target.mode === "create") {
      const res = await fetch(`/api/portal/${token}/pipeline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error ?? "Could not add lead");
        return;
      }
      const j = (await res.json()) as { id: string; source?: string };
      const newRow: PipelineEntry = {
        id: j.id,
        stage: "introduction",
        custom_stage_key: null,
        needs_replacement: columnEdits.needs_replacement,
        lead_name: columnEdits.lead_name,
        lead_email: columnEdits.lead_email,
        lead_phone: columnEdits.lead_phone,
        current_brokerage: columnEdits.current_brokerage,
        agent_profile_url: columnEdits.agent_profile_url,
        lead_location: null,
        introduced_at: columnEdits.introduced_at,
        lead_detail: null,
        campaign_name: null,
        // Manual adds never link a thread. The "View conversation"
        // button is gated off this and renders disabled with a
        // tooltip until a webhook reply lands.
        thread_id: null,
        notes_log: [],
        // Manual adds start unassigned — recruiter picks via the
        // row pill once the row appears.
        assigned_team_member_id: null,
        assigned_team_member: null,
        // Brand-new entry — not yet pushed to Follow Up Boss.
        fub_event_id: null,
        fub_pushed_at: null,
        fub_last_error: null,
        // The server tells us the source it wrote (Client Entry
        // when pipeline_source_split is on, default 'BrokerStaffer'
        // otherwise) — use that directly so the optimistic chip
        // matches the DB row from frame one. Falling back to
        // BrokerStaffer only if the response somehow omits it.
        source: j.source ?? "BrokerStaffer",
      };
      onApply(j.id, {}, newRow);
      toast.success("Candidate added");
      onClose();
      return;
    }

    const res = await fetch(`/api/portal/${token}/pipeline/${target.entry.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? "Could not save");
      return;
    }

    // Optimistic patch — column edits, plus (when custom fields
    // changed) a rebuilt lead_detail.custom_fields so the expanded
    // card reflects the edit immediately without a refetch.
    const optimistic: Partial<PipelineEntry> = { ...columnEdits };
    if (hasCustomEdits || hasRemovals) {
      const prevDetail =
        (target.entry.lead_detail as {
          custom_fields?: Record<string, unknown>;
        } | null) ?? null;
      const prevCf = (prevDetail?.custom_fields ?? {}) as Record<string, unknown>;
      const nextCf = { ...prevCf, ...customFieldsDelta };
      for (const k of removedKeys) delete nextCf[k];
      optimistic.lead_detail = {
        ...(prevDetail ?? {}),
        custom_fields: nextCf,
      };
      // Keep the manual-key list in sync so a just-added field is immediately
      // deletable and a removed one stops offering delete, without a reload.
      optimistic.manual_custom_field_keys = [
        ...(target.entry.manual_custom_field_keys ?? []).filter(
          (k) => !removedKeys.includes(k),
        ),
        ...newlyAddedKeys,
      ];
    }
    onApply(target.entry.id, optimistic);
    toast.success("Lead updated");
    onClose();
  }

  // Existing custom fields still on screen (those not marked for deletion).
  const visibleCustom = initialCustom.filter(([k]) => !removedKeys.includes(k));

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {target.mode === "create" ? "Add a candidate" : "Edit lead"}
          </DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label className="text-[12px]">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" />
          </div>
          <div>
            <Label className="text-[12px]">Email</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@example.com"
            />
          </div>
          <div>
            <Label className="text-[12px]">Phone</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(123) 456-7890" />
          </div>
          <div>
            <Label className="text-[12px]">Company</Label>
            <Input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Compass" />
          </div>
          <div>
            <Label className="text-[12px]">Agent profile</Label>
            <Input
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://…"
            />
          </div>
          <div className="sm:col-span-2">
            <Label className="text-[12px]">Introduction date</Label>
            <Input
              type="date"
              value={introducedAt}
              onChange={(e) => setIntroducedAt(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 rounded-md border border-[#ebecf0] bg-[#fafbfc] px-3 py-2 text-[12.5px] text-[#5b6472] sm:col-span-2">
            <input
              type="checkbox"
              checked={needsReplacement}
              onChange={(e) => setNeedsReplacement(e.target.checked)}
              className="size-3.5 accent-[#1565C0]"
            />
            <span>
              <span className="font-medium text-[#0f1320]">Mark as needing replacement.</span>{" "}
              Always shows the Replacement tag next to the lead's name. (Leads
              in stage "No Show" show the tag automatically.)
            </span>
          </label>
        </div>

        {/* Editable custom fields (Sales Volume, MLS Affiliation, etc.).
            Only in edit mode, and only when the lead actually has
            enrichment fields to edit. Edits are stored as per-entry
            overrides — they never touch the shared lead or overwrite the
            original Bison data, and clearing a value back to its original
            reverts it. */}
        {target.mode === "edit" ? (
          <div className="mt-1 border-t border-[#ebecf0] pt-3">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[#9aa0ab]">
              Custom fields
            </div>
            {visibleCustom.length > 0 ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {visibleCustom.map(([key]) => {
                  const deletable = manualKeySet.has(key.toLowerCase());
                  return (
                    <div key={key}>
                      <div className="flex items-center justify-between gap-2">
                        <Label className="text-[12px]">{prettyFieldLabel(key)}</Label>
                        {deletable ? (
                          <button
                            type="button"
                            onClick={() => setRemovedKeys((cur) => [...cur, key])}
                            className="shrink-0 text-[#c0c4cc] transition-colors hover:text-red-600"
                            aria-label={`Delete ${prettyFieldLabel(key)}`}
                            title="Delete this field"
                          >
                            <X className="size-3.5" />
                          </button>
                        ) : null}
                      </div>
                      <Input
                        value={customValues[key] ?? ""}
                        onChange={(e) =>
                          setCustomValues((cur) => ({ ...cur, [key]: e.target.value }))
                        }
                      />
                    </div>
                  );
                })}
              </div>
            ) : null}
            {/* Newly-added fields: a name + value per row, removable before
                save. On save they merge into this entry's overrides and render
                on the card like any other field. */}
            {addedFields.length > 0 ? (
              <div className="mt-3 flex flex-col gap-2">
                {addedFields.map((f) => (
                  <div key={f.id} className="flex items-end gap-2">
                    <div className="flex-1">
                      <Label className="text-[12px]">Field name</Label>
                      <Input
                        value={f.name}
                        placeholder="e.g. Coaching Status"
                        onChange={(e) =>
                          setAddedFields((cur) =>
                            cur.map((x) =>
                              x.id === f.id ? { ...x, name: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    </div>
                    <div className="flex-1">
                      <Label className="text-[12px]">Value</Label>
                      <Input
                        value={f.value}
                        placeholder="e.g. Active"
                        onChange={(e) =>
                          setAddedFields((cur) =>
                            cur.map((x) =>
                              x.id === f.id ? { ...x, value: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="mb-0.5 shrink-0 text-[#9aa0ab] hover:text-[#0f1320]"
                      onClick={() =>
                        setAddedFields((cur) => cur.filter((x) => x.id !== f.id))
                      }
                      aria-label="Remove field"
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={addCustomField}
            >
              <Plus className="size-3.5" /> Add field
            </Button>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => startTransition(submit)}
            disabled={pending}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : target.mode === "create" ? (
              "Add candidate"
            ) : (
              "Save"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// "YYYY-MM-DD" suitable for <input type=date>. We anchor to UTC so the
// stored ISO survives round-trips without a timezone shift on the user.
function toLocalDateInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function csvCell(v: string): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}


function normalizeUrl(u: string): string {
  if (/^https?:\/\//i.test(u)) return u;
  return `https://${u.replace(/^\/+/, "")}`;
}
function trimUrl(u: string): string {
  return u.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}

// Per-row Follow Up Boss push chip. Renders one of four states:
//
//   • Not connected → "Connect to push" link to the Settings page.
//   • Never pushed  → solid "Push to Follow Up Boss" button.
//   • Pushed OK     → green "In Follow Up Boss" chip + tiny "Push again"
//                     re-push affordance.
//   • Last attempt failed → red "Push failed" chip with the error in
//                     the tooltip + a quick "Retry" affordance.
//
// Re-pushing is always safe — FUB dedupes by email/phone and the
// helper updates the same person row instead of duplicating.
function PushToFubChip({
  entry,
  token,
  fubConnected,
  onLocalUpdate,
}: {
  entry: PipelineEntry;
  token: string;
  fubConnected: boolean;
  onLocalUpdate: (patch: Partial<PipelineEntry>) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function push() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/portal/${token}/pipeline/${entry.id}/push-fub`,
        { method: "POST" },
      );
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        mode?: "created" | "updated";
        reason?: string;
      };
      if (!res.ok || !json.ok) {
        const msg = json.error ?? "Push failed";
        toast.error(msg);
        onLocalUpdate({
          fub_last_error: msg.slice(0, 500),
        });
        return;
      }
      const nowIso = new Date().toISOString();
      onLocalUpdate({
        fub_pushed_at: nowIso,
        fub_last_error: null,
      });
      toast.success(
        json.mode === "created"
          ? "Sent to Follow Up Boss"
          : "Updated in Follow Up Boss",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!fubConnected) {
    // No CTA on the row when the client hasn't connected FUB. The
    // Settings page is the single place that surfaces the "Connect"
    // affordance, so the per-lead strip stays clean.
    return null;
  }

  if (entry.fub_pushed_at) {
    return (
      <span className="inline-flex items-center gap-2">
        <span
          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[#0c8a4e]"
          title={`Pushed ${formatRelativeDate(entry.fub_pushed_at)}${
            entry.fub_last_error
              ? `. Last error: ${entry.fub_last_error}`
              : ""
          }`}
        >
          <CircleCheck className="size-3 shrink-0" />
          <span>In Follow Up Boss</span>
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void push();
          }}
          disabled={busy}
          className="text-[11px] text-[#9aa0ab] underline-offset-2 hover:text-[#1565C0] hover:underline disabled:opacity-50"
          title="Push the latest data again"
        >
          {busy ? "Pushing…" : "Push again"}
        </button>
      </span>
    );
  }

  if (entry.fub_last_error) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void push();
        }}
        disabled={busy}
        className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[#b91c1c] hover:underline disabled:opacity-50"
        title={`Last error: ${entry.fub_last_error}`}
      >
        {busy ? (
          <Loader2 className="size-3 shrink-0 animate-spin" />
        ) : (
          <TriangleAlert className="size-3 shrink-0" />
        )}
        <span>Retry push</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void push();
      }}
      disabled={busy}
      className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[#1565C0] hover:underline disabled:opacity-50"
      title="Send this lead to Follow Up Boss now"
    >
      {busy ? (
        <Loader2 className="size-3 shrink-0 animate-spin" />
      ) : (
        <Send className="size-3 shrink-0" />
      )}
      <span>Push to FUB</span>
    </button>
  );
}

function formatRelativeDate(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const mins = Math.round(ms / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}
