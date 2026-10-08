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

// POST /api/portal/[token]/dnc — add a DNC entry.
//
// kind='agent'   : an email (if supplied) is pushed to per-address
//                  blocklists on Instantly + EmailBison.
// kind='company' : a domain (if supplied) is pushed to wildcard /
//                  domain-level blacklists on both providers. Optional
//                  email is kept as contact metadata only.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const schema = z.object({
  kind: z.enum(["agent", "company"]).default("agent"),
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().email().nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  brokerage: z.string().trim().max(160).nullable().optional(),
  domain: z.string().trim().max(255).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const client = await resolvePortalClient(token);
  if (!client) {
    return NextResponse.json({ error: "Portal not found" }, { status: 404 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  const { kind, name, email, phone, brokerage, notes } = parsed.data;
  // For company rows the domain is the primary blocklist value; normalize
  // it server-side too in case the client sent a bare hostname.
  const domain =
    kind === "company" ? normalizeDomain(parsed.data.domain ?? "") : null;

  const admin = createAdminSupabase();

  // Enforce blocklist FIRST so the row's push_* flags reflect reality
  // on insert. Provider calls take ~1-2s each — acceptable for an
  // explicit "Add" click.
  let pushedInstantly = false;
  let pushedEmailBison = false;
  let pushError: string | null = null;
  if (kind === "company" && domain) {
    const result = await enforceDomainBlocklist(domain);
    pushedInstantly = result.pushedInstantly;
    pushedEmailBison = result.pushedEmailBison;
    pushError = result.error;
  } else if (kind === "agent" && email) {
    const result = await enforceBlocklist(email);
    pushedInstantly = result.pushedInstantly;
    pushedEmailBison = result.pushedEmailBison;
    pushError = result.error;
  }

  const { data, error } = await admin
    .from("client_dnc_entries")
    .insert({
      client_id: client.id,
      kind,
      name,
      // Agent: store email; Company: keep email as contact metadata only.
      email: email ?? null,
      phone: phone ?? null,
      brokerage: kind === "agent" ? (brokerage ?? null) : null,
      domain,
      notes: notes ?? null,
      added_by: "client",
      pushed_to_instantly: pushedInstantly,
      pushed_to_emailbison: pushedEmailBison,
      push_error: pushError,
    })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // Beyond the blacklist: stop the person's existing conversations and
  // their other addresses. After the response, so the Add click is no
  // slower. (A company's domain blacklist already covers everyone there.)
  if (kind === "agent" && email) after(() => stopEntries([{ email, name }]));

  // Slack: announce the new DNC entry. Pre-fetched fields (we
  // already have them from the insert payload), so no extra DB
  // read. Runs inside after().
  const clientId = client.id;
  after(() =>
    notifyPortalDncChange({
      clientId,
      name,
      email: email ?? null,
      phone: phone ?? null,
      domain,
      kind,
      notes: notes ?? null,
      op: "added",
    }),
  );

  return NextResponse.json({
    ok: true,
    id: data.id,
    pushedInstantly,
    pushedEmailBison,
    pushError,
  });
}
