/*
 * Threads sitting on "Unknown" that WOULD now match a client.
 *
 * A thread's client is decided once, when the reply webhook arrives, from the
 * campaign name. Adding an alias afterwards fixes every future thread and none
 * of the existing ones — they keep the answer computed before the alias
 * existed. This finds them; APPLY=1 retags them.
 *
 * It re-derives with the SAME function the webhook uses, so a thread can never
 * be retagged to something the live path would not have chosen.
 */
import { readFileSync } from "node:fs";
import { deriveClientIdFromCampaign } from "../lib/clients/derive.ts";

const env = Object.fromEntries(readFileSync(".env.local","utf8").split("\n").filter(l=>l.includes("=")&&!l.trimStart().startsWith("#")).map(l=>[l.slice(0,l.indexOf("=")).trim(), l.slice(l.indexOf("=")+1).replace(/^["']|["']$/g,"")]));
const U = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL, K = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: K, Authorization: `Bearer ${K}`, "Content-Type": "application/json" };
const apply = process.env.APPLY === "1";

const unknown = (await (await fetch(`${U}/rest/v1/clients?select=id,name&slug=eq.unknown`, { headers: H })).json())[0];
const clients = await (await fetch(`${U}/rest/v1/clients?select=id,name`, { headers: H })).json();
const nameById = new Map(clients.map((c) => [c.id, c.name]));

const threads = await (await fetch(
  `${U}/rest/v1/threads?select=id,subject,campaign_name&client_id=eq.${unknown.id}&limit=1000`, { headers: H })).json();

let would = 0, noCampaign = 0, stillUnknown = 0;
const byClient = new Map();

for (const t of threads) {
  if (!t.campaign_name) { noCampaign++; continue; }
  const derived = await deriveClientIdFromCampaign(t.campaign_name);
  if (!derived || derived === unknown.id) { stillUnknown++; continue; }
  would++;
  const name = nameById.get(derived) ?? derived;
  byClient.set(name, (byClient.get(name) ?? 0) + 1);
  if (apply) {
    await fetch(`${U}/rest/v1/threads?id=eq.${t.id}`, {
      method: "PATCH", headers: { ...H, Prefer: "return=minimal" },
      body: JSON.stringify({ client_id: derived }),
    });
  }
}

console.log(`threads on "Unknown": ${threads.length}`);
console.log(`  ${apply ? "RETAGGED" : "would retag"}: ${would}`);
console.log(`  no campaign name recorded: ${noCampaign}   still no match: ${stillUnknown}\n`);
for (const [name, n] of [...byClient.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(n).padStart(3)} → ${name}`);
}
if (!apply) console.log("\n  dry run — set APPLY=1 to write");
