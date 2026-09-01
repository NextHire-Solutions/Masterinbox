"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Workflow, UserCheck, Ban, Users, Menu, X, Sparkles, Settings2, Target } from "lucide-react";
import { cn } from "@/lib/utils";
import { PortalLogo } from "@/components/portals/portal-logo";
import { CalendlyBanner } from "@/components/portals/calendly-banner";
import { TourProvider } from "@/components/portals/tour/tour-provider";
import { TakeTheTourButton } from "@/components/portals/tour/take-the-tour-button";

interface Props {
  token: string;
  clientName: string;
  counts: { pipeline: number; dnc: number; agents: number; team: number };
  // True when the client has the nav_integrations_label feature flag
  // turned on (Demo Portal today). Renames the Settings nav item to
  // "Integrations" to better match what the page actually does
  // (FollowUpBoss + future CRM connectors). Real clients without
  // the flag never receive this as true, so the "Integrations"
  // string never enters the SSR'd HTML.
  integrationsLabelEnabled?: boolean;
  // Demo-Portal-only: adds an "Ideal Agent Profile" nav item that
  // links to the recruiting-target spec page (Stephanie's June 2026
  // request). Real clients never receive this as true until the
  // flag is rolled out for them.
  idealAgentProfileEnabled?: boolean;
  // Demo-Portal-only: mounts the product tour (auto-start on first
  // visit, replay button in the sidebar). Same flag-rollout story.
  tourEnabled?: boolean;
  children: React.ReactNode;
}

// Shell for every page under /portal/[token]/. Sidebar is sticky on
// md+, slides in as a drawer on mobile. Recruiting Pipeline is the
// portal root — see migration 0027 + app/portal/[token]/page.tsx.
export function PortalShell({
  token,
  clientName,
  counts,
  integrationsLabelEnabled = false,
  idealAgentProfileEnabled = false,
  tourEnabled = false,
  children,
}: Props) {
  const pathname = usePathname();
  const base = `/portal/${token}`;
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close the drawer when navigation happens (mobile users tap a link).
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Lock body scroll when the drawer is open so swipes don't bleed
  // through to the underlying page.
  useEffect(() => {
    if (drawerOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [drawerOpen]);

  // tourTarget threads each nav item's id into a data attribute so
  // the TourStep can anchor itself. undefined → no attribute, no tour
  // step pointing at it.
  type NavItem = {
    href: string;
    label: string;
    icon: typeof Workflow;
    count?: number;
    tone?: "danger";
    tourTarget?: string;
    show?: boolean;
  };
  const items: NavItem[] = [
    { href: `${base}/welcome`, label: "Welcome", icon: Sparkles },
    {
      href: base,
      label: "Recruiting Pipeline",
      icon: Workflow,
      count: counts.pipeline,
      tourTarget: "pipeline",
    },
    {
      href: `${base}/agents`,
      label: "Your Agents",
      icon: UserCheck,
      count: counts.agents,
      tourTarget: "agents",
    },
    {
      href: `${base}/dnc`,
      label: "DNC List",
      icon: Ban,
      count: counts.dnc,
      tone: "danger" as const,
      tourTarget: "dnc",
    },
    {
      href: `${base}/team`,
      label: "Team",
      icon: Users,
      count: counts.team,
      tourTarget: "team",
    },
    {
      href: `${base}/ideal-agent-profile`,
      label: "Ideal Agent Profile",
      icon: Target,
      tourTarget: "ideal-agent-profile",
      show: idealAgentProfileEnabled,
    },
    {
      href: `${base}/settings`,
      label: integrationsLabelEnabled ? "Integrations" : "Settings",
      icon: Settings2,
    },
  ].filter((it) => it.show !== false);

  const activeItem = items.find((it) => isActive(pathname, it.href, base));

  return (
    <>
      {/* Slim Calendly CTA bar — fixed at the top of the viewport.
          Sets --portal-banner-h on <html> when visible so the rest
          of the shell offsets accordingly; dismissed → no var → no
          offset. */}
      <CalendlyBanner />
      <div className="flex min-h-screen bg-[#f6f7f9] text-[#0f1320] antialiased pt-[var(--portal-banner-h,0px)]">
      {/* Mobile top bar — only visible <md. Hamburger toggles the drawer,
          plus a compact client name + current section title. */}
      <header className="fixed inset-x-0 top-[var(--portal-banner-h,0px)] z-40 flex h-14 items-center gap-2 border-b border-[#ebecf0] bg-white/95 px-3 backdrop-blur md:hidden">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          className="inline-flex size-9 items-center justify-center rounded-md text-[#5b6472] hover:bg-[#f6f7f9]"
        >
          <Menu className="size-5" />
        </button>
        <PortalLogo className="h-6 w-auto" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-tight">{clientName}</div>
          <div className="truncate text-[10.5px] uppercase tracking-wider text-[#9aa0ab]">
            {activeItem?.label ?? "Client Portal"}
          </div>
        </div>
      </header>

      {/* Backdrop for the mobile drawer. */}
      {drawerOpen ? (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 z-40 bg-[#0f1320]/40 md:hidden"
        />
      ) : null}

      {/* Sidebar. Drawer on mobile (slides from left), sticky on md+.
          On desktop the sticky offset + height respect the Calendly
          banner via the --portal-banner-h variable. */}
      <aside
        className={cn(
          "fixed bottom-0 left-0 top-[var(--portal-banner-h,0px)] z-50 flex w-[260px] max-w-[80vw] flex-col border-r border-[#ebecf0] bg-white transition-transform duration-200 ease-out md:sticky md:top-[var(--portal-banner-h,0px)] md:z-auto md:h-[calc(100vh-var(--portal-banner-h,0px))] md:w-[232px] md:max-w-none md:translate-x-0 md:transition-none",
          drawerOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center gap-2.5 border-b border-[#ebecf0] px-5 py-4">
          <PortalLogo className="h-7 w-auto" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold leading-tight tracking-tight">
              {clientName}
            </div>
            <div className="text-[10.5px] font-medium uppercase tracking-wider text-[#9aa0ab]">
              Client Portal
            </div>
          </div>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close menu"
            className="inline-flex size-8 items-center justify-center rounded-md text-[#9aa0ab] hover:bg-[#f6f7f9] md:hidden"
          >
            <X className="size-4" />
          </button>
        </div>

        <nav className="flex flex-col gap-px p-2">
          {items.map((it) => {
            const active = isActive(pathname, it.href, base);
            const Icon = it.icon;
            return (
              <Link
                key={it.href}
                href={it.href}
                data-tour-target={it.tourTarget}
                className={cn(
                  "group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors",
                  active
                    ? "bg-[#eaf2fd] text-[#1565C0]"
                    : "text-[#5b6472] hover:bg-[#f6f7f9] hover:text-[#0f1320]",
                )}
              >
                <Icon
                  className={cn(
                    "size-[15px] shrink-0",
                    active ? "text-[#1565C0]" : "text-[#9aa0ab] group-hover:text-[#5b6472]",
                  )}
                  strokeWidth={2}
                />
                <span className="truncate">{it.label}</span>
                {typeof it.count === "number" && it.count > 0 ? (
                  <span
                    className={cn(
                      "ml-auto inline-flex h-[18px] min-w-[22px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold tabular-nums",
                      it.tone === "danger"
                        ? "bg-[#fee2e2] text-[#b91c1c]"
                        : active
                          ? "bg-white text-[#1565C0]"
                          : "bg-[#eef0f3] text-[#5b6472]",
                    )}
                  >
                    {it.count > 99 ? "99+" : it.count}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto border-t border-[#ebecf0] px-5 py-3 text-[11px] text-[#9aa0ab]">
          <span>Powered by BrokerStaffer</span>
        </div>
      </aside>

      {/* Main column. pt-14 reserves space for the mobile top bar; on md+
          the bar is hidden and the sidebar lives inline so no offset. */}
      <main className="min-w-0 flex-1 pt-14 md:pt-0">{children}</main>

      {/* Demo-Portal-only product tour. Renders nothing when
          inactive; auto-starts on first visit per the TourProvider
          rules. tourEnabled gates both the bubbles and the replay
          button so real clients see nothing. */}
      {tourEnabled ? (
        <>
          {/* Floating "Take the tour" CTA (bottom-right). Same tourEnabled gate
              as the tour itself → Demo Portal only, never live clients. */}
          <TakeTheTourButton />
          <TourProvider
            token={token}
            idealAgentProfileEnabled={idealAgentProfileEnabled}
          />
        </>
      ) : null}
      </div>
    </>
  );
}

function isActive(pathname: string | null, href: string, base: string): boolean {
  if (!pathname) return false;
  if (href === base) {
    // Recruiting Pipeline = portal root. The legacy /pipeline sub-route
    // redirects here, so highlight on either path.
    return (
      pathname === base ||
      pathname === `${base}/` ||
      pathname === `${base}/pipeline` ||
      pathname === `${base}/pipeline/`
    );
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
