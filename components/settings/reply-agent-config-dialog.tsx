"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Check, Plus, X } from "lucide-react";
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
import type { AgentSchedule, QualificationQuestion, RunMode } from "@/lib/ai/agent-config";
import { LIVE_SEND_ENV_VAR } from "@/lib/ai/live-gate";
import { cn } from "@/lib/utils";

/*
 * The Reply Agent config — mode, clients, questions, handover, schedule.
 *
 * Kept in step with the OS's src/components/screens/reply-agent-config.tsx in
 * FUNCTION: the same five sections, the same wire shape on save, the same
 * rules about what is offered. The rendering is this app's own — shadcn
 * primitives and Tailwind, the same as the wizard next to it — because a
 * screen that looks foreign to the settings area it sits in reads as broken.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DIALOG IS FOR
 *
 * Everything the upgrade plan's §7 says a person can change, minus voice and
 * model, which the existing two-step wizard already covers. Until now an agent
 * had a tone, a model and a channel; it now also has an operating mode that
 * is acted on, a client it belongs to, a script it works through and a
 * handover that introduces the client by CC.
 *
 * ---------------------------------------------------------------------------
 * WHY LIVE IS DISABLED RATHER THAN ABSENT
 *
 * The Live option is rendered, described, and not selectable, with the reason
 * next to it. A missing control looks like a feature that was forgotten; a
 * disabled one with an explanation is the system telling the truth about
 * itself. The server refuses `run_mode: "live"` independently (see
 * lib/ai/live-gate.ts) — this is the label, not the lock.
 */

export interface ClientOption {
  id: string;
  name: string;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function describeSchedule(s: AgentSchedule): string {
  if (!s || s.kind === "always") return "24/7";
  return `Outside ${s.businessStart}–${s.businessEnd}, ${s.businessDays.map((d) => DAY_NAMES[d]).join(" ")} (${s.timezone})`;
}

export function ReplyAgentConfigDialog({
  agent,
  clients,
  liveSendingEnabled,
  open,
  onOpenChange,
  onSaved,
}: {
  agent: ReplyAgent | null;
  clients: ClientOption[];
  liveSendingEnabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {agent ? (
          <AgentEditor
            key={agent.id}
            agent={agent}
            clients={clients}
            liveSendingEnabled={liveSendingEnabled}
            onClose={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AgentEditor({
  agent,
  clients,
  liveSendingEnabled,
  onClose,
  onSaved,
}: {
  agent: ReplyAgent;
  clients: ClientOption[];
  liveSendingEnabled: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<RunMode>(agent.run_mode);
  const [clientIds, setClientIds] = useState<string[]>(agent.client_ids);
  const [questions, setQuestions] = useState<QualificationQuestion[]>(agent.qualification.questions);
  const [qualEnabled, setQualEnabled] = useState(agent.qualification.enabled);
  const [required, setRequired] = useState(agent.qualification.required);
  const [passRule, setPassRule] = useState(agent.qualification.passRule);
  const [cc, setCc] = useState(agent.handover.ccEmails.join(", "));
  const [handoverMessage, setHandoverMessage] = useState(agent.handover.message);
  const [schedule, setSchedule] = useState<AgentSchedule>(agent.schedule);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function moveQuestion(i: number, by: number) {
    const next = [...questions];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    setQuestions(next);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/reply-agents/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_mode: mode,
          client_ids: clientIds,
          qualification: {
            enabled: qualEnabled,
            questions: questions
              .filter((q) => q.text.trim().length > 0)
              .map((q) => ({ id: q.id, text: q.text.trim() })),
            required,
            pass_rule: passRule,
          },
          handover: {
            cc_emails: cc
              .split(/[,;\s]+/)
              .map((x) => x.trim())
              .filter(Boolean),
            message: handoverMessage,
          },
          schedule:
            schedule.kind === "always"
              ? { kind: "always" }
              : {
                  kind: "off_hours",
                  timezone: schedule.timezone,
                  business_days: schedule.businessDays,
                  business_start: schedule.businessStart,
                  business_end: schedule.businessEnd,
                },
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `Save failed (${res.status})`);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Configure {agent.name}</DialogTitle>
        <p className="text-xs text-muted-foreground">
          Tone, model and temperature live in Edit. Everything about what this agent{" "}
          <i>does</i> is here.
        </p>
      </DialogHeader>

      <div className="space-y-6 max-h-[60vh] overflow-y-auto pr-1">
        {/* ---- mode ---- */}
        <Section title="Mode" sub="What this agent is allowed to do.">
          <div className="space-y-2">
            <Radio
              name="run_mode"
              checked={mode === "pause"}
              onChange={() => setMode("pause")}
              label="Pause"
              sub="Does nothing on any thread. The kill switch."
            />
            <Radio
              name="run_mode"
              checked={mode === "shadow"}
              onChange={() => setMode("shadow")}
              label="Shadow"
              sub="Qualifies and writes a draft into the composer. Never sends."
            />
            <Radio
              name="run_mode"
              checked={mode === "live"}
              onChange={() => liveSendingEnabled && setMode("live")}
              disabled={!liveSendingEnabled}
              label="Live"
              sub={
                liveSendingEnabled
                  ? "Sends automatically, within the schedule and the safety gate."
                  : `Unavailable: live sending is not enabled on this server (${LIVE_SEND_ENV_VAR} is unset) and the transport is deliberately not wired. Validate shadow first.`
              }
            />
          </div>
        </Section>

        {/* ---- clients ---- */}
        <Section
          title="Clients"
          sub="Whose threads this agent runs on. Leave empty and it is a house agent, covering any client that has no agent of its own."
        >
          <div className="flex flex-wrap gap-1.5 max-h-44 overflow-y-auto">
            {clients.length === 0 ? (
              <span className="text-xs text-muted-foreground">No client list available.</span>
            ) : (
              clients.map((c) => {
                const on = clientIds.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setClientIds(on ? clientIds.filter((x) => x !== c.id) : [...clientIds, c.id])
                    }
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                      on
                        ? "border-blue-300 bg-blue-50 text-blue-700"
                        : "border-border bg-muted/40 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {c.name}
                  </button>
                );
              })
            )}
          </div>
        </Section>

        {/* ---- qualification ---- */}
        <Section
          title="Qualification"
          sub="The questions it works through, one per reply, before the lead is handed over."
        >
          <div className="flex items-center justify-between rounded-md border px-3 py-2 mb-3">
            <div>
              <p className="text-sm">Ask these questions before handing over</p>
              <p className="text-[11px] text-muted-foreground">
                Off, and the agent replies as it does today with no script.
              </p>
            </div>
            <Switch checked={qualEnabled} onCheckedChange={(v) => setQualEnabled(v)} />
          </div>
          <div className="space-y-2">
            {questions.map((q, i) => (
              <div key={q.id} className="flex items-center gap-1.5">
                <span className="w-4 text-xs text-muted-foreground shrink-0">{i + 1}</span>
                <Input
                  value={q.text}
                  maxLength={400}
                  placeholder="e.g. Are you licensed in the state you want to work in?"
                  onChange={(e) =>
                    setQuestions(questions.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))
                  }
                  className="h-8 text-sm min-w-0"
                />
                <IconButton label="Move up" onClick={() => moveQuestion(i, -1)}>
                  <ArrowUp className="size-3.5" />
                </IconButton>
                <IconButton label="Move down" onClick={() => moveQuestion(i, 1)}>
                  <ArrowDown className="size-3.5" />
                </IconButton>
                <IconButton
                  label="Remove"
                  onClick={() => setQuestions(questions.filter((_, j) => j !== i))}
                  danger
                >
                  <X className="size-3.5" />
                </IconButton>
              </div>
            ))}
            {questions.length < 10 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() =>
                  setQuestions([...questions, { id: `q${questions.length + 1}-${Date.now()}`, text: "" }])
                }
              >
                <Plus className="size-3.5" />
                Add a question
              </Button>
            ) : null}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Answers needed</label>
              <Input
                type="number"
                min={0}
                max={10}
                value={required}
                onChange={(e) => setRequired(Number(e.target.value))}
                className="h-8 text-sm"
              />
              <p className="text-[11px] text-muted-foreground">0 means all of them.</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Pass rule</label>
              <select
                value={passRule}
                onChange={(e) => setPassRule(e.target.value as "all_answered" | "any_answered")}
                className="w-full h-8 rounded-md border bg-background px-2 text-sm"
              >
                <option value="all_answered">Every question answered</option>
                <option value="any_answered">Enough answers, any order</option>
              </select>
            </div>
          </div>
        </Section>

        {/* ---- handover ---- */}
        <Section
          title="Handover"
          sub="When the lead qualifies, the reply is the introduction — the same message the composer's Introduce button inserts. The agent reads the client from each conversation and CCs that client's introduction contacts automatically, so there is nothing to type here unless you want more."
        >
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Extra addresses to CC (optional)</label>
              <Input
                placeholder="extra@example.com"
                value={cc}
                onChange={(e) => setCc(e.target.value)}
                className="h-8 text-sm"
              />
              <p className="text-[11px] text-muted-foreground">
                CC defaults to the client&apos;s introduction contacts, up to three people from their
                record. Anything here is added on top, never instead.
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Message override (optional)</label>
              <Textarea
                rows={4}
                maxLength={4000}
                placeholder="Leave empty to use the introduction macro."
                value={handoverMessage}
                onChange={(e) => setHandoverMessage(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Empty means the introduction macro. Anything here replaces its wording; template
                variables such as {"{{lead.first_name}}"} still resolve.
              </p>
            </div>
            <p className="text-[11px] text-muted-foreground">
              A live introduction is always labelled Introduction once it has sent. That label is
              not bookkeeping — it notifies the client over n8n and Slack, opens a pipeline entry in
              their portal and pushes it to Follow Up Boss — and it goes through the same guarded
              labels path as the Introduce button, which never announces a thread that already
              carries it.
            </p>
          </div>
        </Section>

        {/* ---- schedule ---- */}
        <Section title="Schedule" sub="When a live agent may send. Ignored in pause and shadow.">
          <div className="space-y-2">
            <Radio
              name="schedule_kind"
              checked={schedule.kind === "always"}
              onChange={() => setSchedule({ ...schedule, kind: "always" })}
              label="24/7"
              sub="Replies go out whenever a lead responds."
            />
            <Radio
              name="schedule_kind"
              checked={schedule.kind === "off_hours"}
              onChange={() => setSchedule({ ...schedule, kind: "off_hours" })}
              label="Outside business hours only"
              sub="Inside the window it drafts and holds; the release job sends the held replies when the window opens."
            />
          </div>
          {schedule.kind === "off_hours" ? (
            <div className="mt-3 space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {DAY_NAMES.map((d, i) => {
                  const on = schedule.businessDays.includes(i);
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setSchedule({
                          ...schedule,
                          businessDays: on
                            ? schedule.businessDays.filter((x) => x !== i)
                            : [...schedule.businessDays, i].sort((a, b) => a - b),
                        })
                      }
                      className={cn(
                        "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                        on
                          ? "border-blue-300 bg-blue-50 text-blue-700"
                          : "border-border bg-muted/40 text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                <Input
                  value={schedule.businessStart}
                  placeholder="09:00"
                  onChange={(e) => setSchedule({ ...schedule, businessStart: e.target.value })}
                  className="h-8 text-sm min-w-0"
                />
                <span className="text-xs text-muted-foreground">to</span>
                <Input
                  value={schedule.businessEnd}
                  placeholder="17:00"
                  onChange={(e) => setSchedule({ ...schedule, businessEnd: e.target.value })}
                  className="h-8 text-sm min-w-0"
                />
              </div>
              <Input
                value={schedule.timezone}
                placeholder="America/New_York"
                onChange={(e) => setSchedule({ ...schedule, timezone: e.target.value })}
                className="h-8 text-sm"
              />
              <p className="text-[11px] text-muted-foreground">
                Business hours in that timezone. Outside them is when a live agent sends.
              </p>
            </div>
          ) : null}
        </Section>

        {error ? <p className="text-xs text-red-600">{error}</p> : null}
      </div>

      <DialogFooter className="gap-2">
        <Button variant="outline" onClick={onClose} disabled={saving} className="mr-auto">
          Cancel
        </Button>
        <Button onClick={save} disabled={saving} className="gap-1.5">
          <Check className="size-3.5" />
          {saving ? "Saving…" : "Save configuration"}
        </Button>
      </DialogFooter>
    </>
  );
}

function Section({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-[11px] text-muted-foreground mb-2 leading-relaxed">{sub}</p>
      {children}
    </section>
  );
}

function Radio({
  name,
  checked,
  onChange,
  label,
  sub,
  disabled,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  sub: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-2.5 rounded-md border px-3 py-2 text-sm",
        disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer hover:bg-accent/40",
        checked && !disabled && "border-blue-300 bg-blue-50/40",
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="mt-0.5"
      />
      <span className="min-w-0">
        <span className="font-medium">{label}</span>
        <span className="block text-[11px] text-muted-foreground leading-relaxed">{sub}</span>
      </span>
    </label>
  );
}

function IconButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "size-7 shrink-0 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent transition-colors",
        danger ? "hover:text-red-600" : "hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
