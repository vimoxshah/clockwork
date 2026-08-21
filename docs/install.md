# Installing & Running Clockwork (developer build)

> Status: private-alpha engineering build. macOS-first. Requires an existing
> Claude Code login (`claude` CLI on PATH) — Clockwork rides your subscription;
> no API key needed.

## Prerequisites

- macOS 13+ (Apple Silicon tested)
- Node.js ≥ 22
- pnpm ≥ 9 (`corepack enable pnpm`)
- git ≥ 2.38
- Claude Code CLI installed and logged in (`claude --version`, run `claude` once)

## Build

```bash
pnpm install
pnpm build          # builds shared → runner → daemon → ui
```

## Run the daemon + UI (single port)

```bash
pnpm --filter @clockwork/ui build   # if you changed UI code
node packages/daemon/dist/main.js
# → clockworkd 0.1.0 listening on 127.0.0.1:4747
```

Open http://127.0.0.1:4747 — paste your API token when prompted:

```bash
cat ~/.clockwork/api-token
```

## Install as a login service (starts at login, restarts on crash)

```bash
node packages/daemon/dist/cli.js install     # writes ~/Library/LaunchAgents/com.clockwork.daemon.plist
node packages/daemon/dist/cli.js doctor      # 6 canned misconfig checks incl. duplicate instance
node packages/daemon/dist/cli.js uninstall
```

The daemon does **not** run while logged out or while the machine sleeps — that
is the honest execution model; see `docs/scheduling.md`.

## First task (60 seconds)

1. Open the UI → **+ New task**.
2. Prompt: "List the TODOs in this repo and summarize themes." Pick a repo path.
3. Schedule: one-off, a minute from now. Book it.
4. Watch the calendar tick over; the report lands in **Inbox**, searchable.

Or drive the API directly:

```bash
TOKEN=$(cat ~/.clockwork/api-token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4747/health
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"demo","prompt":"say hi","schedule":{"kind":"once","runAt":'"$(($(date +%s)*1000+60000))"',"tz":"UTC"}}' \
  http://127.0.0.1:4747/tasks
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4747/tasks/<id>/run-now
```

## Test engine without spending quota

Set `CW_ENGINE=mock` for the daemon to execute jobs with the deterministic
MockRunner — full loop behavior, zero API spend.

## Data layout

```
~/.clockwork/
  clockwork.sqlite      # tasks, schedules, occurrence ledger, runs, reports (WAL)
  api-token             # 0600 bearer token
  safety-journal.jsonl  # deny-list hits, sandbox events, budget stops (FR-27)
  runs/<run-id>/        # transcripts, artifacts, stream journals
  worktrees/            # per-run git worktrees (retention-pruned)
```

## Uninstall

```bash
node packages/daemon/dist/cli.js uninstall
# keep or export ~/.clockwork (reports + DB) before deleting it manually
```
