"use client";

import type { PipelineEntry } from "@/lib/portals/portal-data";
import { cn } from "@/lib/utils";
import { NO_SHOW_STAGE, noShowMoveAllowed } from "@/lib/portals/no-show-window";
import {
  pickFirstString,
  pickProfileUrl,
  PHONE_KEYS,
  AGENT_PROFILE_PREFERRED_KEYS,
  LICENSE_KEYS,
  YEARS_KEYS,
  formatPortalFieldValue,
} from "@/components/portals/custom-field-helpers";

// Inline expandable detail block for a Recruiting Pipeline row.
// Renders every meaningful field on the lead, including the enriched
// Instantly payload — uniformly in a grid that wraps on narrow screens
// for mobile readers.

type LeadDetail = {
  company?: string | null;
  title?: string | null;
  custom_fields?: Record<string, unknown>;
};

interface DetailField {
  label: string;
  value: string;
}

export function PipelineDetailInline({
  entry,
  showSource = false,
  compact = false,
}: {
  entry: PipelineEntry;
  // Reserved for future inline-edit interactions. The caller currently
  // passes a no-op patch handler; keeping it on the type lets us avoid
  // a future breaking-change to consumers.
  token?: string;
  onLocalUpdate?: (patch: Partial<PipelineEntry>) => void;
  // When true, the lead-detail dropdown surfaces a "Source" row
  // alongside the custom variables. Driven server-side off
  // clients.feature_flags.pipeline_source_split — real clients
  // without the flag never receive this as true, so the source
  // string never enters the SSR'd HTML.
  showSource?: boolean;
  // Narrow-container mode (e.g. inside the Kanban detail sheet).
  // Switches the grid from 4-column responsive to 2-column, tones
  // down padding, and lets long values (emails / profile URLs)
  // wrap instead of truncating. The inline list-view expand keeps
  // its full 4-column layout when compact is false.
  compact?: boolean;
}) {
  const detail = (entry.lead_detail ?? {}) as LeadDetail;
  const cf = (detail.custom_fields ?? {}) as Record<string, unknown>;

  const fields: DetailField[] = [];
  const shown = new Set<string>();

  const tryPush = (
    label: string,
    value: unknown,
    // dedupKey *always* marks the key as "shown" — even when the
    // value is empty — so a custom_fields entry with the same key
    // never sneaks in as a duplicate field with a sibling label.
    // Previously this was gated on hasValue(value), which let
    // cf.website surface as a separate "Website" row whenever
    // entry.agent_profile_url was null (the common case for
    // webhook-sourced leads).
    dedupKey?: string | string[],
  ) => {
    if (dedupKey) {
      const keys = Array.isArray(dedupKey) ? dedupKey : [dedupKey];
      for (const k of keys) shown.add(k.toLowerCase());
    }
    if (!hasValue(value)) return;
    fields.push({ label, value: String(value).trim() });
  };

  tryPush("Email", entry.lead_email, "email");

  // Phone — the snapshot column `entry.lead_phone` is the source of
  // truth because it's what the Edit dialog writes to. We fall back
  // to custom_fields ONLY when the snapshot is empty / null (the
  // case the EmailBison key-name fix was originally addressing —
  // EB sometimes stores phone under "Phone Number" instead of the
  // narrow set the intro-time trigger captures). Using `||` rather
  // than `??` so a literal empty-string snapshot also falls through.
  const phone =
    entry.lead_phone || pickFirstString(cf, PHONE_KEYS);
  tryPush("Phone", phone, [
    "phone",
    "phone number",
    "phonenumber",
    "phone_number",
    "mobile",
    "cell",
  ]);

  // License # — surface as its own labeled field so it doesn't drown
  // in the generic "Custom variables" grid below. Dedup the matching
  // keys so they don't double-render.
  const license = pickFirstString(cf, LICENSE_KEYS);
  tryPush("License", license, ["license number", "licensenumber"]);

  // Years in business — same pattern: hoist out of the generic grid.
  const years = pickFirstString(cf, YEARS_KEYS);
  tryPush("Years in business", years, [
    "years in business",
    "years in industry",
    "industry tenure",
    "est. time in industry",
    "experience",
    "years_experience",
  ]);

  const company = entry.current_brokerage ?? detail.company;
  tryPush("Company", company, "company");

  tryPush("Title", detail.title, "title");

  // Agent profile URL — pattern-aware so any future "<Name> Profile"
  // key (Zillow Profile, Realtor.com Profile, etc.) surfaces here
  // without a code change. The preferred list above controls
  // precedence when more than one profile-style key is present.
  const agentProfile =
    (entry.agent_profile_url as string | null) ??
    pickProfileUrl(cf, AGENT_PROFILE_PREFERRED_KEYS);
  // Dedup every "* Profile" key as well as the website/url aliases so
  // the generic grid below doesn't reprint a "Streeteasy Profile" row
  // alongside the dedicated Agent profile link.
  const profileDedupKeys = [
    "website",
    "url",
    ...Object.keys(cf).filter((k) => /profile$/i.test(k)),
  ];
  tryPush("Agent profile", agentProfile, profileDedupKeys);

  tryPush("Location", entry.lead_location, "location");

  // Recruiter ownership — mirrors the row-header pill so the expanded
  // card stays consistent with the table.
  tryPush("Assigned", entry.assigned_team_member?.name, "assigned");

  // Source tag — gated behind the pipeline_source_split feature flag
  // so only flag-enabled clients (Demo Portal today) see the row. Real
  // clients without the flag never get showSource=true, so the value
  // ("BrokerStaffer" / "Client Entry") never enters the rendered HTML.
  // dedupKey "source" prevents a stray custom_fields.source from
  // double-rendering under the same label.
  if (showSource) {
    tryPush("Source", entry.source, "source");
  }

  // Machine-readable keys that show up in Instantly custom_fields but
  // read as noise to a brokerage user (raw UUIDs, sequence step
  // counters, the email id, etc.). Hide them from the expanded card —
  // they're never useful to surface, and rendering the UUID under a
  // "Campaign" label confused the June 2026 client review.
  const CF_SKIP = new Set([
    "campaign",
    "campaign_id",
    "campaignid",
    "step",
    "variant",
    "email_id",
    "emailid",
    "is_first",
    "isfirst",
    "unibox_url",
    "uniboxurl",
  ]);
  for (const [k, v] of Object.entries(cf)) {
    if (shown.has(k.toLowerCase())) continue;
    if (CF_SKIP.has(k.toLowerCase())) continue;
    if (!hasValue(v)) continue;
    // Currency fields (Sales Volume / List-side / Buy-side) render as
    // $XXX,XXX,XXX; every other field is stringified unchanged.
    fields.push({ label: prettyKey(k), value: formatPortalFieldValue(k, v) });
  }

  const introducedDate = entry.introduced_at
    ? new Date(entry.introduced_at).toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <div
      className={cn(
        compact
          ? "px-5 py-5 sm:px-6"
          : "px-4 py-5 sm:px-12 sm:py-6",
      )}
    >
      {fields.length > 0 ? (
        <div
          className={cn(
            "grid",
            compact
              ? "grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2"
              : "grid-cols-1 gap-x-10 gap-y-5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4",
          )}
        >
          {fields.map((f) => (
            <FieldStack
              key={f.label}
              label={f.label}
              value={f.value}
              compact={compact}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-[#ebecf0] bg-white px-4 py-3 text-[12px] text-[#9aa0ab]">
          No additional details captured for this lead yet.
        </div>
      )}

      {introducedDate ? (
        <div
          className={cn(
            "mt-7 grid grid-cols-1 gap-x-12 gap-y-3 border-t border-[#ebecf0] pt-6",
            compact ? "" : "md:grid-cols-[220px_1fr]",
          )}
        >
          <FieldStack label="Introduced" value={introducedDate} compact={compact} />
          {entry.stage !== NO_SHOW_STAGE &&
          !noShowMoveAllowed(entry.introduced_at) ? (
            <div className="flex items-start gap-1.5 text-[11.5px] text-[#9aa0ab]">
              <span aria-hidden>⏱</span>
              <span>
                No Show / No Response window closed. It can only be set within 24
                hours of introduction.
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {entry.notes_log.length > 0 ? (
        <div className="mt-7 border-t border-[#ebecf0] pt-6">
          <div className="text-[10.5px] font-medium uppercase tracking-wide text-[#aab0ba]">
            Notes
          </div>
          <ul className="mt-2 space-y-2">
            {entry.notes_log.map((n) => (
              <li key={n.id} className="rounded-lg bg-white p-2.5 ring-1 ring-[#ebecf0]">
                <div className="text-[11px] text-[#9aa0ab]">
                  {new Date(n.created_at).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </div>
                <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-[#0f1320]">
                  {n.body}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function FieldStack({
  label,
  value,
  compact = false,
}: DetailField & { compact?: boolean }) {
  const link = autoLink(label, value);
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-[#aab0ba]">
        {label}
      </div>
      <div className="mt-0.5 text-[13px] leading-snug">
        {link.href ? (
          // Hyperlink styling: always-on underline with a comfortable
          // offset (matches the default browser convention so it's
          // unambiguous as a link), saturated blue, darker on hover.
          // `title={value}` shows the FULL URL on hover even when the
          // displayed text was shortened by prettyHost(). In compact
          // mode (narrow sheet) we drop the truncate so long emails /
          // profile URLs wrap onto multiple lines instead of clipping
          // to "tom…" / "corc…".
          <a
            href={link.href}
            target={link.external ? "_blank" : undefined}
            rel={link.external ? "noopener noreferrer" : undefined}
            className={cn(
              "block max-w-full font-medium text-blue-600 underline underline-offset-2 hover:text-blue-800",
              compact ? "break-words" : "truncate",
            )}
            title={value}
          >
            {link.display}
          </a>
        ) : (
          <span className="block break-words text-[#0f1320]" title={value}>
            {link.display}
          </span>
        )}
      </div>
    </div>
  );
}

function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  const s = String(v).trim();
  if (s === "" || s === "null" || s === "undefined" || s === "—") return false;
  return true;
}

function prettyKey(k: string): string {
  return k
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function autoLink(
  label: string,
  value: string,
): { href?: string; external?: boolean; display: string } {
  const l = label.toLowerCase();
  // URL-y labels: agent profile, website, linkedin, profile, or
  // anything containing "url". "agent profile" used to fall through
  // because none of the equality checks matched it — long realtor.com
  // paths rendered as plain text, not a clickable link.
  const looksUrly =
    l === "website" ||
    l === "linkedin" ||
    l === "profile" ||
    l === "agent profile" ||
    l.includes("url") ||
    l.includes("profile");

  if (/^https?:\/\//i.test(value)) {
    return { href: value, external: true, display: prettyHost(value) };
  }
  if (l === "email" || l.includes("email")) {
    if (/^[\w.+-]+@[\w.-]+\.\w+$/.test(value)) {
      return { href: `mailto:${value}`, display: value };
    }
  }
  if (l === "phone" || l === "mobile" || l === "cell" || l.includes("phone")) {
    const digits = value.replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) {
      return {
        href: `tel:${value.replace(/[^+\d]/g, "")}`,
        display: value,
      };
    }
  }
  if (looksUrly) {
    const hasDot = /\.[a-z]{2,}/i.test(value);
    if (hasDot && !value.includes(" ")) {
      const href = `https://${value.replace(/^\/+/, "")}`;
      return { href, external: true, display: prettyHost(value) };
    }
  }
  return { display: value };
}

// Display form for a URL inside a narrow field cell.
//
// - Strips protocol + www + trailing slash (the original trimUrl
//   behaviour).
// - If the path is long (realtor.com hash-style routes like
//   /realestateagents/634039a3cbc67abcc0c68231) collapse it to
//   "host › last-segment-prefix…" so the displayed text fits the
//   cell without forcing the `block truncate` to ellipsis-clip a
//   mid-word slug. Full URL stays in the anchor's href + the
//   `title` tooltip.
function prettyHost(url: string): string {
  const cleaned = url
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "");
  if (cleaned.length <= 38) return cleaned;
  const firstSlash = cleaned.indexOf("/");
  if (firstSlash < 0) return cleaned;
  return cleaned.slice(0, firstSlash) + "/…";
}
