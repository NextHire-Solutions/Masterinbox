import { NextResponse, after } from "next/server";
import { z } from "zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { resolvePortalClient } from "@/lib/portals/token";
import {
  enforceBlocklist,
  enforceDomainBlocklist,
  normalizeDomain,
} from "@/lib/portals/enforce-blocklist";
import { stopEntries } from "@/lib/portals/stop-person";
import { notifyPortalDncChange } from "@/lib/webhooks/slack-portal";

// PATCH / DELETE /api/portal/[token]/dnc/[id]
//
// PATCH allows partial updates from the portal's Edit dialog. `kind`
// is intentionally NOT editable — agent vs company is a category-level
// distinction that's locked after creation. When the relevant
// blocklist value changes we re-push:
//   - agent rows: email change → enforceBlocklist on the new address
//   - company rows: domain change → enforceDomainBlocklist on the new
//     domain
// Previous values stay on the providers (same one-directional rule
// as DELETE — the client can un-block manually in those tools).
//
// DELETE removes the row; provider blocklist entries stay in place.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const patchSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  email: z.string().trim().email().nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  brokerage: z.string().trim().max(160).nullable().optional(),
  domain: z.string().trim().max(255).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ token: string; id: string }> },
) {
  const { token, id } = await context.params;
  const client = await resolvePortalClient(token);
  if (!client) {
    return NextResponse.json({ error: "Portal not found" }, { status: 404 });
  }
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const admin = createAdminSupabase();
  const { data: current, error: readErr } = await admin
    .from("client_dnc_entries")
    .select("email, kind, domain, name")
    .eq("id", id)
    .eq("client_id", client.id)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 400 });
  if (!current) return NextResponse.json({ error: "Entry not found" }, { status: 404 });

  // Apply kind-specific column policy: company rows have no brokerage;
  // agent rows have no domain. Normalize domain values that DO come in.
  const incoming = { ...parsed.data };
  const isCompany = current.kind !== "agent";
  if (isCompany && "brokerage" in incoming) incoming.brokerage = null;
  if (!isCompany && "domain" in incoming) incoming.domain = null;
  if (isCompany && "domain" in incoming && incoming.domain) {
    incoming.domain = normalizeDomain(incoming.domain) ?? null;
  }

  const update: Record<string, unknown> = {
    ...incoming,
    updated_at: new Date().toISOString(),
  };

  // Re-push when the relevant blocklist value changes.
  if (isCompany) {
    const newDomain = incoming.domain as string | null | undefined;
    const domainChanged =
      Object.prototype.hasOwnProperty.call(parsed.data, "domain") &&
      newDomain &&
      newDomain !== (current.domain as string | null);
    if (domainChanged && newDomain) {
      const r = await enforceDomainBlocklist(newDomain);
      update.pushed_to_instantly = r.pushedInstantly;
      update.pushed_to_emailbison = r.pushedEmailBison;
      update.push_error = r.error;
    }
  } else {
    const newEmail = parsed.data.email;
    const emailChanged =
      Object.prototype.hasOwnProperty.call(parsed.data, "email") &&
      newEmail &&
      newEmail !== current.email;
    if (emailChanged && newEmail) {
      const r = await enforceBlocklist(newEmail);
      update.pushed_to_instantly = r.pushedInstantly;
      update.pushed_to_emailbison = r.pushedEmailBison;
      update.push_error = r.error;
      const name = (parsed.data.name ?? current.name ?? null) as string | null;
      after(() => stopEntries([{ email: newEmail, name }]));
    }
  }

  const { error } = await admin
    .from("client_dnc_entries")
    .update(update)
    .eq("id", id)
    .eq("client_id", client.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ token: string; id: string }> },
) {
  const { token, id } = await context.params;
  const client = await resolvePortalClient(token);
  if (!client) {
    return NextResponse.json({ error: "Portal not found" }, { status: 404 });
  }
  const admin = createAdminSupabase();
  // Read the row BEFORE the delete so we can surface useful fields
  // in the Slack message — name + handle disappear with the row.
  const { data: existing } = await admin
    .from("client_dnc_entries")
    .select("name, email, phone, domain, kind")
    .eq("id", id)
    .eq("client_id", client.id)
    .maybeSingle();
  const { error } = await admin
    .from("client_dnc_entries")
    .delete()
    .eq("id", id)
    .eq("client_id", client.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (existing) {
    const clientId = client.id;
    after(() =>
      notifyPortalDncChange({
        clientId,
        name: (existing.name as string | null) ?? null,
        email: (existing.email as string | null) ?? null,
        phone: (existing.phone as string | null) ?? null,
        domain: (existing.domain as string | null) ?? null,
        kind: (existing.kind as "agent" | "company" | null) ?? null,
        notes: null,
        op: "removed",
      }),
    );
  }
  return NextResponse.json({ ok: true });
}
