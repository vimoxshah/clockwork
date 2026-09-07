# Scalability assessment (§60, §33)

Iteration 12. §60 asks what must change at 1K / 10K / 100K users and §33 asks
whether the UI survives 5,000 tasks and 50,000 runs. Neither had ever been
measured. This is the measurement.

**Result: no material problem at the stated target.** That is the honest
finding, and it is recorded rather than dressed up as one.

## Method

A temp database built from the real migrations, seeded with tasks and runs,
then the actual calendar month-view query from `api.ts` — the hot path,
since the calendar is the default view — run under `EXPLAIN QUERY PLAN` and
timed. Payload measured as the JSON the endpoint would ship.

## Measurements

| runs seeded | rows returned (30-day window) | SQL | payload | JSON.parse |
| --- | --- | --- | --- | --- |
| 50,000 (§33 target) | 4,203 | **6 ms** | 0.85 MB | 3 ms |
| 200,000 | 16,376 | 25 ms | — | — |
| 500,000 (10× target) | 41,031 | 69 ms | 8.38 MB | 16 ms |

Database file: 7.3 MB at 50k runs, 74.5 MB at 500k. Linear, unremarkable.

## The hypothesis that was wrong

Reading the query first suggested a scalability problem, and the query plan
confirmed the structural part exactly:

```
SCAN runs
USE TEMP B-TREE FOR ORDER BY
```

No index is used. There is genuinely **no index on `started_at` or
`ended_at`**; `idx_runs_task_time` is `(task_id, scheduled_for)` so a range
scan on `scheduled_for` alone cannot use it; the three `OR`-ed ranges defeat
index selection; and `ORDER BY COALESCE(...)` is not indexable, forcing a temp
sort of the whole result.

Every one of those observations is correct. **The conclusion drawn from them
was not.** SQLite scans 50,000 rows in 6 ms. At ten times the target it is
69 ms. A textbook-bad plan over a small table is still fast, and optimising it
would be work with no measurable benefit.

Recorded because it is the same lesson the test work keeps producing:
structural reasoning identifies where to look, measurement decides whether
anything is there.

## §33 large-scale UI — already handled

Both list surfaces cap before rendering, so the "never render huge lists
blindly" requirement is already met:

- `CalendarView.tsx:301` — `events.slice(0, MAX_PER_CELL)` per day cell
- `TasksView.tsx:160` — `filtered.slice(0, visibleCount)`

No virtualization library is present and none is needed at this scale.

## The one latent item

> **UPDATE (2026-09-07).** This section used to say two things: that
> `GET /calendar` had no `LIMIT`, and that the calendar's cost was a payload
> problem waiting for a bound. The first is no longer true. The second was the
> more interesting mistake, and correcting it is most of what follows.

### The route is bounded now, and it can answer in counts

`CALENDAR_ROW_LIMIT` (5,000, `packages/daemon/src/api.ts`) is a hard ceiling on
the rows any single response may carry per collection. `?limit=` may only lower
it, a non-integer `limit` is refused rather than coerced, and every response
reports the bound it applied together with `limits.truncated` — a capped answer
that looked complete would be worse than no bound at all.

The route also gained a second mode. `?group=day` folds the runs half inside
SQLite into one row per non-empty day, carrying the outcome breakdown a month or
year cell needs to colour itself (S-64). `GROUP BY` emits a row only for a day
that holds something, so the result is bounded by the number of non-empty days
rather than by the window's span: a `from=1` window costs a handful of rows, not
twenty thousand. The `other` bucket is derived by subtraction, so the buckets sum
back to the day's run count by construction and a state nobody grouped cannot go
missing.

Measured on 2026-09-07, Apple M4,
`packages/daemon/test/calendar-aggregate-bench.test.ts` (5,000 runs spread over
300 days, 396-day window): the detail view ships 5,000 run rows plus 470 expanded
bookings in **1.130 MB**; the aggregate ships **331 day rows in 51.4 KB** —
22.5x smaller, and the day rows account for every one of the 5,000 runs. Rows and
bytes are properties of the code rather than of the laptop, so that file asserts
them unconditionally, and three runs reproduced them byte for byte.

### The payload projection was a payload win, and only that

Before either of those, `api.ts` stopped shipping the whole frozen
`jobspec_json` blob per row and started selecting
`json_extract(jobspec_json,'$.taskName') AS task_name` — the one field the
calendar reads — with `CalendarRunRowT` on the UI side dropping
`jobspec_json`/`report_json`/`branch`/`worktree_path` from the wire shape, and
`CalendarView.tsx`'s dead `safeName()` helper removed as its one call site. On
the 5,000-run year view the payload dropped **10.16 MB to 1.15 MB**. The
0.85 MB / 8.4 MB figures in the table above predate that change and were never
re-measured at those exact corpus sizes; treat them as illustrating the old
per-row cost, not the current one.

It was expected to speed the request up as well, and it did not. The single
before/after pair measured at the time differed by about 5ms, far inside the
run-to-run spread — ten runs on 2026-09-06 put the same year-view median
anywhere between 349.59ms and 684.26ms on one machine at one commit, decided by
machine load. What stood was the negative result, not the decimals: the
projection changed memory, not latency, because the cost was neither
serialization nor the SQL scan. The runs query alone measured 12.29-32.56ms at
5,000 rows across those ten runs — three to five per cent of the request.

### Where the latency actually was, and what removed it

`recurrence.ts` synthesizes a `DTSTART` for any RRULE saved without one, because
the library would otherwise anchor at construction-time "now" and break
historical and fake-clock expansion. It anchored at `19700101T000000Z`.
`RRule.between()` is a replay rather than a search — the iterator walks forward
from `DTSTART` one period at a time and only then begins accepting dates — so
every calendar request replayed 56 years of occurrences per schedule before it
reached the window, about 20,500 of them per daily schedule, growing by another
365 every calendar year.

`advancedAnchorMs()` now moves that synthetic anchor forward by a **whole number
of `INTERVAL` periods in the rule's own `FREQ` unit**, kept one period below the
padded lower `between()` bound. The result is exactly the old occurrence set
intersected with the range from the anchor onward: the period grid is a suffix of
the old one, every component `parseOptions` reads off `DTSTART` is unchanged
because the anchor is always a whole multiple of the `FREQ` unit measured from
the epoch, and the one-period backoff keeps the part that is intersected away
entirely below the window. Three cases keep the 1970 anchor on purpose — a stated
`COUNT` (dropping early occurrences would promote later ones into the count and
un-exhaust an exhausted rule, breaking S-24 auto-disable), a sub-daily counter
whose skip loop can leave the `INTERVAL` grid, and a degenerate `INTERVAL`.
`YEARLY` keeps it too, because 56 iterations is not a hazard.

Isolated, same rule, same month-view window, measured 2026-09-07 on an Apple M4:

| rule | measurement | 1970 anchor | advanced anchor |
| --- | --- | --- | --- |
| `FREQ=DAILY;BYHOUR=9;BYMINUTE=0` | month view | 25.76 ms | 0.092–0.167 ms |
| `FREQ=WEEKLY;BYDAY=MO,WE,FR` | month view | 6.18 ms | 0.038–0.065 ms |
| `FREQ=HOURLY` | one next-fire, 8-day horizon | 1,347 ms | 2.0 ms |
| `FREQ=MINUTELY` | one next-fire, 8-day horizon | 78,941 ms | 87.6 ms |

The two kinds of measurement are not interchangeable, which is why the column
says which is which: the first two rows expand a rule across a month view, the
last two are a single `nextOccurrenceAfter` over the horizon the save path uses.
The month-view "after" figures are the range across three full test runs on
2026-09-07; the next-fire pairs are the before/after recorded in
`packages/daemon/test/recurrence-anchor.test.ts`.

The last row is the one that mattered most: 79 seconds is not a slow path, it is
a blocked save request and a blocked scheduler tick, and it was reachable by
typing a per-minute rule. The per-year growth is gone with it — the same rule
over the same window width costs 0.088–0.155ms for a 2026 window and
0.088–0.159ms for a 2126 one across those three runs, and which of the two is
faster flips from run to run. That is what "the cost is a function of the
window, not of the date" looks like.

End to end, on the 5,000-run corpus, `GET /calendar` year view: **40.82–42.17 ms
median, 52.90–67.14 ms p95** (n=15 each), and the default 62d/31d window
**13.80–16.62 ms median, 18.14–23.62 ms p95** (n=5 each), across three full test
runs on 2026-09-07. The runs SQL alone measured 22.54–23.80 ms in those runs — so the storage half, which was three to five per cent of the
request, is now more than half of it. That is what "the SQL was never the
problem" looks like once the problem is gone.

`COUNT` is the cost the anchor cannot touch, and it is linear in `COUNT`:
34 ms at 10,000, 277 ms at 100,000, 2.6 s at 1,000,000 and **79 seconds at
40,000,000**. The lever there is a ceiling rather than a faster anchor, so
`MAX_RRULE_COUNT` refuses a `COUNT` above 100,000 at save time with a named
error. It refuses nothing real — a per-minute rule at that ceiling still fires
for 69 days, a daily one for 274 years.

Equivalence, not speed, is what carries the risk here: this module owns S-20/S-21
DST correctness. `packages/daemon/test/recurrence-anchor.test.ts` expands every
shape both ways — with the advanced anchor and with the epoch anchor passed
explicitly, which reproduces the old code path exactly — across every DST
transition, two zones, and the 732-day next-fire horizon, and requires the two
occurrence lists to be identical. It pins the refusals in the same place, so a
rule that must keep the 1970 anchor still gets it.

### Hardware caveat, and it is still a live one

All of the above was measured on an Apple M4 MacBook Pro (10 cores, 16GB, Node
v24.13.1), not on the base M1 Air that `plan/05-execution-plan.md` names as
T-307's acceptance machine. Nothing has been measured on the acceptance machine
at all, and nothing here is extrapolated to it.

The record that made this caveat load-bearing is worth keeping even though the
numbers under it have moved. Ten runs on 2026-09-06, one commit, inside 90
minutes: six were the bench alone under `CLOCKWORK_BENCH_ASSERT=1`, and at
`uptime` load averages of 12.5-27.1 the year-view medians were 623.17 / 684.26 /
579.59ms and all three runs went **red**, while at load 7.4-7.9 the same command
gave 383.93 / 376.56 / 349.59ms and all three went **green**. The four
full-suite runs bracketed the same way: 670.53ms loaded against 368.80 / 368.11 /
375.31ms quiet. An independent review run measured 585.49ms, in the loaded band.
**So the 500ms NFR-3 median was met in six of the ten runs and missed in the
other four, and machine load was the only variable that changed.** The p95 was
above the 500ms ceiling in seven of the ten (429.41-1163.14ms). No headroom
multiple was stated then and none is stated now: an earlier revision of this
paragraph read one off the quiet runs alone, which is the claim that was
corrected.

That is why the bench does not assert these bounds inside the default test
command; `CLOCKWORK_BENCH_ASSERT=1` turns the assertions back on (see
`packages/daemon/test/helpers/bench-gate.ts`). The margin has grown by an order
of magnitude and the gate has not moved, because the gate was never about the
margin — a wall-clock assertion inside the default suite makes the build's colour
a property of the machine at any margin.

### What is latent now

- **One recurrence shape does not terminate, and the defect is upstream.** A rule
  whose `BY` parts are unreachable from its own `INTERVAL` grid — the clearest is
  `FREQ=HOURLY;INTERVAL=2;BYHOUR=3`, whose hours stay even — spins inside rrule
  2.8.1's skip loop without returning. It did so at the 1970 anchor and it does
  so at the advanced one, because the reachable residues mod 24 depend only on
  `gcd(INTERVAL, 24)`. The whole-period discipline preserved that behaviour
  exactly as it preserved everything else. Nothing refuses such a rule yet.
- **A `COUNT` rule still pays the replay**, by design, up to the 100,000 ceiling.
- **The 5,000-row cap is a cap.** A history larger than that gets a truthful
  `limits.truncated`, not a page. Paging the detail view is the right fix when a
  real user hits it; the per-day fold is what makes a wide window cheap in the
  meantime.
- **Idle CPU, RSS and DB vacuum** are named in T-307's scope and remain
  unmeasured.

## What was NOT assessed

- Concurrency. Single-user desktop, `maxParallel` defaults to 2; multi-writer
  contention is out of scope for this shape of product.
- The FTS index (`search_idx`) under load. Search was verified to exist and
  work; its performance at 500k documents is unmeasured.
- Any multi-user or server deployment. The product binds loopback only
  (`test/loopback-bind.test.ts` proves it), so the §60 "1M users" framing does
  not apply to the current architecture at all.
