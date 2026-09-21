/*
 * The exact thread from the bug report: Alex Williams, whose record holds the
 * phone AND the brokerage, and who was asked for both.
 *
 * The shipped draft read:
 *   "Can you confirm that (your phone number) is the best number to reach you?
 *    Also, are you currently affiliated with a brokerage?"
 */
import { readFileSync } from "node:fs";
import { generateReplyDraft } from "../lib/ai/reply.ts";
import { findLeadPhone } from "../lib/ai/lead-phone.ts";

const env = Object.fromEntries(readFileSync(".env.local","utf8").split("\n").filter(l=>l.includes("=")&&!l.trimStart().startsWith("#")).map(l=>[l.slice(0,l.indexOf("=")).trim(), l.slice(l.indexOf("=")+1).replace(/^["']|["']$/g,"")]));
const U = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL, K = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: K, Authorization: `Bearer ${K}` };
const KEY = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY;
if (!KEY) { console.log("no OPENAI_API_KEY in .env.local — cannot draft"); process.exit(0); }

const THREAD = "690a1ec3-d927-42f3-a6d9-b0057dec0e10";
const msgs = await (await fetch(`${U}/rest/v1/messages?select=direction,body_text,sent_at&thread_id=eq.${THREAD}&order=sent_at.asc`,{headers:H})).json();
const conversation = msgs.map((m) => ({ direction: m.direction, sentAt: m.sent_at, body: m.body_text ?? "" }));

const lead = (await (await fetch(`${U}/rest/v1/leads?select=full_name,email,company,custom_fields&email=eq.alex@reitseed.com`,{headers:H})).json())[0];
const cf = lead.custom_fields ?? {};
const recordPhone = cf["phone number"] ?? null;
const hit = findLeadPhone(conversation, recordPhone);
console.log(`phone chosen: ${hit?.phone ?? "none"}   (source: ${hit?.source ?? "-"})`);

const SENSITIVE = /gci|commission|volume|buy.?side|list.?side|sales|income|revenue|price/i;
const ALREADY = /^(phone|company|title|email|name|first|last)/i;
const leadFacts = Object.entries(cf).filter(([k,v]) => typeof v === "string" && v.trim() && !SENSITIVE.test(k) && !ALREADY.test(k))
  .slice(0,12).map(([k,v]) => ({ label: k.replace(/[_-]+/g," ").trim(), value: String(v).slice(0,120) }));
console.log("facts passed:", leadFacts.map(f=>f.label).join(", ") || "(none)");
console.log("facts WITHHELD as commercially sensitive:", Object.keys(cf).filter(k=>SENSITIVE.test(k)).join(", "));

const { body } = await generateReplyDraft({
  provider: "openai", apiKey: KEY, model: "gpt-4o-mini",
  systemPrompt: "You are an outbound-sales rep responding to inbound replies from leads. Be direct, warm and concise. Plain text only. No subject, no greeting, no sign-off — just the body.",
  tone: "professional", responseLength: "medium", temperature: 0.3, maxTokens: 400,
  leadName: lead.full_name, leadEmail: lead.email,
  leadPhone: hit?.phone ?? null, leadCompany: lead.company, leadTitle: null, leadFacts,
  ourName: "Nicole Collins", ourEmail: "nicole.collins@withrealtylabs.com",
  subject: "Re: Confidential conversation?", conversation,
});

const text = body.replace(/\s+/g, " ").trim();
console.log(`\n── the draft now ──\n${text}\n`);

let pass=0, fail=0;
const ok=(n)=>{pass++;console.log(`  ok    ${n}`)}; const no=(n,w)=>{fail++;console.log(`  FAIL  ${n} — ${w}`)};
/\((your|his|her|their)[^)]*\)/i.test(text) ? no("no bracketed placeholder", text.match(/\([^)]*\)/)?.[0]) : ok("no bracketed placeholder");
/are you (currently )?affiliated with a brokerage/i.test(text) ? no("does not ask if they have a brokerage", "still asks") : ok("does not ask if they have a brokerage");
/what('s| is) your (phone|number)|best number to reach you\?/i.test(text) && !text.includes("312-7187") ? no("does not ask for a number it holds","still asks") : ok("does not ask for a number it holds");
/252,500|6,944|\$0\b/.test(text) ? no("never quotes the lead's financials", text.match(/[\d,]+/)?.[0]) : ok("never quotes the lead's financials");
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
