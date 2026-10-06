import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolvePortalRow } from "@/lib/portals/token";
import { portalBillingHold } from "@/lib/portals/billing-hold";
import { PortalBillingHold } from "@/components/portals/billing-hold";
import { loadPortalCounts } from "@/lib/portals/portal-data";
import { clientHasFeature } from "@/lib/portals/feature-flags";
import { PortalShell } from "@/components/portals/portal-shell";
import { ClarityScript } from "@/components/portals/clarity-script";

// Wraps every page under /portal/[token]/ with the shared sidebar nav.
// The token resolves once here; each child page calls
// resolvePortalClient() again — React.cache makes the second call free.

// Portal-scoped social / SEO metadata. Each child page still
// supplies its own title via generateMetadata; Next.js shallow-merges
// fields so the title wins per-page while description, openGraph,
// and twitter card all flow through from here.
//
// The OG image lives at app/portal/opengraph-image.png (NOT under
// [token]/) so the URL Next emits doesn't contain a dynamic
// segment placeholder ("/portal/-/opengraph-image.png" 404s).
// Sitting one level up means the same branded card applies to
// every /portal/* URL, which is exactly what we want.
//
// metadataBase has to be set or Next defaults the og:image URL
// to http://localhost:<port>, which Slack can't fetch. In dev
// this still resolves to localhost (correct); in prod the env-
// driven NEXT_PUBLIC_PORTAL_BASE_URL would override, but we
// hardcode the public hostname here because that's the only
// surface that ever serves these portals.
//
// IMPORTANT: This deliberately doesn't change the global
// app/layout.tsx description ("Unified sales inbox for cold
// outreach email replies."), which is still correct copy for the
// staff MasterInbox app at /. The override below only fires
// underneath /portal/[token]/.
// The OG image at app/portal/opengraph-image.png is served as a
// static asset at /portal/opengraph-image.png (HTTP 200), but
// Next's auto-attach to descendant metadata wasn't firing for
// the dynamic [token] segment. Reference it explicitly here.
// metadataBase makes the relative URL resolve to the public host.
const OG_IMAGE_URL = "/portal/opengraph-image.png";

export const metadata: Metadata = {
  metadataBase: new URL("https://portal.brokerstaffer.com"),
  description: "Your BrokerStaffer Client Portal",
  openGraph: {
    description: "Your BrokerStaffer Client Portal",
    type: "website",
    images: [
      {
        url: OG_IMAGE_URL,
        width: 1200,
        height: 630,
        alt: "BrokerStaffer Client Portal",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    description: "Your BrokerStaffer Client Portal",
    images: [OG_IMAGE_URL],
  },
  robots: { index: false, follow: false },
};

export default async function PortalTokenLayout(props: {
  children: React.ReactNode;
  params: Promise<{ token: string }>;
}) {
  const { token } = await props.params;
  const client = await resolvePortalRow(token);
  if (!client) {
    // /portal/[token]/page.tsx renders its own "Portal not found" screen
    // for the root URL. For sub-routes (pipeline/agents/dnc/team) a
    // missing token is a hard 404 — there's no content to render.
    notFound();
  }
  /*
   * Held for an unpaid invoice (BrokerStaffer OS, 6 Oct): the notice, not the
   * pipeline. Only 'blocked' rows count, and the check fails open.
   */
  const hold = await portalBillingHold(client.id);
  if (hold) return <PortalBillingHold clientName={client.name} hold={hold} />;

  const counts = await loadPortalCounts(client.id);

  // Demo Portal is our internal QA surface, exclude it so our own
  // testing sessions don't pollute real-client Clarity recordings.
  const enableClarity = client.slug !== "demo-portal";

  return (
    <>
      {enableClarity ? <ClarityScript /> : null}
      <PortalShell
        token={token}
        clientName={client.name}
        counts={counts}
        integrationsLabelEnabled={clientHasFeature(client, "nav_integrations_label")}
        idealAgentProfileEnabled={clientHasFeature(client, "ideal_agent_profile")}
        tourEnabled={clientHasFeature(client, "portal_tour")}
      >
        {props.children}
      </PortalShell>
    </>
  );
}
