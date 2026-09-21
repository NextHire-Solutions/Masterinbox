"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Loader2,
  Send,
  X,
  Paperclip,
  Image as ImageIcon,
  Sparkles,
  UserPlus,
  Mail,
  File as FileIcon,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  missingVariables,
  substituteVariables,
  type SubstitutionContext,
} from "@/lib/inbox/template-variables";
import { mergeAlwaysCcString } from "@/lib/inbox/auto-cc";
import { introWasSent } from "@/lib/inbox/intro-send-guard";
import {
  ComposerBodyEditor,
  type ComposerBodyHandle,
} from "@/components/inbox/composer-body-editor";

const PER_FILE_MAX = 25 * 1024 * 1024; // 25 MB
const COMBINED_MAX = 50 * 1024 * 1024; // 50 MB

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

interface QuotedMessage {
  sender: string | null;
  sent_at: string | null;
  body_text: string | null;
  body_html: string | null;
}

interface DraftSeed {
  id: string;
  agent_name: string | null;
  generated_body: string | null;
}

// Auto-saved user draft, loaded from the composer_drafts table via
// the thread-detail loader. When present, takes precedence over the
// AI draft for initial state — represents what the user was last
// typing when they left the thread.
interface ComposerDraftSeed {
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  bcc_addresses: string | null;
  selected_channel_id: string | null;
  add_signature: boolean;
  updated_at: string;
}

// Wire shape posted to the composer-draft route. Matches the table
// column set minus the server-controlled fields (workspace_id,
// thread_id, updated_at).
interface DraftPayload {
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  bcc_addresses: string | null;
  selected_channel_id: string | null;
  add_signature: boolean;
}

// Stable serialisation of a payload used to skip duplicate saves.
// JSON.stringify is fine because every value is a string|null|boolean.
function payloadKey(p: DraftPayload): string {
  return JSON.stringify(p);
}

// Project a ComposerDraftSeed onto the same key shape so we can
// initialise lastSavedKeyRef to "what's already on the server" —
// otherwise the first render would treat the seeded fields as a
// change and trigger a spurious save.
function composerDraftKey(d: ComposerDraftSeed): string {
  return payloadKey({
    subject: d.subject,
    body_html: d.body_html,
    body_text: d.body_text,
    to_addresses: d.to_addresses,
    cc_addresses: d.cc_addresses,
    bcc_addresses: d.bcc_addresses,
    selected_channel_id: d.selected_channel_id,
    add_signature: d.add_signature,
  });
}

export function Composer({
  threadId,
  subject,
  toEmail,
  toName,
  fromEmail,
  fromName,
  leadCompany = null,
  leadTitle = null,
  leadPhone = null,
  channels = [],
  quoted,
  draft,
  composerDraft = null,
  initialBody,
  forwardedBlock = null,
  mode = "reply",
  signatureHtml = null,
  sourceProvider = null,
  subjectLocked = false,
  ccInitial = "",
  bccInitial = "",
  sourceMessageId = null,
  onClose,
}: {
  threadId: string;
  subject: string;
  toEmail: string;
  toName?: string | null;
  fromEmail?: string | null;
  fromName?: string | null;
  // Optional lead enrichment for template-variable substitution. When
  // a template body uses {{lead.company}}, {{lead.title}}, or
  // {{lead.phone_number}}, these values fill the placeholder; missing
  // values leave the placeholder in the inserted body so the user
  // notices and can fix manually.
  leadCompany?: string | null;
  leadTitle?: string | null;
  leadPhone?: string | null;
  // All connected sender mailboxes for this workspace. Drives the From
  // dropdown — user can override which mailbox the message is sent
  // from (defaults to the thread's pinned sender).
  channels?: ChannelOption[];
  quoted?: QuotedMessage | null;
  draft?: DraftSeed | null;
  // Auto-saved user draft from the composer_drafts table. When
  // present, takes precedence over `draft` (AI suggestion) for
  // initial state — the operator's typed text is the truth they
  // most recently expressed.
  composerDraft?: ComposerDraftSeed | null;
  // Provider this thread came from. Drives provider-specific UX: Instantly
  // does not support sending attachments, so we hide the Attach buttons for
  // Instantly threads. EmailBison keeps them.
  sourceProvider?: "emailbison" | "instantly" | null;
  // When true, the Subject field is rendered read-only — used on Reply so
  // the user can't accidentally retype the subject and break recipient-
  // side threading (Gmail/Outlook use subject + In-Reply-To to thread).
  // Forward mode leaves this off so the user can fully edit.
  subjectLocked?: boolean;
  // Comma-separated CC addresses to pre-fill. Caller (thread-view) builds
  // this from the source message's sender + ccs (Reply) or every thread
  // participant (Reply all). When non-empty, the CC row auto-opens so the
  // user can see who's getting looped in before sending.
  ccInitial?: string;
  // Comma-separated BCC addresses to pre-fill. Caller (thread-view)
  // populates this with the source message's BCC (Reply) or every
  // thread participant's BCCs (Reply all). Non-empty value auto-opens
  // the BCC row so the user sees who's getting looped in.
  bccInitial?: string;
  // messages.id of the message the user clicked Reply on (per-message
  // icon). Sent to the /reply API so it uses THAT message's provider id
  // as the reply target — required for recipient-side threading when
  // replying to an older message. Null = bottom Reply button → API falls
  // back to the latest inbound.
  sourceMessageId?: string | null;
  // Pre-fills the body — used by Forward to seed the quoted block before
  // the user adds their own note above it. Takes priority over draft.
  initialBody?: string;
  // The raw forwarded-message block (the "---------- Forwarded message …"
  // quote of the source). When in forward mode this is kept separately
  // from `initialBody` so that if the user clears the body before
  // sending, we can guarantee the original message still rides along.
  forwardedBlock?: string | null;
  // Controls the header label and a few minor UX bits.
  mode?: "reply" | "forward";
  // HTML signature from EmailBison for our sender account. When set + the
  // "Add signature" checkbox is on, we append this to the outgoing body.
  signatureHtml?: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  // Initial state precedence (highest first):
  //   1. composerDraft  — what the operator last typed and left behind
  //   2. initialBody    — Forward-mode quoted seed
  //   3. draft          — AI-suggested body (`pending_draft`)
  //   4. empty
  //
  // Forward mode always uses (2); reply mode chooses between (1)/(3).
  // Body is rich-text (HTML). bodyText is the plain-text projection
  // TipTap gives us — used for empty-body checks and the forward-marker
  // safety net (which scans for the "----- Forwarded message -----"
  // string regardless of formatting).
  const initialPlain = initialBody ?? draft?.generated_body ?? "";
  const initialBodyHtmlFromDraft = composerDraft?.body_html ?? null;
  const initialBodyTextFromDraft = composerDraft?.body_text ?? null;
  const editorRef = useRef<ComposerBodyHandle | null>(null);
  const [bodyHtml, setBodyHtml] = useState<string>(() => {
    if (initialBodyHtmlFromDraft) return initialBodyHtmlFromDraft;
    return initialPlain ? plainTextToHtml(initialPlain) : "";
  });
  const [bodyText, setBodyText] = useState<string>(() => {
    if (initialBodyTextFromDraft) return initialBodyTextFromDraft;
    return initialPlain;
  });
  // `usingDraft` only refers to the AI suggestion banner. A user
  // draft is by definition the operator's own work — never wrapped
  // in the "Draft by <agent>" amber chrome.
  const [usingDraft, setUsingDraft] = useState(
    !composerDraft && !initialBody && Boolean(draft?.generated_body),
  );
  const [composerSubject, setComposerSubject] = useState(
    composerDraft?.subject ?? subject ?? "",
  );
  const [to, setTo] = useState(composerDraft?.to_addresses ?? toEmail);
  // Pre-fill the workspace auto-CC so operators see who's being
  // looped in by default. As of 2026-06-23 the server no longer
  // re-adds this address — if the operator deliberately removes it
  // before sending (sensitive client, internal-note reply), that
  // intent reaches the provider verbatim. The composer is the only
  // canonical source.
  //
  // When a saved composer_draft is present, restore the CC field
  // verbatim — that includes the case where the operator
  // previously removed Nicole. Don't re-merge the auto-CC on top
  // or we'd undo their choice.
  const [cc, setCc] = useState(() =>
    composerDraft?.cc_addresses != null
      ? composerDraft.cc_addresses
      : mergeAlwaysCcString(ccInitial, toEmail),
  );
  const [bcc, setBcc] = useState(composerDraft?.bcc_addresses ?? bccInitial);
  // Pre-select the channel whose display_name / instantly_account_id
  // matches the thread's pinned sender. Falls back to null (use the
  // thread's default) when no match — typically because the channel
  // pinned on the thread is no longer in the workspace's channel list.
  // Composer draft wins when present (the operator already picked).
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    () => {
      if (composerDraft?.selected_channel_id) {
        return composerDraft.selected_channel_id;
      }
      if (!fromEmail) return null;
      const match = channels.find(
        (c) =>
          c.display_name.toLowerCase() === fromEmail.toLowerCase() ||
          (c.instantly_account_id ?? "").toLowerCase() === fromEmail.toLowerCase(),
      );
      return match?.id ?? null;
    },
  );
  // Auto-open the CC row when we pre-filled it — otherwise the user has no
  // visual signal that anyone's being looped in. The auto-CC always fills
  // it, so this is effectively always true; left as state so future per-
  // thread variants (e.g. internal-note send) can opt out.
  const [showCc, setShowCc] = useState(true);
  const [showBcc, setShowBcc] = useState(
    bccInitial.trim().length > 0 ||
      (composerDraft?.bcc_addresses?.trim().length ?? 0) > 0,
  );
  const [addSignature, setAddSignature] = useState(
    composerDraft?.add_signature ?? false,
  );
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [generating, setGenerating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  // --- Draft auto-save -----------------------------------------------------
  //
  // Goal: every keystroke is safely persisted within ~1.5s, and a
  // genuine "I'm leaving now" exit (clicking away, closing the tab)
  // still flushes the latest snapshot.
  //
  // Save state lifecycle:
  //   • savingState: idle → saving → saved → idle (with a small
  //     "Saved <relative>" pulse)
  //   • savedAt: timestamp of the most recent successful upsert,
  //     drives the indicator copy
  //   • hasServerDraft: true when the server has a row for this
  //     thread — controls whether the Discard button shows.
  //     Initialised from props; flips true after the first save.
  type SavingState = "idle" | "saving" | "saved" | "error";
  const [savingState, setSavingState] = useState<SavingState>("idle");
  const [savedAt, setSavedAt] = useState<string | null>(
    composerDraft?.updated_at ?? null,
  );
  const [hasServerDraft, setHasServerDraft] = useState<boolean>(
    Boolean(composerDraft),
  );
  // Refs that need to survive renders without driving them:
  //   • latestPayloadRef: most recent in-memory snapshot, used by the
  //     unmount beacon so it ships whatever the user typed last
  //   • lastSavedKeyRef: serialised "what we already saved" so a
  //     debounce tick that sees no change is a no-op
  //   • sentDuringThisLifetimeRef: when the operator hits Send, the
  //     server deletes the draft row — the unmount beacon would
  //     resurrect it. This flag suppresses the beacon in that case.
  const latestPayloadRef = useRef<DraftPayload | null>(null);
  const lastSavedKeyRef = useRef<string | null>(
    composerDraft ? composerDraftKey(composerDraft) : null,
  );
  const sentDuringThisLifetimeRef = useRef<boolean>(false);

  // Debounced save effect. Trigger on any persisted-field change;
  // skip when nothing's typed yet AND nothing has ever been saved.
  // 1500ms gives the operator room to bash out a sentence without
  // hammering the API, but is short enough that flicking to another
  // thread still snapshots before the unmount-beacon runs.
  useEffect(() => {
    // Forward mode doesn't get drafted — composer is one-shot.
    if (mode === "forward") return;
    const payload: DraftPayload = {
      subject: composerSubject.trim() ? composerSubject : null,
      body_html: bodyHtml.trim() ? bodyHtml : null,
      body_text: bodyText.trim() ? bodyText : null,
      to_addresses: to.trim() ? to : null,
      cc_addresses: cc.trim() ? cc : null,
      bcc_addresses: bcc.trim() ? bcc : null,
      selected_channel_id: selectedChannelId,
      add_signature: addSignature,
    };
    latestPayloadRef.current = payload;
    const key = payloadKey(payload);

    // Nothing to save and nothing previously saved → silent no-op.
    const everythingEmpty =
      !payload.subject &&
      !payload.body_text &&
      !payload.to_addresses &&
      !payload.cc_addresses &&
      !payload.bcc_addresses;
    if (everythingEmpty && !hasServerDraft) return;
    if (key === lastSavedKeyRef.current) return;

    // Fully cleared after having content → DELETE the row.
    if (everythingEmpty && hasServerDraft) {
      const handle = setTimeout(() => {
        void deleteDraft();
      }, 1500);
      return () => clearTimeout(handle);
    }

    const handle = setTimeout(() => {
      void saveDraft(payload, key);
    }, 1500);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyHtml, bodyText, composerSubject, to, cc, bcc, selectedChannelId, addSignature, mode]);

  async function saveDraft(payload: DraftPayload, key: string) {
    setSavingState("saving");
    try {
      const res = await fetch(`/api/threads/${threadId}/composer-draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        setSavingState("error");
        return;
      }
      const json = (await res.json().catch(() => ({}))) as { saved_at?: string };
      lastSavedKeyRef.current = key;
      setHasServerDraft(true);
      setSavedAt(json.saved_at ?? new Date().toISOString());
      setSavingState("saved");
    } catch {
      setSavingState("error");
    }
  }

  async function deleteDraft() {
    setSavingState("saving");
    try {
      const res = await fetch(`/api/threads/${threadId}/composer-draft`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setSavingState("error");
        return;
      }
      lastSavedKeyRef.current = null;
      latestPayloadRef.current = null;
      setHasServerDraft(false);
      setSavedAt(null);
      setSavingState("idle");
    } catch {
      setSavingState("error");
    }
  }

  // Unmount flush — covers "operator clicked another thread" /
  // "operator closed the tab" / "operator navigated away". The
  // debounced effect's setTimeout is cleared on unmount, so without
  // this the last 1.5s of typing would be lost.
  useEffect(() => {
    return () => {
      if (sentDuringThisLifetimeRef.current) return;
      const payload = latestPayloadRef.current;
      if (!payload) return;
      const key = payloadKey(payload);
      if (key === lastSavedKeyRef.current) return;
      // sendBeacon is the right tool for "leaving the page now" —
      // the browser ships it on a best-effort basis even after the
      // tab is gone. Falls back to a regular fetch when sendBeacon
      // isn't available (server-side render won't hit this path
      // anyway, but stay defensive).
      try {
        const body = new Blob([JSON.stringify(payload)], {
          type: "application/json",
        });
        if (typeof navigator !== "undefined" && navigator.sendBeacon) {
          navigator.sendBeacon(
            `/api/threads/${threadId}/composer-draft`,
            body,
          );
        } else {
          void fetch(`/api/threads/${threadId}/composer-draft`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            keepalive: true,
          });
        }
      } catch {
        // Best-effort — don't block unmount on a failed flush.
      }
    };
  }, [threadId]);

  async function discardDraft() {
    if (!hasServerDraft && !composerSubject && !bodyText.trim()) return;
    if (!confirm("Discard this draft? This can't be undone.")) return;
    await deleteDraft();
    editorRef.current?.setContent("");
    setBodyHtml("");
    setBodyText("");
    setComposerSubject(subject || "");
    setTo(toEmail);
    setCc(mergeAlwaysCcString(ccInitial, toEmail));
    setBcc(bccInitial);
    setUsingDraft(Boolean(draft?.generated_body));
    setSavedAt(null);
    setSavingState("idle");
  }

  /*
   * The Introduce button's readiness, asked for once when the composer opens.
   *
   * Up front rather than on click, so the button can say WHY it is unavailable
   * instead of looking broken when pressed. One indexed lookup per composer
   * open, and only in reply mode: an introduction is a reply, never a forward.
   */
  const [introMacro, setIntroMacro] = useState<IntroMacroState>(null);
  /*
   * The text the Introduce button last inserted, held so the send can check
   * the introduction is still in the body before it tags the thread. A ref
   * rather than state: nothing renders from it, and it must not re-run the
   * editor's effects mid-draft.
   */
  const introInsertedRef = useRef<string | null>(null);
  /*
   * Values the introduction asked for and the lead does not have.
   *
   * Substitution turns an unknown value into nothing, so a lead with no
   * brokerage produced "is currently with ." and nothing said so. Held in
   * state rather than shouted once in a toast: a toast is gone in four
   * seconds and this needs to still be on screen when the operator reaches
   * for Send.
   */
  const [introGaps, setIntroGaps] = useState<string[]>([]);
  const [introducing, setIntroducing] = useState(false);

  useEffect(() => {
    if (mode !== "reply") return;
    let cancelled = false;
    void fetch(`/api/threads/${threadId}/intro-macro`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j && typeof j.available === "boolean") setIntroMacro(j as IntroMacroState);
      })
      .catch(() => {
        /* the button stays disabled with its "checking" title — no toast for
           something the user did not ask for */
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, mode]);

  function insertIntroduction() {
    if (!introMacro?.available || introducing) return;
    setIntroducing(true);
    try {
      // The same substitution the Templates picker performs, so an
      // introduction put in by this button and one chosen from the picker read
      // identically.
      const resolved = substituteVariables(introMacro.body, {
        lead: {
          name: toName ?? null,
          email: toEmail,
          phone: leadPhone,
          company: leadCompany,
          title: leadTitle,
        },
        thread: { subject: composerSubject },
        sender: { name: fromName ?? null, email: fromEmail ?? null },
      });
      /*
       * The introduction REPLACES the draft rather than joining it.
       *
       * It used to insert at the caret, like a template. But the composer
       * opens with the reply agent's draft already in it, so pressing
       * Introduce left the agent's sign-off sitting underneath the
       * introduction — two different replies in one email. An introduction is
       * the whole message, never a paragraph added to another one.
       *
       * The toast says when something was replaced, so nobody loses work
       * silently, and the editor's own undo still brings it back.
       */
      const hadDraft = bodyText.trim().length > 0;
      editorRef.current?.setContent(plainTextToHtml(resolved));
      introInsertedRef.current = resolved;

      // What the lead does not have, worked out from the macro BEFORE
      // substitution emptied the gaps.
      setIntroGaps(
        missingVariables(introMacro.body, {
          lead: {
            name: toName ?? null,
            email: toEmail,
            phone: leadPhone,
            company: leadCompany,
            title: leadTitle,
          },
          thread: { subject: composerSubject },
          sender: { name: fromName ?? null, email: fromEmail ?? null },
        }),
      );
      const introCc = introMacro.cc;
      if (introCc) {
        // Merge, never replace — what is already in Cc stays.
        setCc((cur) => mergeRecipientStrings(cur, introCc));
        setShowCc(true);
      }
      toast.success(
        [
          `Introduction to ${introMacro.clientName}`,
          hadDraft ? "replaced the draft" : "added",
          introCc ? `· ${introCc} copied in` : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    } finally {
      setIntroducing(false);
    }
  }

  /*
   * Tag the thread "Introduction" — after the send, never on the click.
   *
   * Applying that label is not bookkeeping. It messages the client, posts to
   * Slack, opens a portal pipeline entry and pushes it to Follow Up Boss. The
   * Introduce button only DRAFTS, so labelling when it is pressed would
   * announce an introduction that has not been sent, and that the operator may
   * still abandon. Labelling once the reply is actually gone tells everyone the
   * truth, and asks the operator for nothing.
   *
   * Silent when the workspace has no Introduction label, and silent when the
   * body no longer carries what the button inserted.
   */
  async function applyIntroductionLabelIfSent(sentBody: string): Promise<boolean> {
    const inserted = introInsertedRef.current;
    introInsertedRef.current = null;
    if (!inserted) return false;
    if (!introMacro?.available || !introMacro.introductionLabelId) return false;
    if (!introWasSent(inserted, sentBody)) return false;
    try {
      const res = await fetch(`/api/threads/${threadId}/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label_id: introMacro.introductionLabelId }),
      });
      if (!res.ok) throw new Error(`labels ${res.status}`);
      return true;
    } catch (err) {
      // The email has already gone. A label that would not stick is a note to
      // the operator, not a failed send.
      console.error("[composer] introduction label failed:", err);
      toast.error("Sent — but the Introduction label didn't stick. Add it from the inbox.");
      return false;
    }
  }

  async function generateAiReply() {
    if (generating) return;
    setGenerating(true);
    try {
      const res = await fetch(`/api/threads/${threadId}/generate-draft`, {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.body) {
        toast.error(json.error ?? "Could not generate a draft.");
        return;
      }
      // AI returns plain text — convert to HTML preserving paragraph
      // breaks so the rich editor can show it sensibly.
      const html = plainTextToHtml(json.body);
      editorRef.current?.setContent(html);
      setBodyHtml(html);
      setBodyText(json.body);
      setUsingDraft(true);
      toast.success(`Draft by ${json.agent_name ?? "Reply Agent"}`);
    } catch {
      toast.error("Could not generate a draft.");
    } finally {
      setGenerating(false);
    }
  }

  function addFiles(next: FileList | File[] | null) {
    if (!next) return;
    const incoming = Array.from(next);
    const merged: File[] = [...files];
    let total = files.reduce((sum, f) => sum + f.size, 0);
    for (const f of incoming) {
      if (f.size > PER_FILE_MAX) {
        toast.error(`"${f.name}" exceeds the 25MB per-file limit.`);
        continue;
      }
      if (merged.some((m) => m.name === f.name && m.size === f.size)) continue;
      if (total + f.size > COMBINED_MAX) {
        toast.error("Combined attachments exceed the 50MB limit.");
        break;
      }
      merged.push(f);
      total += f.size;
    }
    setFiles(merged);
  }

  function removeFile(name: string) {
    setFiles((cur) => cur.filter((f) => f.name !== name));
  }

  async function onSend() {
    // On replies, force the user to write something — sending an empty
    // reply is almost always a mistake. On forwards, an empty body is
    // legitimate (the original message is the payload), and we re-attach
    // the forwarded block below regardless.
    const isForward = mode === "forward";
    if (!isForward && !bodyText.trim()) {
      toast.error("Write something to reply.");
      return;
    }
    setSending(true);
    try {
      // bodyHtml is already real HTML from the rich-text editor. Forward
      // safety net: if the user cleared the editor (or deleted the
      // pre-filled quoted block), re-attach the original message so the
      // forward isn't an empty email. Marker check runs on the plain
      // text projection so formatting changes don't fool it.
      let finalHtml = bodyHtml;
      const FORWARD_MARKER = "---------- Forwarded message ----------";
      if (isForward && forwardedBlock && !bodyText.includes(FORWARD_MARKER)) {
        const quotedHtml = plainTextToHtml(forwardedBlock);
        finalHtml = finalHtml.trim().length > 0
          ? `${finalHtml}<br><br>${quotedHtml}`
          : quotedHtml;
      }
      // Append the EmailBison signature when the user opted in.
      // Signature is already HTML — don't escape it.
      if (addSignature && signatureHtml && signatureHtml.trim().length > 0) {
        finalHtml += `<br><br>${signatureHtml}`;
      }
      // Naming kept to minimise the diff with the existing send path.
      const bodyHtmlToSend = finalHtml;
      // Parse the TO field the same way CC/BCC are parsed so multiple
      // comma/semicolon-separated addresses work. Single-recipient mode
      // (the common reply case) still produces a one-element array.
      // We preserve the `toName` only when the user didn't expand TO into
      // multiple addresses — once it's a list, names aren't paired any
      // more and EmailBison just wants the addresses.
      const parsedTo = parseRecipients(to);
      const toArr = parsedTo
        ? parsedTo.length === 1 && toName
          ? [{ email_address: parsedTo[0].email_address, name: toName }]
          : parsedTo
        : undefined;
      const ccArr = parseRecipients(cc);
      const bccArr = parseRecipients(bcc);
      // True when the operator deliberately edited the Subject field
      // (vs. accepting the auto-derived "Re: <source>" pre-fill). The
      // reply route uses this to decide which EmailBison endpoint to
      // hit — /api/replies/{id}/reply silently ignores subject, while
      // /api/replies/new honours it at the cost of starting a new
      // EmailBison-side thread. Instantly's path always honours the
      // subject in-body, so this flag only affects EmailBison sends.
      const subjectChanged = (composerSubject || "") !== (subject || "");

      let res: Response;
      if (files.length > 0) {
        // Multipart path — EmailBison's attachment endpoint needs the whole
        // request as multipart/form-data with scalars + JSON-stringified
        // recipients + repeated `attachments` file fields.
        const form = new FormData();
        form.append("body", bodyHtmlToSend);
        form.append("content_type", "html");
        if (composerSubject) form.append("subject", composerSubject);
        if (subjectChanged) form.append("subject_changed", "1");
        if (toArr) form.append("to", JSON.stringify(toArr));
        if (ccArr) form.append("cc", JSON.stringify(ccArr));
        if (bccArr) form.append("bcc", JSON.stringify(bccArr));
        form.append("reply_all", "0");
        form.append("inject_previous_email_body", "1");
        if (sourceMessageId) form.append("source_message_id", sourceMessageId);
        if (selectedChannelId) form.append("sender_channel_id", selectedChannelId);
        for (const f of files) form.append("attachments", f, f.name);
        res = await fetch(`/api/threads/${threadId}/reply`, {
          method: "POST",
          body: form,
        });
      } else {
        res = await fetch(`/api/threads/${threadId}/reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            body: bodyHtmlToSend,
            content_type: "html",
            subject: composerSubject,
            subject_changed: subjectChanged,
            to: toArr,
            cc: ccArr,
            bcc: bccArr,
            source_message_id: sourceMessageId ?? undefined,
            sender_channel_id: selectedChannelId ?? undefined,
          }),
        });
      }

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = json.detail
          ? `${json.error ?? "Send failed"}: ${json.detail}`
          : json.error ?? "Send failed";
        toast.error(msg);
        console.error("[composer] send failed:", json);
        return;
      }
      // Suppress the unmount beacon — the server deletes the
      // composer_drafts row in the reply handler, and beaconing a
      // stale snapshot would just resurrect it. Also clear the
      // last-saved key so any debounced timeout fires through to a
      // no-op rather than racing the server delete.
      sentDuringThisLifetimeRef.current = true;
      lastSavedKeyRef.current = null;
      latestPayloadRef.current = null;
      const tagged = await applyIntroductionLabelIfSent(bodyText);
      toast.success(tagged ? "Introduction sent · thread tagged Introduction" : "Reply sent");
      router.refresh();
      onClose();
    } catch {
      toast.error("Send failed");
    } finally {
      setSending(false);
    }
  }

  const replyTitle = toName ?? toEmail;
  const headerLabel =
    mode === "forward"
      ? `Forward${subject ? `: ${subject}` : ""}`
      : `Reply to "${replyTitle || "..."}"`;

  return (
    // At lg+ the composer is a flex child sitting next to the messages
    // column so the prospect panel on the page's right stays visible
    // while drafting. Below lg there isn't room — fall back to the
    // original full-height fixed overlay so phones / narrow viewports
    // still work.
    <div className="fixed inset-y-0 right-0 z-30 w-[640px] max-w-[100vw] shadow-xl lg:static lg:inset-auto lg:z-auto lg:w-[480px] lg:max-w-none lg:shadow-none bg-background border-l flex flex-col shrink-0">
      {/* Header */}
      <div className="h-12 border-b flex items-center px-4 justify-between shrink-0">
        <h3 className="text-sm font-semibold truncate">{headerLabel}</h3>
        <button
          type="button"
          onClick={onClose}
          className="size-8 rounded-md flex items-center justify-center hover:bg-accent"
          aria-label="Close"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Header fields */}
      <div className="px-4 py-3 space-y-2 text-sm border-b shrink-0">
        {/* From — pre-filled with the thread's sender; click to override
            with any other connected mailbox on the same provider. */}
        <FieldRow label="From">
          <SenderPicker
            channels={channels}
            sourceProvider={sourceProvider}
            defaultEmail={fromEmail ?? null}
            defaultName={fromName ?? null}
            selectedId={selectedChannelId}
            onChange={setSelectedChannelId}
          />
        </FieldRow>

        {/* To + Cc/Bcc toggles */}
        <FieldRow
          label="To"
          right={
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <button
                type="button"
                onClick={() => setShowCc((v) => !v)}
                className="hover:text-foreground"
              >
                Cc
              </button>
              <button
                type="button"
                onClick={() => setShowBcc((v) => !v)}
                className="hover:text-foreground"
              >
                Bcc
              </button>
            </div>
          }
        >
          <Input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="email address (separate multiple with commas)"
            // Note: type="email" blocks commas via browser validation,
            // which silently breaks multi-recipient sends — keep as
            // plain text.
            type="text"
            className="flex-1 h-7 border-0 bg-transparent shadow-none px-1 focus-visible:ring-0 text-sm"
          />
        </FieldRow>

        {showCc ? (
          <FieldRow label="Cc">
            <Input
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              placeholder="email addresses (separate multiple with commas)"
              className="flex-1 h-7 border-0 bg-transparent shadow-none px-1 focus-visible:ring-0 text-sm"
            />
          </FieldRow>
        ) : null}

        {showBcc ? (
          <FieldRow label="Bcc">
            <Input
              value={bcc}
              onChange={(e) => setBcc(e.target.value)}
              placeholder="email addresses (separate multiple with commas)"
              className="flex-1 h-7 border-0 bg-transparent shadow-none px-1 focus-visible:ring-0 text-sm"
            />
          </FieldRow>
        ) : null}

        {/* Subject — pre-filled but always editable. On replies, changing
            the subject can break Gmail/Outlook threading on the
            recipient side; surfaced as a tooltip rather than locking. */}
        <FieldRow
          label="Subject"
          right={
            <button
              type="button"
              onClick={() => setComposerSubject("")}
              className="size-5 rounded-sm flex items-center justify-center text-muted-foreground hover:bg-accent"
              aria-label="Clear subject"
            >
              <X className="size-3.5" />
            </button>
          }
        >
          <Input
            value={composerSubject}
            onChange={(e) => setComposerSubject(e.target.value)}
            title={
              mode === "reply"
                ? "Changing the subject on a reply may break threading on the recipient's side"
                : undefined
            }
            className="flex-1 h-7 border-0 bg-transparent shadow-none px-1 focus-visible:ring-0 text-sm"
            placeholder="(no subject)"
          />
        </FieldRow>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {usingDraft && draft?.generated_body ? (
          <div className="mb-3 flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-amber-50 border border-amber-200 text-xs">
            <span className="text-amber-900">
              Draft by <span className="font-medium">{draft.agent_name ?? "Reply Agent"}</span> — review before sending.
            </span>
            <button
              type="button"
              onClick={() => {
                editorRef.current?.setContent("");
                setBodyHtml("");
                setBodyText("");
                setUsingDraft(false);
              }}
              className="text-amber-900 hover:underline font-medium"
            >
              Clear &amp; write from scratch
            </button>
          </div>
        ) : null}
        <ComposerBodyEditor
          ref={editorRef}
          initialHtml={bodyHtml}
          placeholder="Enter your message…"
          onChange={({ html, text }) => {
            setBodyHtml(html);
            setBodyText(text);
            // Once the user types, drop the "draft" marker (they've taken
            // ownership of the body).
            if (usingDraft && html !== plainTextToHtml(draft?.generated_body ?? "")) {
              setUsingDraft(false);
            }
          }}
        />

        {/* Quoted last message */}
        {quoted && (quoted.body_text || quoted.body_html) ? (
          <div className="mt-6 pt-4 border-t">
            <p className="text-xs text-muted-foreground mb-2">
              On {formatQuotedTimestamp(quoted.sent_at)}, {quoted.sender ?? "the lead"} wrote:
            </p>
            <blockquote className="text-sm text-muted-foreground border-l-2 pl-3 whitespace-pre-wrap">
              {(quoted.body_text ?? stripHtml(quoted.body_html ?? "")).slice(0, 2000)}
            </blockquote>
          </div>
        ) : null}
      </div>

      {/* Attachment chips */}
      {files.length > 0 ? (
        <div className="px-4 py-2 border-t flex flex-wrap gap-1.5 shrink-0">
          {files.map((f) => (
            <span
              key={f.name + f.size}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded border bg-muted/50 text-xs"
            >
              <FileIcon className="size-3.5 text-muted-foreground" />
              <span className="max-w-[180px] truncate">{f.name}</span>
              <span className="text-muted-foreground">{formatBytes(f.size)}</span>
              <button
                type="button"
                onClick={() => removeFile(f.name)}
                className="ml-0.5 size-4 rounded flex items-center justify-center hover:bg-background"
                aria-label={`Remove ${f.name}`}
              >
                <X className="size-2.5" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {/* Signature toggle — only rendered when we actually have one to append. */}
      {signatureHtml && signatureHtml.trim().length > 0 ? (
        <div className="px-4 py-2.5 border-t flex items-center gap-2 shrink-0">
          <Checkbox
            checked={addSignature}
            onCheckedChange={(v) => setAddSignature(Boolean(v))}
          />
          <span className="text-xs text-muted-foreground">
            Add signature of the email account
          </span>
        </div>
      ) : null}

      {/* Hidden file inputs — driven by the toolbar icons */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          addFiles(e.target.files);
          if (e.target) e.target.value = "";
        }}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          addFiles(e.target.files);
          if (e.target) e.target.value = "";
        }}
      />

      {/*
        What the introduction could not fill in.
        ------------------------------------------------------------------
        A lead with no brokerage on file produced "and is currently with ."
        and nothing anywhere said so. This sits above Send, stays until the
        gap is dealt with, and names each missing value in the words someone
        would use for it. Dismissable, because the operator may well decide
        the sentence still reads fine.
      */}
      {introGaps.length > 0 ? (
        <div
          role="status"
          className="mx-4 mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:text-amber-200 flex items-start gap-2 shrink-0"
        >
          <span className="flex-1">
            The introduction has gaps: {joinMissing(introGaps)}{" "}
            {introGaps.length === 1 ? "is" : "are"} missing. Read it before sending.
          </span>
          <button
            type="button"
            onClick={() => setIntroGaps([])}
            aria-label="Dismiss the missing-details warning"
            className="shrink-0 rounded px-1 opacity-70 hover:opacity-100"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      {/* Footer toolbar + Send */}
      <div className="px-4 py-3 border-t flex items-center justify-between shrink-0">
        <div className="flex items-center gap-0.5 text-muted-foreground">
          {sourceProvider !== "instantly" ? (
            <>
              <IconButton
                icon={Paperclip}
                label="Attach file"
                onClick={() => fileInputRef.current?.click()}
              />
              <IconButton
                icon={ImageIcon}
                label="Attach image"
                onClick={() => imageInputRef.current?.click()}
              />
            </>
          ) : null}
          <button
            type="button"
            onClick={generateAiReply}
            disabled={generating}
            aria-label="Generate AI reply"
            title="Generate AI reply"
            className="h-8 px-2 inline-flex items-center gap-1.5 rounded-md border bg-background text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {generating ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            {generating ? "Generating…" : "AI reply"}
          </button>
          {mode === "reply" ? (
            <button
              type="button"
              onClick={insertIntroduction}
              disabled={!introMacro?.available || introducing}
              aria-label="Insert the introduction"
              title={
                introMacro === null
                  ? "Checking this client's introduction details…"
                  : introMacro.available
                    ? `Introduce this agent to ${introMacro.clientName}` +
                      (introMacro.cc ? ` and copy in ${introMacro.cc}` : "") +
                      (introMacro.introductionLabelId
                        ? " · tags the thread Introduction once you send"
                        : "")
                    : introMacro.reason
              }
              className="h-8 px-2 inline-flex items-center gap-1.5 rounded-md border bg-background text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <UserPlus className="size-3.5" />
              Introduce
            </button>
          ) : null}
          <TemplatePicker
            substitutionContext={{
              lead: {
                name: toName ?? null,
                email: toEmail,
                phone: leadPhone,
                company: leadCompany,
                title: leadTitle,
              },
              thread: { subject: composerSubject },
              sender: { name: fromName ?? null, email: fromEmail ?? null },
            }}
            onApply={(t) => {
              // Insert the template's HTML at the caret so any existing
              // text the user typed is preserved. If the editor is
              // currently empty, insertContent simply places it at the
              // start.
              if (t.bodyHtml) {
                editorRef.current?.insertContent(t.bodyHtml);
              }
              // Subject: apply the template's subject only when the
              // composer doesn't already have one the user has typed/
              // personalised (don't clobber their work).
              if (t.subject && !composerSubject.trim()) {
                setComposerSubject(t.subject);
              }
              const tplCc = t.cc;
              if (tplCc) {
                setCc((cur) => mergeRecipientStrings(cur, tplCc));
                setShowCc(true);
              }
              const tplBcc = t.bcc;
              if (tplBcc) {
                setBcc((cur) => mergeRecipientStrings(cur, tplBcc));
                setShowBcc(true);
              }
            }}
          />
        </div>
        <div className="flex items-center gap-3">
          {mode === "reply" ? (
            <DraftStatusIndicator
              state={savingState}
              savedAt={savedAt}
              hasServerDraft={hasServerDraft}
              onDiscard={discardDraft}
            />
          ) : null}
          <Button onClick={onSend} disabled={sending} className="gap-1.5">
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

// Inline auto-save status copy + Discard control. Lives in the
// composer footer next to the Send button. Stays invisible when
// the operator hasn't typed yet AND has no saved draft, so an
// empty Reply window looks the same as it always has.
function DraftStatusIndicator({
  state,
  savedAt,
  hasServerDraft,
  onDiscard,
}: {
  state: "idle" | "saving" | "saved" | "error";
  savedAt: string | null;
  hasServerDraft: boolean;
  onDiscard: () => void;
}) {
  if (state === "idle" && !hasServerDraft) return null;
  let label: string;
  if (state === "saving") label = "Saving…";
  else if (state === "error") label = "Save failed";
  else if (savedAt) label = `Saved ${formatSavedAgo(savedAt)}`;
  else label = "";
  return (
    <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
      {label ? <span>{label}</span> : null}
      {hasServerDraft ? (
        <button
          type="button"
          onClick={onDiscard}
          className="text-[#1565C0] hover:underline"
        >
          Discard draft
        </button>
      ) : null}
    </div>
  );
}

// "Saved 5s ago" style copy. Hand-rolled (instead of pulling in
// date-fns / dayjs) because the composer only needs a few buckets:
// just-now, seconds, minutes, hours. Falls back to a calendar
// timestamp for anything older than a day — drafts that stale are
// already past the point where "ago" is useful information.
function formatSavedAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "just now";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function FieldRow({
  label,
  children,
  right,
}: {
  label: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 min-h-7">
      <span className="w-14 shrink-0 text-xs text-muted-foreground">{label}:</span>
      <div className="flex-1 min-w-0 flex items-center gap-1 flex-wrap">{children}</div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}


function IconButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="size-8 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
    >
      <Icon className="size-[15px]" strokeWidth={2} />
    </button>
  );
}

function formatQuotedTimestamp(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Parse a comma- or whitespace-separated string of email addresses into
// EmailBison's recipient array shape. Empty input → undefined (omit).
function parseRecipients(
  input: string,
): Array<{ email_address: string; name?: string | null }> | undefined {
  const tokens = input
    .split(/[,;\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && /@/.test(t));
  if (tokens.length === 0) return undefined;
  return tokens.map((email_address) => ({ email_address }));
}

// Merge two CC/BCC strings, dedup case-insensitively, preserve order.
// Used when a template carries its own CC/BCC and we don't want to
// clobber whatever the user already typed manually.
/** What GET /api/threads/<id>/intro-macro answers with. Null until it has. */
type IntroMacroState =
  | {
      available: true;
      clientName: string;
      body: string;
      cc: string | null;
      introductionLabelId: string | null;
    }
  | { available: false; reason: string; clientName?: string }
  | null;

function mergeRecipientStrings(existing: string, incoming: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    for (const tok of raw.split(/[,;\s]+/)) {
      const t = tok.trim();
      if (!t || !/@/.test(t)) continue;
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
  };
  push(existing);
  push(incoming);
  return out.join(", ");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Plain-text → HTML, preserving paragraph + line breaks so the rich
// editor (and the eventual email recipient) sees the same visual
// structure the user typed. Single newlines become <br>; blank lines
// become paragraph breaks. Safe to feed into the editor's
// initialHtml or insertContent.
function plainTextToHtml(s: string): string {
  if (!s) return "";
  const paragraphs = s.split(/\n{2,}/).map((para) => {
    const inner = escapeHtml(para).replace(/\n/g, "<br>");
    return `<p>${inner || "<br>"}</p>`;
  });
  return paragraphs.join("");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface PickerTemplate {
  id: string;
  name: string;
  body: string;
  body_html: string | null;
  subject: string | null;
  cc: string | null;
  bcc: string | null;
  category: string | null;
}

const UNCATEGORISED_LABEL = "Uncategorised";

interface AppliedTemplate {
  // HTML body to insert at the editor's caret. Variables already
  // substituted. Falls back to plaintextToHtml(t.body) when the
  // template has no body_html (older rows).
  bodyHtml: string;
  subject: string | null;
  cc: string | null;
  bcc: string | null;
}

// Footer "Templates" button — lazy-loads the workspace's reply templates
// on first open, applies variable substitution against the current
// thread context, and hands the whole payload to the composer so it
// can populate subject / cc / bcc / body in one shot.
function TemplatePicker({
  substitutionContext,
  onApply,
}: {
  substitutionContext: SubstitutionContext;
  onApply: (t: AppliedTemplate) => void;
}) {
  const [items, setItems] = useState<PickerTemplate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");

  async function ensureLoaded() {
    if (items !== null || loading) return;
    setLoading(true);
    try {
      const res = await fetch("/api/reply-templates", { cache: "no-store" });
      const json = (await res.json()) as { templates?: PickerTemplate[] };
      setItems(json.templates ?? []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  // Filter by name / subject / body / category.
  const filtered = (items ?? []).filter((t) => {
    if (!filter.trim()) return true;
    const q = filter.trim().toLowerCase();
    return [t.name, t.subject, t.body, t.category]
      .filter(Boolean)
      .some((v) => v!.toLowerCase().includes(q));
  });

  // Group by category — named categories alphabetically, uncategorised last.
  const groups: Array<{ category: string; templates: PickerTemplate[] }> = [];
  {
    const map = new Map<string, PickerTemplate[]>();
    for (const t of filtered) {
      const cat = (t.category ?? "").trim() || UNCATEGORISED_LABEL;
      const list = map.get(cat) ?? [];
      list.push(t);
      map.set(cat, list);
    }
    groups.push(
      ...[...map.entries()]
        .map(([category, templates]) => ({ category, templates }))
        .sort((a, b) => {
          if (a.category === UNCATEGORISED_LABEL) return 1;
          if (b.category === UNCATEGORISED_LABEL) return -1;
          return a.category.localeCompare(b.category);
        }),
    );
  }

  function apply(t: PickerTemplate) {
    const subst = (s: string | null) =>
      s ? substituteVariables(s, substitutionContext) : null;
    // Prefer the rich HTML body when the template has one. Older rows
    // only have the plain `body` column — wrap that in basic HTML so
    // the editor still renders paragraph breaks correctly.
    const rawHtml =
      t.body_html && t.body_html.trim().length > 0
        ? t.body_html
        : plainTextToHtml(
            (t.body ?? "").replace(/\n{3,}/g, "\n\n").trim(),
          );
    const substitutedHtml = substituteVariables(rawHtml, substitutionContext);
    onApply({
      bodyHtml: substitutedHtml,
      subject: subst(t.subject),
      cc: subst(t.cc),
      bcc: subst(t.bcc),
    });
  }

  return (
    <DropdownMenu onOpenChange={(open) => open && ensureLoaded()}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Insert template"
            title="Insert a saved template"
            className="h-8 px-2 inline-flex items-center gap-1.5 rounded-md border bg-background text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            <FileText className="size-3.5" />
            Templates
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-80 max-h-96 overflow-y-auto p-0">
        <div className="sticky top-0 z-10 border-b bg-background p-2">
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            // Base UI's Menu intercepts every keystroke for ARIA
            // type-ahead navigation between items. Stopping
            // propagation on keydown + pointerdown keeps this input
            // owning its own events (same pattern as the sender
            // picker below).
            onKeyDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            placeholder="Search templates…"
            autoFocus
            className="w-full h-8 rounded-md border bg-background px-2 text-sm placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring/30"
          />
        </div>
        {loading ? (
          <div className="px-3 py-3 text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin" />
            Loading…
          </div>
        ) : (items ?? []).length === 0 ? (
          <div className="px-3 py-3 text-xs text-muted-foreground">
            No templates yet. Create them in Settings → Templates.
          </div>
        ) : groups.length === 0 ? (
          <div className="px-3 py-3 text-xs text-muted-foreground">
            No templates match &quot;{filter}&quot;.
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.category}>
              <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {g.category}
              </div>
              {g.templates.map((t) => (
                <DropdownMenuItem
                  key={t.id}
                  onClick={() => apply(t)}
                  className="flex flex-col items-start gap-0.5"
                >
                  <span className="text-sm font-medium">{t.name}</span>
                  {t.subject ? (
                    <span className="text-[10.5px] text-muted-foreground/80">
                      Subject: {t.subject}
                    </span>
                  ) : null}
                  <span className="text-[11px] text-muted-foreground line-clamp-2 whitespace-pre-wrap">
                    {t.body || "(empty)"}
                  </span>
                </DropdownMenuItem>
              ))}
            </div>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Shape of the channel rows the composer cares about — display + the
// provider-specific identifiers. Loaded by the parent and passed down
// via the `channels` prop. Kept exported so thread-view can satisfy
// the type without restating the fields.
export interface ChannelOption {
  id: string;
  provider: "instantly" | "emailbison" | "unipile";
  display_name: string;
  instantly_account_id: string | null;
  // Resolved sender email for this channel. Instantly stores it on
  // instantly_account_id; EmailBison only has a friendly name on the
  // channel row, so the parent derives this from the latest outbound
  // message on the channel and passes it in. Used by the picker to
  // disambiguate channels that share a display_name (the EmailBison
  // 22-sender case where every row is "Nicole Collins").
  email: string | null;
}

// Searchable From-dropdown. Filters channels to the same provider as
// the thread (cross-provider sends aren't supported by the underlying
// APIs), shows display_name + email, and lets the user override the
// pinned sender on this thread for a single send.
function SenderPicker({
  channels,
  sourceProvider,
  defaultEmail,
  defaultName,
  selectedId,
  onChange,
}: {
  channels: ChannelOption[];
  sourceProvider: "instantly" | "emailbison" | null;
  defaultEmail: string | null;
  defaultName: string | null;
  selectedId: string | null;
  onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  // Limit the picker to mailboxes that can actually be used for this
  // thread's provider. Mixed-provider sends aren't supported by the
  // underlying APIs.
  const available = channels.filter(
    (c) => !sourceProvider || c.provider === sourceProvider,
  );

  const selected = selectedId
    ? available.find((c) => c.id === selectedId) ?? null
    : null;

  // Display string for the trigger button — prefers the picked channel,
  // falls back to whatever the parent told us is the default sender.
  const triggerLabel =
    selected?.display_name ?? defaultEmail ?? defaultName ?? "Choose sender";
  const triggerSubLabel = selected ? "" : defaultName ?? "";

  const filtered = filter.trim()
    ? (() => {
        const needle = filter.trim().toLowerCase();
        return available.filter((c) => {
          // display_name covers names + emails-as-names (Instantly stores
          // the email there too). instantly_account_id is literally the
          // email for Instantly channels — search that explicitly so
          // typing the @domain portion of a sender's address matches.
          if (c.display_name.toLowerCase().includes(needle)) return true;
          if (c.email && c.email.toLowerCase().includes(needle)) return true;
          if (
            c.instantly_account_id &&
            c.instantly_account_id.toLowerCase().includes(needle)
          ) {
            return true;
          }
          return false;
        });
      })()
    : available;

  if (available.length <= 1) {
    // Nothing to pick from — render read-only with the default.
    return (
      <div className="flex items-center gap-2 px-2.5 py-1 rounded border bg-muted/40 text-sm">
        <span className="size-4 rounded bg-red-500/90 text-white flex items-center justify-center text-[8px] font-bold">
          <Mail className="size-3" />
        </span>
        <span className="font-medium">{defaultName ?? "You"}</span>
        {defaultEmail ? (
          <span className="text-muted-foreground">({defaultEmail})</span>
        ) : null}
      </div>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="inline-flex items-center gap-2 px-2.5 py-1 rounded border bg-background text-sm hover:bg-accent transition-colors"
            aria-label="Choose sender mailbox"
            title="Click to change the sender mailbox"
          >
            <span className="size-4 rounded bg-red-500/90 text-white flex items-center justify-center text-[8px] font-bold">
              <Mail className="size-3" />
            </span>
            <span className="font-medium truncate max-w-[260px]">
              {triggerLabel}
            </span>
            {triggerSubLabel ? (
              <span className="text-muted-foreground truncate max-w-[160px]">
                ({triggerSubLabel})
              </span>
            ) : null}
            <span className="text-muted-foreground text-[10px]">▾</span>
          </button>
        }
      />
      <DropdownMenuContent
        align="start"
        className="w-[360px] max-h-[400px] overflow-y-auto p-0"
      >
        <div className="sticky top-0 z-10 border-b bg-background p-2">
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            // base-ui's Menu intercepts every keystroke for ARIA
            // typeahead (jumping to items starting with the letter),
            // which is why typing "j" used to send focus to the first
            // "John" item instead of going into this input. Stopping
            // propagation on keydown + pointerdown keeps the input
            // owning its own events.
            onKeyDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            placeholder={`Search ${available.length} sender${available.length === 1 ? "" : "s"}…`}
            autoFocus
            className="w-full h-8 rounded-md border bg-background px-2 text-sm placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring/30"
          />
        </div>
        {defaultEmail ? (
          <DropdownMenuItem
            onClick={() => {
              onChange(null);
              setFilter("");
              setOpen(false);
            }}
            className="flex flex-col items-start gap-0 border-b text-[12px]"
          >
            <span className="font-medium">Use thread default</span>
            <span className="text-muted-foreground">{defaultEmail}</span>
          </DropdownMenuItem>
        ) : null}
        {filtered.length === 0 ? (
          <div className="px-3 py-3 text-xs text-muted-foreground">
            No senders match &quot;{filter}&quot;.
          </div>
        ) : (
          filtered.slice(0, 200).map((c) => {
            const senderEmail = c.email ?? c.instantly_account_id ?? null;
            // Hide the email when it's identical to display_name (the
            // Instantly common case where display_name IS the email),
            // otherwise the row reads "x@y.com  x@y.com".
            const showEmail =
              senderEmail && senderEmail.toLowerCase() !== c.display_name.toLowerCase();
            return (
              <DropdownMenuItem
                key={c.id}
                onClick={() => {
                  onChange(c.id);
                  setFilter("");
                  setOpen(false);
                }}
                className="flex items-start justify-between gap-2 text-[13px]"
              >
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="truncate">{c.display_name}</span>
                  {showEmail ? (
                    <span className="truncate text-[11.5px] text-muted-foreground">
                      {senderEmail}
                    </span>
                  ) : null}
                </span>
                {c.id === selectedId ? (
                  <span className="text-[10px] text-[#1565C0] font-semibold uppercase">
                    Selected
                  </span>
                ) : null}
              </DropdownMenuItem>
            );
          })
        )}
        {filtered.length > 200 ? (
          <div className="px-3 py-1.5 text-center text-[11px] text-muted-foreground border-t">
            {filtered.length - 200} more — refine your search to see them
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * "a", "a and b", "a, b and c" — for the missing-details warning.
 *
 * The first version read "This lead has no the lead's name", because it pasted
 * owner-qualified labels into a sentence that already supplied the owner. The
 * labels carry their own owner now, so the sentence must not.
 */
function joinMissing(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
