/*
 * The phone finder against real threads, to see what it picks and what it
 * refuses. Read-only: it drafts nothing and sends nothing.
 */
import { findLeadPhone } from "../lib/ai/lead-phone.ts";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(readFileSync(".env.local","utf8").split("\n").filter(l=>l.includes("=")&&!l.trimStart().startsWith("#")).map(l=>[l.slice(0,l.indexOf("=")).trim(), l.slice(l.indexOf("=")+1).replace(/^["']|["']$/g,"")]));
const U = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL, K = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: K, Authorization: `Bearer ${K}` };

const threads = await (await fetch(`${U}/rest/v1/threads?select=id,subject&order=updated_at.desc&limit=40`, { headers: H })).json();
let found = 0, refused = 0;
for (const t of threads.slice(0, 18)) {
  const msgs = await (await fetch(`${U}/rest/v1/messages?select=direction,body_text,sent_at&thread_id=eq.${t.id}&order=sent_at.asc`, { headers: H })).json();
  const conversation = (msgs ?? []).map((m) => ({ direction: m.direction, sentAt: m.sent_at, body: m.body_text ?? "" }));
  const hit = findLeadPhone(conversation, null);
  if (hit) { found++; console.log(`  ${hit.phone.padEnd(18)} ${String(hit.label ?? "unlabelled").padEnd(11)} ${String(t.subject ?? "").slice(0, 44)}`); }
  else refused++;
}
console.log(`\n  picked a number on ${found} threads, declined on ${refused}`);
