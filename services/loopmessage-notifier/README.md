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

The lead alert contains the lead's email, so it can never be a first
message. Instead:

```
 new number ──lead──▶ alert HELD + welcome queued
                         │  (15 min apart, daily warm-up cap)
                         ▼
                      welcome: "Hi Lara, this is BrokerStaffer. We'll text you
                      here whenever a new lead is introduced to your team at
                      Douglas Elliman NYC. Reply YES to start getting these,
                      or STOP to opt out."
                         │
            any reply ◀──┘──▶ STOP
                │                 │
                ▼                 ▼
   active: held alerts sent    opted out: nothing more is sent
   now; future alerts go       (START or YES opts back in)
   straight out
```

Someone who texts the sender first (anything — "Hi") is active straight
away and never gets a welcome. Once someone has messaged the sender,
LoopMessage allows replies with no interval; alerts to people who haven't
messaged in the last day are spaced **2 minutes** apart.

Held alerts wait **24 hours** for a reply, then they're dropped (stale).
At most 5 are held per person, one per lead.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | none | Liveness, rollout settings and counts. No names or numbers. |
| `GET` | `/health/upstream` | token | Verifies the LoopMessage key and lists sender ids. |
| `GET` | `/contacts` | token | Every number the service knows: status, held alerts, welcome/reply times, last error. |
| `POST` | `/webhooks/introduction` | token | The Masterinbox webhook. Returns `202` immediately. |
| `POST` | `/webhooks/loopmessage` | LoopMessage secret | Replies and delivery events from LoopMessage. |

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
| `welcomed` | Welcome sent, waiting for a reply; alerts are held |
| `active` | Has messaged the sender; gets alerts |
| `opted_out` | Replied STOP (or LoopMessage says opted out) |
| `needs_inbound` | LoopMessage wouldn't let us start the conversation; waits for them to text first |
| `unreachable` | LoopMessage says the number is invalid / not mobile |
| `welcome_failed` | The welcome was refused or not delivered |

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
member; the warm-up cap spreads them over days. `/health` shows today's
welcome count and cap, and the welcome **reply rate** (LoopMessage wants it
above ~30%).

## Testing with team members

1. In the LoopMessage dashboard, set the webhook (see Deployment) so
   replies reach the service. Without it nobody can be activated.
2. Add testers on the client's portal **Team** page with their mobile
   number. Bare 10-digit US numbers are fine; others need `+` and the
   country code. Placeholder numbers (like `+1 555 100 …`) are skipped.
3. Fastest path: each tester texts anything ("Hi") to the sender number
   first. They're active immediately and get alerts within seconds.
   Otherwise they'll get the welcome (15 min apart, 2 a day at first) and
   should reply YES.
4. Fire an Introduction for that client (add a lead in the Introduction
   stage, or move one there). Use a **new lead** each time — the same lead
   isn't re-sent to the same person within 6 hours.
5. Check `/contacts?token=…` to see who is active, held or opted out.

Testers must not reply STOP — that opts their phone out (START brings it
back).

## Behaviour worth knowing

- **State survives redeploys.** Consent, held alerts, the welcome queue,
  the pacing clock and dedupe keys are saved to a JSON file on the Railway
  volume (`RAILWAY_VOLUME_MOUNT_PATH`). Without a volume the service logs
  `state_not_persistent` and forgets everything on each deploy.
- **LoopMessage error codes drive what happens next**: 500 → opted out;
  invalid number codes → unreachable; 510/520/530 → start over with a welcome
  (or wait for them to text); 540/550 and sender/account errors → pause for
  an hour and retry; network/5xx → retry until the alert expires.
- **Opt-out footer.** LoopMessage appends `To opt-out reply: stop` to at
  least some US messages. The service doesn't add it and can't remove it.
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
at a local mock and set `STATE_PATH` to a scratch file. Preview any payload
without changing state:

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
