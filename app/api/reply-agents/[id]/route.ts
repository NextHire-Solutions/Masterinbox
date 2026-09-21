import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/workspace";
import { saveAgent, deleteAgent, LiveModeNotEnabledError } from "@/lib/ai/agent";
import { normaliseUpgradeFields, upgradeFieldsSchema } from "@/lib/ai/agent-schema";

export const dynamic = "force-dynamic";

const PROVIDERS = ["openai", "anthropic", "openrouter", "vllm"] as const;
const MODES = ["human_in_loop", "auto"] as const;
const LENGTHS = ["short", "medium", "long", "variable"] as const;
const CHANNEL_FILTERS = ["email", "both"] as const;

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  mode: z.enum(MODES).optional(),
  tone: z.string().min(1).max(80).optional(),
  response_length: z.enum(LENGTHS).optional(),
  max_tokens: z.number().int().min(64).max(200000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  provider: z.enum(PROVIDERS).optional(),
  model: z.string().min(1).max(120).optional(),
  api_key: z.string().nullable().optional(),
  system_prompt: z.string().nullable().optional(),
  channel_ids: z.array(z.string().uuid()).optional(),
  channel_filter: z.enum(CHANNEL_FILTERS).optional(),
  active: z.boolean().optional(),
  auto_respond_new: z.boolean().optional(),
  ...upgradeFieldsSchema,
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const session = await requireSession();
  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  try {
    await saveAgent({
      workspaceId: session.activeWorkspace.id,
      id,
      name: parsed.data.name,
      mode: parsed.data.mode,
      tone: parsed.data.tone,
      response_length: parsed.data.response_length,
      max_tokens: parsed.data.max_tokens,
      temperature: parsed.data.temperature,
      provider: parsed.data.provider,
      model: parsed.data.model,
      apiKey:
        parsed.data.api_key === undefined
          ? undefined
          : parsed.data.api_key === ""
            ? null
            : parsed.data.api_key,
      system_prompt: parsed.data.system_prompt,
      channel_ids: parsed.data.channel_ids,
      channel_filter: parsed.data.channel_filter,
      active: parsed.data.active,
      auto_respond_new: parsed.data.auto_respond_new,
      run_mode: parsed.data.run_mode,
      client_ids: parsed.data.client_ids,
      ...normaliseUpgradeFields(parsed.data),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Refused by policy, not malformed — see ai/live-gate.ts. This is the
    // request an inline "go live" toggle in the UI would make, and it is the
    // reason that toggle cannot arm an agent.
    if (err instanceof LiveModeNotEnabledError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Save failed" },
      { status: 400 },
    );
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const session = await requireSession();
  try {
    await deleteAgent(session.activeWorkspace.id, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Delete failed" },
      { status: 400 },
    );
  }
}
