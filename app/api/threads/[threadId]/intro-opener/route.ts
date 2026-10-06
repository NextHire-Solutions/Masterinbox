import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/workspace";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { loadAiConfigWithKey } from "@/lib/ai/config";
import { stripQuoted } from "@/lib/ai/lead-phone";
import { OPENER_SYSTEM, cleanOpener, openerUserPrompt } from "@/lib/inbox/intro-opener";

/*
 * One opening line for the introduction, from the lead's latest reply (6 Oct).
 * Read-only: reads the conversation, asks the workspace's model, returns the
 * line. Nothing is stored or sent — the composer puts it in the draft, where
 * the operator reads it before sending.
 */
export const dynamic = "force-dynamic";

const stripHtml = (html: string) => html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function complete(provider: string, apiKey: string, model: string, system: string, user: string): Promise<string> {
  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 120, system, messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`the model answered ${res.status}`);
    const j = (await res.json()) as { content?: Array<{ text?: string }> };
    return j.content?.[0]?.text ?? "";
  }
  const base = provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, temperature: 0.3, max_tokens: 120, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`the model answered ${res.status}`);
  const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return j.choices?.[0]?.message?.content ?? "";
}

export async function POST(_request: Request, context: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await context.params;
  const session = await requireSession();
  const admin = createAdminSupabase();
  const { data: thread } = await admin.from("threads").select("id, workspace_id").eq("id", threadId).maybeSingle();
  if (!thread || thread.workspace_id !== session.activeWorkspace.id) {
    return NextResponse.json({ error: "No such conversation" }, { status: 404 });
  }
  const { data: last } = await admin
    .from("messages")
    .select("body_text, body_html")
    .eq("thread_id", threadId)
    .eq("direction", "inbound")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const reply = stripQuoted(((last?.body_text as string | null) ?? stripHtml((last?.body_html as string | null) ?? "")).trim());
  if (!reply) return NextResponse.json({ line: null, reason: "The lead has not replied yet." });

  const cfg = await loadAiConfigWithKey(session.activeWorkspace.id);
  if (!cfg?.api_key) return NextResponse.json({ line: null, reason: "No AI key is set for this workspace (Settings → AI)." });
  if (!["anthropic", "openai", "openrouter"].includes(cfg.provider)) {
    return NextResponse.json({ line: null, reason: `The workspace's AI provider (${cfg.provider}) is not supported for this.` });
  }
  try {
    const line = cleanOpener(await complete(cfg.provider, cfg.api_key, cfg.model, OPENER_SYSTEM, openerUserPrompt(reply)));
    return NextResponse.json(line ? { line } : { line: null, reason: "Their reply has nothing specific to pick up on." });
  } catch (e) {
    return NextResponse.json({ line: null, reason: `The line could not be written: ${e instanceof Error ? e.message : String(e)}` });
  }
}
