# Clockwork — Agent Workforce

Twelve features (`plan/AGENT-WORKFORCE-SPEC.md`, `packages/daemon/src/features.ts`
keys F1–F12) that turn a calendar of scheduled runs into something closer to a
team you manage: plans get approved before they execute, agents remember their
last shift, a human declares when they're reachable, cheap checks wake up
expensive ones, repos can recommend their own jobs, every run gets an explicit
verdict, good agents earn more rope, bad streaks trigger a diagnosis instead of
a repeat failure, agents can suggest calendar events without ever writing to
your calendar, and there's a punch clock, a scorecard, and a portable proof
file for the work done.

**Capability registry status** (`packages/daemon/src/features.ts`) — three are
`enforced` (the daemon refuses or defers a user action because of the
feature), nine are `available` (reachable through the API today, but gate
nothing):

| Feature | Key | Status |
|---|---|---|
| Plan-then-execute | `plan_then_execute` | **enforced** |
| Shift-handoff memory | `shift_handoff` | available |
| Office hours | `office_hours` | **enforced** |
| Sentinel + worker pairs | `sentinel_worker` | available |
| Repo-shipped jobs | `repo_shipped_jobs` | available |
| Accept with a note | `accept_with_note` | available |
| Earned autonomy | `earned_autonomy` | **enforced** |
| Self-healing diagnostics | `self_healing` | available |
| Agent-proposed events | `proposed_events` | available |
| Agent timesheets | `agent_timesheets` | available |
| Agent performance reviews | `performance_reviews` | available |
| Proof-of-work export | `proof_of_work_export` | available |

All twelve routes live under `/workforce/*`, behind the same bearer-token auth
as the rest of the API. None of them has dedicated composer/settings UI beyond
what's noted per feature below — reach them via `curl` or the fetch helpers in
`packages/ui/src/api.ts` until a UI is built.

---

## F1 — Plan-then-execute (`plan_then_execute`, enforced)

One booking becomes two runs: a PLAN-mode run at a human hour whose output
becomes an approval item, then an EXECUTE run that only fires once you approve
it, reading the plan through the existing `{{previous.report}}` chain binding.

- **Create a pair**: `POST /workforce/plan-execute` — clones the source task
  into a `plan` half (`permission_mode: 'plan'`, scheduled once at your chosen
  hour) and an `execute` half that is created **disabled** and stays that way.
- **When the plan run finishes**, an approval item appears in your inbox (same
  `approvals` table and `/approvals/:id/respond` path as everything else).
- **You decide**: `POST /workforce/plan-execute/:id/resolve` with
  `{ "decision": "approved" }` books the execute run directly (it does not
  re-enable the task — see ADR-041), or `"rejected"` to drop it.
- List/inspect: `GET /workforce/plan-execute`, `GET /workforce/plan-execute/:id`.

**What it enforces:** the execute half never runs without your explicit
approval of that specific plan. **What it does not do:** it does not evaluate
whether the plan is a *good* plan — that's still your read.

Test: `packages/daemon/test/plan-execute.test.ts`.

---

## F2 — Shift-handoff memory (`shift_handoff`, available)

A recurring task can carry a memory across occurrences: what the agent tried
last time, what blocked it, what to check next.

- **Setup step you have to do yourself**: the memory is only injected if the
  task's prompt contains the literal placeholder `{{handoff.previous}}`
  somewhere in it. Without that placeholder the renderer leaves the prompt
  untouched — this mirrors the existing chain-prompt behaviour exactly, so a
  task that doesn't ask for handoff never gets it.
- Read the history: `GET /workforce/handoff/:taskId?limit=5` (newest first).
  Add a note by hand: `POST /workforce/handoff/:taskId` with
  `{ "author": "human", "kind": "note", "body": "..." }` — human notes render
  as `Note from your reviewer: …` in the injected block, so the agent can tell
  a correction from its own past self.
- F6 (accept-with-note) writes here automatically when you accept a run with a
  note.

Test: `packages/daemon/test/handoff.test.ts`.

---

## F3 — Office hours (`office_hours`, enforced)

You declare windows in which you can actually answer approvals. Tasks whose
**profile** is flagged `may_require_approval` get their `next_fire` shifted
into the next window instead of firing outside it — **tasks whose profile
isn't flagged are untouched.**

Setting it up takes **three** steps, and the third one is not in this
feature's API at all.

- **Step 1 — turn it on.** Off by default:
  `workforce_prefs.office_hours_enabled` starts at `0` (migration
  `0008_agent_workforce.sql`). Turn it on with
  `PUT /workforce/office-hours/enabled { "enabled": true }`.
- **Step 2 — define windows.** `POST /workforce/office-hours` with `dow` (0–6),
  `startMin`/`endMin` (minutes since midnight, `endMin > startMin` — a window
  cannot cross midnight; a shift that does needs two rows), and `tz`.
  `GET /workforce/office-hours` lists them; `DELETE /workforce/office-hours/:id`
  removes one.
- **Step 3 — flag the profile, through F7.** The deferral reads
  `profiles.may_require_approval`, and **no profile route sets that column**:
  it is not a field on `ProfileCreate` or `ProfilePatch`, and migration
  `0008_agent_workforce.sql` defaults it to `0` for every existing profile.
  The only two writers in the entire product belong to F7 earned autonomy —
  `POST /workforce/autonomy/profiles/:profileId/enroll` and accepting an
  autonomy offer. So an `enforced` scheduling feature is reachable only by
  first enrolling the task's profile in a different feature's ladder, at rung
  `plan` or `acceptEdits`. Enrolling at `unattended` sets the flag to `0` and
  makes the profile ineligible for office hours again — that is the entire
  practical difference between the top two rungs (see F7 below).
  **If you do steps 1 and 2 and skip step 3, office hours is on and defers
  nothing.** There is no warning for this; it looks exactly like a correctly
  configured install whose windows are always open.
- **Fails open, by design.** Any error in the office-hours evaluation — a
  broken config, a search that can't find a window inside 14 days, the
  feature being off, no windows defined, or the task's profile not flagged —
  returns "don't shift" and the run fires on schedule. A misconfigured
  office-hours setup can delay a run into the next window; it can never
  silently stop one from firing at all.
- The scheduler applies this check **after** the existing quiet-hours check
  (`scheduler.ts`), so quiet hours still wins if both apply. A deferred
  occurrence is recorded with disposition `deferred`, and the 18
  `scheduler.test.ts` fixtures and the ledger's primary key are untouched by
  this feature.
- **It is not the quiet-hours mechanism, and the two differences are
  deliberate.** Quiet hours pre-claims a fresh `pending` occurrence row at
  the resume instant and bumps `next_fire` only for recurring schedules.
  Office hours does neither:
  - **It deliberately does not pre-claim.** The tick that runs at the resume
    instant has to win its own claim. If this branch had already inserted
    that row, the resume tick's claim would be a no-op, `if (!claimed)
    return` would fire, and the schedule would sit pinned at the deferral
    forever.
  - **It bumps `next_fire` for every kind, `once` included.** The claim
    transaction that just ran has already NULLed a `once` schedule's
    `next_fire`; leaving it there would drop the one-shot entirely, and a
    dropped one-shot is lost work rather than a skipped repeat.

  Both are in the office-hours branch of `scheduler.ts` with the same
  reasoning in a comment beside them, so a future edit that "aligns" the two
  branches would break office hours in one direction and lose one-shot runs
  in the other.

See ADR-038 for why "fail open" is the deliberate choice here, not an
oversight.

Test: `packages/daemon/test/office-hours.test.ts`.

---

## F4 — Sentinel + worker pairs (`sentinel_worker`, available)

A cheap, frequent "sentinel" run checks one condition; when it trips, it books
a full "worker" run. Reuses the existing trigger and policy machinery — a
sentinel binds to a **trigger** row, and the trigger already names the worker
task and carries the enable flag and audit surface.

- `POST /workforce/sentinels` with `{ sentinelTaskId, triggerId, tripExpr,
  cooldownSec }`. Rejected (422) if either id doesn't exist, or if the
  trigger's task IS the sentinel task — a sentinel that books itself is an
  infinite loop.
- Every evaluation of a finished sentinel run writes a `sentinel_trips` row —
  a non-trip is recorded as diagnostic information, not silently discarded.
  `tripExpr` is matched as a case-insensitive substring against the sentinel
  run's report summary.
- A real trip books the worker through the same `evaluatePolicy` +
  `enqueueRunNow` path the webhook trigger handler uses — so a policy
  violation on the worker booking is recorded as a trip with
  `reason: 'policy_violation'` and books nothing, exactly like a webhook fire
  that a policy refuses.
- Cooldown and disabled sentinels also write a trip row with
  `reason: 'cooldown'` / `'disabled'` and book nothing.
- `GET /workforce/sentinels`, `DELETE /workforce/sentinels/:id` (cascades the
  trip history), `GET /workforce/sentinels/:id/trips?limit=`.

Test: `packages/daemon/test/sentinel.test.ts`.

---

## F5 — Repo-shipped jobs (`repo_shipped_jobs`, available)

A `.clockwork/jobs.json` (or `.yaml`/`.yml`, restricted parser — see below)
inside a target repo can declare recommended jobs. Clockwork **discovers and
offers** them; it never imports anything on its own.

- `POST /workforce/repo-jobs/discover { "repoPath": "..." }` reads
  `<repoPath>/.clockwork/jobs.json`, then `jobs.yaml`, then `jobs.yml` (first
  one found wins). A missing file returns `{ offers: [] }` — that is not an
  error. Every offer is stored with a `securityPreview()` computed at
  discovery time (the same red/yellow/info flags template import uses), so
  what you review is what was actually computed, not recomputed live.
- `GET /workforce/repo-jobs?status=` lists offers (`offered` / `imported` /
  `dismissed`). `POST /workforce/repo-jobs/:id/dismiss` drops one — but if the
  repo later edits that job, the changed content digest resets it back to
  `offered` and clears your decision, so an edited job asks again rather than
  silently re-applying your old dismissal.
- `POST /workforce/repo-jobs/:id/import` creates the task **disabled** — you
  still schedule and enable it yourself. A job whose security preview carries
  a **red** flag is refused outright (422); yellow/info flags import but stay
  visible in the preview.
- **The job file cannot choose its own power or budget, full stop.** The
  imported task always gets `permissionMode: 'acceptEdits'`,
  `budget: { maxUsd: 2, maxTurns: 50, timeoutSec: 3600 }`, and
  `schedule: { kind: 'queue' }` — the exact same conservative defaults
  `/templates/import` uses — regardless of what the repo file asks for. No
  profile is assigned by import either; you pick permission mode, profile,
  and a real schedule yourself once you've reviewed the disabled task. See
  ADR-040.
- **No new YAML dependency was added.** `.yaml`/`.yml` files go through a
  restricted parser written for this feature: flat key/value mappings and one
  level of nested lists (enough for a job's `schedule` block), `#` comments,
  quoted and bare scalars. Anchors, aliases, multi-document files, block
  scalars, and deeper nesting are rejected with a named error rather than
  guessed at.

Test: `packages/daemon/test/repo-jobs.test.ts`.

---

## F6 — Accept with a note (`accept_with_note`, available)

The inbox's per-run verdict: accept, reject, or accept-with-a-note. This is
the explicit acceptance signal three other features (F7, F10, F11) read.

- `POST /workforce/runs/:runId/outcome` with
  `{ "decision": "accepted" | "rejected" | "accepted_with_note", "note"?: "..." }`.
  `accepted_with_note` requires a non-empty note. Re-deciding the same run
  **updates** the existing verdict rather than creating a duplicate — `run_id`
  is the primary key.
- A note is appended to that task's shift-handoff memory (F2) as a
  human-authored entry — a reviewer's correction becomes something the next
  occurrence's agent actually reads.
- `GET /workforce/runs/:runId/outcome`, `GET /workforce/tasks/:taskId/outcomes?limit=`.
- UI: `OutcomeControls` is mounted in the inbox report view
  (`packages/ui/src/components/InboxView.tsx`) for finished runs.

Test: `packages/daemon/test/acceptance.test.ts`.

---

## F7 — Earned autonomy (`earned_autonomy`, enforced)

After a configurable streak of **accepted** outcomes with zero rejections in
between, Clockwork **offers** — never grants — the next rung:
`plan → acceptEdits → unattended` (there is no fourth rung, and
`bypassPermissions` is not offered anywhere in the product).

**The ladder has one enforced rung and one advisory step. Read this before
trusting the promotion.** The rung → settings map is
`AUTONOMY_RUNG_SETTINGS` in `packages/shared/src/workforce.ts`:

| Rung | `permission_mode` | `may_require_approval` | What the gate does |
|---|---|---|---|
| `plan` | `plan` | 1 | **Refuses** any task on this profile that asks for a mode other than `plan` (403 `autonomy_rung_exceeded`) |
| `acceptEdits` | `acceptEdits` | 1 | Never refuses anything |
| `unattended` | `acceptEdits` | 0 | Never refuses anything |

The gate is a single branch — `if (allowed === 'plan' && input.permissionMode
!== 'plan')` in `autonomy-policy.ts` — so **only the `plan` rung refuses a
task**. The top two rungs are the **same permission mode**, `acceptEdits`, and
the gate returns "no violation" for every permission mode on both. That means
the second promotion, `acceptEdits → unattended`, **changes no permission and
blocks no run.** Its entire effect is to clear `may_require_approval`, and the
only code in the product that reads that column is F3 **office hours** — so
what the promotion really buys is "this profile's tasks stop being deferred
into an office-hours window", and only while F3 is switched on (it is off by
default). Treat that step as an advisory milestone, not a permission change.

**Enrolling overwrites the profile's permission mode.** `enroll` and accepting
an offer both run `UPDATE profiles SET autonomy_rung=?, permission_mode=?,
may_require_approval=?` — the rung's mode replaces whatever mode the profile
had. Enrolling an `acceptEdits` profile at rung `plan` drops it to `plan`
immediately; promoting it to `unattended` sets it back to `acceptEdits` and
clears the approval flag. There is no "keep my mode, just track the rung"
option.

- **Opt-in only.** A profile with `autonomy_rung IS NULL` is "not enrolled":
  it is never offered anything, and the autonomy check imposes no ceiling on
  it at all. Enroll one explicitly:
  `POST /workforce/autonomy/profiles/:profileId/enroll { "rung": "plan" }`.
  (Enrolling every existing profile automatically would start refusing tasks
  that were already running fine at whatever mode they're at — that's the
  reason unenrolled means unconstrained rather than "assume the bottom rung".)
- **An offer never promotes anything by itself.** The streak check writes an
  `autonomy_offers` row and nothing else. Only
  `POST /workforce/autonomy/offers/:id/respond { "decision": "accepted" }` —
  a human action — writes the new rung to the profile.
  `GET /workforce/autonomy/offers?status=` lists open/decided offers.
- A **declined** offer is not re-offered at the same streak; the streak has
  to grow past the declined offer's streak before you're asked again.
- `GET /workforce/autonomy/profiles/:profileId` returns the current rung,
  streak, and whether a promotion is currently earned.
- **Where the ceiling is enforced**: a second policy gate runs at the same
  three call sites that already run `evaluatePolicy` — task create, task
  patch, and the webhook fire path (`packages/daemon/src/api.ts`) — and
  returns the same `403` shape (`autonomy_rung_exceeded`). In practice it
  fires in exactly one situation: the profile is enrolled at rung `plan` and
  the task asks for a permission mode other than `plan`. On the two upper
  rungs the gate is present but never refuses (see the table above). It is
  also silent for a task with no profile, and for a profile that was never
  enrolled — `autonomy_rung IS NULL` means unconstrained, by design.

See ADR-037 for why offer-only-and-opt-in is the load-bearing design decision
here, not an incidental default.

Test: `packages/daemon/test/autonomy-policy.test.ts`.

---

## F8 — Self-healing diagnostics (`self_healing`, available)

After N consecutive failures (`workforce_prefs.self_heal_failure_threshold`,
default **3**), Clockwork books one diagnostic run with the failed
transcripts as context. Its job is to **propose**, not to fix: the diagnostic
prompt explicitly instructs "read these transcripts, propose exactly one
change, change nothing." The output becomes an approval item — a suggested
prompt or profile diff — that a human applies or rejects.

- **The agent never edits its own prompt or profile.** `apply()` is the only
  code path that writes `tasks.prompt` / `tasks.profile_id`, and it only runs
  from a human calling `POST /workforce/remediations/:id/apply` — never from
  inside the diagnostic run itself.
- At most one diagnostic is booked per failure streak (a diagnostic that
  itself fails does not book another diagnostic — no recursion).
- `GET /workforce/remediations?status=&limit=` lists proposals;
  `GET /workforce/remediations/:id` fetches one;
  `POST /workforce/remediations/:id/reject` discards it.
- A task that recovers gets a clean slate — the shared failure-streak row
  (also used by the pre-existing auth-failure pause feature) is deleted, which
  clears the diagnostic bookkeeping too.

See ADR-039 for the "propose, never apply" boundary in full.

Test: `packages/daemon/test/self-healing.test.ts`.

---

## F9 — Agent-proposed events (`proposed_events`, available)

A run's report may carry a `proposedEvents[]` field: calendar events the
agent suggests ("review PR 42, 10 min"). Clockwork turns that into a
downloadable `.ics` file — **it never writes to your real calendar.** There is
no write path in this module at all; the existing ICS overlay (`ics.ts`)
stays a read-only subscription source and is untouched.

- `GET /workforce/runs/:runId/proposed-events` — parsed and validated events,
  bad entries dropped rather than failing the whole request.
- `GET /workforce/runs/:runId/proposed-events.ics` — an RFC 5545 calendar file
  with a stable `UID` per event (`<runId>-<event.key>@clockwork.local`), so
  re-importing it into your calendar app updates the event instead of
  duplicating it.
- UI: `ProposedEvents` is mounted in the inbox report view for any run with
  proposals.

**Currently returns `[]` for every run.** Nothing in the shipped runners
writes `proposedEvents` into a report yet — no engine or profile currently
asks the model to produce that field. The module and its routes are real and
tested against hand-built report fixtures; the feature starts showing data
the moment a profile's output contract is written to populate the field. Do
not read this as "agents currently propose events" — they don't, yet.

Test: `packages/daemon/test/proposed-events.test.ts`.

---

## F10 — Agent timesheets (`agent_timesheets`, available)

A per-agent punch clock: hours worked, dollars spent, outcomes accepted, and
an effective hourly rate, over any date range.

- `GET /workforce/timesheets?from=&to=&profileId=` (ms epoch; default range
  is the last 30 days). Rows group by profile — `run_outcomes.profile_id` if
  an outcome was recorded, else the profile id frozen in the run's own
  `jobspec_json` at booking time, so **historical runs from before F6 existed
  still show up correctly** with zero extra wiring. Runs with no profile at
  all group under `Unassigned`.
- `hoursWorked` sums `MAX(0, ended_at - started_at)` for runs that actually
  started; a run that never started contributes 0 hours but still contributes
  its cost. `effectiveHourlyRateUsd` is `dollarsSpent / hoursWorked`, and is
  **`null`** (never `Infinity`, never `0`) when `hoursWorked` is zero.
- Set a comparison rate for your own time:
  `PUT /workforce/prefs/hourly-rate { "humanHourlyRateUsd": 45 }` (or `null`
  to clear it).
- Rows sort by dollars spent, descending.

**Measured** (5,000-run corpus, full 365-day window, `workforce-bench.test.ts`
— see the note at the end of this document for hardware caveats). Ten runs on
2026-09-06, six of the bench alone and four inside the full suite, n=25
samples each: median **16.95–47.49ms**, p95 **17.45–64.94ms**. The range, not
a single number, is the measurement — the low end is a quiet machine and the
high end a loaded one. Two earlier revisions of this paragraph gave first a
single-run figure and then a narrower three-run range; neither survived a
loaded machine. Filtering to one profile is the same SQL with the filter
applied in JS afterward, so it costs the same to within that noise (median
**16.66–35.75ms**).

Test: `packages/daemon/test/timesheets.test.ts`.

---

## F11 — Agent performance reviews (`performance_reviews`, available)

A per-profile scorecard: acceptance rate, failure rate, cost trend against the
prior period of equal length — computed by plain SQL, not by a model.

- `GET /workforce/performance?from=&to=` returns a scorecard per group;
  `GET /workforce/performance/:profileId?from=&to=` returns one.
  Uses the **exact same grouping key and window as F10** on purpose — if the
  two disagreed, the product would tell you two different numbers for the
  same agent.
- `acceptanceRate` is `null` when nobody has decided any run in the window yet
  — an unreviewed agent is reported as "not yet reviewed," never as a 0%
  failure. `failureRate` is `null` when the window has zero runs.
  `costTrendUsd` is `null` when the prior window of equal length had no runs
  to compare against.
- **This module makes no model call and writes no prose verdict.**
  `GET /workforce/performance/:profileId/review-prompt?from=&to=` returns the
  *text* of a prompt built from the computed numbers; writing the actual
  written review means scheduling a task — using whichever agent profile you
  choose — with that prompt as its content. Clockwork does **not** ship a
  seeded "reviewer" profile that does this automatically; you point an
  existing or new profile at the generated prompt yourself. The design is
  deliberate: the numbers must be reproducible without invoking an LLM at all,
  and only the human-readable narrative is optional/model-written.

**Measured** (same 5,000-run corpus, ten runs on 2026-09-06 — six of the
bench alone, four inside the full suite): one profile's scorecard (two windowed
scans — current period + previous period) is median **13.06–34.45ms**, p95
**13.62–64.35ms** (n=25). Every group at once (`scorecards()`, all 7 groups in
the bench corpus — one `DISTINCT` scan plus 2 aggregate scans per group, 15
full scans of `runs` total) is median **101.97–232.68ms**, p95
**112.87–269.04ms** (n=15). That is the most expensive query in the whole
feature set, driven by scan count, not row count — worth knowing if you have
far more than 7 active profiles. No bound is claimed for either. The low end
of each range is a quiet machine and the high end a loaded one; earlier
revisions of this paragraph quoted only quiet-machine figures.

Test: `packages/daemon/test/performance.test.ts`.

---

## F12 — Proof-of-work export (`proof_of_work_export`, available)

Export one run's report as a single, self-contained HTML file you host
yourself — no Clockwork-hosted anything, ever.

- `GET /workforce/runs/:runId/proof-of-work` — `text/html`, downloaded with
  `Content-Disposition: attachment`. Query params: `includeTranscript`,
  `includeDiffStat`, `redactPaths` (`'1'`/`'true'`).
- **Self-contained, checked directly on the output**: no `<script src=`, no
  `<link rel="stylesheet">`, no remote `<img src="http...">`. CSS is inlined
  in one `<style>` block. No analytics, no telemetry pixel, no phone-home of
  any kind.
- **Masked, unconditionally.** `maskSecrets` (the same helper the rest of
  Clockwork uses for reports) runs over every interpolated string — summary,
  failure reason, timeline text, transcript tail. There is no flag to turn
  this off.
- **Escaped.** `&`, `<`, `>`, `"`, `'` are escaped in every interpolation,
  because report content is agent-authored text and an unescaped `<script>`
  in a summary would be stored XSS in a file you're about to publish.
- `redactPaths=1` additionally replaces `repoPath`, `worktreePath`, and
  `branch` with `[redacted]`.
- **`includeTranscript` is off by default.** A transcript is the most
  sensitive artifact a run produces; exporting it is an explicit,
  per-download choice, not a default.
- Every export is audited (`audit('run.export_proof', 'run', runId, {...})`).

Test: `packages/daemon/test/proof-of-work.test.ts`.

---

## Performance note (T-307 bench)

`packages/daemon/test/workforce-bench.test.ts` measures F10/F11 (above) and
the pre-existing `/calendar` route under a seeded, deterministic 5,000-run
corpus. All numbers on this page and in `plan/STATUS.md` were captured on an
Apple M4 MacBook Pro (10 cores, 16GB, Node v24.13.1) — **not** on the base M1
Air that `plan/05-execution-plan.md` names as T-307's acceptance machine.

**The bench measures by default and only asserts on request.** Every
wall-clock bound in that file goes through `assertLatency`
(`packages/daemon/test/helpers/bench-gate.ts`): during a normal `pnpm test` it
prints the number and the verdict against the bound and does not fail; with
`CLOCKWORK_BENCH_ASSERT=1` it asserts. Correctness assertions — corpus size,
row counts, HTTP status, response shape — are never gated. One session on
2026-09-06 is the whole argument: six gated runs of this bench, one laptop,
one commit, 90 minutes, split three red and three green. The red runs came at
`uptime` load averages of 12.5–27.1, the green ones at 7.4–7.9: machine load
is the only variable that moved. The default `pnpm test` was green
across all 54 files in both conditions. A red build that means "your laptop
was busy" is worse than no build signal at all.

T-113's FTS numbers cleared their 100ms bound in all ten runs — medians
3.24–5.58ms with the bench alone, 3.46–27.58ms inside the full suite — so
hardware is not a live risk there even though the number itself moved 8x.
T-307's calendar numbers are the opposite: year-view medians of 623.17 /
684.26 / 579.59ms loaded and 383.93 / 376.56 / 349.59ms quiet, against a
500ms ceiling — **met in six of ten runs, missed in the other four**, with p95
above the ceiling in seven of ten (429.41–1163.14ms). An independent
review run measured 585.49ms, in the loaded band. **No headroom multiple is
claimed**: an earlier revision of this page read one off the quiet runs alone,
which is the claim being corrected. Nothing has been measured on the
acceptance hardware at all. See `plan/STATUS.md` and
`docs/architecture/scalability.md` for the full breakdown, including the root
cause of the calendar's cost (RRULE expansion from a synthetic 1970 anchor
date, not the SQL query).
