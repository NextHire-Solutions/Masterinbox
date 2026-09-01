"use client";

import { Compass } from "lucide-react";
import { useTourStore } from "@/lib/tour/store";

// Floating "Take the tour" CTA — a bold accent pill fixed to the bottom-right
// so it's obvious and always in reach for launching the walkthrough on demand
// (handy during client demos). Rendered ONLY when the portal_tour feature flag
// is on, which today is the Demo Portal alone — real client portals never see
// it. Hides itself while the tour is actively running so it doesn't overlap the
// tour bubbles.
export function TakeTheTourButton() {
  const start = useTourStore((s) => s.start);
  const active = useTourStore((s) => s.active);
  if (active) return null;
  return (
    <button
      type="button"
      onClick={() => start()}
      aria-label="Take the product tour"
      className="fixed bottom-5 right-5 z-40 inline-flex items-center gap-2 rounded-full bg-[#1565C0] px-4 py-2.5 text-[13px] font-semibold text-white shadow-lg shadow-[#1565C0]/30 transition-colors hover:bg-[#0d4ea3] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1565C0] focus-visible:ring-offset-2"
    >
      <Compass className="size-4" />
      Take the tour
    </button>
  );
}
