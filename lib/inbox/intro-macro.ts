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
