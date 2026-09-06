# Event triggers — webhooks and GitHub events

A trigger binds an inbound HTTP event to a task. When a matching event
arrives, Clockwork enqueues the task exactly like **Run now** — same policy
gates, same budget, same audit trail (`packages/daemon/src/triggers.ts`).
The event payload is stashed on the run so your prompt can read it.

Two sources ship: `webhook` (any external system, shared-secret auth) and
`github` (HMAC-signed, `x-hub-signature-256`).

## Create a trigger

```bash
TOKEN=$(cat ~/.clockwork/api-token)
curl -s -X POST http://127.0.0.1:4747/triggers \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"release-watch","source":"github","taskId":"<taskId>"}'
```

Body (`packages/daemon/src/api.ts`): `name` (required, truncated to
120 chars), `source` (required, `"webhook"` or `"github"`), `taskId`
(required, must exist), `secret` (optional, ignored unless ≥ 8 chars — see
below), `filter` (optional dot-path object — see below).

Response (`api.ts`):

```json
{ "id": "trg_abc123", "secret": "9f2c…", "webhookPath": "/hooks/trg_abc123" }
```

**`secret` is returned once, in this response only.** The database keeps
only its SHA-256 hash (`triggers.ts,31-33`) — there's no way to retrieve
it later. A `secret` under 8 characters is silently dropped and the response
omits it; that omission is your signal the trigger is unauthenticated
(`api.ts`).

Free plan caps you at 2 triggers; over that, `POST /triggers` returns `402`
(`api.ts`, `features.ts:91`).

Managing triggers (same bearer token as creation): `GET /triggers` lists
them (`hasSecret` instead of the secret); `PATCH /triggers/:id
{"enabled":false}` pauses one; `DELETE /triggers/:id` removes one;
`GET /trigger-events?limit=50` is the delivery log — payload, match result,
run fired or reason it wasn't.

## How a delivery is verified

**`webhook` source:** send the secret as-is in `x-clockwork-secret`; the
daemon hashes it and compares to the stored hash (`triggers.ts`). No
secret on the trigger means **no check at all** — anyone who reaches the URL
fires the task (`api.ts`). Always set a secret before exposing the URL
past your own machine.

**`github` source:** GitHub HMAC-SHA256-signs the raw body and sends
`x-hub-signature-256: sha256=<hex>`; Clockwork recomputes it and does a
constant-time compare (`triggers.ts`). The signing key is **one
process-wide value** — the `CLOCKWORK_GITHUB_WEBHOOK_SECRET` environment
variable — not the per-trigger `secret`, which is stored but never checked
for this source. Leave `secret` unset for `github` triggers. No env var set
means every request is refused with `503`, fail closed (`api.ts`).

The daemon runs as a login `launchd` agent (`cli.ts:16-34`) whose generated
plist has no `EnvironmentVariables` entry, and there's no settings-screen for
this secret yet. Get it into the daemon's environment either by running
`launchctl setenv CLOCKWORK_GITHUB_WEBHOOK_SECRET '<value>'` and then
`launchctl kickstart -k gui/$(id -u)/com.clockwork.daemon` to restart the
agent with it, or by adding an `EnvironmentVariables` dict to
`~/Library/LaunchAgents/com.clockwork.daemon.plist` yourself and running the
same `kickstart` command.

Verification runs over the exact bytes the sender put on the wire, not a
re-parsed-and-re-serialized copy. The daemon registers its own
`application/json` content-type parser (`api.ts`, Fastify built-in —
`addContentTypeParser` with `parseAs: 'string'`, no added dependency) that
stashes the raw request string before parsing it, and `handleHook` HMACs
that raw string (`api.ts`) when present. This closes a real gap: an
earlier build computed the signature over `JSON.stringify(req.body)` — a
re-serialization — which silently differs from what GitHub sent whenever the
delivery is pretty-printed, contains a float, or has an escaped-unicode
sequence, so real GitHub traffic would have failed verification even with
the correct secret. It's verified with a byte-exact test, not yet against
live GitHub: `hooks-rawbody.test.ts` signs a pretty-printed payload with a
float and an escaped `é` over its true wire bytes (accepted) and, as a
negative control, over its re-serialized form — what the old code actually
verified against — which is now correctly rejected
(`api.test.ts:150-192` separately covers the fail-closed no-secret case).
If a real delivery ever returns `401` with a secret you're sure is right,
that mismatch — not your secret — is the likely cause; report it rather than
rotating the secret.

## Filters — restrict which events fire the task

`filter` is a flat dot-path → expected-value object; every path must match
exactly, missing paths never match (`triggers.ts`):

```json
{ "action": "published", "release.prerelease": false }
```

Clockwork does **not** read GitHub's `x-github-event` header — a `github`
trigger fires on any verified event whose filter (if any) matches. Use
`filter` on payload shape to pick the event type, e.g. `action` values that
only appear on `release` events.

GitHub's setup `ping` has no `action` field, so `{"action":"published"}`
never matches it. That's expected — seeing the `ping` land in
`GET /trigger-events` as `filter_not_matched` (not `401`/`503`) is how you
confirm the URL and signature are wired, before a real release ships.

## Event data in your prompt

The payload is available as `{{event.<dot.path>}}` (`templates.ts:114-133`);
unknown paths render as `(missing)` instead of breaking the prompt:

```
A new release {{event.release.tag_name}} shipped on
{{event.repository.full_name}}. Update the changelog.
```

## Reaching your daemon from the internet

Clockwork binds `127.0.0.1` only (`main.ts:91`). GitHub cannot reach it
directly — there is no Clockwork cloud relay. Bring your own gateway:

1. **A tunnel**, for testing or light use: `cloudflared tunnel --url
   http://127.0.0.1:4747` (or `ngrok http 4747`). Point GitHub's webhook
   **Payload URL** at the tunnel's HTTPS URL plus `/hooks/<id>`.
2. **A self-hosted relay** you control (an always-on box, or a
   Tailscale/WireGuard link into your Mac) that forwards to
   `127.0.0.1:4747`. Either way it's your infrastructure, not Clockwork's.

Deliveries only land while your machine is awake and the daemon is running —
same constraint as scheduled tasks (`docs/troubleshooting.md`).

## Recipe: run a task on every new GitHub release

1. Create a task with schedule `{"kind": "queue"}` — its schedule row is
   created with `next_fire=NULL` and `enabled=0` (`repo.ts:119-126`, "ASAP
   queue mode: a queue-kind schedule row keeps the task on the tray"), so the
   scheduler never fires it on its own. It only runs from **Run now** or a
   trigger. (The composer's **ASAP** option creates this same schedule kind;
   what it starts immediately is a manually queued run, not the schedule
   itself.)
2. Export the signing secret before the daemon starts, then create the
   trigger:
   ```bash
   export CLOCKWORK_GITHUB_WEBHOOK_SECRET='a-long-random-value'
   curl -s -X POST http://127.0.0.1:4747/triggers \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"name":"release-watch","source":"github","taskId":"<taskId>",
          "filter":{"action":"published"}}'
   ```
   Note the returned `webhookPath`, e.g. `/hooks/trg_abc123`.
3. Tunnel (above), then add a GitHub webhook on the repo: **Settings →
   Webhooks → Add webhook.** Payload URL = tunnel host + `/hooks/trg_abc123`;
   content type `application/json`; secret = same value as
   `CLOCKWORK_GITHUB_WEBHOOK_SECRET`; events = **Releases**.
4. GitHub's immediate `ping` should show up in `GET /trigger-events` as
   `filter_not_matched` — that confirms delivery works.
5. Publish a release. The `action: "published"` payload matches the filter;
   Clockwork enqueues the task with `{{event.release.*}}` filled in.

## Verify signing locally, no tunnel needed

```bash
SECRET='a-long-random-value'          # matches CLOCKWORK_GITHUB_WEBHOOK_SECRET
TRIGGER_ID='trg_abc123'

printf '%s' '{"action":"published","release":{"tag_name":"v1.2.0","prerelease":false},"repository":{"full_name":"me/repo"}}' > /tmp/payload.json

SIG="sha256=$(openssl dgst -sha256 -hmac "$SECRET" -r < /tmp/payload.json | awk '{print $1}')"

curl -s -X POST "http://127.0.0.1:4747/hooks/$TRIGGER_ID" \
  -H "Content-Type: application/json" \
  -H "x-hub-signature-256: $SIG" \
  --data-binary @/tmp/payload.json
```

Returns `202 {"ok":true,"fired":true,"runId":"..."}` on a filter match, or
`200 {"ok":true,"fired":false,"reason":"filter_not_matched"}` if it doesn't.

## Status codes

| Code | Meaning |
|---|---|
| 202 | fired — task enqueued, `runId` returned |
| 200 | delivered, filter didn't match |
| 401 | bad signature (`github`) or bad secret (`webhook`) |
| 403 | policy engine blocked the run |
| 404 | trigger id doesn't exist |
| 409 | trigger is disabled |
| 410 | the bound task was deleted |
| 503 | `github` source, no `CLOCKWORK_GITHUB_WEBHOOK_SECRET` configured |

Every delivery is recorded in `GET /trigger-events`, but its `source` field
is currently always the literal `"webhook-or-github"`, not the trigger's
actual source (`api.ts`) — use `GET /triggers` if you need to tell them
apart.
