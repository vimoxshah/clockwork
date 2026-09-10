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

## Recurrence expansion — the anchor, and the one ceiling

A rule you save without a `DTSTART` gets one synthesized, because `rrule` would
otherwise anchor at construction-time "now", which breaks historical and
fake-clock expansion. The anchor used to be 1970-01-01, and that was the whole
of the calendar's cost: `RRule.between()` is a replay, not a search — it walks
forward from the anchor one period at a time and only then starts accepting
dates — so every request replayed 56 years of occurrences per schedule, and grew
by another year of replay every calendar year.

`packages/daemon/src/recurrence.ts` now advances that synthetic anchor forward by
a **whole number of `INTERVAL` periods in the rule's own `FREQ` unit**, kept one
period below the window it was asked about. That yields exactly the old
occurrence set with the part below the anchor removed, and the part below the
anchor is entirely below the window. Measured on an Apple M4, 2026-09-07:

| rule | measurement | before | after |
| --- | --- | --- | --- |
| `FREQ=DAILY;BYHOUR=9;BYMINUTE=0` | month view | 25.76 ms | 0.092–0.167 ms |
| `FREQ=WEEKLY;BYDAY=MO,WE,FR` | month view | 6.18 ms | 0.038–0.065 ms |
| `FREQ=HOURLY` | one next-fire, 8-day horizon | 1,347 ms | 2.0 ms |
| `FREQ=MINUTELY` | one next-fire, 8-day horizon | 78,941 ms | 87.6 ms |

The two kinds of measurement are different and the column says which is which.
The month-view "after" figures are the range across three full test runs on
2026-09-07; the next-fire pairs are the before/after recorded in
`packages/daemon/test/recurrence-anchor.test.ts`.

The bottom row is why this was a correctness problem and not a tuning one: a
per-minute rule is a rule you can type, and 79 seconds of expansion blocked the
save request and then the tick that touched the schedule.

Four kinds of rule keep the 1970 anchor on purpose, because the advance is not
provably set-preserving for them: a rule with a stated `COUNT`, a sub-daily rule
whose counter can leave its own `INTERVAL` grid, a degenerate `INTERVAL`, and
`YEARLY` (56 iterations is not a hazard, so it was left where it was).
`packages/daemon/test/recurrence-anchor.test.ts` expands every shape both ways
— across every DST transition, in two zones, over the 732-day next-fire horizon
— and requires the two occurrence lists to be **identical**. Speed without that
equivalence would be worthless here: this module owns the DST rules above.

**`COUNT` is capped at 100,000 at save time.** A `COUNT` rule keeps the epoch
anchor, and its cost is linear in `COUNT`: 34 ms at 10,000, 277 ms at 100,000,
2.6 s at 1,000,000, and 79 seconds at 40,000,000. A larger `COUNT` is refused
with a named error that tells you to drop `COUNT` and use `UNTIL`. The ceiling
refuses nothing real — at 100,000 a per-minute rule still fires for 69 days and
a daily one for 274 years.

**Known defect, upstream and not fixed.** A rule whose coarser `BY` part cannot
be reached from its own `INTERVAL` grid — the clearest is
`FREQ=HOURLY;INTERVAL=2;BYHOUR=3`, whose hours stay even — does not terminate
inside `rrule` 2.8.1's skip loop. It behaved that way at the 1970 anchor and it
behaves that way at the advanced one, because the reachable hours depend only on
`gcd(INTERVAL, 24)`. Clockwork does not refuse such a rule yet.

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

## Office hours (F3, `packages/daemon/src/office-hours.ts`)

A second, optional deferral layer sits right after quiet hours in the tick
loop, for a different reason: quiet hours protects *your* rest, office hours
protects *your ability to answer approvals*. It only ever applies to tasks
whose profile is flagged `may_require_approval` — a task that never asks for
approval is never shifted by this feature.

- **Three setup steps, not two.** (1) Turn the feature on:
  `workforce_prefs.office_hours_enabled` starts at `0`. (2) Define windows via
  `/workforce/office-hours`. (3) **Flag the profile.** The deferral only ever
  looks at tasks whose profile has `may_require_approval = 1`, and **no
  profile route sets that column** — `ProfileCreate` and `ProfilePatch` have
  no such field. The only two writers in the product are F7 earned autonomy:
  `POST /workforce/autonomy/profiles/:profileId/enroll` and accepting an
  autonomy offer. So office hours is reachable only by first enrolling the
  profile in the autonomy ladder, at rung `plan` or `acceptEdits` — enrolling
  at `unattended` sets the flag to `0` and makes the profile ineligible
  again. With steps 1 and 2 done and step 3 skipped, the feature is on and
  defers nothing, silently. See `docs/agent-workforce.md` (F3 and F7).
- **Not** the same mechanism as quiet hours, in two deliberate ways. It does
  mark the claimed occurrence `disposition='deferred'` the way quiet hours
  does, and it leaves the occurrence ledger's primary key, the claim
  transaction, and all 18 `scheduler.test.ts` fixtures unmodified — that
  invariant was a hard constraint during implementation. But:
  - **It does not pre-claim a row at the resume instant**, because the tick at
    the resume instant has to win its own claim. A row pre-claimed here would
    make that tick's claim a no-op, `if (!claimed) return` would fire, and the
    schedule would be pinned at the deferral forever.
  - **It bumps `next_fire` for every schedule kind, `once` included.** The
    claim transaction that just ran has already NULLed a `once` schedule's
    `next_fire`, and a dropped one-shot is lost work, not a skipped repeat.

  **Quiet hours now follows both rules too, and until 2026-09-10 it followed
  neither.** These were written up as office-hours *differences* because office
  hours was built second and reasoned about the hazard properly; quiet hours had
  shipped the other way with no ADR arguing for it. Both failures were real and
  both were reachable: a recurring schedule deferred by quiet hours was pinned
  at its resume instant forever, and a `once` schedule was dropped outright.
  There is now one rule for both branches, with the reasoning in a comment
  beside each. ADR-030 records the repair.
- Windows never cross midnight (`endMin > startMin`); a shift that does is two
  rows. The search for the next open window gives up after 14 days and
  defers no further — a badly configured window set stops deferring rather
  than hanging forever.
- **Fails open.** Any error evaluating office hours — malformed windows, the
  feature being off, the task's profile not flagged, or the fire time already
  being inside a window — results in "don't shift"; the run fires on its
  normal schedule. A broken office-hours configuration can only make a run
  late, never make it silently disappear.

## Overlap policy

When a recurring fire lands while the previous run is still executing:
`skip` (default) → occurrence marked skipped with an inbox note;
`queue` → second instance queues behind the repo mutex (never parallel in-repo).

## Keep-awake honesty

Clockwork arms a macOS power assertion before scheduled runs **when plugged
in**. Closing the lid on battery defeats it — the OS wins, and the report says
"slept through keep-awake". For true overnight jobs use an always-on machine.
We market what is true.
