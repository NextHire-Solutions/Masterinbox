"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronUp,
  ChevronDown,
  Check,
  Copy,
  Mail as MailIcon,
  Phone,
  MapPin,
  Building2,
  Globe,
  Megaphone,
  Users,
  Inbox,
} from "lucide-react";
import { LabelChip } from "@/components/inbox/label-chip";
import { SubsequenceSection } from "@/components/inbox/subsequence-status";
import { FollowupCampaignPicker } from "@/components/inbox/followup-campaign-picker";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { ThreadDetail } from "@/lib/inbox/thread-detail";

type TabId = "details" | "attachments" | "notes";

// The panel is user-resizable; the width is persisted so it survives
// reloads and thread switches.
const WIDTH_KEY = "inbox-prospect-panel-width";
const DEFAULT_WIDTH = 360;
const MIN_WIDTH = 300;
const MAX_WIDTH = 580;

// normalise a custom-field key for case/punctuation-insensitive matching.
const nkey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]+/g, "");

export function ProspectPanel({ detail }: { detail: ThreadDetail }) {
  const { lead, labels } = detail;
  const [tab, setTab] = useState<TabId>("details");

  // ---- resize ----
  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(WIDTH_KEY);
      if (!saved) return;
      const n = Number(saved);
      if (Number.isFinite(n) && n >= MIN_WIDTH && n <= MAX_WIDTH) setWidth(n);
    } catch {
      // private-mode Safari can throw — ignore.
    }
  }, []);

  useEffect(() => {
    if (!resizing) return;
    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      // Handle is on the LEFT edge — dragging left widens the panel.
      const next = Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, d.startWidth - (e.clientX - d.startX)),
      );
      setWidth(next);
    }
    function onUp() {
      setResizing(false);
      dragRef.current = null;
      try {
        window.localStorage.setItem(WIDTH_KEY, String(widthRef.current));
      } catch {
        // ignore
      }
    }
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
    e.preventDefault();
  }

  const initials = (lead.full_name || lead.email || "?")
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Copy failed");
    }
  }

  return (
    <aside
      style={{ width: `${width}px` }}
      className="relative shrink-0 border-l bg-background overflow-y-auto"
    >
      {/* Resize handle — left edge. */}
      <div
        onPointerDown={onHandlePointerDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        className={cn(
          "absolute top-0 left-0 z-10 h-full w-1.5 -ml-px cursor-col-resize select-none",
          "transition-colors hover:bg-accent/60",
          resizing && "bg-accent",
        )}
      />

      <div className="h-10 border-b flex items-center px-4">
        <span className="text-sm font-medium">Prospect details</span>
      </div>

      <div className="p-4 space-y-4">
        <div className="flex items-center gap-3">
          <div className="size-9 rounded-md bg-zinc-100 text-zinc-700 flex items-center justify-center text-sm font-semibold shrink-0">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold truncate flex items-center gap-1.5">
              {lead.full_name ?? lead.email ?? "Unknown"}
            </div>
            {lead.email ? (
              <div className="text-xs text-muted-foreground truncate flex items-center gap-1.5">
                <span className="truncate">{lead.email}</span>
                <button
                  type="button"
                  onClick={() => copy(lead.email!)}
                  className="hover:text-foreground shrink-0"
                  aria-label="Copy email"
                >
                  <Copy className="size-3" />
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {labels.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {labels.map((l) => (
              <LabelChip key={l.id} name={l.name} color={l.color} />
            ))}
          </div>
        ) : null}

        <div className="flex items-center gap-4 border-b">
          {(["details", "attachments", "notes"] as TabId[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "text-sm pb-2 capitalize transition-colors",
                tab === t
                  ? "text-foreground font-medium border-b-2 border-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === "details" ? <DetailsTab detail={detail} onCopy={copy} /> : null}
        {tab === "attachments" ? (
          <div className="text-sm text-muted-foreground py-2">No attachments yet.</div>
        ) : null}
        {tab === "notes" ? (
          <div className="text-sm text-muted-foreground py-2">No notes yet.</div>
        ) : null}
      </div>
    </aside>
  );
}

/* ------------------------------ details ------------------------------ */

function DetailsTab({
  detail,
  onCopy,
}: {
  detail: ThreadDetail;
  onCopy: (v: string) => void;
}) {
  const { lead } = detail;

  // Index custom_fields once, normalised, dropping empties.
  const entries = Object.entries(lead.custom_fields ?? {})
    .filter(([, v]) => v != null && String(v).trim() !== "")
    .map(([k, v]) => ({ key: k, nk: nkey(k), value: String(v).trim() }));

  const consumed = new Set<string>();
  const find = (...cands: string[]): string | null => {
    for (const c of cands) {
      const e = entries.find((x) => x.nk === c);
      if (e) {
        consumed.add(e.nk);
        return e.value;
      }
    }
    return null;
  };

  // ---- Card 1: general agent info ----
  const phone = find("phone", "phonenumber", "mobile", "cell", "mobilephone", "cellphone");
  // Multi-phone + preferred: a staff-maintained list lives on custom_fields.phones,
  // with the chosen one in custom_fields.preferred_phone. Fall back to the single
  // derived phone above when no list has been created yet.
  const storedPhones = Array.isArray(lead.custom_fields?.phones)
    ? (lead.custom_fields.phones as unknown[])
        .filter((x): x is string => typeof x === "string" && x.trim() !== "")
        .map((x) => x.trim())
    : [];
  const preferredPhone =
    typeof lead.custom_fields?.preferred_phone === "string" &&
    (lead.custom_fields.preferred_phone as string).trim() !== ""
      ? (lead.custom_fields.preferred_phone as string).trim()
      : null;
  const phoneList = storedPhones.length ? storedPhones : phone ? [phone] : [];

  // Agent emails: the lead's own email plus any staff-added emails
  // (custom_fields.emails). De-duplicated case-insensitively.
  const storedEmails = Array.isArray(lead.custom_fields?.emails)
    ? (lead.custom_fields.emails as unknown[])
        .filter((x): x is string => typeof x === "string" && x.trim() !== "")
        .map((x) => x.trim())
    : [];
  const emailSeen = new Set<string>();
  const emailList: string[] = [];
  for (const e of [lead.email, ...storedEmails]) {
    const t = (e ?? "").trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (emailSeen.has(k)) continue;
    emailSeen.add(k);
    emailList.push(t);
  }
  const preferredEmail =
    typeof lead.custom_fields?.preferred_email === "string" &&
    (lead.custom_fields.preferred_email as string).trim() !== ""
      ? (lead.custom_fields.preferred_email as string).trim()
      : null;
  const website = find(
    "website",
    "websiteurl",
    "homepage",
    "companysite",
    "companywebsite",
    "url",
    "companyurl",
  );
  let location = find("location", "city");
  const state = find("state", "region");
  if (location && state && !location.toLowerCase().includes(state.toLowerCase())) {
    location = `${location}, ${state}`;
  } else if (!location && state) {
    location = state;
  }
  const company = lead.company ?? find("company", "companyname", "organization");
  const title = lead.title ?? find("title", "jobtitle", "role", "position");

  // Mark identity keys consumed so they don't repeat in Card 2.
  for (const c of ["firstname", "lastname", "name", "fullname", "email", "companyname", "jobtitle"]) {
    if (entries.some((e) => e.nk === c)) consumed.add(c);
  }

  // ---- Card 2: everything else Instantly holds ----
  const card2: Array<{ label: string; value: string }> = [];
  if (title) card2.push({ label: "Title", value: title });
  if (lead.linkedin_url) card2.push({ label: "LinkedIn", value: lead.linkedin_url });
  for (const e of entries) {
    if (consumed.has(e.nk)) continue;
    card2.push({ label: prettifyKey(e.key), value: e.value });
  }

  const sourceLabel =
    detail.source_provider === "instantly"
      ? "Instantly"
      : detail.source_provider === "emailbison"
        ? "EmailBison"
        : null;

  return (
    <div className="space-y-3">
      {/* ---------------- Card 1 — Agent ---------------- */}
      <Card title="Agent" defaultOpen>
        <div className="space-y-px">
          <Field icon={Users} label="Name" value={lead.full_name} onCopy={onCopy} />
          <AgentEmails
            threadId={detail.id}
            emails={emailList}
            preferred={preferredEmail ?? emailList[0] ?? null}
            onCopy={onCopy}
          />
          <AgentPhones
            threadId={detail.id}
            phones={phoneList}
            preferred={preferredPhone ?? phoneList[0] ?? null}
            onCopy={onCopy}
          />
          <Field icon={Building2} label="Company" value={company} onCopy={onCopy} />
          <Field icon={MapPin} label="Location" value={location} onCopy={onCopy} />
          <Field icon={Globe} label="Website" value={website} onCopy={onCopy} />
          <Field icon={Megaphone} label="Campaign" value={detail.campaign_name} onCopy={onCopy} />
          <Field icon={Users} label="Client" value={detail.client_name} onCopy={onCopy} />
          <Field icon={Inbox} label="Source" value={sourceLabel} />
        </div>

        {/* Provider-specific sequencing action. */}
        {detail.source_provider === "instantly" && detail.campaign_name ? (
          <div className="mt-3">
            <SubsequenceSection threadId={detail.id} />
          </div>
        ) : null}
        {detail.source_provider === "emailbison" ? (
          <div className="mt-3">
            <FollowupCampaignPicker threadId={detail.id} />
          </div>
        ) : null}
      </Card>

      {/* ---------------- Card 2 — Lead details ---------------- */}
      {card2.length > 0 ? (
        <Card title="Lead details" defaultOpen>
          <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-3 gap-y-2 text-sm">
            {card2.map((row) => (
              <FieldPair
                key={`${row.label}-${row.value}`}
                label={row.label}
                value={row.value}
                onCopy={onCopy}
              />
            ))}
          </dl>
        </Card>
      ) : null}
    </div>
  );
}

// One labelled row in Card 1 — icon, label, value. Value wraps (never
// truncated) so long campaign names stay fully readable; URLs linkify.
// Agent email(s), with a "+ Add email" action and a "mark as preferred" checkbox
// (shown when there are 2+ emails), mirroring AgentPhones.
//
// Adding appends the email to the agent's provided values in the external agents
// DB (never overwrites Courted; max_matches:1) and stores it on the lead.
// Marking preferred sets the email the client portal shows at introduction
// (leads.custom_fields.preferred_email + existing pipeline snapshots); it does
// NOT re-push to the agents DB. Fail-open: any error is just a toast.
function AgentEmails({
  threadId,
  emails,
  preferred,
  onCopy,
}: {
  threadId: string;
  emails: string[];
  preferred: string | null;
  onCopy?: (v: string) => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const multi = emails.length >= 2;

  async function addEmail() {
    const email = value.trim();
    if (!email || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/threads/${threadId}/agent-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        matched?: number;
        error?: string;
      };
      if (res.ok && j.ok) {
        toast.success(
          (j.matched ?? 0) > 0
            ? "Email added, and saved to the agent record."
            : "Email added.",
        );
        setValue("");
        setOpen(false);
        startTransition(() => router.refresh());
      } else {
        toast.error(j.error ?? "Couldn't add the email.");
      }
    } catch {
      toast.error("Couldn't reach the server.");
    } finally {
      setSaving(false);
    }
  }

  async function markPreferred(email: string) {
    if (busyEmail !== null || sameEmail(email, preferred)) return;
    setBusyEmail(email);
    try {
      const res = await fetch(`/api/threads/${threadId}/agent-email`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        entriesUpdated?: number;
        error?: string;
      };
      if (res.ok && j.ok) {
        const n = j.entriesUpdated ?? 0;
        toast.success(
          n > 0
            ? `Preferred email set. Updated ${n} client portal${n === 1 ? "" : "s"}.`
            : "Preferred email set.",
        );
        startTransition(() => router.refresh());
      } else {
        toast.error(j.error ?? "Couldn't set the preferred email.");
      }
    } catch {
      toast.error("Couldn't reach the server.");
    } finally {
      setBusyEmail(null);
    }
  }

  return (
    <div>
      {emails.length > 0 ? (
        <div className="group flex items-start gap-2.5 py-1.5">
          <MailIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Email
            </div>
            {multi ? (
              <div className="mt-1 space-y-1">
                {emails.map((e) => {
                  const isPref = sameEmail(e, preferred);
                  return (
                    <div key={e} className="flex items-center gap-2">
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={isPref}
                        disabled={busyEmail !== null}
                        onClick={() => markPreferred(e)}
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
                          isPref
                            ? "border-foreground bg-foreground text-background"
                            : "border-muted-foreground/40 hover:border-foreground",
                          busyEmail !== null && "opacity-60",
                        )}
                        aria-label={isPref ? "Preferred email" : "Mark as preferred"}
                        title={isPref ? "Preferred email" : "Mark as preferred"}
                      >
                        {isPref ? <Check className="size-3" /> : null}
                      </button>
                      <span className="min-w-0 flex-1 break-words text-sm leading-snug">
                        {e}
                      </span>
                      {isPref ? (
                        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          Preferred
                        </span>
                      ) : null}
                      {onCopy ? (
                        <button
                          type="button"
                          onClick={() => onCopy(e)}
                          className="shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground hover:!text-foreground"
                          aria-label="Copy email"
                        >
                          <Copy className="size-3" />
                        </button>
                      ) : null}
                    </div>
                  );
                })}
                <div className="pt-0.5 text-[11px] text-muted-foreground">
                  The preferred email is shown in the client portal at introduction.
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-1.5">
                <span className="min-w-0 flex-1 break-words text-sm leading-snug">
                  {emails[0]}
                </span>
                {onCopy ? (
                  <button
                    type="button"
                    onClick={() => onCopy(emails[0])}
                    className="mt-0.5 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground hover:!text-foreground"
                    aria-label="Copy email"
                  >
                    <Copy className="size-3" />
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* Add-email affordance, aligned under the field value column. */}
      <div className="pl-6">
        {open ? (
          <div className="flex items-center gap-1.5 py-1.5">
            <input
              autoFocus
              type="email"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addEmail();
                if (e.key === "Escape") {
                  setOpen(false);
                  setValue("");
                }
              }}
              placeholder="name@example.com"
              className="h-7 flex-1 rounded-md border bg-background px-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              type="button"
              onClick={addEmail}
              disabled={saving}
              className="h-7 rounded-md bg-foreground px-2.5 text-[12px] font-medium text-background disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setValue("");
              }}
              className="h-7 px-1.5 text-[12px] text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="py-1 text-[12px] font-medium text-muted-foreground hover:text-foreground"
          >
            + Add email
          </button>
        )}
      </div>
    </div>
  );
}

// Compare two phone strings by digits, ignoring formatting.
function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = a.replace(/\D/g, "");
  const nb = b.replace(/\D/g, "");
  return na && nb ? na === nb : a.trim() === b.trim();
}

// Compare two emails case-insensitively.
function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// Agent phone(s), with a "mark as preferred" control.
//
//  - 0 numbers: just a "+ Add phone" affordance (matches the old read-only card).
//  - 1 number:  the number shown as a normal field row + "+ Add phone".
//  - 2+ numbers: each number gets a checkbox; the checked one is PREFERRED — the
//    number the client portal shows once the lead is marked as Introduction.
//
// Adding POSTs (external agents DB + stored on the lead); marking preferred
// PATCHes (lead's preferred_phone + already-introduced portal entries + external
// agents DB). Both refresh the panel from the server so the list re-renders.
// Fail-open: any error is just a toast; the inbox never blocks.
function AgentPhones({
  threadId,
  phones,
  preferred,
  onCopy,
}: {
  threadId: string;
  phones: string[];
  preferred: string | null;
  onCopy?: (v: string) => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyPhone, setBusyPhone] = useState<string | null>(null);
  const multi = phones.length >= 2;

  async function addPhone() {
    const phone = value.trim();
    if (!phone || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/threads/${threadId}/agent-phone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        matched?: number;
        error?: string;
      };
      if (res.ok && j.ok) {
        toast.success(
          (j.matched ?? 0) > 0
            ? "Phone added, and saved to the agent record."
            : "Phone added.",
        );
        setValue("");
        setOpen(false);
        startTransition(() => router.refresh());
      } else {
        toast.error(j.error ?? "Couldn't add the phone number.");
      }
    } catch {
      toast.error("Couldn't reach the server.");
    } finally {
      setSaving(false);
    }
  }

  async function markPreferred(phone: string) {
    if (busyPhone !== null || samePhone(phone, preferred)) return;
    setBusyPhone(phone);
    try {
      const res = await fetch(`/api/threads/${threadId}/agent-phone`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        entriesUpdated?: number;
        error?: string;
      };
      if (res.ok && j.ok) {
        const n = j.entriesUpdated ?? 0;
        toast.success(
          n > 0
            ? `Preferred number set. Updated ${n} client portal${n === 1 ? "" : "s"}.`
            : "Preferred number set.",
        );
        startTransition(() => router.refresh());
      } else {
        toast.error(j.error ?? "Couldn't set the preferred number.");
      }
    } catch {
      toast.error("Couldn't reach the server.");
    } finally {
      setBusyPhone(null);
    }
  }

  return (
    <div>
      {phones.length > 0 ? (
        <div className="group flex items-start gap-2.5 py-1.5">
          <Phone className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Phone
            </div>
            {multi ? (
              <div className="mt-1 space-y-1">
                {phones.map((p) => {
                  const isPref = samePhone(p, preferred);
                  return (
                    <div key={p} className="flex items-center gap-2">
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={isPref}
                        disabled={busyPhone !== null}
                        onClick={() => markPreferred(p)}
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
                          isPref
                            ? "border-foreground bg-foreground text-background"
                            : "border-muted-foreground/40 hover:border-foreground",
                          busyPhone !== null && "opacity-60",
                        )}
                        aria-label={isPref ? "Preferred number" : "Mark as preferred"}
                        title={isPref ? "Preferred number" : "Mark as preferred"}
                      >
                        {isPref ? <Check className="size-3" /> : null}
                      </button>
                      <span className="min-w-0 flex-1 break-words text-sm leading-snug">
                        {p}
                      </span>
                      {isPref ? (
                        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          Preferred
                        </span>
                      ) : null}
                      {onCopy ? (
                        <button
                          type="button"
                          onClick={() => onCopy(p)}
                          className="shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground hover:!text-foreground"
                          aria-label="Copy phone"
                        >
                          <Copy className="size-3" />
                        </button>
                      ) : null}
                    </div>
                  );
                })}
                <div className="pt-0.5 text-[11px] text-muted-foreground">
                  The preferred number is shown in the client portal at introduction.
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-1.5">
                <span className="min-w-0 flex-1 break-words text-sm leading-snug">
                  {phones[0]}
                </span>
                {onCopy ? (
                  <button
                    type="button"
                    onClick={() => onCopy(phones[0])}
                    className="mt-0.5 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground hover:!text-foreground"
                    aria-label="Copy phone"
                  >
                    <Copy className="size-3" />
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* Add-phone affordance, aligned under the field value column. */}
      <div className="pl-6">
        {open ? (
          <div className="flex items-center gap-1.5 py-1.5">
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addPhone();
                if (e.key === "Escape") {
                  setOpen(false);
                  setValue("");
                }
              }}
              placeholder="+1 (305) 555-0000"
              className="h-7 flex-1 rounded-md border bg-background px-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              type="button"
              onClick={addPhone}
              disabled={saving}
              className="h-7 rounded-md bg-foreground px-2.5 text-[12px] font-medium text-background disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setValue("");
              }}
              className="h-7 px-1.5 text-[12px] text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="py-1 text-[12px] font-medium text-muted-foreground hover:text-foreground"
          >
            + Add phone
          </button>
        )}
      </div>
    </div>
  );
}

function Field({
  icon: Icon,
  label,
  value,
  onCopy,
}: {
  icon: typeof MailIcon;
  label: string;
  value: string | null | undefined;
  onCopy?: (v: string) => void;
}) {
  if (!value) return null;
  return (
    <div className="group flex items-start gap-2.5 py-1.5">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div className="text-sm break-words leading-snug">
          <LinkValue value={value} />
        </div>
      </div>
      {onCopy ? (
        <button
          type="button"
          onClick={() => onCopy(value)}
          className="mt-0.5 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground hover:!text-foreground"
          aria-label={`Copy ${label}`}
        >
          <Copy className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

// Compact key/value row for Card 2. The copy button sits inline with
// the value and only reveals itself on group-hover so the layout stays
// quiet at rest. `group/row` scopes the hover to this <dd>, not the
// surrounding card.
function FieldPair({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy?: (v: string) => void;
}) {
  return (
    <>
      <dt className="text-xs text-muted-foreground break-words pt-0.5">{label}</dt>
      <dd className="group/row flex items-start gap-2 break-words leading-snug">
        <div className="min-w-0 flex-1">
          <LinkValue value={value} />
        </div>
        {onCopy ? (
          <button
            type="button"
            onClick={() => onCopy(value)}
            className="mt-0.5 shrink-0 text-muted-foreground/0 transition-colors group-hover/row:text-muted-foreground hover:!text-foreground"
            aria-label={`Copy ${label}`}
          >
            <Copy className="size-3" />
          </button>
        ) : null}
      </dd>
    </>
  );
}

// Renders a URL value as a link, anything else as plain wrapped text.
function LinkValue({ value }: { value: string }) {
  const v = value.trim();
  if (/^https?:\/\/\S+$/i.test(v)) {
    return (
      <a
        href={v}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 hover:underline break-all"
      >
        {v}
      </a>
    );
  }
  return <>{value}</>;
}

function prettifyKey(key: string): string {
  return key
    .replace(/[_\-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

// Collapsible titled card.
function Card({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 text-sm font-semibold hover:bg-accent/40 transition-colors"
      >
        {title}
        {open ? (
          <ChevronUp className="size-3.5 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-3.5 text-muted-foreground" />
        )}
      </button>
      {open ? <div className="px-3 pb-3 pt-0.5">{children}</div> : null}
    </div>
  );
}
