// Delivery engine: who may be texted, when, and what happens to an alert
// for someone who can't be texted yet.
//
// LoopMessage's rules (helpdesk "Is it possible to send an outbound text
// first?" and apidocs "Sending Messages"):
//
// - Texting a number that has never messaged the sender starts ("inits") a
//   conversation. That needs the Init-conversations feature, at least 15
//   minutes between initiations, a daily cap that warms up from 2 a day,
//   and a first message with no emails, phone numbers or links that lets
//   the person agree or unsubscribe.
// - Once a person has messaged the sender, replies need no interval.
// - Messages to people who haven't messaged recently need at least 2
//   minutes between them, or the request may be rejected. A welcome is one
//   of those too. (This one the operator chose not to follow for people
//   who've opted in: see coldIntervalMs and slowDown.)
// - If recipients report the sender, messages stop being delivered and the
//   sender can be blocked — every alert, for every client, stops.
//
// So an alert (which contains the lead's phone) never goes to someone who
// hasn't messaged the sender. A new number gets a short welcome, paced as
// an initiation, and its alerts are held. A YES-type reply is consent: it
// activates them and releases what was held. Anything less clear keeps the
// alerts held (see interpretReply in inbound.js).
//
// Contact lifecycle:
//
//   new ──alert──▶ welcome_queued ──welcome sent──▶ welcomed ──reply──▶ active
//    │                  │                              │
//    └──── they text the sender first ─────────────────┴────────────────▶ active
//
//   any ──STOP (or "no" before they're active)──▶ opted_out ──START/YES──▶ active
//   LoopMessage refuses the number ──▶ unreachable / welcome_failed
//   LoopMessage won't let us start it ──▶ needs_inbound (waits for them)
//
// Sends run one at a time under a lock. Replies and delivery events don't
// wait for it: they're applied the moment they arrive, so LoopMessage gets
// its 200 at once and a STOP takes effect even mid-release. Every send
// re-checks the contact after it returns, and nothing a send learns can
// undo an opt-out.
//
// State is saved after every change and before every send (store.js). A
// send the service was killed in the middle of counts as sent, and a send
// LoopMessage may have queued (timeout, 5xx) is never repeated: a missed
// text is logged, a duplicate can't be taken back.

import { randomUUID } from "node:crypto";
import { normalizePhone } from "./phone.js";
import { interpretReply, readReply } from "./inbound.js";
import { buildText, buildWelcomeText, isSafeInitialText, leadFromLegacyAlertText } from "./notify.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_CONFIG = Object.freeze({
  initIntervalMs: 15 * MINUTE,
  // null = follow LoopMessage's warm-up schedule (warmupCap).
  initDailyCap: null,
  // Spacing between texts to people who are opted in but haven't texted the
  // sender in the last day (welcomes share it). LoopMessage's docs ask for 2
  // minutes between such messages ("otherwise, your request may be
  // rejected"). The operator chose one per scheduler pass, about every 15
  // seconds (Oct 2026): everyone in this queue has opted in, and
  // "recently" may well mean weeks. If LoopMessage objects with a 540, the
  // service falls back to slowIntervalMs for slowModeMs (see slowDown).
  coldIntervalMs: 10 * 1000,
  slowIntervalMs: 2 * MINUTE,
  slowModeMs: HOUR,
  // LoopMessage doesn't define "recently"; a day is the assumption.
  recentInboundMs: 24 * HOUR,
  holdTtlMs: 24 * HOUR,
  maxHeldPerContact: 5,
  // As long as an alert can wait, so a lead fired again while its first
  // alert is held, queued or recently sent never becomes a second text.
  dedupeTtlMs: 24 * HOUR,
  // How long a reply's message_id is remembered. LoopMessage retries a
  // webhook for about 3 hours.
  inboundDedupeTtlMs: 24 * HOUR,
  rateLimitBackoffMs: HOUR,
  retryBackoffMs: 5 * MINUTE,
  maxAttempts: 3,
  brand: "BrokerStaffer",
});

// LoopMessage error codes (apidocs/error-codes) that decide what happens
// next. Anything not listed is retried a few times, then given up on.
const OPTED_OUT = new Set([500]);
const INVALID_CONTACT = new Set([150, 160, 165, 170, 180, 190]);
const NEEDS_INBOUND = new Set([510, 520, 530]);
// 540: "You have reached the limit of sending messages to recipients who
// have not been contacted for a long time." 550: the pricing plan's limit.
const RATE_LIMITED = new Set([540, 550]);
const TOO_FAST = 540;
// Credentials, sender name or account problems: nothing about the contact
// is wrong, so pause sending instead of failing the contact.
const CONFIG_ERRORS = new Set([110, 130, 210, 220, 230, 240, 250, 260, 270, 290, 300, 310, 320, 330]);

// Statuses an alert can't get past until a person acts.
const TERMINAL = new Set(["opted_out", "unreachable", "welcome_failed"]);

// LoopMessage's warm-up for new conversations per sender per day: days 1-2
// → 2, days 3-4 → 5, days 5-7 → 10, to day 14 → 20, then 30, and from day
// 22 → 50. Counted from our first welcome.
export function warmupCap(firstInitAt, now) {
  if (!firstInitAt) return 2;
  const day = Math.floor((now - firstInitAt) / DAY) + 1;
  if (day <= 2) return 2;
  if (day <= 4) return 5;
  if (day <= 7) return 10;
  if (day <= 14) return 20;
  if (day <= 21) return 30;
  return 50;
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function iso(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

function withoutUndefined(obj) {
  return Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => v !== undefined));
}

function dedupeKey(entryId, contact) {
  return `${entryId}:${contact}`;
}

// How a reply is read depends on where the person is (see interpretReply).
// Only someone who has had the welcome is asked for a YES; texting the
// sender before any welcome is itself opting in.
function stageOf(c) {
  if (c.status === "active") return "active";
  if (c.status === "opted_out") return "opted_out";
  // The welcome is out, or on its way: they're answering it.
  if (c.status === "welcomed" || c.welcomeInFlightAt) return "welcome";
  return "first_contact";
}

// Reply text for logs: enough to judge it, not a whole essay.
function excerpt(text) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

function isObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

// An alert as stored in a held list or the outbox: only its own fields, so
// no send-time marker (inFlightAt, notBefore) travels with a copy.
function alertCopy(alert) {
  return {
    entryId: alert.entryId,
    text: alert.text,
    lead: alert.lead ?? null,
    name: alert.name ?? null,
    passthrough: alert.passthrough,
    at: alert.at,
    ...(alert.attempts ? { attempts: alert.attempts } : {}),
  };
}

function normalizeState(raw) {
  const s = isObject(raw) ? raw : {};
  return {
    version: 2,
    contacts: isObject(s.contacts) ? s.contacts : {},
    welcomeQueue: Array.isArray(s.welcomeQueue) ? s.welcomeQueue : [],
    outbox: Array.isArray(s.outbox) ? s.outbox : [],
    // Introductions accepted by the webhook and not yet routed. Saved
    // before the webhook is answered, so a redeploy can't lose one.
    intake: Array.isArray(s.intake) ? s.intake : [],
    dedupe: isObject(s.dedupe) ? s.dedupe : {},
    // message_ids of replies already applied: LoopMessage retries webhooks.
    seenInbound: isObject(s.seenInbound) ? s.seenInbound : {},
    // Alerts LoopMessage accepted, by message_id, for its delivery events.
    sentAlerts: isObject(s.sentAlerts) ? s.sentAlerts : {},
    // The alert being sent straight away (to someone who texted recently),
    // so a restart mid-send can log it. Sends are one at a time.
    immediateInFlight: isObject(s.immediateInFlight) ? s.immediateInFlight : null,
    pacing: {
      lastInitAt: null,
      firstInitAt: null,
      // When each welcome of the last 24 hours went out (the daily cap).
      initTimes: null,
      initBlockedUntil: null,
      // Consecutive welcomes refused with 510/520/530, and who the first
      // of them parked (see onWelcomeNeedsInbound).
      initRefusalStreak: 0,
      parkedByStreak: null,
      lastColdAt: null,
      coldBlockedUntil: null,
      // While set and in the future, texts to people who haven't texted
      // recently go at LoopMessage's documented pace (see slowDown).
      slowUntil: null,
      ...(isObject(s.pacing) ? s.pacing : {}),
    },
  };
}

function previewStatus(status, recent) {
  if (status === "active") return recent ? "would_send_now" : "would_queue_paced";
  if (status === "new") return "would_hold_and_send_welcome";
  if (TERMINAL.has(status)) return `would_skip_${status}`;
  return "would_hold_awaiting_reply";
}

export class Engine {
  constructor({ store, send, now = () => Date.now(), config = {}, logger = console }) {
    this.store = store;
    this.send = send;
    this.now = now;
    this.logger = logger;
    this.config = { ...DEFAULT_CONFIG, ...withoutUndefined(config) };
    // A lead's dedupe key has to outlive its held alert, or a re-fire while
    // it's still held would hold (and later send) a second copy.
    this.config.dedupeTtlMs = Math.max(this.config.dedupeTtlMs, this.config.holdTtlMs);
    if (!isSafeInitialText(this.config.brand)) {
      throw new Error(
        "brand contains an email, link, phone number or currency, which LoopMessage forbids in a first message",
      );
    }
    const loaded = store.load();
    this.state = normalizeState(loaded);
    // True after a failed save, until one succeeds (see ensureSaved).
    this.dirty = false;
    // Sends waiting on LoopMessage's answer (see handleStatusEvent).
    this.sendsInFlight = 0;
    // Written by version 1, or by version 1 again after a rollback.
    this.migratePacing(Boolean(loaded) && loaded.version !== 2);
    this.lock = Promise.resolve();
    this.recoverInterrupted();
  }

  // Version 1 counted welcomes per UTC day, which allowed a full day's cap
  // either side of midnight. Rebuild the rolling window from when each
  // contact was welcomed, keeping any times this version recorded before a
  // rollback; if the day counter saw more welcomes than that (someone
  // welcomed twice), count the extra ones at the last welcome, which is
  // later than they really were and so errs towards fewer.
  migratePacing(fromV1) {
    const p = this.state.pacing;
    if (!fromV1 && Array.isArray(p.initTimes)) return;
    const now = this.now();
    const recent = (at) => Number.isFinite(at) && now - at < DAY;
    const known = [
      ...new Set([
        ...(Array.isArray(p.initTimes) ? p.initTimes : []),
        ...Object.values(this.state.contacts).map((c) => c?.welcomedAt),
      ]),
    ].filter(recent);
    const counted = Math.max(0, Math.floor(Number(p.initCountToday) || 0));
    const counterCurrent = recent(p.lastInitAt) && p.initDay === utcDay(p.lastInitAt);
    const knownThatDay = known.filter((at) => utcDay(at) === p.initDay).length;
    const extra = counterCurrent ? Math.max(0, counted - knownThatDay) : 0;
    p.initTimes = [...known, ...Array(extra).fill(p.lastInitAt)];
    if (fromV1) {
      // Version 1 didn't count a welcome toward the 2-minute spacing of
      // paced alerts, or keep dedupe keys for 24 hours (it used 6). Keys
      // with more than 6 hours left were made by this version: left alone.
      if (p.lastInitAt) p.lastColdAt = Math.max(p.lastColdAt ?? 0, p.lastInitAt);
      const extend = this.config.dedupeTtlMs - 6 * HOUR;
      if (extend > 0) {
        for (const [key, until] of Object.entries(this.state.dedupe)) {
          if (Number.isFinite(until) && until - now <= 6 * HOUR) this.state.dedupe[key] = until + extend;
        }
      }
    }
    delete p.initDay;
    delete p.initCountToday;
  }

  // A send the service was stopped in the middle of may have gone out. It
  // counts as sent: never repeated, and counted for pacing as of now.
  recoverInterrupted() {
    const t = this.now();
    let changed = false;
    for (const c of Object.values(this.state.contacts)) {
      if (c.welcomeInFlightAt) {
        delete c.welcomeInFlightAt;
        this.unqueueWelcome(c.contact);
        if (c.status === "welcome_queued") c.status = "welcomed";
        c.welcomedAt = t;
        c.welcomeMessageId = null;
        c.welcomeUnconfirmed = true;
        c.lastOutboundAt = t;
        this.countInit(t);
        this.log("warn", "welcome_send_interrupted", { contact: c.contact, team_member: c.name ?? null });
        changed = true;
      }
      const interrupted = (c.held ?? []).filter((a) => a.inFlightAt);
      if (interrupted.length > 0) {
        c.held = c.held.filter((a) => !a.inFlightAt);
        c.lastOutboundAt = t;
        for (const a of interrupted) {
          this.markSent(a.entryId, c.contact, t);
          this.log("warn", "alert_send_interrupted", { entry_id: a.entryId, contact: c.contact, team_member: c.name ?? null });
        }
        changed = true;
      }
    }
    const paced = this.state.outbox.filter((i) => i.inFlightAt);
    if (paced.length > 0) {
      this.state.outbox = this.state.outbox.filter((i) => !i.inFlightAt);
      this.state.pacing.lastColdAt = t;
      for (const i of paced) {
        this.markSent(i.entryId, i.contact, t);
        this.log("warn", "alert_send_interrupted", { entry_id: i.entryId, contact: i.contact, paced: true });
      }
      changed = true;
    }
    // A paced send whose item a STOP removed mid-send still started the
    // 2-minute clock.
    if (this.state.pacing.coldInFlightAt) {
      delete this.state.pacing.coldInFlightAt;
      this.state.pacing.lastColdAt = t;
      changed = true;
    }
    const immediate = this.state.immediateInFlight;
    if (immediate) {
      this.state.immediateInFlight = null;
      this.markSent(immediate.entryId, immediate.contact, t);
      const c = this.state.contacts[immediate.contact];
      if (c) c.lastOutboundAt = t;
      this.log("warn", "alert_send_interrupted", { entry_id: immediate.entryId, contact: immediate.contact });
      changed = true;
    }
    if (changed) this.persist();
  }

  // A lead that has (or may have) reached someone isn't sent to them again
  // for a full dedupe window from now, however long it was held first.
  markSent(entryId, contact, t) {
    const key = dedupeKey(entryId, contact);
    this.state.dedupe[key] = Math.max(this.state.dedupe[key] ?? 0, t + this.config.dedupeTtlMs);
  }

  // Serialize sends and the work around them. Replies and delivery events
  // don't go through here (see handleInbound).
  run(fn) {
    const result = this.lock.then(() => fn());
    this.lock = result.catch(() => {});
    return result;
  }

  // Resolves once everything queued so far has finished. Tests use it.
  idle() {
    return this.lock;
  }

  // Resolves once nothing is queued or running, including work queued
  // while waiting (a release started by a reply). For shutdown; false if
  // it didn't get there in time.
  async drain({ timeoutMs = 20_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = this.lock;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let timer;
      const timedOut = await Promise.race([
        current.then(() => false),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(true), remaining);
        }),
      ]);
      clearTimeout(timer);
      if (timedOut) return false;
      if (this.lock === current) return true;
    }
  }

  log(level, msg, fields = {}) {
    const line = JSON.stringify({ level, msg, ...fields });
    if (level === "error") this.logger.error(line);
    else if (level === "warn") this.logger.warn(line);
    else this.logger.log(line);
  }

  // Returns whether the state reached disk. Keeps running on the in-memory
  // state either way; the next change retries. Callers that promise
  // something is on disk (a send's in-flight mark, an acknowledged webhook)
  // check the result.
  persist() {
    try {
      this.store.save(this.state);
      this.dirty = false;
      return true;
    } catch (err) {
      this.dirty = true;
      this.log("error", "state_save_failed", { error: String(err?.message ?? err) });
      return false;
    }
  }

  // For webhook answers: whether everything applied so far is on disk,
  // retrying the save if an earlier one failed. A redelivered event that
  // changes nothing still gets a 503 until then, so LoopMessage keeps
  // delivering it rather than us acknowledging a change that isn't saved.
  ensureSaved() {
    return this.dirty ? this.persist() : true;
  }

  // The transport should never throw (loopmessage.js returns failures), but
  // if it does, nobody knows whether the message left: treat it as maybe
  // sent.
  async safeSend(message) {
    this.sendsInFlight += 1;
    try {
      const res = await this.send(message);
      if (res && typeof res === "object") return res;
      return { ok: false, ambiguous: true, status: null, code: null, error: "no_result" };
    } catch (err) {
      return { ok: false, ambiguous: true, status: null, code: null, error: String(err?.message ?? err) };
    } finally {
      this.sendsInFlight -= 1;
    }
  }

  isRecent(c, now) {
    return Boolean(c?.lastInboundAt) && now - c.lastInboundAt <= this.config.recentInboundMs;
  }

  dailyCap(now) {
    return this.config.initDailyCap ?? warmupCap(this.state.pacing.firstInitAt, now);
  }

  // Welcomes in the last 24 hours: the cap is rolling, so it can't be spent
  // twice around midnight.
  initsInWindow(now) {
    return this.state.pacing.initTimes.filter((at) => now - at < DAY).length;
  }

  countInit(t) {
    const p = this.state.pacing;
    p.lastInitAt = t;
    p.lastColdAt = t;
    p.firstInitAt ??= t;
    p.initTimes.push(t);
    p.initRefusalStreak = 0;
    p.parkedByStreak = null;
  }

  // Rate limits and sender/account problems are about the sender, not one
  // person: stop sending to anyone who hasn't texted recently.
  pauseSending(until) {
    const p = this.state.pacing;
    p.initBlockedUntil = Math.max(p.initBlockedUntil ?? 0, until);
    p.coldBlockedUntil = Math.max(p.coldBlockedUntil ?? 0, until);
  }

  // The gap to keep between texts to people who haven't texted recently:
  // the configured one, or LoopMessage's documented 2 minutes while slowed.
  coldInterval(now) {
    const p = this.state.pacing;
    const slowed = p.slowUntil && now < p.slowUntil;
    return slowed ? Math.max(this.config.coldIntervalMs, this.config.slowIntervalMs) : this.config.coldIntervalMs;
  }

  // LoopMessage said we're over its limit for people who haven't texted
  // recently (540). Go at its documented pace for a while, and wait one
  // such interval before the next try. If that's still refused, it's a
  // limit and not our pace: pause for the usual hour.
  slowDown(now) {
    const p = this.state.pacing;
    const alreadySlowed = p.slowUntil && now < p.slowUntil;
    p.slowUntil = now + this.config.slowModeMs;
    this.pauseSending(now + (alreadySlowed ? this.config.rateLimitBackoffMs : this.config.slowIntervalMs));
    return alreadySlowed;
  }

  // -------------------------------------------------------------------------
  // Lead alerts

  // The webhook's path: saved to disk before the caller is answered, routed
  // in the background. If the service stops first, the next start routes
  // it. `saved` is false when the disk write failed; it's still routed by
  // this process, but a restart would lose it.
  enqueueIntroduction(plan) {
    const item = { id: randomUUID(), plan, receivedAt: this.now() };
    this.state.intake.push(item);
    const saved = this.persist();
    this.drainIntake().catch((err) =>
      this.log("error", "intake_failed", { error: String(err?.message ?? err) }),
    );
    return { id: item.id, saved };
  }

  drainIntake() {
    return this.run(() => this.routeIntake());
  }

  async routeIntake() {
    while (this.state.intake.length > 0) {
      const item = this.state.intake[0];
      if (this.now() - (item.receivedAt ?? 0) > this.config.holdTtlMs) {
        // Older than any alert may wait (the service was down that long).
        // Routing it now could re-text people its first attempt reached.
        this.log("warn", "introduction_expired", { entry_id: item.plan?.entryId ?? null, received_at: iso(item.receivedAt) });
        this.state.intake = this.state.intake.filter((x) => x.id !== item.id);
        this.persist();
        continue;
      }
      try {
        await this.routePlan(item.plan, false);
      } catch (err) {
        // A bug, not LoopMessage (send failures don't throw). Recipients
        // already handled are protected by their dedupe keys; give the
        // rest another go on the next tick, a few times at most.
        item.attempts = (item.attempts ?? 0) + 1;
        this.log("error", "introduction_failed", {
          entry_id: item.plan?.entryId ?? null,
          attempts: item.attempts,
          error: String(err?.message ?? err),
        });
        if (item.attempts < this.config.maxAttempts) {
          this.persist();
          return;
        }
      }
      this.state.intake = this.state.intake.filter((x) => x.id !== item.id);
      this.persist();
    }
  }

  // The ?wait=1 path, and dry runs.
  async handleIntroduction(plan, { dryRun = false } = {}) {
    return this.run(async () => {
      if (!dryRun) this.expire(this.now());
      const results = await this.routePlan(plan, dryRun);
      if (!dryRun) this.persist();
      return results;
    });
  }

  async routePlan(plan, dryRun) {
    const passthrough = JSON.stringify({
      pipeline_entry_id: plan.entryId,
      client_id: plan.clientId ?? null,
      source: plan.source ?? null,
    }).slice(0, 1000);

    const results = [];
    for (const recipient of plan.recipients ?? []) {
      results.push(await this.routeAlert(recipient, plan, passthrough, this.now(), dryRun));
    }
    return results;
  }

  async routeAlert(r, plan, passthrough, now, dryRun) {
    const base = { name: r.name ?? null, mobile: r.mobile ?? null, contact: r.contact };
    const key = dedupeKey(plan.entryId, r.contact);

    if ((this.state.dedupe[key] ?? 0) > now) {
      if (!dryRun) {
        this.log("info", "duplicate_suppressed", {
          entry_id: plan.entryId,
          contact: r.contact,
          team_member: r.name ?? null,
        });
      }
      return { ...base, status: "duplicate_suppressed" };
    }

    const existing = this.state.contacts[r.contact];
    if (dryRun) {
      return { ...base, status: previewStatus(existing?.status ?? "new", this.isRecent(existing, now)) };
    }

    const c = this.ensureContact(r.contact, { name: r.name, clientName: plan.clientName }, now);
    const alert = {
      entryId: plan.entryId,
      text: r.text,
      lead: r.lead ?? null,
      name: r.name ?? null,
      passthrough,
      at: now,
    };

    if (TERMINAL.has(c.status)) {
      this.log("info", "alert_skipped", {
        entry_id: plan.entryId,
        contact: c.contact,
        team_member: c.name ?? null,
        reason: c.status,
      });
      return { ...base, status: `skipped_${c.status}` };
    }

    this.state.dedupe[key] = now + this.config.dedupeTtlMs;

    if (c.status === "active") {
      if (this.isRecent(c, now)) {
        // The dedupe key is on disk before the text goes out: if the
        // service dies mid-send, the introduction is routed again on
        // restart and comes out a duplicate, not a second text. If it
        // can't be saved, the alert waits in the outbox instead.
        this.state.immediateInFlight = { entryId: alert.entryId, contact: c.contact, at: now };
        if (!this.persist()) {
          this.state.immediateInFlight = null;
          this.queueOutbox(c, alert, { notBefore: now + this.config.retryBackoffMs });
          this.log("error", "send_deferred_state_not_saved", { entry_id: plan.entryId, contact: c.contact });
          return { ...base, status: "queued_retry", error: "state_not_saved" };
        }
        const res = await this.sendAlert(c, alert);
        this.state.immediateInFlight = null;
        return { ...base, ...this.settleAlert(c, alert, res, { cold: false }) };
      }
      this.queueOutbox(c, alert);
      this.log("info", "alert_paced", {
        entry_id: plan.entryId,
        contact: c.contact,
        team_member: c.name ?? null,
        outbox: this.state.outbox.length,
      });
      return { ...base, status: "queued_paced" };
    }

    const wasNew = c.status === "new";
    this.hold(c, alert, now);
    if (wasNew) this.queueWelcome(c, now);
    this.log("info", "alert_held", {
      entry_id: plan.entryId,
      contact: c.contact,
      team_member: c.name ?? null,
      contact_status: c.status,
    });
    return { ...base, status: wasNew ? "held_welcome_queued" : "held_awaiting_reply" };
  }

  // The alert's text in the CURRENT wording, built at send time so a copy
  // change also applies to alerts that were held or queued before it.
  renderAlert(c, alert) {
    const name = alert.name ?? c.name ?? null;
    if (alert.lead) return buildText(name, alert.lead);
    const legacy = leadFromLegacyAlertText(alert.text);
    return legacy ? buildText(name, legacy) : alert.text;
  }

  async sendAlert(c, alert) {
    const startedAt = this.now();
    const res = await this.safeSend({ contact: c.contact, text: this.renderAlert(c, alert), passthrough: alert.passthrough });
    return { ...res, startedAt };
  }

  // What a send's result means for the alert and the person. `cold` = sent
  // to someone who hasn't texted recently, which starts the 2-minute
  // spacing. Times are taken after the send: a slow LoopMessage call
  // mustn't shorten the gap to the next message.
  settleAlert(c, alert, res, { cold }) {
    const now = this.now();
    const fields = { entry_id: alert.entryId, contact: c.contact, team_member: c.name ?? null };

    if (res.ok || res.ambiguous) {
      c.lastOutboundAt = now;
      if (cold) this.state.pacing.lastColdAt = now;
      this.markSent(alert.entryId, c.contact, now);
      if (res.ok) {
        if (res.messageId) {
          this.state.sentAlerts[res.messageId] = {
            contact: c.contact,
            entryId: alert.entryId,
            at: now,
            startedAt: res.startedAt ?? now,
          };
        }
        this.log("info", "alert_sent", { ...fields, message_id: res.messageId ?? null, ...(cold ? { paced: true } : {}) });
        return { status: "sent", messageId: res.messageId ?? null };
      }
      // LoopMessage may have queued it (a timeout or a 5xx). Sending it
      // again could text them twice, so it isn't.
      this.log("warn", "alert_send_unconfirmed", { ...fields, http_status: res.status ?? null, error: res.error ?? null });
      return { status: "sent_unconfirmed", error: res.error ?? null };
    }

    const refused = this.onAlertRefused(c, alert, res, now);
    if (refused) return { status: refused, error: res.error ?? null };

    // LoopMessage couldn't be reached at all: that's about the sender, so
    // pause whatever happened to this person meanwhile.
    const answered = res.status != null;
    if (!answered) this.pauseSending(now + this.config.retryBackoffMs);

    if (TERMINAL.has(c.status)) {
      // They opted out (or were refused) while it was being sent.
      return { status: `skipped_${c.status}`, error: res.error ?? null };
    }

    // Not sent, and nothing points at the person: try again shortly. Only
    // failures LoopMessage answered count toward giving up; while it can't
    // be reached at all, the alert waits until it expires.
    const attempts = (alert.attempts ?? 0) + (answered ? 1 : 0);
    if (attempts >= this.config.maxAttempts) {
      // Free the dedupe key so a re-fired introduction can try again.
      delete this.state.dedupe[dedupeKey(alert.entryId, c.contact)];
      this.log("error", "alert_dropped_after_retries", {
        ...fields,
        attempts,
        http_status: res.status ?? null,
        error: res.error ?? null,
      });
      return { status: "failed", error: res.error ?? null };
    }
    const notBefore = now + this.config.retryBackoffMs;
    this.queueOutbox(c, { ...alert, attempts }, { notBefore, front: true });
    this.log("warn", "alert_retry_scheduled", {
      ...fields,
      attempts,
      http_status: res.status ?? null,
      error: res.error ?? null,
    });
    return { status: "queued_retry", error: res.error ?? null };
  }

  // Alerts LoopMessage refused for a reason we can act on. Returns the
  // result status, or null when it's nothing we recognise.
  onAlertRefused(c, alert, res, now) {
    const code = res.code ?? null;
    const rateLimited = RATE_LIMITED.has(code) || res.status === 429;
    const known =
      rateLimited || OPTED_OUT.has(code) || INVALID_CONTACT.has(code) || NEEDS_INBOUND.has(code) || CONFIG_ERRORS.has(code);
    if (!known) return null;

    const fields = {
      entry_id: alert.entryId,
      contact: c.contact,
      code,
      http_status: res.status ?? null,
      error: res.error ?? null,
    };
    c.lastError = { code, message: res.error ?? null, at: now };

    if (OPTED_OUT.has(code)) {
      if (c.status !== "opted_out") this.markOptedOut(c, now, "loopmessage_500");
      this.log("warn", "alert_refused_opted_out", fields);
      return "failed_opted_out";
    }
    const senderProblem = rateLimited || CONFIG_ERRORS.has(code);
    if (senderProblem) {
      // About the sender, not this person: slow down or pause everyone,
      // whatever this person did meanwhile.
      const config = CONFIG_ERRORS.has(code);
      if (code === TOO_FAST) {
        const paused = this.slowDown(now);
        this.log("warn", "loopmessage_limit_slowing_down", { ...fields, paused_for_an_hour: paused });
      } else {
        this.pauseSending(now + this.config.rateLimitBackoffMs);
        this.log(config ? "error" : "warn", config ? "loopmessage_config_error" : "alert_rate_limited", fields);
      }
    }
    // A STOP that arrived while this was being sent stands, whatever
    // LoopMessage says about the send.
    if (c.status === "opted_out") {
      this.log("info", "alert_refused_after_opt_out", fields);
      return "skipped_opted_out";
    }
    if (senderProblem) {
      this.queueOutbox(c, alert, { front: true });
      return "queued_retry";
    }
    if (INVALID_CONTACT.has(code)) {
      this.markUnreachable(c, now);
      this.log("warn", "alert_refused_invalid_contact", fields);
      return "failed_unreachable";
    }
    // NEEDS_INBOUND: LoopMessage no longer sees an open conversation. Start
    // over: hold the alert and send a fresh welcome.
    this.hold(c, alert, now);
    if (c.status === "active") this.queueWelcome(c, now);
    this.log("warn", "alert_refused_needs_new_conversation", fields);
    return "held_welcome_queued";
  }

  // -------------------------------------------------------------------------
  // Replies and delivery events from LoopMessage
  //
  // Both are applied synchronously, without the send lock: LoopMessage
  // wants a 200 within 15 seconds and retries otherwise, and a STOP must
  // take effect even while a release is sending.

  handleInbound({ contact: rawContact, text, messageId = null }) {
    const now = this.now();
    if (messageId) {
      // A webhook retry of a reply already applied. Applying it again could
      // let a retried "yes" undo a STOP sent after it, so it never is; if
      // the first one hasn't reached disk yet, the retry gets a 503 again.
      if ((this.state.seenInbound[messageId] ?? 0) > now) {
        this.log("info", "inbound_duplicate", { message_id: messageId });
        return { ignored: "duplicate_message", saved: this.ensureSaved() };
      }
      this.state.seenInbound[messageId] = now + this.config.inboundDedupeTtlMs;
    }

    const outcome = this.applyInbound(rawContact, text, now);
    // false: the webhook answers 503 and LoopMessage delivers it again. It's
    // already in effect in memory, and the redelivery is recognised above.
    outcome.saved = this.persist();

    // Consent is saved before LoopMessage gets its 200; sending what was
    // held (network calls) is queued behind any send in progress.
    if (outcome.release) {
      this.run(() => this.releasePending(outcome.contact)).catch((err) =>
        this.log("error", "release_failed", { contact: outcome.contact, error: String(err?.message ?? err) }),
      );
    }
    return outcome;
  }

  applyInbound(rawContact, text, now) {
    if (String(rawContact ?? "").includes("@")) {
      // An iMessage reply from an Apple ID email can't be matched to a team
      // member's phone. Logged with the address and text so an opt-out can
      // be honoured by hand.
      const read = readReply(text);
      this.log(read.stop || read.refusal ? "error" : "warn", "inbound_from_email_contact", {
        contact: String(rawContact),
        text: excerpt(text),
      });
      return { ignored: "email_contact" };
    }
    const normalized = normalizePhone(rawContact);
    if (!normalized.ok) {
      this.log("info", "inbound_ignored", { contact: rawContact ?? null, reason: normalized.reason });
      return { ignored: normalized.reason };
    }

    const contact = normalized.e164;
    const c = this.ensureContact(contact, {}, now);
    const before = c.status;
    c.lastInboundAt = now;
    const { action, reason, mentionsStop } = interpretReply(text, { name: c.name, stage: stageOf(c) });
    const done = (release) => ({ contact, before, status: c.status, action, release });
    const who = { contact, team_member: c.name ?? null };

    if (action === "opt_out") {
      if (c.status !== "opted_out") this.markOptedOut(c, now, reason === "stop" ? "replied_stop" : reason);
      return done(false);
    }
    if (action === "reply") {
      // Already getting alerts: they've just messaged, so anything waiting
      // for them can go now. A reply that talks about stopping without
      // asking to is left for a person to judge.
      if (mentionsStop) this.log("warn", "possible_opt_out", { ...who, text: excerpt(text) });
      return done(true);
    }
    if (action === "hold") {
      if (c.status === "opted_out") {
        this.log("info", "inbound_from_opted_out", who);
      } else {
        // Not a clear yes: their alerts stay held. Logged with the text so
        // someone can follow up.
        this.log("warn", "reply_not_consent", { ...who, contact_status: c.status, text: excerpt(text) });
      }
      return done(false);
    }

    // consent, or resume after an opt-out
    c.status = "active";
    c.activatedAt = now;
    c.optedOutAt = null;
    c.welcomeAttempts = 0;
    c.inboundRefusals = 0;
    this.unqueueWelcome(contact);
    this.log("info", "contact_activated", { contact, team_member: c.name ?? null, was: before });
    return done(true);
  }

  // Runs under the lock. Each alert is marked in flight and saved before
  // it's sent, and removed once it has been, so a STOP or a restart part
  // way through can neither resend one nor strand the rest.
  async releasePending(contact) {
    const c = this.state.contacts[contact];
    if (!c || c.status !== "active") return 0;
    const now = this.now();

    // They just messaged the sender, so LoopMessage allows replies with no
    // interval: everything waiting for them goes now, oldest first, one
    // text per lead.
    const byEntry = new Map();
    for (const a of [...(c.held ?? []), ...this.takeOutbox(contact)]) {
      if (now - a.at <= this.config.holdTtlMs) byEntry.set(a.entryId, alertCopy(a));
    }
    c.held = [...byEntry.values()].sort((a, b) => a.at - b.at);
    if (c.held.length === 0) return 0;
    this.persist();

    let released = 0;
    let attempted = 0;
    while (c.status === "active" && c.held.length > 0) {
      const alert = c.held[0];
      alert.inFlightAt = this.now();
      if (!this.persist()) {
        // Without its in-flight mark on disk a restart could send it
        // twice. Leave it held; the scheduler tries again.
        delete alert.inFlightAt;
        this.log("error", "send_deferred_state_not_saved", { entry_id: alert.entryId, contact });
        break;
      }
      const res = await this.sendAlert(c, alert);
      c.held = c.held.filter((a) => a !== alert); // a STOP may have emptied it already
      delete alert.inFlightAt;
      attempted += 1;
      const r = this.settleAlert(c, alert, res, { cold: false });
      if (r.status === "sent" || r.status === "sent_unconfirmed") released += 1;
      if (r.status === "queued_retry" && c.status === "active") {
        // LoopMessage is struggling; the rest wait in the outbox instead of
        // being tried back to back.
        const notBefore = this.now() + this.config.retryBackoffMs;
        for (const rest of c.held) this.queueOutbox(c, rest, { notBefore });
        c.held = [];
      }
      this.persist();
    }
    this.log("info", "held_alerts_released", { contact, released, attempted, remaining: c.held.length });
    return released;
  }

  handleStatusEvent({ event, messageId, errorCode }) {
    if (!messageId) return { ignored: "no_message_id" };
    const now = this.now();
    const code = errorCode ?? null;

    // `saved: false` makes the webhook answer 503 so LoopMessage retries;
    // applying an event twice is harmless (each change is conditional).
    const welcomed = Object.values(this.state.contacts).find((x) => x.welcomeMessageId === messageId);
    if (welcomed) {
      const out = this.onWelcomeStatus(welcomed, event, code, now);
      return { ...out, saved: this.persist() };
    }
    const alert = this.state.sentAlerts[messageId];
    if (alert) {
      const out = this.onAlertStatus(alert, messageId, event, code, now);
      return { ...out, saved: this.persist() };
    }
    // Includes a redelivery of an event already handled (its record is
    // gone): acknowledged only once that handling is on disk. While a send
    // is still waiting on LoopMessage's answer, it may be about that one,
    // whose id we don't know yet: ask LoopMessage to deliver it again.
    return { ignored: "unknown_message", retryLater: this.sendsInFlight > 0, saved: this.ensureSaved() };
  }

  onWelcomeStatus(c, event, code, now) {
    if (event === "message_delivered") {
      c.welcomeDeliveredAt ??= now;
      return { contact: c.contact, status: c.status };
    }
    c.lastError = { code, message: "welcome_not_delivered", at: now };
    this.log("warn", "welcome_not_delivered", { contact: c.contact, team_member: c.name ?? null, code, contact_status: c.status });

    if (OPTED_OUT.has(code)) {
      if (c.status !== "opted_out") this.markOptedOut(c, now, "welcome_failed_500");
    } else if (c.status === "welcomed") {
      // Only while still waiting on this welcome: a reply or a STOP since
      // then stands, and a retried event finds them already handled.
      if (INVALID_CONTACT.has(code)) this.markUnreachable(c, now);
      else if (NEEDS_INBOUND.has(code)) c.status = "needs_inbound";
      else {
        // Not delivered for a reason that isn't about them: send it again,
        // a few times at most.
        c.welcomeAttempts = (c.welcomeAttempts ?? 0) + 1;
        if (c.welcomeAttempts < this.config.maxAttempts) {
          this.queueWelcome(c, now);
        } else {
          c.status = "welcome_failed";
          c.held = [];
          this.log("error", "welcome_failed", {
            contact: c.contact,
            team_member: c.name ?? null,
            code,
            attempts: c.welcomeAttempts,
          });
        }
      }
    }
    return { contact: c.contact, status: c.status };
  }

  onAlertStatus(sent, messageId, event, code, now) {
    delete this.state.sentAlerts[messageId];
    const c = this.state.contacts[sent.contact];
    if (event === "message_delivered") return { contact: sent.contact, status: c?.status ?? null };

    // Free the dedupe key so a re-fired introduction can try again.
    delete this.state.dedupe[dedupeKey(sent.entryId, sent.contact)];
    this.log("warn", "alert_not_delivered", {
      entry_id: sent.entryId,
      contact: sent.contact,
      team_member: c?.name ?? null,
      code,
    });
    if (!c) return { contact: sent.contact, status: null };

    c.lastError = { code, message: "alert_not_delivered", at: now };
    // They've texted us since this alert started going out: the number
    // works and the conversation is open, whatever LoopMessage now says
    // about the older message.
    if ((c.lastInboundAt ?? 0) > (sent.startedAt ?? sent.at)) return { contact: c.contact, status: c.status };
    if (OPTED_OUT.has(code)) {
      if (c.status !== "opted_out") this.markOptedOut(c, now, "alert_failed_500");
    } else if (c.status !== "opted_out") {
      if (INVALID_CONTACT.has(code)) this.markUnreachable(c, now);
      // The conversation is gone: later alerts wait for a reply to a new
      // welcome.
      else if (NEEDS_INBOUND.has(code) && c.status === "active") this.queueWelcome(c, now);
    }
    return { contact: c.contact, status: c.status };
  }

  // -------------------------------------------------------------------------
  // Scheduler

  async tick() {
    return this.run(async () => {
      this.expire(this.now());
      await this.routeIntake();
      await this.releaseStranded();
      // At most one message per tick to someone who hasn't texted recently,
      // welcome or paced alert: LoopMessage wants those 2 minutes apart.
      const welcomed = await this.maybeSendWelcome(this.now());
      if (!welcomed) await this.maybeSendCold(this.now());
      this.persist();
    });
  }

  // Held alerts on someone already active are left behind when the service
  // stops part way through a release. Recent → send now; otherwise they
  // take the paced route.
  async releaseStranded() {
    const now = this.now();
    for (const c of Object.values(this.state.contacts)) {
      if (c.status !== "active" || !Array.isArray(c.held) || c.held.length === 0) continue;
      if (this.isRecent(c, now)) {
        await this.releasePending(c.contact);
        continue;
      }
      const count = c.held.length;
      for (const a of c.held) this.queueOutbox(c, a);
      c.held = [];
      this.log("info", "held_alerts_requeued", { contact: c.contact, team_member: c.name ?? null, count });
    }
  }

  // Returns true when it tried a send.
  async maybeSendWelcome(now) {
    const p = this.state.pacing;
    if (p.initBlockedUntil && now < p.initBlockedUntil) return false;
    if (p.coldBlockedUntil && now < p.coldBlockedUntil) return false;
    if (this.initsInWindow(now) >= this.dailyCap(now)) return false;
    if (p.lastInitAt && now - p.lastInitAt < this.config.initIntervalMs) return false;
    if (p.lastColdAt && now - p.lastColdAt < this.coldInterval(now)) return false;

    // Skip entries that no longer need a welcome (replied, opted out...).
    while (this.state.welcomeQueue.length > 0) {
      const head = this.state.contacts[this.state.welcomeQueue[0]];
      if (head && head.status === "welcome_queued") break;
      this.state.welcomeQueue.shift();
    }
    const contact = this.state.welcomeQueue[0];
    if (!contact) return false;
    const c = this.state.contacts[contact];

    // Saved first: if the service dies mid-send, the restart counts this
    // welcome as sent instead of sending a second first message. No save,
    // no send.
    c.welcomeInFlightAt = now;
    if (!this.persist()) {
      delete c.welcomeInFlightAt;
      this.pauseSending(now + this.config.retryBackoffMs);
      this.log("error", "send_deferred_state_not_saved", { contact, kind: "welcome" });
      return true;
    }
    const res = await this.safeSend({
      contact,
      text: buildWelcomeText({ name: c.name, brand: this.config.brand }),
      passthrough: JSON.stringify({ kind: "welcome" }),
    });
    const t = this.now();
    delete c.welcomeInFlightAt;

    // Sent, or LoopMessage may have queued it: either way it's never sent
    // again and it counts against the spacing and the cap. A reply or STOP
    // that arrived during the send isn't undone.
    if (res.ok || res.ambiguous) {
      this.unqueueWelcome(contact);
      if (c.status === "welcome_queued") c.status = "welcomed";
      c.welcomedAt = t;
      c.welcomeMessageId = res.messageId ?? null;
      if (res.ok) delete c.welcomeUnconfirmed;
      else c.welcomeUnconfirmed = true;
      c.lastOutboundAt = t;
      this.countInit(t);
      this.log(res.ok ? "info" : "warn", res.ok ? "welcome_sent" : "welcome_send_unconfirmed", {
        contact,
        team_member: c.name ?? null,
        client: c.clientName ?? null,
        message_id: res.messageId ?? null,
        ...(res.ok ? {} : { http_status: res.status ?? null, error: res.error ?? null }),
        sent_last_24h: this.initsInWindow(t),
        cap: this.dailyCap(t),
      });
      return true;
    }

    const code = res.code ?? null;
    const fields = { contact, team_member: c.name ?? null, code, http_status: res.status ?? null, error: res.error ?? null };
    c.lastError = { code, message: res.error ?? null, at: t };

    // Problems with the sender, not this person: pause everyone, whatever
    // this person did meanwhile. They stay queued (if they still need a
    // welcome) and aren't counted against.
    if (RATE_LIMITED.has(code) || res.status === 429 || CONFIG_ERRORS.has(code)) {
      const config = CONFIG_ERRORS.has(code);
      if (code === TOO_FAST) {
        const paused = this.slowDown(t);
        this.log("warn", "loopmessage_limit_slowing_down", { ...fields, paused_for_an_hour: paused });
      } else {
        this.pauseSending(t + this.config.rateLimitBackoffMs);
        this.log(config ? "error" : "warn", config ? "loopmessage_config_error" : "welcome_rate_limited", fields);
      }
      return true;
    }
    if (res.status == null) {
      // LoopMessage couldn't be reached, so nothing was sent.
      this.pauseSending(t + this.config.retryBackoffMs);
      this.log("warn", "welcome_retry_scheduled", { ...fields, reason: "unreachable" });
      return true;
    }

    if (c.status !== "welcome_queued") {
      // They replied or opted out while it was being sent: that stands.
      this.unqueueWelcome(contact);
      this.log("info", "welcome_refused_after_reply", { ...fields, contact_status: c.status });
      return true;
    }
    if (OPTED_OUT.has(code)) {
      this.markOptedOut(c, t, "loopmessage_500");
      this.log("warn", "welcome_refused_opted_out", fields);
      return true;
    }
    if (INVALID_CONTACT.has(code)) {
      this.markUnreachable(c, t);
      this.log("warn", "welcome_refused_invalid_contact", fields);
      return true;
    }
    if (NEEDS_INBOUND.has(code)) {
      this.onWelcomeNeedsInbound(c, t, fields);
      return true;
    }

    // A refusal we don't recognise: give it a few tries, then stop.
    c.welcomeAttempts = (c.welcomeAttempts ?? 0) + 1;
    if (c.welcomeAttempts >= this.config.maxAttempts) {
      this.unqueueWelcome(contact);
      c.status = "welcome_failed";
      c.held = [];
      this.log("error", "welcome_failed", { ...fields, attempts: c.welcomeAttempts });
      return true;
    }
    p.initBlockedUntil = t + this.config.retryBackoffMs;
    this.log("warn", "welcome_retry_scheduled", { ...fields, attempts: c.welcomeAttempts });
    return true;
  }

  // 510/520/530: LoopMessage won't let us start this conversation. For one
  // person that means waiting for them to text first (their alerts stay
  // held). Two different people in a row looks like the sender, not them:
  // keep both queued and pause, so one sender-wide refusal can't park the
  // whole queue. Someone refused twice is parked whatever the streak.
  onWelcomeNeedsInbound(c, t, fields) {
    const p = this.state.pacing;
    p.initRefusalStreak = (p.initRefusalStreak ?? 0) + 1;
    c.inboundRefusals = (c.inboundRefusals ?? 0) + 1;
    this.unqueueWelcome(c.contact);

    if (p.initRefusalStreak === 1 || c.inboundRefusals >= 2) {
      c.status = "needs_inbound";
      if (p.initRefusalStreak === 1) p.parkedByStreak = c.contact;
      this.log("warn", "welcome_refused_needs_inbound", fields);
    } else {
      const first = p.parkedByStreak ? this.state.contacts[p.parkedByStreak] : null;
      if (first && first.status === "needs_inbound") this.queueWelcome(first, t);
      p.parkedByStreak = null;
      this.queueWelcome(c, t);
      this.log("error", "welcome_refusals_paused", { ...fields, streak: p.initRefusalStreak });
    }
    p.initBlockedUntil =
      t + (p.initRefusalStreak >= 2 ? this.config.rateLimitBackoffMs : this.config.initIntervalMs);
  }

  // One alert from the outbox. Alerts to people who haven't texted recently
  // keep coldInterval from any other such message, welcomes included.
  async maybeSendCold(now) {
    const p = this.state.pacing;
    if (p.coldBlockedUntil && now < p.coldBlockedUntil) return false;

    // People who stopped being active since their alert was queued: held
    // for after their reply, or dropped if they're gone.
    for (const item of [...this.state.outbox]) {
      const c = this.state.contacts[item.contact];
      if (c?.status === "active") continue;
      this.state.outbox = this.state.outbox.filter((i) => i !== item);
      if (c && !TERMINAL.has(c.status)) this.hold(c, item, now);
    }

    const spaced = !p.lastColdAt || now - p.lastColdAt >= this.coldInterval(now);
    const item = this.state.outbox.find(
      (i) => (!i.notBefore || i.notBefore <= now) && (spaced || this.isRecent(this.state.contacts[i.contact], now)),
    );
    if (!item) return false;
    const c = this.state.contacts[item.contact];
    const cold = !this.isRecent(c, now);

    item.inFlightAt = now;
    // On the pacing record too: a STOP mid-send removes the item, and with
    // it the item's mark.
    if (cold) this.state.pacing.coldInFlightAt = now;
    if (!this.persist()) {
      delete item.inFlightAt;
      delete this.state.pacing.coldInFlightAt;
      this.pauseSending(now + this.config.retryBackoffMs);
      this.log("error", "send_deferred_state_not_saved", { entry_id: item.entryId, contact: item.contact, paced: true });
      return true;
    }
    const res = await this.sendAlert(c, item);
    this.state.outbox = this.state.outbox.filter((i) => i !== item);
    delete item.inFlightAt;
    delete this.state.pacing.coldInFlightAt;
    this.settleAlert(c, item, res, { cold });
    return true;
  }

  // -------------------------------------------------------------------------
  // Bookkeeping

  ensureContact(contact, { name, clientName } = {}, now) {
    let c = this.state.contacts[contact];
    if (!c) {
      c = {
        contact,
        status: "new",
        name: name ?? null,
        clientName: clientName ?? null,
        createdAt: now,
        held: [],
      };
      this.state.contacts[contact] = c;
    } else {
      if (name) c.name = name;
      if (clientName) c.clientName = clientName;
      if (!Array.isArray(c.held)) c.held = [];
    }
    return c;
  }

  hold(c, alert, now) {
    // One held copy per lead: a lead re-fired while still held replaces the
    // older copy (its details may have changed) instead of becoming a
    // second text on release.
    c.held = c.held.filter((h) => h.entryId !== alert.entryId);
    c.held.push(alertCopy({ ...alert, at: alert.at ?? now }));
    const overflow = c.held.length - this.config.maxHeldPerContact;
    if (overflow > 0) {
      c.held.splice(0, overflow);
      this.log("warn", "held_alerts_dropped", {
        contact: c.contact,
        dropped: overflow,
        reason: "max_held_per_contact",
      });
    }
  }

  queueOutbox(c, alert, { notBefore = null, front = false } = {}) {
    if (this.state.outbox.some((i) => i.contact === c.contact && i.entryId === alert.entryId)) return;
    const item = { ...alertCopy(alert), contact: c.contact, attempts: alert.attempts ?? 0 };
    if (notBefore) item.notBefore = notBefore;
    if (front) this.state.outbox.unshift(item);
    else this.state.outbox.push(item);
  }

  queueWelcome(c, now) {
    if (!this.state.welcomeQueue.includes(c.contact)) this.state.welcomeQueue.push(c.contact);
    c.status = "welcome_queued";
    c.welcomeQueuedAt = now;
  }

  unqueueWelcome(contact) {
    this.state.welcomeQueue = this.state.welcomeQueue.filter((x) => x !== contact);
  }

  takeOutbox(contact) {
    const mine = this.state.outbox.filter((i) => i.contact === contact);
    if (mine.length > 0) this.state.outbox = this.state.outbox.filter((i) => i.contact !== contact);
    return mine;
  }

  markOptedOut(c, now, reason) {
    const dropped = (c.held?.length ?? 0) + this.takeOutbox(c.contact).length;
    c.status = "opted_out";
    c.optedOutAt = now;
    c.held = [];
    this.unqueueWelcome(c.contact);
    this.log("warn", "contact_opted_out", {
      contact: c.contact,
      team_member: c.name ?? null,
      reason,
      dropped_alerts: dropped,
    });
  }

  markUnreachable(c, now) {
    if (c.status === "opted_out") return;
    c.status = "unreachable";
    c.unreachableAt = now;
    c.held = [];
    this.takeOutbox(c.contact);
    this.unqueueWelcome(c.contact);
  }

  expire(now) {
    for (const map of [this.state.dedupe, this.state.seenInbound]) {
      for (const [key, until] of Object.entries(map)) {
        if (until <= now) delete map[key];
      }
    }
    for (const [id, sent] of Object.entries(this.state.sentAlerts)) {
      if (now - (sent?.at ?? 0) > this.config.inboundDedupeTtlMs) delete this.state.sentAlerts[id];
    }
    const p = this.state.pacing;
    p.initTimes = p.initTimes.filter((at) => now - at < DAY);

    const ttl = this.config.holdTtlMs;
    for (const c of Object.values(this.state.contacts)) {
      if (!Array.isArray(c.held) || c.held.length === 0) continue;
      const fresh = c.held.filter((a) => now - a.at <= ttl);
      if (fresh.length !== c.held.length) {
        this.log("info", "held_alerts_expired", {
          contact: c.contact,
          team_member: c.name ?? null,
          expired: c.held.length - fresh.length,
        });
        c.held = fresh;
      }
    }
    const before = this.state.outbox.length;
    this.state.outbox = this.state.outbox.filter((i) => now - i.at <= ttl);
    if (this.state.outbox.length !== before) {
      this.log("warn", "paced_alerts_expired", { expired: before - this.state.outbox.length });
    }
  }

  // -------------------------------------------------------------------------
  // Reporting

  stats(now = this.now()) {
    const contacts = {};
    let held = 0;
    let welcomed = 0;
    let repliedAfterWelcome = 0;
    for (const c of Object.values(this.state.contacts)) {
      contacts[c.status] = (contacts[c.status] ?? 0) + 1;
      held += c.held?.length ?? 0;
      if (c.welcomedAt) {
        welcomed += 1;
        if (c.activatedAt && c.activatedAt >= c.welcomedAt) repliedAfterWelcome += 1;
      }
    }
    return {
      contacts,
      held_alerts: held,
      welcome_queue: this.state.welcomeQueue.length,
      paced_outbox: this.state.outbox.length,
      intake_pending: this.state.intake.length,
      // true while slowed to LoopMessage's 2-minute pace after a 540
      slowed_down: Boolean(this.state.pacing.slowUntil && now < this.state.pacing.slowUntil),
      welcomes_last_24h: this.initsInWindow(now),
      welcome_cap_24h: this.dailyCap(now),
      // LoopMessage wants this above ~30%.
      welcome_reply_rate: welcomed ? Math.round((repliedAfterWelcome / welcomed) * 100) / 100 : null,
    };
  }

  snapshot() {
    return Object.values(this.state.contacts)
      .map((c) => ({
        contact: c.contact,
        name: c.name ?? null,
        client: c.clientName ?? null,
        status: c.status,
        held_alerts: c.held?.length ?? 0,
        welcome_queued_at: iso(c.welcomeQueuedAt),
        welcomed_at: iso(c.welcomedAt),
        welcome_unconfirmed: Boolean(c.welcomeUnconfirmed),
        welcome_delivered_at: iso(c.welcomeDeliveredAt),
        activated_at: iso(c.activatedAt),
        last_inbound_at: iso(c.lastInboundAt),
        opted_out_at: iso(c.optedOutAt),
        last_error: c.lastError
          ? { ...c.lastError, at: iso(c.lastError.at) }
          : null,
      }))
      .sort(
        (a, b) =>
          a.status.localeCompare(b.status) || String(a.name).localeCompare(String(b.name)),
      );
  }
}
