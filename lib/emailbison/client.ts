import { env } from "@/lib/env";

// Thin typed wrapper around EmailBison's REST API. Bearer auth. All endpoints
// live under `${baseUrl}/api/...`. See docs/emailbison-openapi.json.

// Shape of a reply object returned by /api/replies/{id}/conversation-thread.
// Note: `subject` here, NOT `email_subject` (different from webhook payload).
export interface ConvReply {
  id: number;
  uuid?: string;
  folder?: string;
  subject?: string | null;
  read?: boolean;
  interested?: boolean;
  automated_reply?: boolean;
  html_body?: string | null;
  text_body?: string | null;
  raw_body?: string | null;
  date_received?: string | null;
  type?: string;
  scheduled_email_id?: number | null;
  campaign_id?: number | null;
  lead_id?: number;
  sender_email_id?: number | null;
  raw_message_id?: string | null;
  from_name?: string | null;
  from_email_address?: string | null;
  primary_to_email_address?: string | null;
  to?: Array<{ name?: string; address?: string }> | string | null;
  cc?: Array<{ name?: string; address?: string }> | string | null;
  bcc?: Array<{ name?: string; address?: string }> | string | null;
  parent_id?: number | null;
  attachments?: Array<{ id: number; uuid: string; file_name?: string; download_url?: string }>;
}

export class EmailBisonError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
  }
}

export interface ClientOpts {
  baseUrl?: string;
  apiKey?: string;
}

export function createEmailBisonClient(opts: ClientOpts = {}) {
  const baseUrl = (opts.baseUrl ?? env.EMAILBISON_BASE_URL).replace(/\/$/, "");
  const apiKey = opts.apiKey ?? env.EMAILBISON_API_KEY;
  if (!apiKey) {
    throw new Error(
      "EmailBison API key is not configured (EMAILBISON_API_KEY).",
    );
  }

  async function request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      // EmailBison is an external service; never cache by default.
      cache: "no-store",
    });
    const text = await res.text();
    const data = text ? safeJSON(text) : null;
    if (!res.ok) {
      throw new EmailBisonError(
        `EmailBison ${method} ${path} -> ${res.status}`,
        res.status,
        data ?? text,
      );
    }
    return data as T;
  }

  return {
    // Workspaces (EmailBison's "teams")
    listWorkspaces: () =>
      request<{
        data: Array<{ id: number; name: string; personal_team?: boolean; main?: boolean }>;
      }>("GET", "/workspaces/v1.1"),
    switchWorkspace: (teamId: number) =>
      request<{ data: { name: string } }>("POST", "/workspaces/v1.1/switch-workspace", {
        team_id: teamId,
      }),

    // Webhooks
    listWebhooks: () =>
      request<{ data: Array<{ id: number; name: string; url: string; events: string[] }> }>(
        "GET",
        "/webhook-url",
      ),
    createWebhook: (input: { name: string; url: string; events: string[] }) =>
      request<{ data: { id: number; name: string; url: string; events: string[] } }>(
        "POST",
        "/webhook-url",
        input,
      ),
    updateWebhook: (id: number, input: { name?: string; url?: string; events?: string[] }) =>
      request<{ data: { id: number } }>("PUT", `/webhook-url/${id}`, input),
    deleteWebhook: (id: number) => request<unknown>("DELETE", `/webhook-url/${id}`),

    // Sender emails (= channels)
    listSenderEmails: (page = 1) =>
      request<{
        data: Array<{
          id: number;
          name?: string | null;
          email: string;
          status: string;
          type: string;
          daily_limit?: number;
        }>;
      }>("GET", `/sender-emails?page=${page}`),

    // Campaigns — single page. Laravel-style pagination meta is included so
    // callers can walk pages without a second request to discover totals.
    // `type` is "outbound" (default) or "reply_followup".
    listCampaigns: (page = 1) =>
      request<{
        data: Array<{ id: number; name: string; status: string; type?: string }>;
        meta?: { current_page?: number; last_page?: number; per_page?: number; total?: number };
        links?: { next?: string | null };
      }>("GET", `/campaigns?page=${page}`),

    // Walk every page of /campaigns and concatenate. Safe for any catalog
    // size — Laravel returns `meta.last_page` so we know when to stop. Caps
    // at 100 pages (= 1500 campaigns at default per_page=15) as a runaway
    // guard.
    listAllCampaigns: async (): Promise<
      Array<{ id: number; name: string; status: string; type?: string }>
    > => {
      const collected: Array<{ id: number; name: string; status: string; type?: string }> = [];
      for (let page = 1; page <= 100; page++) {
        const res = await request<{
          data: Array<{ id: number; name: string; status: string; type?: string }>;
          meta?: { current_page?: number; last_page?: number };
          links?: { next?: string | null };
        }>("GET", `/campaigns?page=${page}`);
        for (const c of res.data ?? []) collected.push(c);
        const last = res.meta?.last_page ?? page;
        const nextUrl = res.links?.next ?? null;
        if (page >= last || !nextUrl) break;
      }
      return collected;
    },

    // POST /api/replies/{reply_id}/followup-campaign/push — pushes the reply
    // (and its lead) into a reply_followup campaign so EmailBison resumes
    // outreach on the same thread using that campaign's sequence. Verified
    // against docs/emailbison-openapi.json (operationId
    // pushReplyandLeadToreplyFollowupCampaign).
    pushReplyToFollowupCampaign: (
      replyId: number,
      input: { campaign_id: number; force_add_reply?: boolean },
    ) =>
      request<{ data: { success?: boolean; message?: string } }>(
        "POST",
        `/replies/${replyId}/followup-campaign/push`,
        input,
      ),

    // PATCH /api/replies/{reply_id}/mark-as-interested — flips the
    // reply's `interested` flag to true on EmailBison's side so the
    // sentiment classification round-trips back to operator-facing
    // smart lists + sequence rules in EmailBison. Defaults match
    // Stephanie's curl examples (skip_webhooks=false here so
    // downstream automations still fire). Wired into the labels
    // route so applying the "Interested" label in MasterInbox
    // pushes the same decision back to EmailBison.
    markReplyAsInterested: (
      replyId: number,
      opts?: { skip_webhooks?: boolean },
    ) =>
      request<{ data: { success?: boolean; message?: string } }>(
        "PATCH",
        `/replies/${replyId}/mark-as-interested`,
        { skip_webhooks: opts?.skip_webhooks ?? false },
      ),

    // PATCH /api/replies/{reply_id}/mark-as-not-interested — sister
    // endpoint to the above. Default skip_webhooks=true (per
    // Stephanie's example) so EmailBison doesn't fire
    // lead_not_interested webhooks back to subscribers that already
    // know via MasterInbox.
    markReplyAsNotInterested: (
      replyId: number,
      opts?: { skip_webhooks?: boolean },
    ) =>
      request<{ data: { success?: boolean; message?: string } }>(
        "PATCH",
        `/replies/${replyId}/mark-as-not-interested`,
        { skip_webhooks: opts?.skip_webhooks ?? true },
      ),

    // Replies
    listReplies: (params: { page?: number; sender_email_id?: number; campaign_id?: number } = {}) => {
      const q = new URLSearchParams();
      if (params.page) q.set("page", String(params.page));
      if (params.sender_email_id) q.set("sender_email_id", String(params.sender_email_id));
      if (params.campaign_id) q.set("campaign_id", String(params.campaign_id));
      return request<{ data: unknown[] }>(
        "GET",
        `/replies${q.toString() ? `?${q.toString()}` : ""}`,
      );
    },
    getReplyThread: (replyId: number) =>
      request<{
        data: {
          current_reply?: ConvReply;
          older_messages?: ConvReply[];
          newer_messages?: ConvReply[];
        };
      }>("GET", `/replies/${replyId}/conversation-thread`),
    // POST /api/replies/{id}/reply. JSON path is used when there are no
    // attachments. When attachments are present, callers must use
    // sendReplyMultipart instead — EmailBison expects multipart/form-data
    // with file fields appended as `attachments[]`.
    sendReply: (
      replyId: number,
      input: {
        message: string;
        to_emails?: Array<{ name?: string | null; email_address: string }>;
        cc_emails?: Array<{ name?: string | null; email_address: string }>;
        bcc_emails?: Array<{ name?: string | null; email_address: string }>;
        reply_all?: boolean;
        inject_previous_email_body?: boolean | null;
        content_type?: "html" | "text";
        sender_email_id?: number | null;
        use_dedicated_ips?: boolean;
        reply_template_id?: number | null;
      },
    ) =>
      // Response shape per docs:
      //   { data: { success, message, reply: { id, ... } } }
      // NOT { data: { id } } as our older type claimed.
      request<{ data: { success?: boolean; reply?: { id?: number } } }>(
        "POST",
        `/replies/${replyId}/reply`,
        input,
      ),

    // Multipart variant for attachment uploads. Per-file cap 25MB,
    // combined cap 50MB — server-side validation should already have
    // enforced these before we get here.
    sendReplyMultipart: async (
      replyId: number,
      input: {
        message: string;
        to_emails?: Array<{ name?: string | null; email_address: string }>;
        cc_emails?: Array<{ name?: string | null; email_address: string }>;
        bcc_emails?: Array<{ name?: string | null; email_address: string }>;
        reply_all?: boolean;
        inject_previous_email_body?: boolean | null;
        content_type?: "html" | "text";
        sender_email_id?: number | null;
        attachments: Array<{ name: string; blob: Blob }>;
      },
    ): Promise<{ data: { success?: boolean; reply?: { id?: number } } }> => {
      const form = new FormData();
      form.append("message", input.message);
      if (input.content_type) form.append("content_type", input.content_type);
      if (input.reply_all) form.append("reply_all", "1");
      if (input.inject_previous_email_body !== undefined && input.inject_previous_email_body !== null) {
        form.append("inject_previous_email_body", input.inject_previous_email_body ? "1" : "0");
      }
      if (input.sender_email_id) form.append("sender_email_id", String(input.sender_email_id));

      // EmailBison's multipart endpoint expects recipient arrays as
      // PHP-style nested form fields (to_emails[0][email_address]=...),
      // NOT a JSON-stringified blob. Validation fails with
      // "field must be an array" if you send a string.
      const appendRecipients = (
        key: "to_emails" | "cc_emails" | "bcc_emails",
        rows?: Array<{ name?: string | null; email_address: string }>,
      ) => {
        if (!rows || rows.length === 0) return;
        rows.forEach((r, i) => {
          if (r.name) form.append(`${key}[${i}][name]`, r.name);
          form.append(`${key}[${i}][email_address]`, r.email_address);
        });
      };
      appendRecipients("to_emails", input.to_emails);
      appendRecipients("cc_emails", input.cc_emails);
      appendRecipients("bcc_emails", input.bcc_emails);

      for (const f of input.attachments) {
        form.append("attachments[]", f.blob, f.name);
      }

      // No Content-Type header — fetch sets the multipart boundary itself.
      const res = await fetch(`${baseUrl}/api/replies/${replyId}/reply`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        body: form,
        cache: "no-store",
      });
      const text = await res.text();
      const data = text ? safeJSON(text) : null;
      if (!res.ok) {
        throw new EmailBisonError(
          `EmailBison POST /replies/${replyId}/reply (multipart) -> ${res.status}`,
          res.status,
          data ?? text,
        );
      }
      return data as { data: { success?: boolean; reply?: { id?: number } } };
    },

    // POST /api/replies/new — fresh-send variant used when the operator
    // changes the Subject on a reply. EmailBison's normal reply endpoint
    // (/api/replies/{id}/reply) silently drops `subject` because it
    // inherits from the original conversation. /api/replies/new accepts
    // a subject, at the cost of creating a brand-new thread on
    // EmailBison's side (no parent_id / in_reply_to on the spec). Lead
    // linkage is preserved because EmailBison matches the recipient by
    // email. Use the reply endpoint when subject is unchanged; reach
    // for this one only when the operator has deliberately edited it.
    composeNewEmail: (input: {
      subject: string;
      message: string;
      sender_email_id: number;
      content_type?: "html" | "text";
      to_emails?: Array<{ name?: string | null; email_address: string }>;
      cc_emails?: Array<{ name?: string | null; email_address: string }>;
      bcc_emails?: Array<{ name?: string | null; email_address: string }>;
      use_dedicated_ips?: boolean;
    }) =>
      // Same response shape as sendReply: { data: { success, reply: { id } } }.
      request<{ data: { success?: boolean; reply?: { id?: number } } }>(
        "POST",
        `/replies/new`,
        input,
      ),

    // Multipart variant of /replies/new for attachment uploads. Mirrors
    // sendReplyMultipart's PHP-style nested fields so EmailBison's
    // validator accepts to_emails[0][email_address] etc. as arrays.
    composeNewEmailMultipart: async (input: {
      subject: string;
      message: string;
      sender_email_id: number;
      content_type?: "html" | "text";
      to_emails?: Array<{ name?: string | null; email_address: string }>;
      cc_emails?: Array<{ name?: string | null; email_address: string }>;
      bcc_emails?: Array<{ name?: string | null; email_address: string }>;
      attachments: Array<{ name: string; blob: Blob }>;
    }): Promise<{ data: { success?: boolean; reply?: { id?: number } } }> => {
      const form = new FormData();
      form.append("subject", input.subject);
      form.append("message", input.message);
      form.append("sender_email_id", String(input.sender_email_id));
      if (input.content_type) form.append("content_type", input.content_type);
      const appendRecipients = (
        key: "to_emails" | "cc_emails" | "bcc_emails",
        rows?: Array<{ name?: string | null; email_address: string }>,
      ) => {
        if (!rows || rows.length === 0) return;
        rows.forEach((r, i) => {
          if (r.name) form.append(`${key}[${i}][name]`, r.name);
          form.append(`${key}[${i}][email_address]`, r.email_address);
        });
      };
      appendRecipients("to_emails", input.to_emails);
      appendRecipients("cc_emails", input.cc_emails);
      appendRecipients("bcc_emails", input.bcc_emails);
      for (const f of input.attachments) {
        form.append("attachments[]", f.blob, f.name);
      }
      const res = await fetch(`${baseUrl}/api/replies/new`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        body: form,
        cache: "no-store",
      });
      const text = await res.text();
      const data = text ? safeJSON(text) : null;
      if (!res.ok) {
        throw new EmailBisonError(
          `EmailBison POST /replies/new (multipart) -> ${res.status}`,
          res.status,
          data ?? text,
        );
      }
      return data as { data: { success?: boolean; reply?: { id?: number } } };
    },

    // Blacklist (Do-Not-Contact). POST /api/blacklisted-emails with the
    // raw email — blocks the address from all current + future campaigns
    // in the active team.
    blacklistEmail: (email: string) =>
      request<{ data?: unknown }>("POST", "/blacklisted-emails", { email }),

    // Domain-level blacklist. POST /api/blacklisted-domains — every
    // address at the given domain is blocked from current + future
    // campaigns in the active team. Used by the portal's company DNC
    // flow (one domain instead of N emails).
    blacklistDomain: (domain: string) =>
      request<{ data?: unknown }>("POST", "/blacklisted-domains", { domain }),

    // PATCH /api/replies/{reply_id}/unsubscribe — "unsubscribes the contact
    // associated with a specific reply from scheduled emails" in the active
    // team. Used with the blacklist when someone must not be contacted: the
    // blacklist stops the address, this stops the lead's scheduled emails.
    unsubscribeReply: (replyId: number | string) =>
      request<{ data?: unknown }>("PATCH", `/replies/${replyId}/unsubscribe`),

    // Leads
    getLead: (leadId: number) => request<{ data: unknown }>("GET", `/leads/${leadId}`),
    // EmailBison returns scheduled emails with a NESTED sender_email object
    // (id + email + name), NOT a flat sender_email_id. Empirically confirmed
    // from raw_payload inspection.
    getLeadSentEmails: (leadId: number | string) =>
      request<{
        data: Array<{
          id: number;
          campaign_id: number;
          lead_id?: number;
          sender_email?: { id: number; email: string; name?: string | null };
          sender_email_id?: number; // legacy / fallback if present
          sequence_step_id?: number | null;
          thread_reply?: boolean;
          email_subject?: string | null;
          email_body?: string | null;
          status?: string;
          scheduled_date?: string | null;
          sent_at?: string | null;
        }>;
      }>("GET", `/leads/${leadId}/sent-emails`),

    // /leads/{id}/scheduled-emails — upcoming queued sends for the lead.
    // Used to detect whether a lead is CURRENTLY enrolled in any
    // reply_followup campaign (sent-emails alone tells us "ever was";
    // scheduled-emails tells us "still is"). We only need the slim set
    // of fields below — the full payload includes a nested lead +
    // sender_email block we don't read.
    getLeadScheduledEmails: (leadId: number | string) =>
      request<{
        data: Array<{
          id: number;
          campaign_id: number;
          lead_id?: number;
          status?: string;
          scheduled_date?: string | null;
          sent_at?: string | null;
        }>;
        meta?: { current_page?: number; last_page?: number };
        links?: { next?: string | null };
      }>("GET", `/leads/${leadId}/scheduled-emails`),

    // Raw escape hatch for ad-hoc calls
    raw: request,
  };
}

function safeJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
