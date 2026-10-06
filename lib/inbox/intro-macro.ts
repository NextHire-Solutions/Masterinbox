/*
 * The introduction macro — copied from the workspace, deliberately.
 *
 * Both apps read the same database and must produce the same sentence from
 * the same client record, so this file is kept byte-identical to
 * `src/lib/tools/master-inbox/inbox/intro-macro.ts` in BrokerStaffer OS. If
 * one changes, change the other. There is no shared package between the two
 * deployments, and inventing one to carry ninety lines would be worse.
 */
/*
 * The introduction macro — one wording, rendered two ways.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MODULE EXISTS
 *
 * The same paragraph is produced in two places and they must never drift:
 *
 *   1. Onboarding a client writes an "Intro Macro - <client>" row into
 *      `reply_templates`, so the wording is in the Templates picker and in
 *      the standalone Master Inbox as well.
 *   2. The Introduce button in the composer renders it on demand, from the
 *      client's CURRENT details, so correcting a role or a brokerage in
 *      Clients → Edit changes what the next introduction says.
 *
 * Before this module the wording lived inline in the clients API route and
 * (2) did not exist. Both now call `renderIntroMacroTemplate`.
 *
 * ---------------------------------------------------------------------------
 * TWO KINDS OF VALUE
 *
 * The client's values (who is being introduced) are known when a template is
 * written, so they are substituted HERE, into literal text.
 *
 * The lead's values (who is being introduced TO) are only known when a
 * particular conversation is open, so they stay as `{{lead.*}}` placeholders
 * and are resolved by `substituteVariables` at insert time — the same
 * substitution the Templates picker has always used, so a macro inserted by
 * the button and one inserted from the picker read identically.
 */

export interface IntroMacroClient {
  /** The client's name on the roster. Used when `brokerage` is empty. */
  name: string;
  /** Who the agent is introduced to: "Nicole Collins". */
  contactName: string | null;
  /** Their role, as it reads in the sentence: "Team Leader". */
  contactRole: string | null;
  /** The brokerage named in the body and the sign-off. */
  brokerage: string | null;
  /**
   * Overrides the first name derived from `contactName`.
   *
   * The clients API has always taken `client_first_name` as its own field, so
   * a caller that sends something other than the first word keeps getting
   * exactly what it sent. Everything else derives it.
   */
  contactFirstName?: string | null;
  /**
   * The first contact's address, copied in by the Introduce button.
   *
   * Optional because the macro's WORDING never uses it — only the Cc does —
   * and every caller that renders wording without one keeps working.
   */
  contactEmail?: string | null;
  /**
   * The second and third people to introduce the agent to, when the client
   * has them. Clients asked to introduce an agent to a team leader, a
   * managing broker and an owner at once, with all three copied in.
   *
   * Optional and separate from the first contact so that every caller written
   * before this existed keeps producing exactly the sentence it produced
   * before — see `renderIntroMacroTemplate`.
   */
  extraContacts?: IntroMacroContact[] | null;
  /**
   * The client's own introduction, pasted on the record (os_clients.
   * intro_override, OS migration 0026). When set it replaces the standard
   * wording below; it may use the same {{lead.*}} / {{sender.*}} fields.
   */
  introOverride?: string | null;
  /** The first contact's territories (os_clients.contact_territories, 0029). See `routeIntro`. */
  contactTerritories?: string[] | null;
  /** Wording by market or person (os_clients.intro_variants, 0030). See `pickIntroVariant`. */
  introVariants?: IntroVariant[] | null;
}

/** One of the people an agent is introduced to. */
export interface IntroMacroContact {
  /** "Shaurs Patel". */
  name: string | null;
  /** "Managing Broker" — how it reads in the sentence. */
  role: string | null;
  /** Copied in by the Introduce button. Not needed to be named. */
  email?: string | null;
  /** Overrides the first name derived from `name`. */
  firstName?: string | null;
  /**
   * The places this person covers — "Charleston", "Summerville" — matched
   * against the lead's campaign name by `routeIntro`. Empty: every lead.
   */
  territories?: string[] | null;
}

/**
 * Everyone this client introduces to, first contact first, in order.
 *
 * A person counts only when they have BOTH a name and a role: the sentence
 * reads "<name>, <role>", so half a contact would render "Shaurs Patel, at
 * Oz Group". Half-filled people are refused at the edit screen rather than
 * quietly dropped here, but this stays defensive — it is also what the
 * composer and the template writer read.
 */
export function introContacts(client: IntroMacroClient): IntroMacroContact[] {
  const all: IntroMacroContact[] = [
    {
      name: client.contactName,
      role: client.contactRole,
      email: client.contactEmail ?? null,
      firstName: client.contactFirstName ?? null,
      territories: client.contactTerritories ?? null,
    },
    ...(client.extraContacts ?? []),
  ];
  return all.filter((c) => (c.name ?? "").trim() && (c.role ?? "").trim());
}

/** Every address to copy in, de-duplicated, in the order the people appear. */
export function introContactEmails(client: IntroMacroClient): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of introContacts(client)) {
    const email = (c.email ?? "").trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

/**
 * "A", "A and B", "A, B and C" — the plain English list.
 *
 * No comma before the final "and": these are bare first names with nothing
 * inside them to confuse, and it matches how the client writes it.
 */
function joinPlain(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * "A, Role", "A, Role, and B, Role" — the list of named people.
 *
 * A comma DOES precede the final "and" here, because every item already
 * contains a comma of its own and without it the last two run together.
 */
function joinNamed(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/** The fields the macro cannot be written without. */
export const REQUIRED_INTRO_FIELDS = ["contactName", "contactRole"] as const;

/**
 * Which required values are missing, as labels fit for a tooltip.
 *
 * `brokerage` is not required: it falls back to the client's own name, which
 * is what the Onboard dialog has always done with an empty brokerage field.
 */
export function missingIntroFields(client: IntroMacroClient): string[] {
  const out: string[] = [];
  if (!client.contactName?.trim()) out.push("contact name");
  if (!client.contactRole?.trim()) out.push("their role");
  return out;
}

export function hasIntroDetails(client: IntroMacroClient): boolean {
  return missingIntroFields(client).length === 0;
}

/**
 * First word of a name: "Nicole Collins" → "Nicole".
 *
 * Deliberately simple — the Onboard dialog has always derived the first name
 * this way, and matching it keeps templates written before this module and
 * after it identical.
 */
export function firstNameOf(full: string | null | undefined): string {
  return (full ?? "").trim().split(/\s+/)[0] ?? "";
}

/**
 * "Nicole Collins, Team Leader" — everyone this client introduces to, exactly
 * as the macro's first line names them.
 *
 * Exported so the edit screen's live preview shows the real sentence rather
 * than an approximation of it. One function, so the two cannot drift.
 */
export function introPeopleSentence(client: IntroMacroClient): string {
  const contacts = introContacts(client);
  const named = contacts.length
    ? contacts.map((c) => `${(c.name ?? "").trim()}, ${(c.role ?? "").trim()}`)
    : [`${(client.contactName ?? "").trim()}, ${(client.contactRole ?? "").trim()}`];
  return joinNamed(named);
}

/**
 * The macro, with the client's details filled in and the lead's left as
 * `{{lead.*}}` placeholders.
 *
 * Byte-for-byte the wording that has been going into `reply_templates` since
 * onboarding was built; a test pins it so an edit here cannot silently change
 * what every existing client's template says.
 *
 * A client with two or three contacts names all of them on the SAME line —
 * "I'd like to introduce you to A, Role, B, Role, and C, Role at Oz Group" —
 * and the two sentences that follow address them together. With one contact
 * every join collapses to that one person, so the output is identical to what
 * it has always been. That is the whole reason the lists are built rather than
 * branched on: there is no separate one-contact path to drift.
 */
export function renderIntroMacroTemplate(client: IntroMacroClient): string {
  const brokerage = (client.brokerage ?? "").trim() || client.name;
  const contacts = introContacts(client);

  // Defensive: a caller with no usable contact at all still gets the shape it
  // used to get, with empty values, rather than a sentence with holes in it.
  const firsts = contacts.length
    ? contacts.map((c) => (c.firstName ?? "").trim() || firstNameOf(c.name))
    : [(client.contactFirstName ?? "").trim() || firstNameOf(client.contactName)];

  const people = introPeopleSentence(client);
  const firstNames = joinPlain(firsts);

  return (
    /*
     * The lead's FIRST name, not their full name.
     *
     * It was `{{lead.name}}`, which produced "Hey Gisele Abrantes Trautman,".
     * Nobody opens an email to a person they are about to introduce with all
     * three of their names. Changed on the client's instruction.
     */
    `Hey {{lead.first_name}},\n\n` +
    `I'd like to introduce you to ${people} at ${brokerage}\n\n` +
    `${firstNames}, I recently connected with {{lead.first_name}}, ` +
    `who can be reached directly at {{lead.phone_number}} and is currently with {{lead.company}}.\n\n` +
    `{{lead.first_name}}, ${firstNames} will be in touch directly to ` +
    `learn more about your business and discuss the opportunity in greater detail.\n\n` +
    `I hope you have a productive conversation!\n\n` +
    `Best,\n{{sender.name}}\nTalent Acquisition | ${brokerage}`
  );
}

/** The name given to a client's stored template. Used to find it again. */
export function introTemplateName(clientName: string): string {
  return `Intro Macro - ${clientName}`;
}

/* ------------------------------------------------------------------------ */

/** The client's custom introduction, when one is set (blank counts as none). */
export function customIntro(client: IntroMacroClient): string | null {
  const t = (client.introOverride ?? "").trim();
  return t ? t : null;
}

/** The introduction to use: the client's custom one, else the standard wording. */
export function introText(client: IntroMacroClient): string {
  return customIntro(client) ?? renderIntroMacroTemplate(client);
}

/**
 * Whether there is an introduction to send. A custom intro is enough on its
 * own; otherwise the standard wording needs the contact name and role.
 */
export function introReady(client: IntroMacroClient): boolean {
  return customIntro(client) !== null || hasIntroDetails(client);
}

/* ------------------------------------------------------------------------ */

/** At most this many people per client — three columns, then the rest (0028). */
export const MAX_INTRO_CONTACTS = 10;

/**
 * People 4 and up, from os_clients.more_contacts (OS migration 0028): an
 * ordered list of { name, role, email }. Anything malformed is dropped rather
 * than trusted, and the list is capped so 3 + these never exceeds the limit.
 */
export function moreContactsFrom(value: unknown): IntroMacroContact[] {
  if (!Array.isArray(value)) return [];
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return value
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({ name: str(x.name), role: str(x.role), email: str(x.email), territories: territoriesFrom(x.territories) }))
    .filter((x) => x.name || x.role || x.email)
    .slice(0, MAX_INTRO_CONTACTS - 3);
}

/* ------------------------------------------------------------------------ */
/*
 * TERRITORIES (Jeff Cook, 6 Oct).
 *
 * A client with one point of contact per territory wants each lead introduced
 * to that territory's people only. The territory is already known for every
 * lead: each campaign is built for one territory and says so in its name
 * ("Jeff Cook Real Estate + Charleston, SC + ZF NS1"), and every thread
 * records its campaign. So each person may list the places they cover, and a
 * person is introduced when one of those places appears in the campaign name.
 *
 * People 1-3 keep theirs in os_clients.contact_territories ({"1": [...],
 * "2": [...], "3": [...]}, OS migration 0029); people 4+ inside their own
 * more_contacts entry. A client with no territories anywhere is untouched.
 */

/** At most this many places per person. */
export const MAX_TERRITORIES = 10;

/** A list of place names, cleaned: trimmed, blanks and repeats dropped, capped. */
export function territoriesFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    const t = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
    if (t && !out.some((o) => placeKey(o) === placeKey(t))) out.push(t);
  }
  return out.slice(0, MAX_TERRITORIES);
}

/** Person `slot`'s (1-3) territories from os_clients.contact_territories. */
export function slotTerritories(value: unknown, slot: 1 | 2 | 3): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return territoriesFrom((value as Record<string, unknown>)[String(slot)]);
}

/**
 * How a place or a campaign name is compared: accents, case, dashes and
 * punctuation ignored, so "Charlotte–Triad, NC" contains "charlotte" and
 * "Mt. Pleasant" equals "mt pleasant".
 */
export function placeKey(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Whether `place` appears in `campaignName` as whole words. */
export function campaignCovers(campaignName: string | null | undefined, place: string): boolean {
  const p = placeKey(place);
  return !!p && ` ${placeKey(campaignName)} `.includes(` ${p} `);
}

export interface IntroRoute {
  /** False when nobody on this client has a territory: everyone, as always. */
  byTerritory: boolean;
  /** The places in the campaign name that picked the people. */
  matched: string[];
  /** Territories are set but the campaign names none of them: everyone is introduced. */
  fallback: boolean;
  /** Who this lead is introduced to, by name, in order. */
  people: string[];
  /** The wording variant this lead gets (its label or places), or null for the client's usual intro. */
  variant?: string | null;
}

/**
 * The client as THIS lead's introduction needs it: only the people whose
 * territory appears in the lead's campaign name, plus anyone with no
 * territory (they are on every introduction). When the campaign names no
 * territory at all, everyone — a lead is never left without a person.
 *
 * Returns a client whose contact fields hold just those people, so the
 * wording, the Cc and the reply agent's handover need no change of their own.
 */
export function routeIntro(
  client: IntroMacroClient,
  campaignName: string | null | undefined,
): { client: IntroMacroClient; route: IntroRoute } {
  const routed = routePeople(client, campaignName);
  const picked = pickIntroVariant(client.introVariants ?? [], campaignName, routed.route);
  if (!picked) return { client: routed.client, route: { ...routed.route, variant: null } };
  return {
    client: { ...routed.client, introOverride: picked.text },
    route: { ...routed.route, variant: variantName(picked) },
  };
}

/** Who the lead is introduced to, by territory — `routeIntro` before any wording variant. */
function routePeople(
  client: IntroMacroClient,
  campaignName: string | null | undefined,
): { client: IntroMacroClient; route: IntroRoute } {
  const people = introContacts(client);
  const names = (list: IntroMacroContact[]) => list.map((c) => (c.name ?? "").trim());
  const covers = (c: IntroMacroContact) => (c.territories ?? []).filter((t) => campaignCovers(campaignName, t));
  if (!people.some((c) => (c.territories ?? []).length)) {
    return { client, route: { byTerritory: false, matched: [], fallback: false, people: names(people) } };
  }
  const hits = people.filter((c) => covers(c).length);
  if (!hits.length) {
    return { client, route: { byTerritory: true, matched: [], fallback: true, people: names(people) } };
  }
  const keep = people.filter((c) => !(c.territories ?? []).length || hits.includes(c));
  const matched: string[] = [];
  for (const c of hits) for (const t of covers(c)) if (!matched.some((m) => placeKey(m) === placeKey(t))) matched.push(t);
  const [first, ...rest] = keep;
  return {
    client: {
      ...client,
      contactName: first.name,
      contactRole: first.role,
      contactEmail: first.email ?? null,
      contactFirstName: first.firstName ?? null,
      contactTerritories: first.territories ?? null,
      extraContacts: rest,
    },
    route: { byTerritory: true, matched, fallback: false, people: names(keep) },
  };
}

/** The os_clients columns `introClientFromRow` reads. */
export const INTRO_ROW_COLUMNS =
  "name, contact_name, contact_role, contact_email, " +
  "contact2_name, contact2_role, contact2_email, " +
  "contact3_name, contact3_role, contact3_email, brokerage, intro_override, more_contacts, contact_territories, intro_variants";

/**
 * An os_clients row as the macro needs it: person 1, people 2-3 from their
 * columns, 4+ from more_contacts (0028), each with their territories (0029),
 * and the custom intro (0026). A column a migration has not added yet reads
 * as empty. One mapping for the Introduce button and the reply agent.
 */
export function introClientFromRow(row: Record<string, unknown>, fallbackName: string): IntroMacroClient {
  const str = (k: string) => (typeof row[k] === "string" && (row[k] as string)) || null;
  return {
    name: str("name") ?? fallbackName,
    contactName: str("contact_name"),
    contactRole: str("contact_role"),
    contactEmail: str("contact_email"),
    contactTerritories: slotTerritories(row.contact_territories, 1),
    extraContacts: [
      ...([2, 3] as const).map((n) => ({
        name: str(`contact${n}_name`),
        role: str(`contact${n}_role`),
        email: str(`contact${n}_email`),
        territories: slotTerritories(row.contact_territories, n),
      })),
      ...moreContactsFrom(row.more_contacts),
    ],
    brokerage: str("brokerage"),
    introOverride: str("intro_override"),
    introVariants: introVariantsFrom(row.intro_variants),
  };
}

/* ------------------------------------------------------------------------ */
/*
 * WORDING BY MARKET OR PERSON (client feedback, 6 Oct; os_clients.intro_variants,
 * OS migration 0030).
 *
 * A client may want one introduction for Charleston leads and another for
 * Columbia's, or a different one whenever Angela is the person introduced.
 * Each variant names the places it is for (matched against the lead's
 * campaign name, exactly as territories are) and/or the people it is for, and
 * the first variant that fits wins. None fits: the client's usual intro.
 *
 * A person-based variant applies only when the lead was routed to that person
 * by territory. When the campaign names no territory everyone is introduced,
 * and "Angela is among everyone" says nothing about this lead.
 */

export interface IntroVariant {
  id: string;
  /** What the team calls it: "Charleston". Optional. */
  label: string | null;
  /** Places matched against the campaign name. */
  places: string[];
  /** People it is for, by name. */
  people: string[];
  /** The introduction, with the same {{lead.*}} / {{sender.*}} fields. */
  text: string;
}

export const MAX_INTRO_VARIANTS = 20;
export const MAX_INTRO_VARIANT_TEXT = 5000;

/** os_clients.intro_variants, cleaned: malformed entries and blank texts dropped, capped. */
export function introVariantsFrom(value: unknown): IntroVariant[] {
  if (!Array.isArray(value)) return [];
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const out: IntroVariant[] = [];
  value.forEach((x, i) => {
    if (!x || typeof x !== "object") return;
    const r = x as Record<string, unknown>;
    const text = typeof r.text === "string" ? r.text.replace(/\r\n/g, "\n").trim().slice(0, MAX_INTRO_VARIANT_TEXT) : "";
    const places = territoriesFrom(r.places);
    const people = territoriesFrom(r.people);
    if (!text || (!places.length && !people.length)) return;
    out.push({ id: str(r.id) ?? `v${i + 1}`, label: str(r.label), places, people, text });
  });
  return out.slice(0, MAX_INTRO_VARIANTS);
}

/** How a variant is named to the team: its label, else its places and people. */
export function variantName(v: IntroVariant): string {
  return v.label ?? [...v.places, ...v.people].join(", ");
}

/** The variant this lead gets, or null. See the section comment for the person rule. */
export function pickIntroVariant(
  variants: IntroVariant[],
  campaignName: string | null | undefined,
  route: Pick<IntroRoute, "byTerritory" | "fallback" | "people">,
): IntroVariant | null {
  const routedTo = route.byTerritory && !route.fallback ? route.people.map(placeKey) : [];
  for (const v of variants) {
    if (v.places.some((p) => campaignCovers(campaignName, p))) return v;
    if (v.people.some((p) => routedTo.includes(placeKey(p)))) return v;
  }
  return null;
}

/* ------------------------------------------------------------------------ */
/*
 * THE SUBJECT (client feedback, 6 Oct): "Intro: {Lead First Name} & {Client
 * Brokerage}". With no first name for the lead, just the brokerage — never
 * "Intro:  & Oz Group".
 */

/** The brokerage an introduction names: the client's, else the client's name. */
export function introBrokerage(client: Pick<IntroMacroClient, "brokerage" | "name">): string {
  return (client.brokerage ?? "").trim() || client.name.trim();
}

export function introSubject(brokerage: string, leadFirstName: string | null | undefined): string {
  const first = (leadFirstName ?? "").trim();
  const b = brokerage.trim();
  return first ? `Intro: ${first} & ${b}` : `Intro: ${b}`;
}

/* ------------------------------------------------------------------------ */
/*
 * A LEAD WITH NO PHONE (client feedback, 6 Oct): the sentence is rewritten
 * rather than left with a hole — "who can be reached directly at  and is
 * currently with Compass" becomes "who is currently with Compass". Covers the
 * standard wording and the four ways the clients' own intros phrase it; any
 * other gap is still filled with nothing and named above Send.
 *
 * Works on the TEMPLATE, before substitution, so the composer can still list
 * what is missing from what is left.
 */
const PHONE = String.raw`\{\{\s*lead\.phone_number\s*\}\}`;
const COMPANY = String.raw`\{\{\s*lead\.company\s*\}\}`;

export function fitIntroToLead(
  template: string,
  lead: { name?: string | null; email?: string | null; phone?: string | null; company?: string | null; title?: string | null } | null | undefined,
): string {
  const phone = !!(lead?.phone ?? "").trim();
  const company = !!(lead?.company ?? "").trim();
  let t = template;
  // "InterCoast Properties, Inc." ending a sentence: one full stop, not two.
  if (/\.\s*$/.test(lead?.company ?? "")) t = t.replace(new RegExp(`(${COMPANY})\\.`, "g"), "$1");
  if (phone && company) return t;
  // ", who can be reached directly at {{phone}} and is currently with {{company}}"
  t = t.replace(new RegExp(String.raw`(,?)\s*who can be reached directly (?:at|to)\s+${PHONE}\s+and is currently with\s+${COMPANY}`, "gi"),
    (_m, comma: string) =>
      phone ? `${comma} who can be reached directly at {{lead.phone_number}}`
        : company ? `${comma} who is currently with {{lead.company}}`
          : "");
  if (!phone) {
    // ", who can be reached directly at {{phone}}" closing a sentence.
    t = t.replace(new RegExp(String.raw`,?\s*who can be reached directly (?:at|to)\s+${PHONE}(?=\s*[.!])`, "gi"), "");
    // A sentence of its own: "{{lead.first_name}} can be reached directly at {{phone}}."
    // (A field like {{lead.first_name}} has a dot inside it, so fields are stepped over whole.)
    t = t.replace(new RegExp(String.raw`(?:\{\{[^}]*\}\}|[^\n.!?{}])*\bcan be reached directly (?:at|to)\s+${PHONE}\s*[.!]?[ \t]*`, "gi"), "");
  }
  if (!company) {
    t = t.replace(new RegExp(String.raw`,?\s*who is currently with\s+${COMPANY}(?=\s*[.!])`, "gi"), "");
  }
  return t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}
