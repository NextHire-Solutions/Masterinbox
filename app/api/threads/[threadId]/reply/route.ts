import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { sendOutboundReply } from "@/lib/inbox/send-reply";

// Sends an outbound reply for the given thread via EmailBison's
// POST /api/replies/{id}/reply endpoint (or Instantly's /emails/reply).
//
// The send itself — provider resolution, the provider call, the outbound
// `messages` row, the thread update, the feedback verdict, the drafts marked
// sent and the composer auto-save cleanup — lives in lib/inbox/send-reply.ts,
// lifted out so the reply agent can send through exactly the same path
// without a session. This handler parses and authenticates as it always did
// and hands over; its responses are exactly what they were.
//
// Two transport modes:
//   - JSON body (no attachments)            → application/json
//   - multipart/form-data (with attachments) → see below
//
// Multipart form fields (used by the composer when files are picked):
//   body, content_type, subject              — scalars
//   to, cc, bcc                              — JSON-stringified arrays
//   reply_all, inject_previous_email_body    — "0" | "1"
//   attachments                              — repeated File fields

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PER_FILE_MAX = 25 * 1024 * 1024; // 25 MB
const COMBINED_MAX = 50 * 1024 * 1024; // 50 MB

// Workspace-wide auto-CC. The composer pre-fills the workspace
// CC address (lib/inbox/auto-cc.ts) so operators always see Nicole
// looped in by default and can leave her checked.
//
// IMPORTANT (2026-06-23): The server-side merge that used to
// re-add Nicole here was removed at Stephanie's request. The
// composer is the canonical source — when an operator
// deliberately removes Nicole from the CC field for a sensitive
// client, that intent now reaches EmailBison/Instantly verbatim
// instead of getting silently overridden by a server safety net.
// If we ever need to support direct API callers that bypass the
// composer, they're responsible for setting CC explicitly.

const recipientSchema = z.object({
  name: z.string().nullable().optional(),
  email_address: z.string().email(),
});

const schema = z.object({
  body: z.string().min(1, "Reply body is required"),
  subject: z.string().optional(),
  content_type: z.enum(["html", "text"]).default("html"),
  to: z.array(recipientSchema).optional(),
  cc: z.array(recipientSchema).optional(),
  bcc: z.array(recipientSchema).optional(),
  reply_all: z.boolean().default(false),
  inject_previous_email_body: z.boolean().default(true),
  // messages.id of the specific message the user clicked Reply on. When
  // omitted (the bottom floating Reply button) we fall back to the latest
  // inbound. When set, we use THAT message's provider id (Instantly
  // email_id / EmailBison reply_id) as the reply target so the outbound's
  // In-Reply-To header points at the right ancestor for Gmail threading.
  source_message_id: z.string().uuid().optional(),
  // Override the sender mailbox for THIS send. When set, we look up the
  // channels row and use its provider-specific identifier (Instantly
  // eaccount / EmailBison sender_email_id) instead of the default
  // resolution from the thread's outbound_sender_email. Required for
  // the "From" dropdown in the composer.
  sender_channel_id: z.string().uuid().optional(),
  // True when the operator deliberately edited the Subject in the
  // composer (vs. accepting the auto-derived "Re: <source>" value).
  // EmailBison's /api/replies/{id}/reply silently drops `subject`,
  // so we route subject-changed sends through /api/replies/new
  // instead. Instantly always honours subject in-body, so the flag
  // doesn't affect that path. Optional + defaulted to false so older
  // clients (and any unknown direct API caller) keep current behaviour.
  subject_changed: z.boolean().optional(),
});

type ParsedInput = z.infer<typeof schema>;

export async function POST(
  request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;

  const userClient = await createServerSupabase();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  // Parse either JSON or multipart based on the inbound content-type.
  let payload: ParsedInput;
  let attachments: Array<{ name: string; blob: Blob }> = [];
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.startsWith("multipart/")) {
      const form = await request.formData();
      const fields: Record<string, unknown> = {};
      const files: File[] = [];
      for (const [key, value] of form.entries()) {
        if (key === "attachments" || key === "attachments[]") {
          if (value instanceof File) files.push(value);
        } else if (key === "to" || key === "cc" || key === "bcc") {
          // Recipients arrive JSON-stringified from the client.
          try {
            fields[key] = JSON.parse(String(value));
          } catch {
            fields[key] = undefined;
          }
        } else if (
          key === "reply_all" ||
          key === "inject_previous_email_body" ||
          key === "subject_changed"
        ) {
          fields[key] = value === "1" || value === "true";
        } else {
          fields[key] = String(value);
        }
      }

      // Enforce attachment caps server-side too — never trust the client.
      let combined = 0;
      for (const f of files) {
        if (f.size > PER_FILE_MAX) {
          return NextResponse.json(
            { error: `"${f.name}" exceeds the 25MB per-file limit.` },
            { status: 413 },
          );
        }
        combined += f.size;
      }
      if (combined > COMBINED_MAX) {
        return NextResponse.json(
          { error: "Combined attachments exceed the 50MB limit." },
          { status: 413 },
        );
      }
      attachments = files.map((f) => ({ name: f.name, blob: f }));
      const parsed = schema.safeParse(fields);
      if (!parsed.success) {
        return NextResponse.json(
          { error: parsed.error.issues[0]?.message ?? "Invalid input" },
          { status: 400 },
        );
      }
      payload = parsed.data;
    } else {
      const json = await request.json().catch(() => null);
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        return NextResponse.json(
          { error: parsed.error.issues[0]?.message ?? "Invalid input" },
          { status: 400 },
        );
      }
      payload = parsed.data;
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Bad request" },
      { status: 400 },
    );
  }

  // Server-side auto-CC injection was removed 2026-06-23 — see the
  // import block at the top of this file. payload.cc is now sent
  // verbatim downstream (EmailBison send, Instantly send, the
  // outbound `messages` snapshot). The composer remains the
  // canonical pre-fill source for the always-CC address.

  // Membership check via user-scoped RLS — only members of the workspace
  // owning this thread can see/reply to it.
  const { data: thread } = await userClient
    .from("threads")
    .select("id, workspace_id, lead_id, channel_id, outbound_sender_email, source_provider, instantly_thread_id")
    .eq("id", threadId)
    .maybeSingle();
  if (!thread) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  const admin = createAdminSupabase();

  const result = await sendOutboundReply({
    admin,
    workspaceId: thread.workspace_id,
    threadId,
    body:
      payload.content_type === "html"
        ? { kind: "html", html: payload.body }
        : { kind: "plain", text: payload.body },
    subject: payload.subject,
    subjectChanged: payload.subject_changed,
    to: payload.to,
    cc: payload.cc,
    bcc: payload.bcc,
    replyAll: payload.reply_all,
    injectPreviousEmailBody: payload.inject_previous_email_body,
    sourceMessageId: payload.source_message_id,
    senderChannelId: payload.sender_channel_id,
    attachments,
    actor: { kind: "user", userId: user.id },
  });
  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json({ ok: true });
}
