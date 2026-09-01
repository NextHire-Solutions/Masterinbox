import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolvePortalClient } from "@/lib/portals/token";
import { loadTeamMembers } from "@/lib/portals/portal-data";
import { clientHasFeature } from "@/lib/portals/feature-flags";
import { getClientPlan } from "@/lib/portals/client-plan";
import { TeamList } from "@/components/portals/team-list";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await props.params;
  const client = await resolvePortalClient(token);
  return {
    title: client ? `${client.name} — Team` : "Portal not found",
    robots: { index: false, follow: false },
  };
}

export default async function TeamPage(props: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await props.params;
  const client = await resolvePortalClient(token);
  if (!client) notFound();
  const members = await loadTeamMembers(client.id);
  // Plan is read from the external dashboard (fail-open) and only when the
  // show_client_plan flag is on — Demo Portal today, so real clients never
  // fetch it and see the Team page exactly as before.
  const showPlan = clientHasFeature(client, "show_client_plan");
  let plan = showPlan ? await getClientPlan(client.name) : null;
  // The Demo Portal is not a billed client, so it isn't in the plan feed. Show
  // a representative plan there so the UI can be reviewed; every real client
  // resolves to its ACTUAL plan from the feed above.
  if (showPlan && !plan && client.id === "00ef116c-646d-43b4-a323-680548ea7126") {
    plan = "production";
  }
  return <TeamList token={token} members={members} plan={plan} />;
}
