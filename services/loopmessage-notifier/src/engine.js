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
//   minutes between them.
// - If recipients report the sender, messages stop being delivered and the
//   sender can be blocked — every alert, for every client, stops.
//
// So an alert (which contains the lead's email) never goes to someone who
// hasn't messaged the sender. A new number gets a short welcome, paced as
// an initiation, and its alerts are held. Any reply other than STOP counts
// as consent: it activates them and releases what was held.
//
// Contact lifecycle:
//
//   new ──alert──▶ welcome_queued ──welcome sent──▶ welcomed ──reply──▶ active
//    │                  │                              │
//    └──── they text the sender first ─────────────────┴────────────────▶ active
//
//   any ──STOP──▶ opted_out ──START/YES──▶ active
//   LoopMessage refuses the number ──▶ unreachable / welcome_failed
//   LoopMessage won't let us start it ──▶ needs_inbound (waits for them)
//
// Everything runs under one lock, so a reply arriving mid-send can't
// release the same held alert twice. State is saved after every change
// (store.js) so a redeploy doesn't forget consent or the pacing clock.

import { normalizePhone } from "./phone.js";
import { classifyReply } from "./inbound.js";
import { buildWelcomeText, isSafeInitialText } from "./notify.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_CONFIG = Object.freeze({
  initIntervalMs: 15 * MINUTE,
  // null = follow LoopMessage's warm-up schedule (warmupCap).
  initDailyCap: null,
  coldIntervalMs: 2 * MINUTE,
  // LoopMessage doesn't define "recently"; a day is the assumption.
  recentInboundMs: 24 * HOUR,
  holdTtlMs: 24 * HOUR,
  maxHeldPerContact: 5,
  dedupeTtlMs: 6 * HOUR,
  rateLimitBackoffMs: HOUR,
  retryBackoffMs: 5 * MINUTE,
  maxAttempts: 3,
  brand: "BrokerStaffer",
});

// LoopMessage error codes (apidocs/error-codes) that decide what happens
// next. Anything not listed is treated as transient and retried.
const OPTED_OUT = new Set([500]);
const INVALID_CONTACT = new Set([150, 160, 170, 180, 190]);
const NEEDS_INBOUND = new Set([510, 520, 530]);
const RATE_LIMITED = new Set([540, 550]);
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

function normalizeState(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    version: 1,
    contacts: s.contacts && typeof s.contacts === "object" ? s.contacts : {},
    welcomeQueue: Array.isArray(s.welcomeQueue) ? s.welcomeQueue : [],
    outbox: Array.isArray(s.outbox) ? s.outbox : [],
    dedupe: s.dedupe && typeof s.dedupe === "object" ? s.dedupe : {},
    pacing: {
      lastInitAt: null,
      firstInitAt: null,
      initDay: null,
      initCountToday: 0,
      initBlockedUntil: null,
      lastColdAt: null,
      coldBlockedUntil: null,
      ...(s.pacing && typeof s.pacing === "object" ? s.pacing : {}),
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
    if (!isSafeInitialText(this.config.brand)) {
      throw new Error(
        "brand contains an email, link, phone number or currency, which LoopMessage forbids in a first message",
      );
    }
    this.state = normalizeState(store.load());
    this.lock = Promise.resolve();
  }

  // Serialize every state change. Sends happen inside the lock, so a reply
  // arriving mid-send waits rather than racing the same held alert.
  run(fn) {
    const result = this.lock.then(() => fn());
    this.lock = result.catch(() => {});
    return result;
  }

  // Resolves once everything queued so far (including background releases)
  // has finished. Tests and shutdown use it.
  idle() {
    return this.lock;
  }

  log(level, msg, fields = {}) {
    const line = JSON.stringify({ level, msg, ...fields });
    if (level === "error") this.logger.error(line);
    else if (level === "warn") this.logger.warn(line);
    else this.logger.log(line);
  }

  persist() {
    try {
      this.store.save(this.state);
    } catch (err) {
      // Keep running on the in-memory state; the next change retries.
      this.log("error", "state_save_failed", { error: String(err?.message ?? err) });
    }
  }

  isRecent(c, now) {
    return Boolean(c?.lastInboundAt) && now - c.lastInboundAt <= this.config.recentInboundMs;
  }

  dailyCap(now) {
    return this.config.initDailyCap ?? warmupCap(this.state.pacing.firstInitAt, now);
  }

  // -------------------------------------------------------------------------
  // Lead alerts

  async handleIntroduction(plan, { dryRun = false } = {}) {
    return this.run(async () => {
      const now = this.now();
      if (!dryRun) this.expire(now);
      const passthrough = JSON.stringify({
        pipeline_entry_id: plan.entryId,
        client_id: plan.clientId ?? null,
        source: plan.source ?? null,
      }).slice(0, 1000);

      const results = [];
      for (const recipient of plan.recipients) {
        results.push(await this.routeAlert(recipient, plan, passthrough, now, dryRun));
      }
      if (!dryRun) this.persist();
      return results;
    });
  }

  async routeAlert(r, plan, passthrough, now, dryRun) {
    const base = { name: r.name ?? null, mobile: r.mobile ?? null, contact: r.contact };
    const key = `${plan.entryId}:${r.contact}`;

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
    const alert = { entryId: plan.entryId, text: r.text, passthrough, at: now };

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
        const res = await this.deliver(c, alert, now);
        return { ...base, ...res };
      }
      const alreadyQueued = this.state.outbox.some(
        (i) => i.contact === c.contact && i.entryId === plan.entryId,
      );
      if (alreadyQueued) return { ...base, status: "queued_paced" };
      this.state.outbox.push({ ...alert, contact: c.contact, attempts: 0 });
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

  // Send one alert now. Only called for active contacts.
  async deliver(c, alert, now) {
    const res = await this.send({ contact: c.contact, text: alert.text, passthrough: alert.passthrough });
    if (res.ok) {
      c.lastOutboundAt = now;
      this.log("info", "alert_sent", {
        entry_id: alert.entryId,
        contact: c.contact,
        team_member: c.name ?? null,
        message_id: res.messageId ?? null,
      });
      return { status: "sent", messageId: res.messageId ?? null };
    }
    const handled = this.onAlertRefused(c, alert, res, now);
    if (handled) return { status: handled, error: res.error ?? null };

    // Not a refusal we recognise: try again from the paced outbox shortly.
    // Only a specific refusal (a code) counts toward giving up; a network
    // or 5xx failure is LoopMessage's problem and retries until the alert
    // expires.
    this.state.outbox.unshift({
      ...alert,
      contact: c.contact,
      attempts: (alert.attempts ?? 0) + (res.code == null ? 0 : 1),
      notBefore: now + this.config.retryBackoffMs,
    });
    this.log("warn", "alert_retry_scheduled", {
      entry_id: alert.entryId,
      contact: c.contact,
      http_status: res.status ?? null,
      error: res.error ?? null,
    });
    return { status: "queued_retry", error: res.error ?? null };
  }

  // Alerts LoopMessage refused for a reason we can act on. Returns the
  // result status, or null when the refusal looks transient.
  onAlertRefused(c, alert, res, now) {
    const code = res.code ?? null;
    if (code === null) return null;
    const fields = {
      entry_id: alert.entryId,
      contact: c.contact,
      code,
      http_status: res.status ?? null,
      error: res.error ?? null,
    };
    c.lastError = { code, message: res.error ?? null, at: now };

    if (OPTED_OUT.has(code)) {
      this.markOptedOut(c, now, "loopmessage_500");
      this.log("warn", "alert_refused_opted_out", fields);
      return "failed_opted_out";
    }
    if (INVALID_CONTACT.has(code)) {
      this.markUnreachable(c, now);
      this.log("warn", "alert_refused_invalid_contact", fields);
      return "failed_unreachable";
    }
    if (NEEDS_INBOUND.has(code)) {
      // LoopMessage no longer sees an open conversation. Start over: hold
      // the alert and send a fresh welcome.
      c.status = "new";
      this.hold(c, alert, now);
      this.queueWelcome(c, now);
      this.log("warn", "alert_refused_needs_new_conversation", fields);
      return "held_welcome_queued";
    }
    if (RATE_LIMITED.has(code) || CONFIG_ERRORS.has(code)) {
      this.state.pacing.coldBlockedUntil = now + this.config.rateLimitBackoffMs;
      this.state.outbox.unshift({ ...alert, contact: c.contact, attempts: alert.attempts ?? 0 });
      this.log(CONFIG_ERRORS.has(code) ? "error" : "warn", CONFIG_ERRORS.has(code) ? "loopmessage_config_error" : "alert_rate_limited", fields);
      return "queued_retry";
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Replies and delivery events from LoopMessage

  async handleInbound({ contact: rawContact, text }) {
    const outcome = await this.run(async () => {
      const now = this.now();
      this.expire(now);

      if (String(rawContact ?? "").includes("@")) {
        this.log("info", "inbound_ignored", { reason: "email_contact" });
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
      const kind = classifyReply(text);
      c.lastInboundAt = now;

      if (kind === "stop") {
        if (c.status !== "opted_out") this.markOptedOut(c, now, "replied_stop");
        this.persist();
        return { contact, before, status: c.status, release: false };
      }

      if (c.status === "opted_out" && kind !== "start") {
        this.log("info", "inbound_from_opted_out", { contact, team_member: c.name ?? null });
        this.persist();
        return { contact, before, status: c.status, release: false };
      }

      if (c.status !== "active") {
        c.status = "active";
        c.activatedAt = now;
        c.optedOutAt = null;
        c.welcomeAttempts = 0;
        this.unqueueWelcome(contact);
        this.log("info", "contact_activated", { contact, team_member: c.name ?? null, was: before });
      }
      this.persist();
      return { contact, before, status: c.status, release: true };
    });

    // Consent is saved before LoopMessage gets its 200. Releasing held
    // alerts (network calls) is queued behind it, so the webhook isn't held
    // past LoopMessage's 15-second timeout.
    if (outcome.release) {
      this.run(() => this.releasePending(outcome.contact)).catch((err) =>
        this.log("error", "release_failed", { contact: outcome.contact, error: String(err?.message ?? err) }),
      );
    }
    return outcome;
  }

  async releasePending(contact) {
    const now = this.now();
    const c = this.state.contacts[contact];
    if (!c || c.status !== "active") return 0;

    // They just messaged the sender, so LoopMessage allows replies with no
    // interval: everything waiting for them goes now, oldest first, one
    // text per lead.
    const byEntry = new Map();
    for (const a of [...(c.held ?? []), ...this.takeOutbox(contact)]) {
      if (now - a.at <= this.config.holdTtlMs) byEntry.set(a.entryId, a);
    }
    const pending = [...byEntry.values()].sort((a, b) => a.at - b.at);
    c.held = [];

    let released = 0;
    for (const alert of pending) {
      if (c.status !== "active") {
        // A refusal mid-release (e.g. opted out) changed things; keep the
        // rest where the refusal handling expects them.
        if (!TERMINAL.has(c.status)) this.hold(c, alert, now);
        continue;
      }
      const res = await this.deliver(c, alert, now);
      if (res.status === "sent") released += 1;
    }
    if (pending.length > 0) {
      this.log("info", "held_alerts_released", { contact, released, attempted: pending.length });
    }
    this.persist();
    return released;
  }

  async handleStatusEvent({ event, messageId, errorCode }) {
    return this.run(async () => {
      if (!messageId) return { ignored: "no_message_id" };
      const now = this.now();
      const c = Object.values(this.state.contacts).find((x) => x.welcomeMessageId === messageId);
      if (!c) return { ignored: "not_a_welcome" };

      if (event === "message_delivered") {
        c.welcomeDeliveredAt = now;
      } else if (event === "message_failed") {
        const code = errorCode ?? null;
        c.lastError = { code, message: "welcome_not_delivered", at: now };
        if (OPTED_OUT.has(code)) {
          this.markOptedOut(c, now, "welcome_failed_500");
        } else if (c.status === "welcomed") {
          if (INVALID_CONTACT.has(code)) this.markUnreachable(c, now);
          else {
            c.status = "welcome_failed";
            c.held = [];
          }
          this.log("warn", "welcome_not_delivered", { contact: c.contact, team_member: c.name ?? null, code });
        }
      }
      this.persist();
      return { contact: c.contact, status: c.status };
    });
  }

  // -------------------------------------------------------------------------
  // Scheduler: one welcome and one paced alert per tick at most.

  async tick() {
    return this.run(async () => {
      const now = this.now();
      this.expire(now);
      await this.maybeSendWelcome(now);
      await this.maybeSendCold(now);
      this.persist();
    });
  }

  async maybeSendWelcome(now) {
    const p = this.state.pacing;
    const day = utcDay(now);
    if (p.initDay !== day) {
      p.initDay = day;
      p.initCountToday = 0;
    }
    if (p.initBlockedUntil && now < p.initBlockedUntil) return;
    if (p.initCountToday >= this.dailyCap(now)) return;
    if (p.lastInitAt && now - p.lastInitAt < this.config.initIntervalMs) return;

    // Skip entries that no longer need a welcome (replied, opted out...).
    while (this.state.welcomeQueue.length > 0) {
      const head = this.state.contacts[this.state.welcomeQueue[0]];
      if (head && head.status === "welcome_queued") break;
      this.state.welcomeQueue.shift();
    }
    const contact = this.state.welcomeQueue[0];
    if (!contact) return;
    const c = this.state.contacts[contact];

    const text = buildWelcomeText({ name: c.name, clientName: c.clientName, brand: this.config.brand });
    const res = await this.send({ contact, text, passthrough: JSON.stringify({ kind: "welcome" }) });

    // Remove by number, not position, and don't demote someone who replied
    // in the meantime — the lock prevents both today; this keeps it true if
    // the code around it changes.
    if (res.ok) {
      this.unqueueWelcome(contact);
      if (c.status === "welcome_queued") c.status = "welcomed";
      c.welcomedAt = now;
      c.welcomeMessageId = res.messageId ?? null;
      c.lastOutboundAt = now;
      p.lastInitAt = now;
      p.firstInitAt ??= now;
      p.initCountToday += 1;
      this.log("info", "welcome_sent", {
        contact,
        team_member: c.name ?? null,
        client: c.clientName ?? null,
        message_id: res.messageId ?? null,
        sent_today: p.initCountToday,
        cap_today: this.dailyCap(now),
      });
      return;
    }

    const code = res.code ?? null;
    c.lastError = { code, message: res.error ?? null, at: now };
    const fields = { contact, team_member: c.name ?? null, code, http_status: res.status ?? null, error: res.error ?? null };

    if (OPTED_OUT.has(code)) {
      this.markOptedOut(c, now, "loopmessage_500");
      this.log("warn", "welcome_refused_opted_out", fields);
      return;
    }
    if (INVALID_CONTACT.has(code)) {
      this.markUnreachable(c, now);
      this.log("warn", "welcome_refused_invalid_contact", fields);
      return;
    }
    if (NEEDS_INBOUND.has(code)) {
      // LoopMessage won't let us start this conversation. Their alerts stay
      // held; the moment they text the sender they're activated.
      this.unqueueWelcome(contact);
      c.status = "needs_inbound";
      this.log("warn", "welcome_refused_needs_inbound", fields);
      return;
    }
    if (RATE_LIMITED.has(code) || CONFIG_ERRORS.has(code)) {
      p.initBlockedUntil = now + this.config.rateLimitBackoffMs;
      this.log(CONFIG_ERRORS.has(code) ? "error" : "warn", CONFIG_ERRORS.has(code) ? "loopmessage_config_error" : "welcome_rate_limited", fields);
      return;
    }
    if (code === null) {
      // Network or 5xx: a LoopMessage problem, not this contact's. Pause and
      // retry the same welcome without counting it against them, so an
      // outage can't permanently fail people.
      p.initBlockedUntil = now + this.config.retryBackoffMs;
      this.log("warn", "welcome_retry_scheduled", { ...fields, reason: "transient" });
      return;
    }

    // A refusal code we don't recognise: give it a few tries, then stop.
    c.welcomeAttempts = (c.welcomeAttempts ?? 0) + 1;
    if (c.welcomeAttempts >= this.config.maxAttempts) {
      this.unqueueWelcome(contact);
      c.status = "welcome_failed";
      c.held = [];
      this.log("error", "welcome_failed", { ...fields, attempts: c.welcomeAttempts });
      return;
    }
    p.initBlockedUntil = now + this.config.retryBackoffMs;
    this.log("warn", "welcome_retry_scheduled", { ...fields, attempts: c.welcomeAttempts });
  }

  async maybeSendCold(now) {
    const p = this.state.pacing;
    if (p.coldBlockedUntil && now < p.coldBlockedUntil) return;
    if (p.lastColdAt && now - p.lastColdAt < this.config.coldIntervalMs) return;

    const idx = this.state.outbox.findIndex((item) => !item.notBefore || item.notBefore <= now);
    if (idx === -1) return;
    const [item] = this.state.outbox.splice(idx, 1);
    const c = this.state.contacts[item.contact];

    if (!c || c.status !== "active") {
      // Opted out, or LoopMessage asked for a fresh conversation, since this
      // was queued. Keep it for after their reply unless they're gone.
      if (c && !TERMINAL.has(c.status)) this.hold(c, item, now);
      return;
    }

    const cold = !this.isRecent(c, now);
    const res = await this.send({ contact: c.contact, text: item.text, passthrough: item.passthrough });
    if (res.ok) {
      if (cold) p.lastColdAt = now;
      c.lastOutboundAt = now;
      this.log("info", "alert_sent", {
        entry_id: item.entryId,
        contact: c.contact,
        team_member: c.name ?? null,
        message_id: res.messageId ?? null,
        paced: true,
      });
      return;
    }

    if (this.onAlertRefused(c, item, res, now)) return;

    // Network/5xx failures retry until the alert expires; only a specific
    // refusal code we don't recognise counts toward giving up.
    const attempts = (item.attempts ?? 0) + (res.code == null ? 0 : 1);
    if (attempts >= this.config.maxAttempts) {
      // Free the dedupe key so a re-fired introduction can try again.
      delete this.state.dedupe[`${item.entryId}:${c.contact}`];
      this.log("error", "alert_dropped_after_retries", {
        entry_id: item.entryId,
        contact: c.contact,
        attempts,
        http_status: res.status ?? null,
        error: res.error ?? null,
      });
      return;
    }
    this.state.outbox.unshift({ ...item, attempts, notBefore: now + this.config.retryBackoffMs });
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
    c.held.push({
      entryId: alert.entryId,
      text: alert.text,
      passthrough: alert.passthrough,
      at: alert.at ?? now,
    });
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
    c.status = "unreachable";
    c.unreachableAt = now;
    c.held = [];
    this.takeOutbox(c.contact);
    this.unqueueWelcome(c.contact);
  }

  expire(now) {
    for (const [key, until] of Object.entries(this.state.dedupe)) {
      if (until <= now) delete this.state.dedupe[key];
    }
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
    const p = this.state.pacing;
    return {
      contacts,
      held_alerts: held,
      welcome_queue: this.state.welcomeQueue.length,
      paced_outbox: this.state.outbox.length,
      welcomes_today: p.initDay === utcDay(now) ? p.initCountToday : 0,
      welcome_cap_today: this.dailyCap(now),
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
