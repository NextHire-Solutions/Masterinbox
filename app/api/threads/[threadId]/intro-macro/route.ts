import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/workspace";
import { createAdminSupabase } from "@/lib/supabase/admin";
import {
  hasIntroDetails,
  introContactEmails,
  missingIntroFields,
  renderIntroMacroTemplate,
} from "@/lib/inbox/intro-macro";

/*
 * What the composer's Introduce button needs for this conversation.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE DETAILS COME FROM
 *
 * The client's introduction details — who to introduce, their role, their
 * brokerage, and now a second and third person — are held on `os_clients`,
 * the workspace's roster, which lives in this same database. This route reads
 * that record directly and renders the macro from it.
 *
 * It used to read the stored "Intro Macro - <client>" reply template instead.
 * That was one lookup and no rendering, but it had two faults:
 *
 *   · the template is found by NAME, and five clients are spelled differently
 *     on the roster than they are here ("BHGRE Base Camp" vs "BHGRE
 *     Basecamp"). Two of them had details filled in and a template that this
 *     app could never find, so the button stayed dark for no visible reason.
 *   · a template is a copy. Correcting a role on the roster rewrites it, but
 *     any moment where the rewrite has not happened is a moment this app
 *     shows the old wording.
 *
 * Reading the roster removes both, and makes this button behave exactly like
 * the one in the workspace, which renders from the same record.
 *
 * The stored template is still the fallback, for a client that has a template
 * but no roster record — the state every client was in before the roster
 * existed.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS RETURNED
 *
 * The lead's values stay as `{{lead.*}}` placeholders: the composer resolves
 * them with the same `substituteVariables` the Templates picker uses, so a
 * macro inserted by the button and one inserted from the picker read
 * identically.
 *
 * Always 200 when the caller may ask. "This client has no introduction
 * details yet" is an answer, not a failure — the button shows it as a tooltip
 * and disables itself, and an error status would log a red line in the
 * console for a perfectly ordinary state.
 */

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  const session = await requireSession();
  const admin = createAdminSupabase();

  const { data: thread } = await admin
    .from("threads")
    .select("id, client_id")
    .eq("id", threadId)
    .eq("workspace_id", session.activeWorkspace.id)
    .maybeSingle();
  if (!thread) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }

  const clientId = (thread.client_id as string | null) ?? null;
  if (!clientId) {
    return NextResponse.json({
      available: false,
      reason: "This conversation is not assigned to a client yet.",
    });
  }

  const { data: client } = await admin
    .from("clients")
    .select("id, name")
    .eq("id", clientId)
    .maybeSingle();
  const clientName = (client?.name as string | undefined) ?? "this client";

  /*
   * The workspace's "Introduction" label, so the composer can tag the thread
   * once the introduction has actually been sent. Null when no such label
   * exists — the composer then simply does not tag. It never creates one:
   * that label drives the portal pipeline and the Follow Up Boss push, and
   * minting it here would start machinery this workspace has not set up.
   */
  const { data: introLabel } = await admin
    .from("labels")
    .select("id")
    .eq("workspace_id", session.activeWorkspace.id)
    .ilike("name", "Introduction")
    .maybeSingle();
  const introductionLabelId = (introLabel?.id as string | undefined) ?? null;

  /*
   * The roster record, keyed to this client. A missing table or a client that
   * was never added to the roster are both "fall back to the template", never
   * a failure.
   */
  let row: Record<string, unknown> | null = null;
  try {
    const { data } = await admin
      .from("os_clients")
      .select(
        "name, contact_name, contact_role, contact_email, " +
          "contact2_name, contact2_role, contact2_email, " +
          "contact3_name, contact3_role, contact3_email, brokerage",
      )
      .eq("mi_client_id", clientId)
      .maybeSingle();
    row = (data as Record<string, unknown> | null) ?? null;
  } catch {
    row = null;
  }

  if (row) {
    const str = (k: string) => (row?.[k] as string | null) ?? null;
    const details = {
      // The name shown to a person is THIS app's, not the roster's — they are
      // spelled differently for five clients and this is the one people see.
      name: clientName,
      contactName: str("contact_name"),
      contactRole: str("contact_role"),
      contactEmail: str("contact_email"),
      extraContacts: [2, 3].map((n) => ({
        name: str(`contact${n}_name`),
        role: str(`contact${n}_role`),
        email: str(`contact${n}_email`),
      })),
      brokerage: str("brokerage"),
    };

    if (hasIntroDetails(details)) {
      return NextResponse.json({
        available: true,
        clientName,
        body: renderIntroMacroTemplate(details),
        bodyHtml: null,
        cc: introContactEmails(details).join(", ") || null,
        introductionLabelId,
      });
    }

    /*
     * A roster record with nothing filled in. Fall through to the template
     * rather than reporting "no details": a client onboarded before the
     * roster stored them still has a perfectly good template, and saying
     * otherwise would take the button away from someone who had it.
     */
  }

  const { data: template } = await admin
    .from("reply_templates")
    .select("id, name, body, body_html, cc")
    .eq("workspace_id", session.activeWorkspace.id)
    .eq("name", `Intro Macro - ${clientName}`)
    .maybeSingle();

  if (!template || !template.body) {
    const missing = row ? missingIntroFields({
      name: clientName,
      contactName: (row.contact_name as string | null) ?? null,
      contactRole: (row.contact_role as string | null) ?? null,
      brokerage: null,
    }).join(" and ") : null;
    return NextResponse.json({
      available: false,
      clientName,
      reason: missing
        ? `Add ${clientName}'s ${missing} in the workspace under Clients → Edit.`
        : `${clientName} has no introduction details yet — add them in the workspace under Clients → Edit.`,
    });
  }

  return NextResponse.json({
    available: true,
    clientName,
    body: template.body as string,
    bodyHtml: (template.body_html as string | null) ?? null,
    cc: ((template.cc as string | null) ?? "").trim() || null,
    introductionLabelId,
  });
}
