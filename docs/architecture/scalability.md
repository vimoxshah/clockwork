# Scalability assessment (§60, §33)

Iteration 12. §60 asks what must change at 1K / 10K / 100K users and §33 asks
whether the UI survives 5,000 tasks and 50,000 runs. Neither had ever been
measured. This is the measurement.

**Result: no material problem at the stated target.** That is the honest
finding, and it is recorded rather than dressed up as one.

## Method

A temp database built from the real migrations, seeded with tasks and runs,
then the actual calendar month-view query from `api.ts:653` — the hot path,
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

`GET /calendar` has **no `LIMIT`**. Rendering is capped but the payload is
not, so it grows linearly with the window: 0.85 MB at the target, 8.4 MB at
10×. Over loopback that is fast, but it is memory churn on every calendar
navigation.

**Not changed here.** Adding a LIMIT would silently truncate calendar data —
a behaviour change, and a user-visible one — to fix something that measures
fine at the target. The right trigger is a real user with a very large
history, not a hypothetical. If it is ever addressed, the fix is to bound the
window server-side and page, not to truncate.

## What was NOT assessed

- Concurrency. Single-user desktop, `maxParallel` defaults to 2; multi-writer
  contention is out of scope for this shape of product.
- The FTS index (`search_idx`) under load. Search was verified to exist and
  work; its performance at 500k documents is unmeasured.
- Any multi-user or server deployment. The product binds loopback only
  (`test/loopback-bind.test.ts` proves it), so the §60 "1M users" framing does
  not apply to the current architecture at all.
