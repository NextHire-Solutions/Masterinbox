// EmailBison sends candidate enrichment as a flat list of
// `custom_variables`, then our sync flattens that into a JSONB
// `leads.custom_fields` map. The key names are operator-typed in
// EB and have no enforced casing or naming convention — the same
// concept arrives as "phone", "Phone", "phone number",
// "Phone Number", "PhoneNumber", etc. across different campaigns.
//
// These two helpers normalise that out at render time so the
// portal UI can stay declarative: "pick whichever of these keys
// has a value." Both are pure / synchronous / no I/O.

export function pickFirstString(
  cf: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): string | null {
  if (!cf) return null;
  for (const k of keys) {
    const v = cf[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

// Pattern-aware profile-URL picker. Tries the supplied preferred
// list first (highest-precedence known keys), then any other key
// matching `/profile$/i` so newly-introduced variants like
// "Zillow Profile" or "Realtor.com Profile" surface without a
// code change.
export function pickProfileUrl(
  cf: Record<string, unknown> | null | undefined,
  preferred: readonly string[],
): string | null {
  if (!cf) return null;
  const explicit = pickFirstString(cf, preferred);
  if (explicit) return explicit;
  const profileKeys = Object.keys(cf)
    .filter((k) => /profile$/i.test(k))
    .sort((a, b) => a.localeCompare(b));
  return pickFirstString(cf, profileKeys);
}

// Canonical key lists. Centralised so the table cell, the mobile
// card, the detail drawer, and any future surface stay in sync.

export const PHONE_KEYS: readonly string[] = [
  "Phone Number",
  "phone number",
  "Phone number",
  "phone_number",
  "PhoneNumber",
  "phone",
  "Phone",
  "mobile",
  "Mobile",
  "cell",
  "Cell",
];

export const AGENT_PROFILE_PREFERRED_KEYS: readonly string[] = [
  "Courted Profile",
  "courted profile",
  "Agent Profile",
  "agent profile",
  "agentProfile",
  "agent_profile",
  "Zillow Profile",
  "Realtor.com Profile",
  "StreetEasy Profile",
  "realtor profile",
  "brokerage profile",
  "website",
  "Website",
  "url",
  "URL",
];

// Whole-dollar production fields that should render as $XXX,XXX,XXX in the
// portal: Sales Volume, List-side, Buy-side (and their "($)" label variants).
// Excludes the "(#)" COUNT variants (e.g. "List-side (#)" = 0 deals), which are
// not dollar amounts. Match is casing / separator / suffix tolerant.
export function isPortalCurrencyField(key: string): boolean {
  const k = key.toLowerCase();
  if (k.includes("#")) return false; // "(#)" = a deal count, not a dollar figure
  const norm = k.replace(/[^a-z]/g, "");
  return norm === "salesvolume" || norm === "listside" || norm === "buyside";
}

// Render a custom-field value for the portal. For the currency fields above,
// when the value is a plain number (optionally already carrying $ / commas),
// return it as whole-dollar USD ($12,500,000). Anything else — a range like
// "$54K - $385K", an abbreviation, non-numeric text, an empty value, or any
// non-currency field — is returned stringified & trimmed, UNCHANGED, so this
// can never mangle a value it doesn't fully understand.
export function formatPortalFieldValue(key: string, value: unknown): string {
  const raw = value == null ? "" : String(value).trim();
  if (raw === "" || !isPortalCurrencyField(key)) return raw;
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return raw; // not a plain number → leave as-is
  return `$${Math.round(Number(cleaned)).toLocaleString("en-US")}`;
}

export const LICENSE_KEYS: readonly string[] = [
  "License Number",
  "License number",
  "license number",
  "LicenseNumber",
];

export const YEARS_KEYS: readonly string[] = [
  "Years In Business",
  "Years in Business",
  "years in business",
  "Years in Industry",
  "Industry Tenure",
  "Est. time in industry",
  "experience",
  "years_experience",
];
