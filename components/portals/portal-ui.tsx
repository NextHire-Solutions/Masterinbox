"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { PortalLogo } from "@/components/portals/portal-logo";

// Shared UI primitives for the portal surfaces (Pipeline, Agents, DNC,
// Team). Keep the look consistent with the existing portal — light card
// surface, refined typography, no flashy effects.

export function PortalPageHeader({
  title,
  subtitle,
  actions,
  titleBadge,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  // Optional element shown inline to the right of the title (e.g. a plan
  // badge). Absent on every page that doesn't pass it → no layout change.
  titleBadge?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
          {titleBadge ?? null}
        </div>
        {subtitle ? (
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-[#5b6472]">
            {subtitle}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

// A subtle mount fade-in for tables — same useMounted() pattern used in
// the chart redesign. No loop, no bounce.
export function useMounted(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return on;
}

export function PortalEmpty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-[#dde0e5] bg-white p-12 text-center">
      <PortalLogo className="mx-auto h-10 w-auto opacity-60" />
      <p className="mt-3 text-sm font-medium">{title}</p>
      {hint ? <p className="mt-1 text-xs text-[#9aa0ab]">{hint}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

// One pill style used across status badges. Tones: neutral, success,
// warning, danger, accent.
export function Pill({
  tone = "neutral",
  children,
  className,
}: {
  tone?: "neutral" | "success" | "warning" | "danger" | "accent";
  children: React.ReactNode;
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-[#eef0f3] text-[#5b6472]",
    success: "bg-[#e9f7ef] text-[#0c8a4e]",
    warning: "bg-[#fef7e6] text-[#a06200]",
    danger: "bg-[#fee2e2] text-[#b91c1c]",
    accent: "bg-[#eaf2fd] text-[#1565C0]",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold leading-none",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// Shared pager footer for the portal list views (Agents, DNC,
// Recruiting Pipeline). All three lists paginate client-side at the
// same page size, so the controls are deliberately minimal: a
// prev/next pair flanking a "X – Y of Z" indicator. The total count
// already accounts for active filters at the call site, so the math
// here is purely slicing math.
export function PaginationFooter({
  page,
  pageSize,
  total,
  onPageChange,
  className,
  label = "results",
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (next: number) => void;
  className?: string;
  label?: string;
}) {
  if (total <= pageSize) return null;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize + 1;
  const end = Math.min(safePage * pageSize, total);
  return (
    <div
      className={cn(
        "mt-3 flex items-center justify-between rounded-xl border border-[#ebecf0] bg-white px-3 py-2 text-[12px] text-[#5b6472]",
        className,
      )}
    >
      <div className="tabular-nums">
        <span className="font-medium text-[#0f1320]">
          {start.toLocaleString()}–{end.toLocaleString()}
        </span>{" "}
        of {total.toLocaleString()} {label}
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPageChange(safePage - 1)}
          disabled={safePage <= 1}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-[#ebecf0] bg-white px-2 text-[12px] font-medium text-[#5b6472] transition-colors hover:bg-[#f6f7f9] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ChevronLeft className="size-3.5" />
          Prev
        </button>
        <span className="px-2 tabular-nums text-[12px] text-[#9aa0ab]">
          Page {safePage} / {totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(safePage + 1)}
          disabled={safePage >= totalPages}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-[#ebecf0] bg-white px-2 text-[12px] font-medium text-[#5b6472] transition-colors hover:bg-[#f6f7f9] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Next
          <ChevronRight className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

// Page-size constant used by every portal list so they paginate in
// lockstep. 50 is the user-confirmed default; tweaking here changes
// every list at once.
export const PORTAL_PAGE_SIZE = 50;

// Cross-page "select all" banner — the Gmail/Notion pattern. Ticking
// the header checkbox only selects the visible page slice (so users
// can build cross-page selections by paging + ticking). The moment a
// page is fully ticked AND there's more data beyond it, this banner
// renders the upgrade path:
//   "All 50 on this page are selected.  Select all 336 agents"
// and once everything is selected:
//   "All 336 agents are selected.  Clear selection"
//
// Self-contained — pass in counts + handlers and reuse across every
// paged portal list (Agents, DNC, Pipeline).
export function SelectAllAcrossPagesBanner({
  visiblePageFullySelected,
  selectedCount,
  totalCount,
  noun,
  onSelectAll,
  onClear,
}: {
  visiblePageFullySelected: boolean;
  selectedCount: number;
  totalCount: number;
  noun: string;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  // Single page — never show; the bulk bar already explains
  // "N selected" and there's no "all pages" to escalate to.
  if (totalCount <= PORTAL_PAGE_SIZE) return null;

  const allSelected = selectedCount >= totalCount;
  if (!visiblePageFullySelected && !allSelected) return null;

  return (
    <div className="-mt-2 mb-4 flex items-center justify-center gap-1 rounded-lg border border-[#bcd5f1] bg-[#eaf2fd]/60 px-3 py-2 text-[12.5px] text-[#1565C0]">
      {allSelected ? (
        <>
          <span>
            All <span className="font-semibold">{totalCount.toLocaleString()}</span>{" "}
            {noun} are selected.
          </span>
          <button
            type="button"
            onClick={onClear}
            className="ml-1 font-semibold underline-offset-2 hover:underline"
          >
            Clear selection
          </button>
        </>
      ) : (
        <>
          <span>
            All <span className="font-semibold">{PORTAL_PAGE_SIZE}</span> {noun} on
            this page are selected.
          </span>
          <button
            type="button"
            onClick={onSelectAll}
            className="ml-1 font-semibold underline-offset-2 hover:underline"
          >
            Select all {totalCount.toLocaleString()} {noun}
          </button>
        </>
      )}
    </div>
  );
}

// Initials avatar — used in the Team and DNC lists. When `src` is
// provided we render the photo inside the same circle; broken loads
// fall back to the initials so a stale URL never leaves a blank
// circle.
export function Avatar({
  name,
  src,
  className,
}: {
  name: string;
  src?: string | null;
  className?: string;
}) {
  const [imgError, setImgError] = useState(false);
  const initials =
    name
      .split(/\s+/)
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?";

  const showImage = !!src && !imgError;

  return (
    <div
      className={cn(
        "flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#eaf2fd] text-xs font-semibold text-[#1565C0]",
        className,
      )}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src as string}
          alt={name}
          className="size-full object-cover"
          onError={() => setImgError(true)}
        />
      ) : (
        initials
      )}
    </div>
  );
}
