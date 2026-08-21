# Clockwork — Scheduling Semantics

The scheduler is the most-tested module in the codebase. This document states
exactly how time works; the fixture suite (`packages/daemon/test/scheduler.test.ts`)
proves it.

## The model (ADR-005)

- **Tick loop, not OS cron**: every 30s the daemon queries
  `schedules WHERE next_fire <= now AND enabled`.
- **next_fire materialization**: on task save and after each fire, recurrence is
  expanded in the schedule's IANA zone and stored as UTC epoch ms.
- **Wall-clock comparisons only** — no cached deltas, so NTP corrections and
  manual clock changes cannot re-fire or skip occurrences (S-25).

## The occurrence ledger — why double-fire is impossible

Every occurrence is claimed by `INSERT` into `schedule_occurrences` whose
primary key is `(schedule_id, occurrence_at)` **in the same transaction** that
inserts the run row and advances `next_fire`. A crash commits all three writes
or none. Two racing schedulers (or a crash-restart race) cannot both claim one
occurrence — proven by concurrent-claim attack tests.

Dispositions: `fired` · `coalesced` · `skipped` · `missed`.

## DST rules (normative)

| Case | Behavior | Fixture |
|---|---|---|
| Nonexistent local time (spring-forward) | fires at the post-transition instant | America/New_York 2026-03-08 02:30, Europe/Berlin 2026-03-29 02:30 |
| Ambiguous local time (fall-back) | fires on the FIRST occurrence (earlier UTC) | America/New_York 2026-11-01 01:30 |
| Half-hour zones | handled via IANA data | Australia/Lord_Howe |
| Recurring across a transition | local wall time preserved each week | Berlin weekly fixture |

Zones: schedules follow their stored IANA zone, never the system zone (S-22).

## Sleep, wake, and missed runs

- Machine asleep at fire time → the next tick after wake runs a catch-up sweep
  (the startup sweep is the same code path).
- **Missed-window policy** per task:
  - `run-late` (default): if within `missed_window_sec`, ONE catch-up run fires,
    report shows "ran Xm late".
  - `skip`: occurrence claimed `missed`; notification explains why.
  - `ask`: inbox item in state `awaiting_user` — you decide.
- **Coalescing rule**: sleeping through N occurrences produces at most ONE
  catch-up run per schedule; covered occurrences are recorded as `coalesced`
  and listed in the report.
- Runs keep wall-clock timeouts: a sleep-inflated run may hit its timeout — the
  report says so honestly (S-13).

## Overlap policy

When a recurring fire lands while the previous run is still executing:
`skip` (default) → occurrence marked skipped with an inbox note;
`queue` → second instance queues behind the repo mutex (never parallel in-repo).

## Keep-awake honesty

Clockwork arms a macOS power assertion before scheduled runs **when plugged
in**. Closing the lid on battery defeats it — the OS wins, and the report says
"slept through keep-awake". For true overnight jobs use an always-on machine.
We market what is true.
