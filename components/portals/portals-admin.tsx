"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Copy,
  ExternalLink,
  Pencil,
  Check,
  Loader2,
  Search,
  Users,
  Globe,
  Sparkles,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PortalLogo } from "@/components/portals/portal-logo";
import { publicPortalUrl } from "@/lib/portals/public-url";
import type { PortalClientRow } from "@/app/(app)/portals/page";

// Absolute date for the "last intro" column — client asked for an
// explicit date instead of "Xh ago / 1mo ago" so it's easier to spot
// stale clients at a glance. Locale + UTC are fixed so the value is
// the same in any timezone the operator opens this page from.
function formatLastIntro(iso: string | null): string {
  if (!iso) return "No intros yet";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function clientInitials(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

export function PortalsAdmin({ rows }: { rows: PortalClientRow[] }) {
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<PortalClientRow | null>(null);
  const router = useRouter();

  const filtered =
    search.trim().length === 0
      ? rows
      : rows.filter((r) => r.name.toLowerCase().includes(search.trim().toLowerCase()));

  const totalIntros = rows.reduce((n, r) => n + r.intro_count, 0);
  const livePortals = rows.filter((r) => r.portal_enabled && r.portal_token).length;
  const withIntros = rows.filter((r) => r.intro_count > 0).length;

  return (
    // flex-1 + overflow-y-auto: this page lives inside AppShell's <main>,
    // which is overflow-hidden — so the page must own its own scroll.
    <div className="flex-1 overflow-y-auto bg-[#f6f7f9] text-[#0f1320] antialiased">
      <div className="mx-auto max-w-5xl px-8 py-10">
        {/* ---- Header ---- */}
        <div className="flex items-start gap-3.5">
          <div className="rounded-xl border border-[#ebecf0] bg-white p-2 shadow-sm">
            <PortalLogo className="h-8 w-auto" />
          </div>
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight">Client Portals</h1>
            <p className="mt-0.5 max-w-lg text-sm leading-relaxed text-[#5b6472]">
              Every client gets a private, login-free page of their Introduction
              leads. Manage and share the links here.
            </p>
          </div>
        </div>

        {/* ---- Summary ---- */}
        <div className="my-7 grid grid-cols-3 gap-4">
          <SummaryCard
            icon={Users}
            label="Clients"
            value={rows.length}
            hint={`${withIntros} with introductions`}
          />
          <SummaryCard
            icon={Globe}
            label="Live portals"
            value={livePortals}
            hint={`of ${rows.length} clients`}
          />
          <SummaryCard
            icon={Sparkles}
            label="Total introductions"
            value={totalIntros}
            hint="across all clients"
            accent
          />
        </div>

        {/* ---- Search ---- */}
        <div className="relative mb-4 max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#9aa0ab]" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clients…"
            className="h-10 w-full rounded-xl border border-[#ebecf0] bg-white pl-9 pr-3 text-sm placeholder:text-[#9aa0ab] focus:border-[#bcd5f1] focus:outline-none focus:ring-2 focus:ring-[#eaf2fd]"
          />
        </div>

        {/* ---- Client list ---- */}
        <div className="overflow-hidden rounded-2xl border border-[#ebecf0] bg-white shadow-sm">
          <div className="grid grid-cols-[1fr_84px_128px_72px_72px_128px] gap-3 border-b border-[#f0f1f4] bg-[#fafbfc] px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-[#9aa0ab]">
            <div>Client</div>
            <div className="text-center">Intros</div>
            <div>Last intro</div>
            <div className="text-center">Live</div>
            <div className="text-center">SMS</div>
            <div className="text-right">Actions</div>
          </div>

          {filtered.length === 0 ? (
            <div className="px-5 py-16 text-center text-sm text-[#9aa0ab]">
              No clients match “{search}”.
            </div>
          ) : (
            filtered.map((r) => (
              <PortalRow
                key={r.id}
                row={r}
                onEdit={() => setEditing(r)}
                onToggle={(enabled) => {
                  void patchPortal(r.id, { portal_enabled: enabled }).then((ok) => {
                    if (ok) {
                      toast.success(enabled ? "Portal enabled" : "Portal disabled");
                      router.refresh();
                    }
                  });
                }}
                onToggleSms={(enabled) => {
                  // Turning SMS on texts real people, so it asks first.
                  if (
                    enabled &&
                    !confirm(
                      `Turn on SMS alerts for ${r.name}?\n\nFrom their next introduction, each person switched on in their portal's Team page gets a text (the first time, a welcome asking them to reply YES).`,
                    )
                  ) {
                    return;
                  }
                  void patchPortal(r.id, { sms_alerts: enabled }).then((ok) => {
                    if (ok) {
                      toast.success(
                        enabled ? `SMS alerts on for ${r.name}` : `SMS alerts off for ${r.name}`,
                      );
                      router.refresh();
                    }
                  });
                }}
              />
            ))
          )}
        </div>

        <p className="mt-4 text-xs leading-relaxed text-[#9aa0ab]">
          Anyone with a portal link can open it — there is no password. Keep the
          random suffix in each URL so links can&apos;t be guessed.
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-[#9aa0ab]">
          SMS: when on, the client&apos;s team gets a text for each new
          introduction. Who on the team gets it is chosen with the SMS switches
          on their portal&apos;s Team page.
        </p>
      </div>

      <EditPortalUrlDialog
        row={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          router.refresh();
        }}
      />
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  hint,
  accent,
}: {
  icon: typeof Users;
  label: string;
  value: number;
  hint: string;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border p-5 shadow-sm",
        accent
          ? "border-transparent bg-gradient-to-br from-[#1565C0] to-[#2f7fe0] text-white"
          : "border-[#ebecf0] bg-white",
      )}
    >
      {accent ? (
        <div
          className="pointer-events-none absolute -right-8 -top-10 size-36 rounded-full opacity-40 blur-2xl"
          style={{ background: "radial-gradient(circle, #ffffff 0%, transparent 70%)" }}
        />
      ) : null}
      <div className="relative">
        <div
          className={cn(
            "inline-flex size-9 items-center justify-center rounded-xl",
            accent ? "bg-white/15" : "bg-[#eaf2fd]",
          )}
        >
          <Icon className={cn("size-[18px]", accent ? "text-white" : "text-[#1565C0]")} />
        </div>
        <div
          className={cn(
            "mt-3 text-[34px] font-semibold leading-none tracking-tight tabular-nums",
            accent ? "text-white" : "text-[#0f1320]",
          )}
        >
          {value}
        </div>
        <div
          className={cn(
            "mt-1.5 text-[13px] font-medium",
            accent ? "text-white" : "text-[#0f1320]",
          )}
        >
          {label}
        </div>
        <div className={cn("text-[11.5px]", accent ? "text-white/70" : "text-[#9aa0ab]")}>
          {hint}
        </div>
      </div>
    </div>
  );
}

function PortalRow({
  row,
  onEdit,
  onToggle,
  onToggleSms,
}: {
  row: PortalClientRow;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
  onToggleSms: (enabled: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const portalPath = row.portal_token ? `/portal/${row.portal_token}` : null;
  // Brokerage-facing URL on the custom domain. Used for the row's
  // copy + open actions — staff share the portal.brokerstaffer.com
  // URL, NOT the Railway host.
  const portalAbsoluteUrl = publicPortalUrl(row.portal_token);
  const isLive = Boolean(row.portal_enabled && portalAbsoluteUrl);

  function copyLink() {
    if (!portalAbsoluteUrl) return;
    navigator.clipboard.writeText(portalAbsoluteUrl).then(
      () => {
        setCopied(true);
        toast.success("Portal link copied");
        setTimeout(() => setCopied(false), 1500);
      },
      () => toast.error("Couldn't copy"),
    );
  }

  return (
    <div className="grid grid-cols-[1fr_84px_128px_72px_72px_128px] items-center gap-3 border-b border-[#f0f1f4] px-5 py-3.5 transition-colors last:border-0 hover:bg-[#fafbfc]">
      {/* Client */}
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#eaf2fd] text-xs font-semibold text-[#1565C0]">
          {clientInitials(row.name)}
        </div>
        <div className="min-w-0">
          <Link
            href={`/portals/${row.id}`}
            className="group block truncate text-[14px] font-medium transition-colors hover:text-[#1565C0]"
          >
            {row.name}
            <ChevronRight className="ml-0.5 inline size-3.5 -translate-y-px text-[#c2c7d0] transition-transform group-hover:translate-x-0.5 group-hover:text-[#1565C0]" />
          </Link>
          {portalPath ? (
            <div className="truncate font-mono text-[11px] text-[#9aa0ab]">{portalPath}</div>
          ) : (
            <div className="text-[11px] text-[#c23934]">No portal URL set</div>
          )}
        </div>
      </div>

      {/* Intros */}
      <div className="flex justify-center">
        <span
          className={cn(
            "inline-flex h-7 min-w-9 items-center justify-center rounded-full px-2.5 text-[13px] font-semibold tabular-nums",
            row.intro_count > 0
              ? "bg-[#eaf2fd] text-[#1565C0]"
              : "bg-[#f0f1f4] text-[#9aa0ab]",
          )}
        >
          {row.intro_count}
        </span>
      </div>

      {/* Last intro */}
      <div className="text-[13px] text-[#5b6472]">{formatLastIntro(row.last_intro_at)}</div>

      {/* Portal toggle */}
      <div className="flex justify-center">
        <Switch
          checked={row.portal_enabled}
          onCheckedChange={(v) => onToggle(Boolean(v))}
          aria-label="Portal enabled"
        />
      </div>

      {/* SMS alerts toggle */}
      <div
        className="flex justify-center"
        title={row.sms_alerts ? "Team gets a text for each new introduction" : "No SMS alerts"}
      >
        <Switch
          checked={row.sms_alerts}
          onCheckedChange={(v) => onToggleSms(Boolean(v))}
          aria-label={`SMS alerts for ${row.name}`}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-0.5">
        <IconAction
          icon={copied ? Check : Copy}
          label="Copy link"
          onClick={copyLink}
          disabled={!portalAbsoluteUrl}
        />
        <IconAction icon={Pencil} label="Edit URL" onClick={onEdit} />
        {isLive && portalAbsoluteUrl ? (
          <a
            href={portalAbsoluteUrl}
            target="_blank"
            rel="noopener"
            className="inline-flex size-8 items-center justify-center rounded-lg text-[#9aa0ab] transition-all hover:bg-[#eaf2fd] hover:text-[#1565C0]"
            aria-label="Open live portal"
            title="Open live portal"
          >
            <ExternalLink className="size-4" />
          </a>
        ) : (
          <span className="size-8" />
        )}
      </div>
    </div>
  );
}

function IconAction({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: typeof Copy;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="inline-flex size-8 items-center justify-center rounded-lg text-[#9aa0ab] transition-all hover:bg-[#f0f2f5] hover:text-[#0f1320] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <Icon className="size-4" />
    </button>
  );
}

// PATCH helper shared by the toggle + the edit dialog.
async function patchPortal(
  clientId: string,
  patch: { portal_token?: string; portal_enabled?: boolean; sms_alerts?: boolean },
): Promise<boolean> {
  const res = await fetch(`/api/clients/${clientId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    toast.error(json.error ?? "Update failed");
    return false;
  }
  return true;
}

function EditPortalUrlDialog({
  row,
  onClose,
  onSaved,
}: {
  row: PortalClientRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [token, setToken] = useState("");
  const [pending, startTransition] = useTransition();
  const open = row !== null;

  useEffect(() => {
    if (row) setToken(row.portal_token ?? "");
  }, [row?.id, row?.portal_token, row]);

  function onOpenChange(v: boolean) {
    if (!v) onClose();
  }

  async function save() {
    if (!row) return;
    const next = token.trim();
    if (next.length < 8) {
      toast.error("Portal URL must be at least 8 characters");
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(next)) {
      toast.error("Only letters, numbers, hyphens and underscores");
      return;
    }
    if (next === row.portal_token) {
      onClose();
      return;
    }
    const ok = await patchPortal(row.id, { portal_token: next });
    if (ok) {
      toast.success("Portal URL updated");
      startTransition(() => onSaved());
    }
  }

  if (!row) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Portal URL — {row.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-xs font-medium text-[#5b6472]">Custom URL slug</label>
          <div className="flex items-center overflow-hidden rounded-lg border border-[#ebecf0] bg-white focus-within:border-[#bcd5f1] focus-within:ring-2 focus-within:ring-[#eaf2fd]">
            <span className="whitespace-nowrap border-r border-[#ebecf0] bg-[#fafbfc] px-2.5 py-2 font-mono text-xs text-[#9aa0ab]">
              /portal/
            </span>
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="flex-1 bg-transparent px-2.5 py-2 font-mono text-sm focus:outline-none"
              placeholder="brooklyn-group-a1b2c3"
              autoFocus
            />
          </div>
          <p className="text-[11px] leading-relaxed text-[#9aa0ab]">
            Anyone with this link can view the portal — there is no password. Keep
            the random suffix so it can&apos;t be guessed. Letters, numbers,
            hyphens and underscores only; 8 characters minimum.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : "Save URL"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
