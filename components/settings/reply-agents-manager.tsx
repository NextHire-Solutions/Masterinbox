"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Pencil,
  Trash2,
  Bot,
  Eye,
  EyeOff,
  Search,
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Pause,
  Play,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ReplyAgent } from "@/lib/ai/agent";
import type { RunMode } from "@/lib/ai/agent-config";
import type { AgentStatsRow } from "@/lib/ai/stats";
import { cn } from "@/lib/utils";
import {
  ReplyAgentConfigDialog,
  describeSchedule,
  type ClientOption,
} from "@/components/settings/reply-agent-config-dialog";

/*
 * The per-agent numbers, plan §8. Read from GET /api/reply-agents/stats — the
 * same route an external tool reads — so the number on this screen and the
 * number in somebody's spreadsheet come from one reader. Until migration 0010
 * has run the route answers 503 with the reason, and the panel says so rather
 * than rendering an unexplained blank.
 */
type AgentStats = AgentStatsRow["stats"];

function pct(v: number | null): string {
  return v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`;
}

const PROVIDERS = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "vllm", label: "vLLM (self-hosted)" },
] as const;

const MODEL_OPTIONS: Record<string, string[]> = {
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "gpt-5-mini", "gpt-5"],
  anthropic: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-7"],
  openrouter: [
    "openai/gpt-4o-mini",
    "openai/gpt-4o",
    "anthropic/claude-haiku-4-5",
    "anthropic/claude-sonnet-4-6",
    "google/gemini-2.0-flash",
  ],
  vllm: ["meta-llama/Llama-3.1-8B-Instruct"],
};

const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
  openrouter: "openai/gpt-4o-mini",
  vllm: "meta-llama/Llama-3.1-8B-Instruct",
};

const TONE_OPTIONS = [
  { value: "professional", label: "Professional" },
  { value: "friendly", label: "Friendly" },
  { value: "casual", label: "Casual" },
  { value: "formal", label: "Formal" },
  { value: "persuasive", label: "Persuasive" },
  { value: "empathetic", label: "Empathetic" },
];

const LENGTH_OPTIONS: Array<{ value: Length; label: string }> = [
  { value: "short", label: "Short (1-2 sentences)" },
  { value: "medium", label: "Medium (1 paragraph)" },
  { value: "long", label: "Long (2-3 paragraphs)" },
  { value: "variable", label: "Variable (context-based)" },
];

// Token budgets — these cap the completion length. Reply drafts almost
// never need more than ~2k tokens; bigger budgets just waste credits and
// can exceed model caps (e.g. gpt-4o-mini's 16k completion limit).
const TOKEN_OPTIONS = [
  { value: 1000, label: "1k tokens (short replies)" },
  { value: 2000, label: "2k tokens (recommended)" },
  { value: 4000, label: "4k tokens (long replies)" },
  { value: 8000, label: "8k tokens (max)" },
];

type Provider = "openai" | "anthropic" | "openrouter" | "vllm";
type Length = "short" | "medium" | "long" | "variable";
type ChannelFilter = "email" | "both";

interface FormState {
  name: string;
  tone: string;
  response_length: Length;
  max_tokens: number;
  temperature: number;
  provider: Provider;
  model: string;
  api_key: string;
  system_prompt: string;
  channel_filter: ChannelFilter;
  active: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  tone: "professional",
  response_length: "medium",
  max_tokens: 2000,
  temperature: 0.4,
  provider: "openai",
  model: "gpt-4o-mini",
  api_key: "",
  system_prompt: "",
  channel_filter: "both",
  active: true,
};

export function ReplyAgentsManager({
  agents,
  clients,
  liveSendingEnabled,
}: {
  agents: ReplyAgent[];
  clients: ClientOption[];
  liveSendingEnabled: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ReplyAgent | null>(null);
  const [configuring, setConfiguring] = useState<ReplyAgent | null>(null);
  const [stats, setStats] = useState<Map<string, AgentStats> | null>(null);
  const [statsNote, setStatsNote] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Re-read whenever the roster changes (a save, a duplicate, a pause all
  // refresh the page and hand down a new `agents` array). setState only ever
  // runs inside the promise callbacks, never synchronously in the effect body.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/reply-agents/stats?per_page=200", { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.detail ?? json?.error ?? `Stats unavailable (${res.status})`);
        return (json?.data ?? []) as AgentStatsRow[];
      })
      .then((rows) => {
        if (cancelled) return;
        setStats(new Map(rows.map((r) => [r.agent_id, r.stats])));
        setStatsNote(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setStats(null);
        setStatsNote(e instanceof Error ? e.message : "Stats unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [agents]);

  async function patchAgent(a: ReplyAgent, body: Record<string, unknown>): Promise<string | null> {
    const res = await fetch(`/api/reply-agents/${a.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      return json.error ?? `Request failed (${res.status})`;
    }
    return null;
  }

  /*
   * Inline pause / activate, plan §7. One click, no dialog: pause is the kill
   * switch and a kill switch behind a modal is not one. "Activate" always
   * means shadow — nothing on this screen can arm an agent to live.
   */
  async function setMode(a: ReplyAgent, mode: RunMode) {
    setBusy(a.id);
    setNotice(null);
    const err = await patchAgent(a, { run_mode: mode });
    setBusy(null);
    if (err) {
      setNotice(err);
      return;
    }
    setNotice(
      mode === "pause"
        ? `${a.name} is paused. It will not touch another thread until you switch it back.`
        : `${a.name} is in ${mode} mode.`,
    );
    startTransition(() => router.refresh());
  }

  async function duplicate(a: ReplyAgent) {
    setBusy(a.id);
    setNotice(null);
    const res = await fetch(`/api/reply-agents/${a.id}/duplicate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(null);
    setNotice(res.ok ? json.note ?? "Duplicated." : json.error ?? "Duplicate failed");
    if (res.ok) startTransition(() => router.refresh());
  }
  const [step, setStep] = useState<1 | 2>(1);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setStep(1);
    setError(null);
    setShowKey(false);
    setOpen(true);
  }

  function openEdit(a: ReplyAgent) {
    setEditing(a);
    setForm({
      name: a.name,
      tone: a.tone,
      response_length: a.response_length,
      max_tokens: a.max_tokens,
      temperature: a.temperature,
      provider: a.provider,
      model: a.model,
      api_key: "",
      system_prompt: a.system_prompt ?? "",
      channel_filter: a.channel_filter,
      active: a.active,
    });
    setStep(1);
    setError(null);
    setShowKey(false);
    setOpen(true);
  }

  async function submit() {
    setError(null);
    const url = editing ? `/api/reply-agents/${editing.id}` : "/api/reply-agents";
    const method = editing ? "PATCH" : "POST";
    const body: Record<string, unknown> = {
      name: form.name,
      mode: "human_in_loop", // hardcoded — auto-respond intentionally removed
      tone: form.tone,
      response_length: form.response_length,
      max_tokens: form.max_tokens,
      temperature: form.temperature,
      provider: form.provider,
      model: form.model,
      system_prompt: form.system_prompt.trim() ? form.system_prompt : null,
      channel_filter: form.channel_filter,
      active: form.active,
      auto_respond_new: false,
    };
    if (form.api_key.trim()) body.api_key = form.api_key.trim();

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error ?? "Save failed");
      return;
    }
    setOpen(false);
    // Reset the search filter so the new/edited agent is visible. Otherwise
    // browser autofill or a stale query can hide it until a hard refresh.
    setSearch("");
    startTransition(() => router.refresh());
  }

  async function handleDelete(a: ReplyAgent) {
    if (!confirm(`Delete reply agent "${a.name}"?`)) return;
    const res = await fetch(`/api/reply-agents/${a.id}`, { method: "DELETE" });
    if (!res.ok) {
      alert("Delete failed");
      return;
    }
    startTransition(() => router.refresh());
  }

  const filtered = search.trim()
    ? agents.filter((a) => a.name.toLowerCase().includes(search.toLowerCase()))
    : agents;

  const canAdvance = step === 1 ? form.name.trim().length > 0 : true;

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? id.slice(0, 8);

  return (
    <div className="space-y-5">
      {/* Header row */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Reply Agents</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Create AI agents that automatically respond to prospect messages using full
            conversation context.
          </p>
        </div>
        <Button size="sm" onClick={openCreate} className="gap-1.5 shrink-0">
          <Plus className="size-3.5" />
          Create Agent
        </Button>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search agents by name"
          className="pl-8 h-9 text-sm"
          // Browser was autofilling the logged-in user's email into this
          // input and filtering everything out. Lock it down to prevent any
          // password-manager / address-book / browser-autocomplete writes.
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          type="search"
          name="agent_search"
          data-1p-ignore
          data-lpignore="true"
        />
      </div>

      {/* Info box */}
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm">
        <p className="font-semibold text-blue-900 mb-1.5">How Reply Agents Work:</p>
        <ul className="space-y-1 text-blue-900/90">
          <li>
            <span className="font-medium">Smart Monitoring:</span> Agents monitor threads where the
            last message is from a prospect
          </li>
          <li>
            <span className="font-medium">Context Analysis:</span> Uses full conversation history
            (last 20 messages) for intelligent replies
          </li>
          <li>
            <span className="font-medium">Human-in-Loop:</span> Creates drafts for your review
            before sending
          </li>
          <li>
            <span className="font-medium">Channel Integration:</span> Works with your existing
            email channels
          </li>
        </ul>
      </div>

      {/*
        * Stated once, at the top, rather than repeated on every card: Live is
        * off for the whole server, and this is the sentence that says why.
        */}
      {!liveSendingEnabled ? (
        <div
          className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
          data-testid="live-off-banner"
        >
          <p className="font-semibold mb-1">Live sending is off on this server.</p>
          <p className="text-amber-900/90">
            The whole live path is built — safety gate, schedule, off-hours release, the CC
            handover and the send itself — but nothing can send until someone sets{" "}
            <code className="text-[12px]">MASTER_INBOX_REPLY_AGENT_LIVE_SEND=1</code> deliberately.
            Shadow shows you exactly what an agent would have sent.
          </p>
        </div>
      ) : null}

      {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}

      {/* Empty state or agent grid */}
      {filtered.length === 0 ? (
        <div className="rounded-lg border bg-card py-14 text-center">
          <Bot className="size-7 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm font-medium">
            {search.trim() ? "No agents match your search." : "No agents yet"}
          </p>
          <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
            Create your first AI agent to start automating email responses. Your agent will monitor
            all prospect conversations and generate contextual replies.
          </p>
          <div className="mt-4">
            <Button size="sm" onClick={openCreate} className="gap-1.5">
              <Plus className="size-3.5" />
              Create Your First Agent
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {filtered.map((a) => (
            <div key={a.id} className="rounded-lg border bg-card p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold truncate">{a.name}</p>
                    <span
                      className={cn(
                        "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                        a.active
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-zinc-100 text-zinc-600",
                      )}
                    >
                      {a.active ? "Active" : "Inactive"}
                    </span>
                    <ModePill mode={a.run_mode} />
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {channelLabel(a.channel_filter)} · {a.provider} · {a.model}
                  </p>
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  {a.run_mode === "pause" ? (
                    <button
                      type="button"
                      onClick={() => setMode(a, "shadow")}
                      disabled={busy !== null}
                      className="size-7 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                      aria-label="Activate (shadow)"
                      title="Activate (shadow)"
                    >
                      <Play className="size-3.5" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setMode(a, "pause")}
                      disabled={busy !== null}
                      className="size-7 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                      aria-label="Pause"
                      title="Pause"
                    >
                      <Pause className="size-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setConfiguring(a)}
                    className="size-7 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                    aria-label="Configure"
                    title="Configure mode, clients, questions, handover, schedule"
                  >
                    <SlidersHorizontal className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => duplicate(a)}
                    disabled={busy !== null}
                    className="size-7 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                    aria-label="Duplicate"
                    title="Duplicate as a paused test variant"
                  >
                    <Copy className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => openEdit(a)}
                    className="size-7 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                    aria-label="Edit"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(a)}
                    disabled={pending}
                    className="size-7 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-red-600 transition-colors"
                    aria-label="Delete"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-y-1 text-xs">
                <span className="text-muted-foreground">Tone</span>
                <span className="capitalize">{a.tone}</span>
                <span className="text-muted-foreground">Length</span>
                <span className="capitalize">{a.response_length}</span>
                <span className="text-muted-foreground">Temperature</span>
                <span>{a.temperature.toFixed(2)}</span>
                <span className="text-muted-foreground">Max tokens</span>
                <span>{a.max_tokens.toLocaleString()}</span>
                <span className="text-muted-foreground">API key</span>
                <span className={a.has_api_key ? "text-emerald-600" : "text-amber-600"}>
                  {a.has_api_key ? "Configured" : "Not set"}
                </span>
                <span className="text-muted-foreground">Clients</span>
                <span className="truncate" title={a.client_ids.map(clientName).join(", ")}>
                  {a.client_ids.length === 0 ? "Any (house agent)" : a.client_ids.map(clientName).join(", ")}
                </span>
                <span className="text-muted-foreground">Questions</span>
                <span>
                  {a.qualification.enabled ? `${a.qualification.questions.length} asked` : "None"}
                </span>
                <span className="text-muted-foreground">Handover</span>
                <span className="truncate" title={a.handover.ccEmails.join(", ")}>
                  {a.handover.ccEmails.length > 0
                    ? `Introduction, CC client contacts + ${a.handover.ccEmails.join(", ")}`
                    : "Introduction, CC client contacts"}
                </span>
                <span className="text-muted-foreground">Schedule</span>
                <span className="truncate" title={describeSchedule(a.schedule)}>
                  {describeSchedule(a.schedule)}
                </span>
              </div>

              {/* ---- the numbers, plan §8 ---- */}
              {stats?.get(a.id) ? (
                <div className="grid grid-cols-4 gap-1.5 pt-1" data-testid="agent-stats">
                  <Metric label="Drafted" value={stats.get(a.id)!.replies_drafted} />
                  <Metric label="Sent" value={stats.get(a.id)!.replies_sent} sub={pct(stats.get(a.id)!.reply_rate)} />
                  <Metric label="Lead replies" value={stats.get(a.id)!.lead_replies_received} />
                  <Metric
                    label="Qualified"
                    value={stats.get(a.id)!.qualification_qualified}
                    sub={`${pct(stats.get(a.id)!.qualification_rate)} of ${stats.get(a.id)!.qualification_started}`}
                  />
                  <Metric
                    label="Handed over"
                    value={stats.get(a.id)!.qualification_handed_over}
                    sub={pct(stats.get(a.id)!.handover_rate)}
                  />
                  <Metric label="Stopped" value={stats.get(a.id)!.qualification_stopped} />
                  <Metric label="Held" value={stats.get(a.id)!.sends_held} sub="gate refused" />
                  <Metric label="Tokens" value={stats.get(a.id)!.tokens_total} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {statsNote ? (
        <p className="text-xs text-muted-foreground" data-testid="stats-note">
          <span className="font-medium text-foreground">No numbers yet.</span> {statsNote}
        </p>
      ) : null}

      <ReplyAgentConfigDialog
        agent={configuring}
        clients={clients}
        liveSendingEnabled={liveSendingEnabled}
        open={configuring !== null}
        onOpenChange={(v) => {
          if (!v) setConfiguring(null);
        }}
        onSaved={() => {
          setConfiguring(null);
          setNotice("Saved.");
          startTransition(() => router.refresh());
        }}
      />

      {/* 2-step wizard dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit Reply Agent" : "Create New Agent"}
            </DialogTitle>
            <p className="text-xs text-muted-foreground">
              Set up an AI agent for automated email responses
            </p>
          </DialogHeader>

          {/* Step indicator */}
          <div className="rounded-lg border bg-muted/30 px-4 py-3">
            <p className="text-xs font-semibold mb-2">
              {editing ? "Edit Agent" : "Create Agent"} – Step {step} of 2
            </p>
            <div className="flex items-center gap-3">
              <StepBadge n={1} active={step === 1} done={step > 1} label="General & Channels" hint="Agent settings and channels" />
              <div className="flex-1 h-px bg-border" />
              <StepBadge n={2} active={step === 2} done={false} label="AI Configuration" hint="AI model and behavior settings" />
            </div>
          </div>

          <div className="space-y-4 max-h-[55vh] overflow-y-auto pr-1">
            {step === 1 ? (
              <>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">
                    Agent Name <span className="text-red-500">*</span>
                  </label>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="e.g., Sales Support Agent"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Choose a descriptive name for your agent
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium">Tone of Voice</label>
                  <select
                    value={form.tone}
                    onChange={(e) => setForm({ ...form, tone: e.target.value })}
                    className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                  >
                    {TONE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium">Response Length</label>
                  <select
                    value={form.response_length}
                    onChange={(e) =>
                      setForm({ ...form, response_length: e.target.value as Length })
                    }
                    className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                  >
                    {LENGTH_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium">Max tokens per reply run</label>
                  <select
                    value={form.max_tokens}
                    onChange={(e) => setForm({ ...form, max_tokens: Number(e.target.value) })}
                    className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                  >
                    {TOKEN_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-muted-foreground">
                    Higher budgets allow longer + more context-aware drafts.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium">Channel</label>
                  <select
                    value={form.channel_filter}
                    onChange={(e) =>
                      setForm({ ...form, channel_filter: e.target.value as ChannelFilter })
                    }
                    className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                  >
                    <option value="both">All channels</option>
                    <option value="email">Email only</option>
                  </select>
                  <p className="text-[11px] text-muted-foreground">
                    Limits which inbound channels the agent drafts for.
                  </p>
                </div>

                <div className="flex items-center justify-between rounded-md border px-3 py-2">
                  <div>
                    <p className="text-sm">Active</p>
                    <p className="text-[11px] text-muted-foreground">
                      Drafts are only generated when the agent is active.
                    </p>
                  </div>
                  <Switch
                    checked={form.active}
                    onCheckedChange={(v) => setForm({ ...form, active: v })}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">Provider</label>
                    <select
                      value={form.provider}
                      onChange={(e) => {
                        const next = e.target.value as Provider;
                        setForm({
                          ...form,
                          provider: next,
                          model: DEFAULT_MODELS[next] ?? "",
                        });
                      }}
                      className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                    >
                      {PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">Model</label>
                    <select
                      value={
                        (MODEL_OPTIONS[form.provider] ?? []).includes(form.model)
                          ? form.model
                          : "__custom__"
                      }
                      onChange={(e) => {
                        if (e.target.value === "__custom__") {
                          setForm({ ...form, model: "" });
                        } else {
                          setForm({ ...form, model: e.target.value });
                        }
                      }}
                      className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                    >
                      {(MODEL_OPTIONS[form.provider] ?? []).map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                      <option value="__custom__">Custom…</option>
                    </select>
                  </div>
                </div>

                {!(MODEL_OPTIONS[form.provider] ?? []).includes(form.model) ? (
                  <Input
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                    placeholder="Custom model id"
                  />
                ) : null}

                <div className="space-y-1.5">
                  <label className="text-xs font-medium">API Key</label>
                  <div className="relative">
                    <Input
                      type={showKey ? "text" : "password"}
                      value={form.api_key}
                      onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                      placeholder={
                        editing?.has_api_key
                          ? "•••••• (saved — leave blank to keep)"
                          : "sk-…"
                      }
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 size-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground"
                    >
                      {showKey ? (
                        <EyeOff className="size-3.5" />
                      ) : (
                        <Eye className="size-3.5" />
                      )}
                    </button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Stored encrypted with pgcrypto. Never sent to the browser after save.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium">Temperature</label>
                  <Input
                    type="number"
                    step={0.1}
                    min={0}
                    max={2}
                    value={form.temperature}
                    onChange={(e) =>
                      setForm({ ...form, temperature: Number(e.target.value) })
                    }
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Lower = more deterministic. 0.3-0.5 is a good range for sales replies.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium">Custom system prompt (optional)</label>
                  <Textarea
                    value={form.system_prompt}
                    onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
                    rows={8}
                    placeholder="Leave blank to use the default sales-rep prompt"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    This is the system message the model receives on every draft. Use it to
                    inject your product/positioning context.
                  </p>
                </div>
              </>
            )}

            {error ? <p className="text-xs text-red-600">{error}</p> : null}
          </div>

          <DialogFooter className="gap-2">
            {step === 2 ? (
              <Button
                variant="outline"
                onClick={() => setStep(1)}
                className="gap-1.5 mr-auto"
              >
                <ArrowLeft className="size-3.5" />
                Back
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setOpen(false)} className="mr-auto">
                Cancel
              </Button>
            )}
            {step === 1 ? (
              <Button onClick={() => setStep(2)} disabled={!canAdvance} className="gap-1.5">
                Next
                <ArrowRight className="size-3.5" />
              </Button>
            ) : (
              <Button onClick={submit} disabled={pending} className="gap-1.5">
                <Check className="size-3.5" />
                {editing ? "Save changes" : "Create agent"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StepBadge({
  n,
  active,
  done,
  label,
  hint,
}: {
  n: number;
  active: boolean;
  done: boolean;
  label: string;
  hint: string;
}) {
  return (
    <div className="flex items-center gap-2 flex-1">
      <span
        className={cn(
          "size-7 rounded-full flex items-center justify-center text-xs font-semibold border-2 transition-colors shrink-0",
          active
            ? "border-blue-500 text-blue-600 bg-blue-50"
            : done
              ? "border-emerald-500 text-emerald-600 bg-emerald-50"
              : "border-muted-foreground/30 text-muted-foreground",
        )}
      >
        {done ? <Check className="size-3.5" /> : n}
      </span>
      <div className="min-w-0">
        <p className={cn("text-xs font-medium", active && "text-foreground")}>{label}</p>
        <p className="text-[10px] text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

function channelLabel(filter: ChannelFilter): string {
  if (filter === "email") return "Email";
  return "All";
}

function ModePill({ mode }: { mode: RunMode }) {
  const look: Record<RunMode, { text: string; className: string; title: string }> = {
    pause: {
      text: "Paused",
      className: "bg-zinc-100 text-zinc-600",
      title: "Does nothing on any thread.",
    },
    shadow: {
      text: "Shadow",
      className: "bg-blue-100 text-blue-700",
      title: "Writes a draft into the composer. Never sends.",
    },
    live: {
      text: "Live",
      className: "bg-emerald-100 text-emerald-700",
      title: "Sends automatically, within its schedule and the safety gate.",
    },
  };
  const l = look[mode];
  return (
    <span
      className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-medium", l.className)}
      title={l.title}
      data-testid="mode-pill"
    >
      {l.text}
    </span>
  );
}

function Metric({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="rounded-md border bg-muted/30 px-2 py-1.5 min-w-0">
      <p className="text-[10px] text-muted-foreground truncate">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value.toLocaleString()}</p>
      {sub ? <p className="text-[10px] text-muted-foreground truncate">{sub}</p> : null}
    </div>
  );
}
