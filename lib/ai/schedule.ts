/*
 * Copied from BrokerStaffer OS, deliberately.
 *
 * Both apps read the same database and must run the reply agent by the same
 * rules, so this file is kept in step with
 * `src/lib/tools/master-inbox/ai/schedule.ts` in the workspace. If one changes,
 * change the other. There is no shared package between the two deployments.
 */
/*
 * When a live agent is allowed to send.
 *
 * ---------------------------------------------------------------------------
 * THE QUESTION THIS ANSWERS
 *
 * Plan §5: an agent sends either 24/7, or only OUTSIDE business hours — the
 * after-hours and weekend cover that is the whole reason the client asked for
 * this. Inside business hours an off-hours agent still writes the reply; it
 * just holds it, and the release job (ai/release.ts) sends it when the window
 * opens.
 *
 * ---------------------------------------------------------------------------
 * WHOSE CLOCK
 *
 * The requirements record leaves this open (Q4: reply managers are outside the
 * US, leads are in it), so the timezone is per-agent configuration and this
 * module never reads the server's clock zone. Railway containers run UTC; a
 * "9 to 5" evaluated in UTC would send during New York's afternoon, which is
 * exactly the failure this feature exists to avoid.
 *
 * `Intl.DateTimeFormat` with an explicit `timeZone` is the whole mechanism.
 * It handles DST for free, which a stored UTC offset would not: the window
 * must move with the clocks, not with the number we wrote down in March.
 *
 * ---------------------------------------------------------------------------
 * PURE, AND TESTED THAT WAY
 *
 * Every function takes `now` as an argument. No `Date.now()` anywhere, so the
 * tests can stand at 4:59pm on a Friday in New York and ask what happens.
 */

import type { AgentSchedule } from "./agent-config";

export interface LocalClock {
  /** 0 = Sunday … 6 = Saturday, in the schedule's timezone. */
  weekday: number;
  /** Minutes since local midnight. */
  minutes: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/**
 * What time it is for this agent.
 *
 * An invalid IANA zone makes `Intl` throw. That must not take down a webhook,
 * so it is caught and reported — and the caller treats "we do not know what
 * time it is" as "do not send", never as "send".
 */
export function localClock(now: Date, timezone: string): LocalClock | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);

    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const weekday = WEEKDAY_INDEX[get("weekday")];
    // hourCycle h23 still renders midnight as "24" in some ICU versions.
    const hour = Number(get("hour")) % 24;
    const minute = Number(get("minute"));
    if (weekday === undefined || Number.isNaN(hour) || Number.isNaN(minute)) return null;
    return { weekday, minutes: hour * 60 + minute };
  } catch {
    return null;
  }
}

function toMinutes(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Is `now` inside the agent's configured business hours?
 *
 * Returns null when the question cannot be answered (bad timezone, unparseable
 * window). Callers must read null as "unknown", and unknown must never send.
 */
export function isWithinBusinessHours(schedule: AgentSchedule, now: Date): boolean | null {
  const clock = localClock(now, schedule.timezone);
  if (!clock) return null;
  if (!schedule.businessDays.includes(clock.weekday)) return false;

  const start = toMinutes(schedule.businessStart);
  const end = toMinutes(schedule.businessEnd);
  if (start === null || end === null) return null;
  /*
   * An end at or before the start describes no window at all. Rather than
   * treat the whole day as sendable — which would turn a misconfigured
   * off-hours agent into a 24/7 one — the whole day counts as business hours
   * and the agent holds everything. Visibly stuck beats invisibly sending.
   */
  if (end <= start) return true;

  return clock.minutes >= start && clock.minutes < end;
}

export type SendWindow =
  | { open: true }
  | { open: false; reason: "inside_business_hours" | "schedule_unreadable" };

/**
 * May a live agent send RIGHT NOW?
 *
 * The only place the schedule turns into a yes/no. `always` is an unconditional
 * yes; `off_hours` is a yes exactly when we are outside the business window.
 */
export function sendWindow(schedule: AgentSchedule, now: Date): SendWindow {
  if (schedule.kind === "always") return { open: true };
  const inside = isWithinBusinessHours(schedule, now);
  if (inside === null) return { open: false, reason: "schedule_unreadable" };
  return inside ? { open: false, reason: "inside_business_hours" } : { open: true };
}

/**
 * When does the window next open? Used to tell a person how long a held reply
 * will wait, and by nothing that decides whether to send.
 *
 * Walks forward in 15-minute steps for up to eight days. Crude on purpose: the
 * arithmetic alternative has to re-implement DST transitions, and this runs
 * once per held reply on a screen, not per message.
 */
export function nextWindowOpensAt(schedule: AgentSchedule, now: Date): Date | null {
  if (sendWindow(schedule, now).open) return now;
  const STEP_MS = 15 * 60 * 1000;
  const LIMIT = (8 * 24 * 60) / 15;
  for (let i = 1; i <= LIMIT; i++) {
    const at = new Date(now.getTime() + i * STEP_MS);
    if (sendWindow(schedule, at).open) return at;
  }
  return null;
}

/** Human-readable summary for the config screen and the API. */
export function describeSchedule(schedule: AgentSchedule): string {
  if (schedule.kind === "always") return "24/7";
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = schedule.businessDays.map((d) => names[d] ?? "?").join(", ");
  return `Outside ${schedule.businessStart}–${schedule.businessEnd} on ${days} (${schedule.timezone})`;
}
