# loopmessage-notifier

Receives `lead.introduction` webhooks from the Masterinbox app and texts the
client's team via [LoopMessage](https://loopmessage.com) (iMessage, with
carrier fallback).

Replaces the n8n workflow that previously did this over Twilio. n8n is no
longer in the path.

## Why it's a service and not a workflow

The producer — `lib/webhooks/n8n-introduction.ts` — fires inside
`next/server` `after()`, swallows every error, and never retries. A failed
POST leaves nothing behind but a console line. So the durability (consent,
pacing, retries, dedupe, per-recipient logging) has to live on the
receiving side.

## Consent before alerts

LoopMessage treats texting a number that has never messaged the sender as
*starting a conversation*, and puts strict rules on it (helpdesk: "Is it
possible to send an outbound text first?"):

- needs the Init-conversations feature (enabled on this account);
- at least **15 minutes** between new conversations;
- a daily cap that **warms up from 2 a day** to about 50 after three weeks;
- the first message must not contain **emails, phone numbers, links**,
  currencies or marketing, and should let the person agree or unsubscribe;
- recipients reporting the sender gets messages marked *Not delivered* and
  can get the sender **blocked** — which would stop every alert for every
  client.

The lead alert contains the lead's phone number, so it can never be a
first message. Instead:

```
 new number ──lead──▶ alert HELD + welcome queued
                         │  (15 min apart, a pass apart from any other message to
                         │   someone who hasn't texted, rolling 24h cap)
                         ▼
                      welcome: "Hi Lara, this is BrokerStaffer. We'll text you
                      here whenever a new agent is introduced to your team.
                      Reply YES to start getting these, or STOP to opt out."
                         │
   YES, "sure", "ok", 👍 ◀──┴──▶ STOP, "no thanks", "wrong number",
                │                  "not Eddy", "remove my number"
                ▼                       │
   active: held alerts sent             ▼
   now; future alerts go       opted out: nothing more is sent
   straight out                (START or YES opts back in)

   Anything else ("Who is this?", "Hi", "let me check with my manager",
   "ok, how did you get my number?") is neither: the alerts stay held and the
   reply is logged as reply_not_consent, with its text, for a person to
   follow up.
```

**Only a YES-type reply is consent**, as the welcome asks: yes, sure, ok,
sounds good, thanks, 👍, a Like on the welcome, and similar. A yes mixed
with doubt ("sure, who is this?") is held. This matters because a Team page
can hold a mistyped or reassigned number: a stranger's reply must never
release a lead's name and phone. A wrong guess can only hold someone's
alerts back, and it's logged. In tests with 220 realistic replies from
strangers at a wrong number, the only ones read as consent were "ok", "k",
"👍" and "sure lol", which no rule can tell apart from a team member's yes.

**Someone who texts the sender first** ("Hi") before any welcome has opted
in by doing so and is active straight away, unless they refuse or ask who
we are.

**Opting out, once someone gets alerts, takes a clear request**: STOP,
UNSUBSCRIBE, CANCEL and the like on their own or with a word or two ("stop
please", "STOP 🛑"), or a request aimed at these texts ("stop texting me",
"take me off this list", "no more of these", "I left the team"). Replies
about the lead don't count: "going to stop by her office", "she told me to
stop calling her", "wrong number on this one". A reply that mentions
stopping without clearly asking is logged as `possible_opt_out` for a
person to check. iPhone reactions that arrive as text (`Liked "…"`) quote
our message, STOP included; they're read as the reaction and never opt
anyone out.

Once someone has messaged the sender, LoopMessage allows replies with no
interval. Alerts to people who are opted in but haven't messaged in the last
day go out **one per scheduler pass, about every 15 seconds**, in one queue
for everyone; welcomes share that queue.

LoopMessage's docs ask for more: "you must keep a minimal interval of 2
minutes between each such message. Otherwise, your request may be
rejected." The 15 seconds is the operator's decision (Oct 2026), on the
grounds that everyone in that queue has opted in and "recently" isn't
defined. The fallback is automatic: if LoopMessage answers **540** ("limit
of sending messages to recipients who have not been contacted for a long
time"), the service keeps the alert, waits 2 minutes, and sends at the
2-minute pace for the next hour (`loopmessage_limit_slowing_down` in the
logs, `slowed_down: true` on `/health`). A second 540 while slowed pauses
sending for an hour. To go back to 2 minutes for good, set
`COLD_SEND_INTERVAL_SECONDS=120`.

Held alerts wait **24 hours** for a reply, then they're dropped (stale).
At most 5 are held per person, one per lead.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | none | Liveness, rollout settings and counts. No names or numbers. |
| `GET` | `/health/upstream` | token | Verifies the LoopMessage key and lists sender ids. |
| `GET` | `/contacts` | token | Every number the service knows: status, held alerts, welcome/reply times, last error. |
| `POST` | `/webhooks/introduction` | token | The Masterinbox webhook. Returns `202` once the introduction is saved to disk; `400` (and a log line) for a malformed one; `503` if it couldn't be saved (it's still sent unless the service restarts first). |
| `POST` | `/webhooks/loopmessage` | LoopMessage secret | Replies and delivery events from LoopMessage. `503` if the change couldn't be saved, so LoopMessage delivers it again. |

*token* is `?token=<INTRO_WEBHOOK_TOKEN>` or an `X-Webhook-Token` header.
The LoopMessage webhook is checked against `LOOPMESSAGE_WEBHOOK_SECRET`,
sent by LoopMessage as the `Authorization` header (configured in their
dashboard). Both compared in constant time.

On the introduction webhook, `&wait=1` blocks and returns per-recipient
results; add `&dry_run=1` to preview what *would* happen (held, welcome,
sent, skipped) without changing anything.

Contact statuses in `/contacts`:

| Status | Meaning |
|---|---|
| `welcome_queued` | Waiting for its turn under the 15-minute spacing / daily cap |
| `welcomed` | Welcome sent, waiting for a YES; alerts are held. `welcome_unconfirmed` means LoopMessage didn't confirm it (timeout or 5xx) and it won't be sent again. |
| `active` | Has messaged the sender; gets alerts |
| `opted_out` | Replied STOP or refused (or LoopMessage says opted out) |
| `needs_inbound` | LoopMessage wouldn't let us start the conversation; waits for them to text first |
| `unreachable` | LoopMessage says the number is invalid / not mobile |
| `welcome_failed` | The welcome was refused, or not delivered 3 times |

## Who decides which clients are texted

Masterinbox does. Staff turn **SMS** on or off per client on the Client
Portals page; for a client that's on, the people switched on in their
portal's Team page are the team[] Masterinbox sends here. Every
Introduction Masterinbox approves for SMS carries `"sms_enabled": true`,
and this service texts nothing without it (logged as
`sms_not_approved`). That keeps out BrokerStaffer OS's own copy of the
introduction webhook and any older app build, neither of which knows about
the switches.

With that in place `NOTIFY_CLIENTS` can be `*`; it stays as an emergency
brake (empty = text nobody).

## Rollout controls

| Variable | Effect |
|---|---|
| `NOTIFY_CLIENTS` | Client names or ids, comma-separated, case-insensitive. `*` enables every client. **Empty enables nobody**, so a missing variable can't text the whole install. |
| `TEST_RECIPIENT_OVERRIDE` | While set, each enabled lead sends exactly **one** text to this number instead of the team. |

Events for clients that aren't enabled are logged as `client_not_enabled`
with the client's name **and id**.

Typical sequence:

```
1. one test number     NOTIFY_CLIENTS="Demo Portal"   TEST_RECIPIENT_OVERRIDE="+1…"
2. a client's team     NOTIFY_CLIENTS="Demo Portal"
3. full rollout        NOTIFY_CLIENTS="*"
```

Turning on many clients at once queues a welcome for every new team
member; the warm-up cap spreads them over days. `/health` shows the
welcomes sent in the last 24 hours against the cap, and the welcome **reply
rate** (LoopMessage wants it above ~30%).

Pacing variables: `INIT_INTERVAL_MINUTES` (default 15) can't go below
LoopMessage's 15 minutes; the service refuses to start unless
`ALLOW_FAST_PACING=1`, which is for local testing against a mock only.
`COLD_SEND_INTERVAL_SECONDS` (default 10, which with the 15-second
scheduler means one text per pass) is the gap described above.
`INIT_DAILY_CAP` replaces the warm-up schedule.

## Testing with team members

1. In the LoopMessage dashboard, set the webhook (see Deployment) so
   replies reach the service. Without it nobody can be activated.
2. Add testers on the client's portal **Team** page with their mobile
   number. Bare 10-digit US numbers are fine; others need `+` and the
   country code. Placeholder numbers (like `+1 555 100 …`) are skipped.
3. Fastest path: each tester texts anything ("Hi") to the sender number
   first. They're active immediately and get alerts within seconds.
   Otherwise they'll get the welcome (15 min apart, 2 a day at first) and
   must reply YES (or "sure", "ok", 👍). Any other reply keeps their alerts
   held.
4. Fire an Introduction for that client (add a lead in the Introduction
   stage, or move one there). Use a **new lead** each time — the same lead
   isn't re-sent to the same person within 24 hours.
5. Check `/contacts?token=…` to see who is active, held or opted out.

Testers must not reply STOP — that opts their phone out (START brings it
back).

## Log lines that need a person

| `msg` | What happened | What to do |
|---|---|---|
| `reply_not_consent` | Someone replied to the welcome, but not with a clear yes. The reply's text is in the line. | If they're on the team, ask them to reply YES. |
| `possible_opt_out` | Someone getting alerts mentioned stopping without clearly asking. The text is in the line. | Read it; if they want out, ask them to reply STOP. |
| `inbound_from_email_contact` | A reply came from an Apple ID email, which can't be matched to a phone. Error level if it reads as an opt-out. | Opt them out by hand if so. |
| `alert_send_unconfirmed`, `welcome_send_unconfirmed`, `*_send_interrupted` | LoopMessage may or may not have sent it; it won't be sent again. | Check with the person if it matters. |
| `alert_not_delivered`, `welcome_not_delivered` | LoopMessage reported it undelivered. | Usually nothing; repeated ones point at the number. |
| `state_save_failed` | The state file couldn't be written; nothing is sent until it can be. | Check the volume. |

## Behaviour worth knowing

- **State survives redeploys.** Consent, held alerts, the welcome queue,
  the pacing clock, dedupe keys and accepted-but-unrouted introductions are
  saved to a JSON file on the Railway volume (`RAILWAY_VOLUME_MOUNT_PATH`).
  On Railway the service refuses to start without one
  (`ALLOW_EPHEMERAL_STATE=1` overrides), since it would forget opt-outs.
- **A text is never sent twice; a missed one is logged.** Every send is
  marked on disk before it goes out. If LoopMessage may have queued a
  message without confirming it (a timeout, a 5xx without an error code),
  or the service was stopped mid-send, it counts as sent: logged as
  `alert_send_unconfirmed` / `welcome_send_unconfirmed` /
  `*_send_interrupted`, never retried. Only a send that provably never
  reached LoopMessage (connection refused, DNS) is retried. If that mark
  can't be written (disk full), nothing is sent until it can. The same
  lead isn't sent to the same person again within 24 hours of the text.
- **Replies don't wait for sends.** A reply or delivery event is applied
  and saved the moment it arrives, so LoopMessage gets its 200 at once and a
  STOP stops a release that's under way. LoopMessage's redeliveries of the
  same reply are ignored by `message_id`, so a retried "yes" can't undo a
  later STOP. Nothing LoopMessage reports about a send undoes an opt-out.
- **LoopMessage error codes drive what happens next**: 500 → opted out;
  invalid number codes → unreachable; 510/520/530 → start over with a welcome
  (or wait for them to text; two different people refused in a row pauses
  welcomes for an hour instead); 540/550, HTTP 429 and sender/account errors
  → pause for an hour and retry; unreachable → retry until the alert
  expires; other codes → 3 tries.
- **Delivery events** (`message_failed`) are acted on for alerts as well as
  welcomes: logged as `alert_not_delivered`, 500 opts the person out, and
  the lead can be re-sent if it's fired again. A welcome that fails for a
  reason that isn't about the person is sent again, 3 times at most.
- **Shutdown** (Railway's SIGTERM on redeploy): the scheduler stops; the
  process exits once the send in progress and any request still being
  received have finished (up to ~20s). Requests are still accepted
  meanwhile; they're on disk before they're answered, so the next process
  picks up whatever this one doesn't finish.
- **Opt-out footer.** LoopMessage appends `To opt-out reply: stop` to at
  least some US messages; the service can't remove it. The alert carries
  no opt-out line of its own, so it isn't said twice (the welcome still
  says "or STOP to opt out", as a first message must). Replying STOP works
  whether or not a line is shown.
- **Sender must be the name, not the id.** `sender-name-list` returns an
  `id` that the send endpoint rejects (code 220). `LOOPMESSAGE_SENDER_ID`
  must hold the sender's name, e.g. `+19453926102`.
- **A `200` from LoopMessage means queued, not delivered.** Delivery events
  on the LoopMessage webhook update the welcome's status.
- **Phone normalization is required, not cosmetic.** `client_team_members.phone`
  is free text; members whose number can't be normalized are skipped and
  logged by name. A phone listed twice on a team gets one text.
- One replica only: the lock and the state file assume a single process.

## Local development

```bash
npm test                  # no deps, no network, simulated clock
```

To run the server against a fake LoopMessage, point `LOOPMESSAGE_BASE_URL`
at a local mock, set `STATE_PATH` to a scratch file and, to skip the real
spacing, `ALLOW_FAST_PACING=1`. Preview any payload without changing state:

```bash
curl -s -X POST "http://127.0.0.1:3000/webhooks/introduction?token=$INTRO_WEBHOOK_TOKEN&wait=1&dry_run=1" \
  -H 'Content-Type: application/json' \
  -d '{"event":"lead.introduction","pipeline_entry_id":"test-1",
       "source":"inbox_label",
       "lead":{"name":"Jane Doe","email":"jane@example.com","company":"Acme"},
       "client":{"id":"c1","name":"Test Client"},
       "team":[{"name":"Agent","mobile":"9733966766"}]}'
```

## Deployment

Railway, in the same project as the Masterinbox app, as its own service,
with a volume mounted at `/data`. No GitHub connection — deploys are pushed
directly from this directory:

```bash
RAILWAY_TOKEN=<project token> railway up --service loopmessage-notifier
```

The app points at it with, on the app service:

```
N8N_INTRODUCTION_WEBHOOK_URL=https://<this-service>/webhooks/introduction?token=<INTRO_WEBHOOK_TOKEN>
```

The env var keeps its `N8N_` name so the app code doesn't have to change;
it no longer points at n8n.

LoopMessage points at it from its dashboard (webhook settings for the
organization):

```
URL:            https://<this-service>/webhooks/loopmessage
Authorization:  <LOOPMESSAGE_WEBHOOK_SECRET>
Events:         inbound messages (required); delivered / failed (optional)
```
