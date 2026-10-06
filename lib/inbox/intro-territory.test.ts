import assert from "node:assert/strict";
import { test } from "node:test";
import { renderIntroMacroTemplate } from "./intro-macro";
/* ---------------------------------------------------------------- territories (6 Oct) --- */
import { routeIntro, campaignCovers, slotTerritories, territoriesFrom, introContactEmails, moreContactsFrom } from "./intro-macro";

const jeff = {
  name: "Jeff Cook Real Estate",
  brokerage: "Jeff Cook Real Estate",
  contactName: "Alma Nowatzke", contactRole: "Talent Specialist", contactEmail: "alma@jc.test",
  contactTerritories: ["Myrtle Beach", "Greenville"],
  extraContacts: [
    { name: "Angela Oakes", role: "Growth Advisor", email: "angela@jc.test", territories: ["Charlotte"] },
    { name: "Lance Overstreet", role: "Management Team", email: "lance@jc.test", territories: ["Charleston", "Summerville"] },
    { name: "Stan Taylor", role: "Management Team", email: "stan@jc.test", territories: ["Charleston", "Summerville"] },
    { name: "Stewart Samples", role: "Management Team", email: "stewart@jc.test", territories: ["Columbia"] },
  ],
};

test("territories: each of Jeff Cook's real campaign names reaches its own people only", () => {
  const cases: Array<[string, string[]]> = [
    ["Jeff Cook Real Estate + Charlotte–Triad, NC + ZF NS1 (EST)", ["Angela Oakes"]],
    ["Jeff Cook Real Estate + Charleston, SC + ZF NS1 (EST)", ["Lance Overstreet", "Stan Taylor"]],
    ["Jeff Cook Real Estate + Charleston–Summerville + ZF NS1 SEPT-2026 (EST)", ["Lance Overstreet", "Stan Taylor"]],
    ["Jeff Cook Real Estate LPT Realty 3 + Nicole + Moncks Corner, Summerville, Ladson, Goose Creek, Ridgeville, Hanahan", ["Lance Overstreet", "Stan Taylor"]],
    ["Jeff Cook Real Estate + Myrtle Beach + ZF NS1 SEPT-2026 (EST)", ["Alma Nowatzke"]],
    ["Jeff Cook Real Estate + Greenville + ZF NS1 SEPT-2026 (EST)", ["Alma Nowatzke"]],
    ["Jeff Cook (Personal Emails) - Columbia MLS", ["Stewart Samples"]],
  ];
  for (const [campaign, want] of cases) {
    const { client, route } = routeIntro(jeff, campaign);
    assert.deepEqual(route.people, want, campaign);
    assert.equal(route.fallback, false, campaign);
    assert.deepEqual(introContactEmails(client), want.map((n) => `${n.split(" ")[0].toLowerCase()}@jc.test`), campaign);
  }
});

test("territories: the intro names the territory's people in one sentence, like any multi-person intro", () => {
  const { client } = routeIntro(jeff, "Jeff Cook Real Estate + Charleston, SC + ZF NS1 (EST)");
  const text = renderIntroMacroTemplate(client);
  assert.match(text, /introduce you to Lance Overstreet, Management Team, and Stan Taylor, Management Team at Jeff Cook Real Estate/);
  assert.match(text, /Lance and Stan, I recently connected/);
  assert.doesNotMatch(text, /Alma|Angela|Stewart/);
});

test("territories: a campaign naming no territory introduces everyone, and says so", () => {
  const { client, route } = routeIntro(jeff, "Interested ZF - With Phone Number");
  assert.equal(route.fallback, true);
  assert.equal(introContactEmails(client).length, 5);
  assert.equal(routeIntro(jeff, null).route.fallback, true);
});

test("territories: someone with no territory is on every introduction", () => {
  const withOwner = { ...jeff, extraContacts: [...jeff.extraContacts, { name: "Jeff Cook", role: "Owner", email: "jeff@jc.test", territories: [] }] };
  assert.deepEqual(routeIntro(withOwner, "Jeff Cook Real Estate + Columbia + ZF").route.people, ["Stewart Samples", "Jeff Cook"]);
});

test("territories: a client with none set is exactly as before", () => {
  const plain = { name: "Oz Group", brokerage: "Oz Group", contactName: "A B", contactRole: "Owner", contactEmail: "a@oz.test" };
  const { client, route } = routeIntro(plain, "Oz Group + Charleston");
  assert.equal(client, plain);
  assert.equal(route.byTerritory, false);
});

test("territories: whole words only, any case, accents and dashes ignored", () => {
  assert.equal(campaignCovers("X + Charlotte–Triad, NC", "charlotte"), true);
  assert.equal(campaignCovers("X + North Charleston", "Charleston"), true);
  assert.equal(campaignCovers("X + Charlestonian", "Charleston"), false);
  assert.equal(campaignCovers("X + Charleston", "Charlotte"), false);
  assert.equal(campaignCovers("X + Mt. Pleasant", "Mt Pleasant"), true);
  assert.equal(campaignCovers("X + Myrtle Beach", ""), false);
});

test("territories: stored values are cleaned, and people 1-3 read by slot", () => {
  assert.deepEqual(territoriesFrom([" Charleston ", "", "charleston", 4, "Summerville"]), ["Charleston", "Summerville"]);
  assert.deepEqual(territoriesFrom("Charleston"), []);
  assert.deepEqual(slotTerritories({ "1": ["Greenville"], "3": ["Columbia"] }, 3), ["Columbia"]);
  assert.deepEqual(slotTerritories({ "1": ["Greenville"] }, 2), []);
  assert.deepEqual(slotTerritories(null, 1), []);
  assert.deepEqual(moreContactsFrom([{ name: "A", role: "R", email: null, territories: ["Columbia"] }])[0].territories, ["Columbia"]);
});

test("territories: a stored row maps to the same client the button and the agent use", async () => {
  const { introClientFromRow } = await import("./intro-macro");
  const c = introClientFromRow({
    name: "Jeff Cook Real Estate", contact_name: "Alma Nowatzke", contact_role: "Talent Specialist", contact_email: "alma@jc.test",
    contact2_name: "Angela Oakes", contact2_role: "Growth Advisor", contact2_email: "angela@jc.test",
    contact3_name: null, contact3_role: null, contact3_email: null, brokerage: "Jeff Cook Real Estate", intro_override: "",
    more_contacts: [{ name: "Stewart Samples", role: "Management Team", email: "stewart@jc.test", territories: ["Columbia"] }],
    contact_territories: { "1": ["Myrtle Beach", "Greenville"], "2": ["Charlotte"] },
  }, "x");
  assert.equal(c.introOverride, null);
  assert.deepEqual(routeIntro(c, "JC + Greenville + ZF").route.people, ["Alma Nowatzke"]);
  assert.deepEqual(routeIntro(c, "JC + Columbia MLS").route.people, ["Stewart Samples"]);
  // Before 0029 (no contact_territories column): everyone, as today.
  const old = introClientFromRow({ name: "Jeff Cook Real Estate", contact_name: "Alma Nowatzke", contact_role: "Talent Specialist" }, "x");
  assert.equal(routeIntro(old, "JC + Greenville").route.byTerritory, false);
});

/* ---- 6 Oct: subject, a lead with no phone, wording by market or person ---- */
import { fitIntroToLead, introSubject, introBrokerage, introVariantsFrom, pickIntroVariant, renderIntroMacroTemplate as renderStd } from "./intro-macro";

test("intro subject: Intro: first name & brokerage, never a hole", () => {
  assert.equal(introSubject("Jeff Cook Real Estate", "Gisele"), "Intro: Gisele & Jeff Cook Real Estate");
  assert.equal(introSubject("Oz Group", ""), "Intro: Oz Group");
  assert.equal(introSubject("Oz Group", null), "Intro: Oz Group");
  assert.equal(introBrokerage({ brokerage: " ", name: "The Karp Group" }), "The Karp Group");
});

test("no phone: the standard sentence is rewritten, not left with a blank", () => {
  const tpl = renderStd({ name: "Oz", contactName: "Nicole Collins", contactRole: "Team Leader", brokerage: "Oz Group" });
  const line = (t: string) => t.split("\n").find((l) => l.includes("I recently connected"))!;
  assert.equal(fitIntroToLead(tpl, { phone: "555", company: "Compass" }), tpl, "nothing missing: untouched");
  assert.equal(line(fitIntroToLead(tpl, { phone: "", company: "Compass" })), "Nicole, I recently connected with {{lead.first_name}}, who is currently with {{lead.company}}.");
  assert.equal(line(fitIntroToLead(tpl, { phone: "555", company: null })), "Nicole, I recently connected with {{lead.first_name}}, who can be reached directly at {{lead.phone_number}}.");
  assert.equal(line(fitIntroToLead(tpl, { phone: null, company: " " })), "Nicole, I recently connected with {{lead.first_name}}.");
  assert.ok(!fitIntroToLead(tpl, {}).includes("phone_number"));
});

test("no phone: the clients' own phrasings", () => {
  const own = "Hey {{lead.first_name}},\n\nJustin and Ananda, I recently connected with {{lead.first_name}}, who is currently with {{lead.company}}.\n\n{{lead.first_name}} can be reached directly at {{lead.phone_number}}.\n\n{{lead.first_name}}, Justin will be in touch.";
  assert.equal(fitIntroToLead(own, { company: "Compass" }),
    "Hey {{lead.first_name}},\n\nJustin and Ananda, I recently connected with {{lead.first_name}}, who is currently with {{lead.company}}.\n\n{{lead.first_name}}, Justin will be in touch.");
  assert.equal(fitIntroToLead("I met {{lead.first_name}}, who can be reached directly to {{lead.phone_number}}. Next.", { company: "x" }), "I met {{lead.first_name}}. Next.");
  assert.equal(fitIntroToLead("with {{lead.first_name}}, who can be reached directly at  {{lead.phone_number}} and is currently with {{lead.company}}.", { company: "x" }),
    "with {{lead.first_name}}, who is currently with {{lead.company}}.");
  assert.equal(fitIntroToLead("Text with no phone field.", {}), "Text with no phone field.");
});

test("variants: by place in the campaign name, by routed person, first wins, none → usual", () => {
  const vs = introVariantsFrom([
    { id: "a", label: "Charleston", places: ["Charleston"], people: [], text: "CHS intro" },
    { id: "b", places: [], people: ["Angela Oakes"], text: "Angela intro" },
    { id: "bad", places: [], people: [], text: "no target" },
    { id: "blank", places: ["Columbia"], text: "  " },
  ]);
  assert.deepEqual(vs.map((v) => v.id), ["a", "b"], "a variant needs text and a place or a person");
  const routed = { byTerritory: true, fallback: false, people: ["Angela Oakes"] };
  assert.equal(pickIntroVariant(vs, "JC + Charleston, SC + ZF", routed)?.id, "a");
  assert.equal(pickIntroVariant(vs, "JC + Charlotte", routed)?.id, "b");
  assert.equal(pickIntroVariant(vs, "Interested ZF", { byTerritory: true, fallback: true, people: ["Angela Oakes", "Alma"] }), null, "everyone introduced: a person variant does not apply");
  assert.equal(pickIntroVariant(vs, "Oz + Columbia", { byTerritory: false, fallback: false, people: ["Angela Oakes"] }), null);
});

test("routeIntro: the variant's wording replaces the client's usual intro for that lead only", () => {
  const client = {
    name: "Jeff Cook", contactName: "Angela Oakes", contactRole: "Growth Advisor", brokerage: "Jeff Cook Real Estate",
    contactTerritories: ["Charlotte"], introOverride: "usual",
    extraContacts: [{ name: "Stewart Samples", role: "Management Team", territories: ["Columbia"] }],
    introVariants: introVariantsFrom([{ id: "c", label: "Columbia", places: ["Columbia"], text: "Columbia wording" }]),
  };
  const col = routeIntro(client, "Jeff Cook Real Estate + Columbia + ZF");
  assert.equal(col.client.introOverride, "Columbia wording");
  assert.equal(col.route.variant, "Columbia");
  assert.deepEqual(col.route.people, ["Stewart Samples"]);
  const clt = routeIntro(client, "Jeff Cook Real Estate + Charlotte + ZF");
  assert.equal(clt.client.introOverride, "usual");
  assert.equal(clt.route.variant, null);
});

test("a lead's company ending in a full stop does not get a second one", () => {
  const t = "with {{lead.first_name}}, who can be reached directly at {{lead.phone_number}} and is currently with {{lead.company}}.\n\nNext.";
  assert.equal(fitIntroToLead(t, { phone: "1", company: "InterCoast Properties, Inc." }), t.replace("{{lead.company}}.", "{{lead.company}}"));
  assert.equal(fitIntroToLead(t, { phone: "1", company: "Compass" }), t);
});
