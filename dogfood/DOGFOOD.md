# Dogfood — Clockwork runs on Clockwork

Per the execution plan's working agreements: from M1, the builder's own machine
runs **≥3 real recurring jobs continuously**. Every silent failure is a P0.

## The three jobs

| # | Job | Task name | Schedule | Profile | Repo | Budget |
|---|---|---|---|---|---|---|
| 1 | dependency-triage | "Weekly dep triage" | Mondays 09:00 (local tz) | @dep-surgeon | clockwork repo itself | $2 / 50 turns / 1h |
| 2 | test-doctor | "Flaky test sweep" | Wednesdays 09:00 | @generalist (test-doctor skill) | clockwork repo | $2 / 50 turns / 1h |
| 3 | docs-writer | "Docs drift check" | Fridays 09:00 | @docs-scribe | clockwork repo | $1.5 / 40 turns / 45m |

## Booking them

```bash
node packages/daemon/dist/main.js &
TOKEN=$(cat ~/.clockwork/api-token)
TZ=$(readlink /etc/localtime | sed 's|.*/zoneinfo/||')

book() { curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "$1" http://127.0.0.1:4747/tasks; }

book "{\"name\":\"Weekly dep triage\",\"prompt\":\"Run the dependency-triage procedure on this repository.\",\"repoPath\":\"$PWD\",\"schedule\":{\"kind\":\"rrule\",\"rrule\":\"FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0\",\"tz\":\"$TZ\"},\"missedPolicy\":\"run-late\"}"
book "{\"name\":\"Flaky test sweep\",\"prompt\":\"Run the test-doctor procedure on this repository.\",\"repoPath\":\"$PWD\",\"schedule\":{\"kind\":\"rrule\",\"rrule\":\"FREQ=WEEKLY;BYDAY=WE;BYHOUR=9;BYMINUTE=0\",\"tz\":\"$TZ\"}}"
book "{\"name\":\"Docs drift check\",\"prompt\":\"Run the docs-writer procedure on this repository.\",\"repoPath\":\"$PWD\",\"schedule\":{\"kind\":\"rrule\",\"rrule\":\"FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0\",\"tz\":\"$TZ\"}}"
```

## Per-run tracking log (append after every run)

Record in `dogfood/RUN-LOG.md`:

- scheduled time vs actual start vs actual finish
- machine sleep state during window
- queue delay, repo lock delay
- cost, turns, result
- report quality (worth reading? actionable?)
- any failure + recovery behavior

**Silent-failure rule:** anything wrong that produced no inbox/notification
signal is an automatic P0 — file it, root-cause it, fix it.
