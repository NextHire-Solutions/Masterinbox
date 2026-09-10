"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  Settings2,
  Loader2,
  ArrowUp,
  ArrowDown,
  Eye,
  EyeOff,
  Plus,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { STAGE_LABEL_MAX_LEN } from "@/lib/portals/portal-data";
import {
  type StageDef,
  STRUCTURAL_CANONICAL_STAGES,
  STAGE_COLOR_PALETTE,
  GLOBAL_CUSTOM_STAGE_KEYS,
} from "@/lib/portals/stage-config";

// Manage Stages editor — Demo Portal only (gated by `manage_stages`; the board
// renders <StageManager> in place of <StageLabelEditor> only when the flag is on).
// This first increment: rename, reorder, and show/hide the existing stages.
// Custom-stage creation lands with the board's custom-column rendering next.
//
// SAFETY: saving only writes the client_pipeline_stages overlay via
// PATCH /api/portal/[token]/stages — never the enum, entries, or any webhook.

const STRUCTURAL = new Set<string>(STRUCTURAL_CANONICAL_STAGES);
// The two global "no show" stages are system-provided: they can be renamed /
// reordered / hidden like any stage, but never deleted (they come back from
// code on the next load anyway).
const SYSTEM_CUSTOM = new Set<string>(GLOBAL_CUSTOM_STAGE_KEYS);

type Row = {
  key: string;
  label: string;
  color: string;
  kind: "canonical" | "custom";
  canonical_stage: string | null;
  hidden: boolean;
};

export function StageManager({
  token,
  stages,
}: {
  token: string;
  stages: StageDef[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>(() =>
    stages.map((s) => ({
      key: s.key,
      label: s.label,
      color: s.color,
      kind: s.kind,
      canonical_stage: s.canonicalStage,
      hidden: s.hidden,
    })),
  );
  const [saving, setSaving] = useState(false);
  const [pending, startTransition] = useTransition();
  const busy = saving || pending;

  function move(i: number, dir: -1 | 1) {
    setRows((cur) => {
      const j = i + dir;
      if (j < 0 || j >= cur.length) return cur;
      const next = cur.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }
  function rename(i: number, label: string) {
    setRows((cur) => cur.map((r, k) => (k === i ? { ...r, label } : r)));
  }
  function toggleHidden(i: number) {
    setRows((cur) =>
      cur.map((r, k) =>
        k === i && !STRUCTURAL.has(r.key) ? { ...r, hidden: !r.hidden } : r,
      ),
    );
  }
  function addStage() {
    const key = `custom_${Math.random().toString(36).slice(2, 10)}`;
    const used = new Set(rows.map((r) => r.color));
    const color =
      STAGE_COLOR_PALETTE.find((c) => !used.has(c)) ??
      STAGE_COLOR_PALETTE[rows.length % STAGE_COLOR_PALETTE.length];
    setRows((cur) => [
      ...cur,
      { key, label: "New stage", color, kind: "custom", canonical_stage: null, hidden: false },
    ]);
  }
  function deleteStage(i: number) {
    setRows((cur) =>
      cur[i]?.kind === "custom" && !SYSTEM_CUSTOM.has(cur[i].key)
        ? cur.filter((_, k) => k !== i)
        : cur,
    );
  }
  // Custom-stage color: click the dot to cycle through the preset palette.
  function cycleColor(i: number) {
    setRows((cur) =>
      cur.map((r, k) => {
        if (k !== i || r.kind !== "custom") return r;
        const idx = STAGE_COLOR_PALETTE.indexOf(r.color);
        const next = STAGE_COLOR_PALETTE[(idx + 1) % STAGE_COLOR_PALETTE.length];
        return { ...r, color: next };
      }),
    );
  }

  async function save() {
    // Guard: never let every stage be hidden.
    if (rows.every((r) => r.hidden)) {
      toast.error("At least one stage must stay visible.");
      return;
    }
    const payload = {
      stages: rows.map((r) => ({
        key: r.key,
        label: r.label.trim() || r.key,
        color: r.color,
        kind: r.kind,
        canonical_stage: r.kind === "canonical" ? r.canonical_stage : null,
        hidden: r.hidden,
      })),
    };
    setSaving(true);
    try {
      const res = await fetch(`/api/portal/${token}/stages`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error ?? "Could not save stages");
        return;
      }
      toast.success("Stages updated");
      startTransition(() => router.refresh());
    } catch {
      toast.error("Could not reach the server");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mb-4 overflow-hidden rounded-2xl border border-[#ebecf0] bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-[#fafbfc] sm:px-5"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[#eaf2fd] text-[#1565C0]">
          <Settings2 className="size-[16px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold text-[#0f1320]">
            Manage stages
          </span>
          <span className="mt-0.5 block text-[12px] leading-snug text-[#5b6472]">
            Rename, reorder, and show or hide your pipeline stages. Applies to
            everyone viewing this portal.
          </span>
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-[#9aa0ab] transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <div className="border-t border-[#ebecf0] bg-[#fafbfc] px-4 pb-4 pt-4 sm:px-5 sm:pb-5">
          <div className="flex flex-col gap-2">
            {rows.map((r, i) => {
              const structural = STRUCTURAL.has(r.key);
              return (
                <div
                  key={r.key}
                  className={cn(
                    "flex items-center gap-2 rounded-xl border border-[#ebecf0] bg-white px-3 py-2 shadow-[0_1px_0_rgba(0,0,0,0.02)]",
                    r.hidden && "opacity-60",
                  )}
                >
                  <span className="flex flex-col">
                    <button
                      type="button"
                      onClick={() => move(i, -1)}
                      disabled={busy || i === 0}
                      aria-label="Move up"
                      className="text-[#9aa0ab] hover:text-[#0f1320] disabled:opacity-30"
                    >
                      <ArrowUp className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(i, 1)}
                      disabled={busy || i === rows.length - 1}
                      aria-label="Move down"
                      className="text-[#9aa0ab] hover:text-[#0f1320] disabled:opacity-30"
                    >
                      <ArrowDown className="size-3.5" />
                    </button>
                  </span>
                  {r.kind === "custom" ? (
                    <button
                      type="button"
                      onClick={() => cycleColor(i)}
                      disabled={busy}
                      aria-label="Change color"
                      title="Click to change color"
                      className="inline-block size-3 shrink-0 rounded-full ring-1 ring-black/10"
                      style={{ backgroundColor: r.color }}
                    />
                  ) : (
                    <span
                      aria-hidden
                      className="inline-block size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: r.color }}
                    />
                  )}
                  <Input
                    value={r.label}
                    onChange={(e) => rename(i, e.target.value)}
                    maxLength={STAGE_LABEL_MAX_LEN}
                    disabled={busy}
                    aria-label={`Rename ${r.key}`}
                    className="h-9 flex-1 border-0 bg-transparent px-0 text-[16px] shadow-none focus-visible:ring-0 sm:text-[13.5px]"
                  />
                  <button
                    type="button"
                    onClick={() => toggleHidden(i)}
                    disabled={busy || structural}
                    aria-label={r.hidden ? "Show stage" : "Hide stage"}
                    title={
                      structural
                        ? "This stage can't be hidden"
                        : r.hidden
                          ? "Hidden — click to show"
                          : "Visible — click to hide"
                    }
                    className="text-[#9aa0ab] hover:text-[#0f1320] disabled:opacity-30"
                  >
                    {r.hidden ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </button>
                  {r.kind === "custom" && !SYSTEM_CUSTOM.has(r.key) ? (
                    <button
                      type="button"
                      onClick={() => deleteStage(i)}
                      disabled={busy}
                      aria-label="Delete stage"
                      title="Delete this custom stage"
                      className="text-[#9aa0ab] hover:text-[#e23a3a] disabled:opacity-30"
                    >
                      <X className="size-4" />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>

          <button
            type="button"
            onClick={addStage}
            disabled={busy}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-[#d4dae3] px-3 py-2 text-[12.5px] font-medium text-[#5b6472] transition-colors hover:border-[#1565C0] hover:text-[#1565C0] disabled:opacity-50"
          >
            <Plus className="size-3.5" />
            Add stage
          </button>

          <div className="mt-4 flex items-center justify-between gap-2">
            <span className="text-[11.5px] text-[#9aa0ab]">
              Custom stages are for your team's workflow. They don't change your
              reporting.
            </span>
            <Button onClick={save} disabled={busy} className="min-w-[120px]">
              {busy ? <Loader2 className="size-4 animate-spin" /> : "Save changes"}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
