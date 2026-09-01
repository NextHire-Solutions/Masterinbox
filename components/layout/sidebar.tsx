"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Eye,
  Plus,
  Clock,
  Archive,
  Trash2,
  Building2,
  LogOut,
  Search,
  MoreHorizontal,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { CreateListDialog } from "@/components/inbox/create-list-dialog";
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
import { Button } from "@/components/ui/button";
import type { SessionContext } from "@/lib/auth/workspace";
import {
  normalizeClientName,
  type ClientStatus,
  type ListRow,
} from "@/lib/inbox/lists-shared";

// Flat status dots — cleaner and more consistent than the 🟢/🟡/🔴 emoji,
// which render as heavy glossy spheres. Tailwind swatches read well in both
// light and dark themes.
const STATUS_DOT: Record<ClientStatus, string> = {
  active: "bg-emerald-500",
  paused: "bg-amber-500",
  churned: "bg-red-500",
};
const STATUS_LABEL: Record<ClientStatus, string> = {
  active: "Active",
  paused: "Paused",
  churned: "Churned",
};

// Sidebar width is user-resizable via the drag handle on the right edge.
// Width is persisted in localStorage so the user's preference survives reloads
// (and tab switches). Server-rendered default matches DEFAULT_WIDTH so the
// first paint is stable; useEffect then restores any saved value.
const SIDEBAR_WIDTH_KEY = "sales-inbox-sidebar-width";
const DEFAULT_WIDTH = 232;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

const inboxLists: Array<{ href: string; label: string; icon: LucideIcon; iconClassName?: string }> = [
  { href: "/inbox/all-email", label: "All", icon: Eye, iconClassName: "text-foreground" },
];

const folderLinks: Array<{ href: string; label: string; icon: LucideIcon }> = [
  { href: "/reminders", label: "Reminders", icon: Clock },
  // These match the special view names handled in loadThreads (status filters).
  { href: "/inbox/archive", label: "Archive", icon: Archive },
  { href: "/inbox/trash", label: "Trash", icon: Trash2 },
];

export function Sidebar({
  session,
  lists: initialLists,
  listCounts = {},
}: {
  session: SessionContext;
  lists: ListRow[];
  // list id → count of unseen open threads, drives the "N new" pill.
  listCounts?: Record<string, number>;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeListId = searchParams.get("list");
  const [createOpen, setCreateOpen] = useState(false);
  const [listSearch, setListSearch] = useState("");
  const [editingList, setEditingList] = useState<ListRow | null>(null);
  const [deletingList, setDeletingList] = useState<ListRow | null>(null);
  const router = useRouter();
  // Sidebar ordering is now SERVER-AUTHORITATIVE — `lib/inbox/lists.ts`
  // sorts every list by the most recent inbound reply (view
  // `client_inbox_activity`). Drag-reorder was removed because
  // auto-sort would override any manual move. The list comes
  // straight from the server prop.
  const lists = initialLists;
  // Client health (🟢 active / 🟡 paused / 🔴 churned) comes from an external
  // feed via the /api/clients/status proxy. Fetched AFTER mount as a pure
  // progressive enhancement — the sidebar renders fully without it, and any
  // failure just leaves status unset. It can never block or break the inbox.
  const [clientStatus, setClientStatus] = useState<{
    counts: Record<ClientStatus, number> | null;
    byName: Record<string, ClientStatus>;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/clients/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.ok) {
          setClientStatus({ counts: d.counts ?? null, byName: d.byName ?? {} });
        }
      })
      .catch(() => {
        // fail open — no status, sidebar unchanged.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  // Mirror the latest width into a ref so the pointer-up handler can read it
  // without re-binding the effect on every width change.
  const widthRef = useRef(width);
  widthRef.current = width;

  // Restore persisted width on mount. Done in useEffect (not in useState's
  // lazy initializer) so the server-rendered HTML matches the first client
  // paint — avoids the React hydration mismatch warning.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
      if (!saved) return;
      const n = Number(saved);
      if (Number.isFinite(n) && n >= MIN_WIDTH && n <= MAX_WIDTH) {
        setWidth(n);
      }
    } catch {
      // localStorage can throw in private-mode Safari; ignore.
    }
  }, []);

  // Global pointer handlers active only while dragging. Listening on window
  // (not the handle) so the drag keeps tracking even if the cursor moves
  // outside the 4px strip — same pattern as native window-resize handles.
  useEffect(() => {
    if (!resizing) return;

    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      const next = Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, d.startWidth + (e.clientX - d.startX)),
      );
      setWidth(next);
    }
    function onUp() {
      setResizing(false);
      dragRef.current = null;
      try {
        // Persist on release, not every move, so localStorage doesn't get
        // hammered during the drag.
        window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(widthRef.current));
      } catch {
        // localStorage can throw in private-mode Safari; ignore.
      }
    }

    // Pin the cursor + suppress text selection across the whole page while
    // dragging — otherwise the cursor flickers back to default when the
    // pointer briefly leaves the thin handle strip.
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [resizing]);

  function onHandlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    dragRef.current = { startX: e.clientX, startWidth: width };
    setResizing(true);
    // Stop text selection during drag.
    e.preventDefault();
  }

  // The inbox sidebar (client lists, folders) is meaningless on the
  // Client Portals screens — hide it there so the portal admin gets the
  // full width. Placed after all hooks so hook order stays stable.
  if (pathname.startsWith("/portals")) return null;

  return (
    <aside
      style={{ width: `${width}px` }}
      className="relative shrink-0 border-r bg-background flex flex-col"
    >
      <div className="px-4 pt-4 pb-3 flex items-center gap-2">
        <span className="text-base">📈</span>
        <h2 className="text-sm font-semibold tracking-tight">Sales inbox</h2>
      </div>

      <nav className="px-2 flex flex-col gap-px shrink-0">
        {inboxLists.map((item) => {
          const Icon = item.icon;
          const active = (pathname === item.href || pathname.startsWith(`${item.href}/`)) && !activeListId;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "group flex items-center gap-2.5 px-2 py-1.5 rounded-md text-[13.5px] font-medium text-foreground/80 hover:bg-accent hover:text-foreground transition-colors",
                active && "bg-accent text-foreground",
              )}
            >
              <Icon className={cn("size-4 shrink-0", item.iconClassName)} strokeWidth={2} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Search input — filters the lists below. Always visible above the
          scrollable lists area so it never falls off-screen. */}
      <div className="px-2 pt-2 pb-1 shrink-0">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="search"
            // Chrome's autofill ignores most hints if a saved value
            // previously matched this slot — clients were getting
            // admin@outreachify.io dropped here, filtering every list
            // out. The readOnly-until-focus trick is the only reliable
            // way to suppress it: the field is non-targetable for the
            // browser's autofill heuristic at mount time, then becomes
            // editable the moment the user clicks in.
            name="sidebar-list-filter"
            autoComplete="off"
            inputMode="search"
            aria-autocomplete="none"
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            readOnly
            onFocus={(e) => e.currentTarget.removeAttribute("readonly")}
            value={listSearch}
            onChange={(e) => setListSearch(e.target.value)}
            placeholder="Search lists…"
            className="w-full h-8 pl-7 pr-2 rounded-md border bg-background text-[13px] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      {/* Scrollable lists area. flex-1 + overflow-y-auto so a long client
          catalog scrolls inside the sidebar rather than pushing
          Reminders/Archive/Trash/Logout off-screen.
          Order is server-authoritative now: lib/inbox/lists.ts sorts
          every list by max(sent_at) of inbound messages on that
          client's threads (view `client_inbox_activity`). The realtime
          refresher fires router.refresh() on every `messages` INSERT,
          so a fresh reply bubbles its client to the top within ~250ms
          without any client-side reordering. Search just filters the
          server-sorted list in place. */}
      {/* Client-health summary. Counts come straight from the authoritative
          feed. Rendered only once the status fetch succeeds — absent
          otherwise, so nothing shifts if the feed is unavailable. */}
      {clientStatus?.counts ? (
        <div className="px-4 pt-0.5 pb-2 shrink-0 flex items-center gap-4 text-[11px] font-medium">
          {(["active", "paused", "churned"] as const).map((k) => (
            <span
              key={k}
              className="inline-flex items-center gap-1.5"
              title={STATUS_LABEL[k]}
            >
              <span className={cn("size-2 rounded-full", STATUS_DOT[k])} />
              <span className="tabular-nums text-muted-foreground">
                {clientStatus.counts![k]}
              </span>
            </span>
          ))}
        </div>
      ) : null}

      <nav className="px-2 flex flex-col gap-px overflow-y-auto flex-1 min-h-0">
        {(listSearch.trim().length === 0
          ? lists
          : lists.filter((l) =>
              l.name.toLowerCase().includes(listSearch.trim().toLowerCase()),
            )
        ).map((list) => {
          const active = activeListId === list.id;
          return (
            <ListRow
              key={list.id}
              list={list}
              active={active}
              unseen={listCounts[list.id] ?? 0}
              status={clientStatus?.byName[normalizeClientName(list.name)]}
              onEdit={() => setEditingList(list)}
              onDelete={() => setDeletingList(list)}
            />
          );
        })}

        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="flex items-center gap-2.5 px-2 py-1.5 rounded-md text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors text-left"
        >
          <Plus className="size-4 shrink-0" strokeWidth={2} />
          <span>Create list item</span>
        </button>
      </nav>

      <nav className="px-2 pb-2 flex flex-col gap-px">
        {folderLinks.map((item) => {
          const Icon = item.icon;
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 px-2 py-1.5 rounded-md text-[13.5px] text-foreground/80 hover:bg-accent hover:text-foreground transition-colors",
                active && "bg-accent text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={2} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t">
        <WorkspaceBadge session={session} />
        <LogoutButton />
      </div>

      <CreateListDialog open={createOpen} onOpenChange={setCreateOpen} />
      <CreateListDialog
        open={editingList !== null}
        onOpenChange={(v) => !v && setEditingList(null)}
        editing={editingList}
        onUpdated={() => {
          setEditingList(null);
          router.refresh();
        }}
      />
      <DeleteListDialog
        list={deletingList}
        onClose={() => setDeletingList(null)}
        onDeleted={() => {
          setDeletingList(null);
          router.refresh();
        }}
      />

      {/* Resize handle — sits flush against the right border. A 6px-wide hit
          target so it's easy to grab without being visually heavy. */}
      <div
        onPointerDown={onHandlePointerDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        className={cn(
          "absolute top-0 right-0 h-full w-1.5 -mr-px cursor-col-resize select-none z-10",
          "hover:bg-accent/60 transition-colors",
          resizing && "bg-accent",
        )}
      />
    </aside>
  );
}

function WorkspaceBadge({ session }: { session: SessionContext }) {
  return (
    <div className="w-full flex items-center gap-2 px-3 py-2 text-[13px]">
      <Building2 className="size-4 text-muted-foreground" strokeWidth={2} />
      <span className="truncate flex-1 text-left font-medium">
        {session.activeWorkspace.name}
      </span>
    </div>
  );
}

// One sidebar row for a sales-list (per-client live list). Renders the
// emoji + name as a Link; a hover-revealed kebab menu offers Rename
// (which also covers emoji edit) and Delete. Parent owns the modal state
// so multiple rows can't open conflicting dialogs.
function ListRow({
  list,
  active,
  unseen,
  status,
  onEdit,
  onDelete,
}: {
  list: ListRow;
  active: boolean;
  unseen: number;
  // Client health from the external feed. undefined = not matched / feed
  // unavailable → fall back to the list's own icon.
  status?: ClientStatus;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative flex items-center rounded-md hover:bg-accent transition-colors",
        active && "bg-accent",
      )}
    >
      <Link
        href={`/inbox/all-email?list=${list.id}`}
        className={cn(
          "flex-1 min-w-0 flex items-center gap-2.5 px-2 py-1.5 text-[13.5px] font-medium text-foreground/80 hover:text-foreground transition-colors",
          active && "text-foreground",
        )}
      >
        {/* Fixed-width indicator slot so client names align whether the row
            shows a status dot or falls back to its folder icon. */}
        <span className="w-4 shrink-0 flex items-center justify-center">
          {status ? (
            <span
              className={cn("size-2.5 rounded-full", STATUS_DOT[status])}
              title={STATUS_LABEL[status]}
            />
          ) : (
            <span className="text-base leading-none">{list.icon ?? "📁"}</span>
          )}
        </span>
        <span className="truncate">{list.name}</span>
        {unseen > 0 ? (
          <span className="ml-auto shrink-0 inline-flex items-center rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white tabular-nums">
            {unseen > 99 ? "99+" : unseen} new
          </span>
        ) : null}
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="List actions"
              className={cn(
                "shrink-0 size-6 mr-1 rounded flex items-center justify-center text-muted-foreground/60 hover:bg-background hover:text-foreground transition-opacity",
                active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          }
        />
        <DropdownMenuContent align="start" className="text-sm">
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault();
              onEdit();
            }}
          >
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault();
              onDelete();
            }}
            className="text-red-600 focus:text-red-600"
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// DELETE /api/lists/{id}. Hard delete — thread_list_items cascades via
// the FK; threads keep their client_id intact (the list was just a view).
function DeleteListDialog({
  list,
  onClose,
  onDeleted,
}: {
  list: ListRow | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [pending, startTransition] = useTransition();
  if (!list) return null;
  async function confirmDelete() {
    if (!list) return;
    const res = await fetch(`/api/lists/${list.id}`, { method: "DELETE" });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      toast.error(json.error ?? "Delete failed");
      return;
    }
    startTransition(() => onDeleted());
  }
  return (
    <Dialog open={true} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete &quot;{list.name}&quot;?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          The list will be removed from the sidebar. Threads themselves stay
          intact — you can recreate the list later if you change your mind.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={confirmDelete}
            disabled={pending}
            className="bg-red-600 hover:bg-red-700 text-white"
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LogoutButton() {
  async function onLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = "/login";
  }
  return (
    <button
      type="button"
      onClick={onLogout}
      className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-foreground/80 hover:bg-accent hover:text-foreground transition-colors"
    >
      <LogOut className="size-4 text-muted-foreground" strokeWidth={2} />
      <span>Logout</span>
    </button>
  );
}
