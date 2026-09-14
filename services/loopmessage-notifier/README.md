# loopmessage-notifier

Receives `lead.introduction` webhooks from the Masterinbox app and texts the
client's team via [LoopMessage](https://loopmessage.com) (iMessage, with
carrier fallback).

Replaces the n8n workflow that previously did this over Twilio. n8n is no
longer in the path.

## Why it's a service and not a workflow

The producer — `lib/webhooks/n8n-introduction.ts` — fires inside
`next/server` `after()`, swallows every error, and never retries. A failed
POST leaves nothing behind but a console line. So the durability (retries,
dedupe, per-recipient logging) has to live on the receiving side.

## Flow

```
Masterinbox app                     this service                LoopMessage
  human marks lead
  as Introduction
        │
        │ POST /webhooks/introduction?token=…
        │ one request per pipeline entry
        ▼
                              validate token
                              normalize each team
                              member's phone → E.164
                              dedupe (entry, number)
                                     │
                                     │ POST /message/send/  ×N
                                     ▼
                                                          iMessage / SMS
```

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | none | Liveness. No secrets in the response. |
| `GET` | `/health/upstream` | token | Verifies the LoopMessage key and lists sender ids. |
| `POST` | `/webhooks/introduction` | token | The webhook. Returns `202` immediately. |

Auth is `?token=<INTRO_WEBHOOK_TOKEN>` or an `X-Webhook-Token` header,
compared in constant time.

Add `&wait=1` to block on the sends and get per-recipient results back —
useful for testing, not for the production caller.

## Rollout controls

Two variables decide who actually gets texted. Both are read at startup,
so changing them on Railway redeploys the service.

| Variable | Effect |
|---|---|
| `NOTIFY_CLIENTS` | Client names or ids, comma-separated, case-insensitive. `*` enables every client. **Empty enables nobody**, so a missing variable can't text the whole install. |
| `TEST_RECIPIENT_OVERRIDE` | While set, each enabled lead sends exactly **one** text to this number instead of the team. The greeting uses the team member who owns that number if they're on the team. |

Events for clients that aren't enabled are acknowledged and logged as
`client_not_enabled` with the client's name **and id**. If a client name
doesn't match what you expect, copy the id from that log line.

Typical sequence:

```
1. client-side test   NOTIFY_CLIENTS="Demo Portal"   TEST_RECIPIENT_OVERRIDE="+1…"
2. real team, one     NOTIFY_CLIENTS="Demo Portal"   (override removed)
3. full rollout       NOTIFY_CLIENTS="*"
```

To check a live config without texting anyone, add `&dry_run=1` to a
`wait=1` request. It returns the recipients that *would* be texted.
`/health` shows how many clients are enabled and whether the override is on.

## Behaviour worth knowing

- **Opt-out footer.** LoopMessage appended `To opt-out reply: stop` to the
  message sent to a US number, but not to one sent to an Indian number.
  The service doesn't add it and can't remove it.
- **Sender must be the name, not the id.** `sender-name-list` returns an
  `id` that the send endpoint rejects (code 220). `LOOPMESSAGE_SENDER_ID`
  must hold the sender's name, e.g. `+19453926102`.

- **A `200` from LoopMessage means queued, not delivered.** Confirm with
  `GET /message-status/{id}/`. The service logs the `message_id` for this.
- **Dedupe is keyed on `(pipeline_entry_id, phone)`** with a 6h TTL, so a
  replayed webhook won't double-text an agent, but a genuinely new lead for
  the same agent still goes through. A *failed* send releases its claim so a
  retry isn't swallowed.
- **Phone normalization is required, not cosmetic.** `client_team_members.phone`
  is free text (`9733966766`, `631-425-5731`); LoopMessage rejects anything
  without a country code. Members whose number can't be normalized are
  skipped and logged by name — they are never silently dropped.
- **Retries** cover network errors and 408/425/429/5xx, twice with backoff.
  A 4xx is not retried.
- **`HTTP 200` with `{"success": false}`** is treated as a failure; the API
  returns this for auth problems.
- State is in-memory. A redeploy clears the dedupe window; the cost is at
  worst one duplicate text on a webhook replayed across a restart.

## Local development

```bash
cp .env.example .env      # fill in LOOPMESSAGE_API_KEY + INTRO_WEBHOOK_TOKEN
npm test                  # no deps, no network
DRY_RUN=1 npm start
```

Dry run with the real payload shape:

```bash
curl -s -X POST "http://127.0.0.1:3000/webhooks/introduction?token=$INTRO_WEBHOOK_TOKEN&wait=1" \
  -H 'Content-Type: application/json' \
  -d '{"event":"lead.introduction","pipeline_entry_id":"test-1",
       "source":"inbox_label",
       "lead":{"name":"Jane Doe","email":"jane@example.com","company":"Acme"},
       "client":{"id":"c1","name":"Test Client"},
       "team":[{"name":"Agent","mobile":"9733966766"}]}'
```

## Deployment

Railway, in the same project as the Masterinbox app, as its own service.
No GitHub connection — deploys are pushed directly from this directory:

```bash
RAILWAY_TOKEN=<project token> railway up --service loopmessage-notifier
```

Then point the app at it by setting, on the app service:

```
N8N_INTRODUCTION_WEBHOOK_URL=https://<this-service>/webhooks/introduction?token=<INTRO_WEBHOOK_TOKEN>
```

The env var keeps its `N8N_` name so the app code doesn't have to change;
it no longer points at n8n.
