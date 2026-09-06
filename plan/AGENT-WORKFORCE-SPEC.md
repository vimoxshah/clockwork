# Agent Workforce — implementation contract

Twelve features turn Clockwork from *a calendar that runs agents* into *a
calendar that employs them*. The schema, the shared types and the capability
registry already landed (migration `0008_agent_workforce.sql`). This document is
the contract twelve independent agents build against.

It is written so that an agent who has never read another agent's code can
finish its feature and have the result compose. Everything ambiguous is decided
here. Where a decision looks arbitrary, the reason is given — so that an agent
who disagrees can see what it would be breaking.

---

## 0. Hard rules

**Each feature agent creates exactly TWO new files** — its daemon module and its
test — **plus at most one optional UI component**. Nothing else.

**No feature agent may edit any of these:**

| File | Why it is frozen |
| --- | --- |
| `packages/daemon/src/api.ts` | twelve agents appending routes to one 1,574-line file is twelve merge conflicts |
| `packages/daemon/src/features.ts` | the registry is already correct; changing a status is a claim about code that must be reviewed |
| `packages/daemon/src/run-manager.ts` | the run lifecycle, the repo mutex and the semaphore live here |
| `packages/daemon/src/scheduler.ts` | the occurrence-ledger claim transaction is the double-fire guard |
| `packages/daemon/migrations/*.sql` | forward-only; an applied migration's id is already in `schema_migrations`, so an edit never runs |
| any existing test | see rule 3 |

When a feature needs one of those files changed, the agent **returns a wiring
snippet** — a fenced block naming the file, the anchor line to insert after, and
the exact code — in its final message. It does not apply it. §3 gives the
format. An integrator applies all twelve at once, in one reviewable pass.

**Three more rules, in force for every feature:**

1. **Migration 0008 is the only migration.** If a feature seems to need a
   column that is not in §1, the design is wrong — say so and stop. Do not add
   `0009_*.sql`. Do not `CREATE TABLE IF NOT EXISTS` a new table at runtime.
2. **The status in `features.ts` is `planned` until the feature runs.** The
   integrator flips it, in the same pass that applies the wiring. Adding
   upgrade-modal copy for a planned key fails `feature-honesty.test.ts`.
3. **No existing test is weakened, skipped or deleted.** The baseline is **260
   passing tests across 37 files** plus the 14 foundation tests in
   `workforce-foundation.test.ts` — **274 across 38 files** as of this
   document. If a change breaks a test, the change is
   wrong. This applies with particular force to `scheduler.test.ts` — see F3.

**Untouchable machinery.** The repo mutex, the run semaphore, the occurrence
ledger (`schedule_occurrences`, PK `(schedule_id, occurrence_at)`) and
everything the ADR-034 sandbox/permission work wired. F3 is the only feature
that goes near the scheduler at all, and it does so by the quiet-hours
precedent, which touches none of the four.

---

## 1. What already exists

### 1.1 Migration `packages/daemon/migrations/0008_agent_workforce.sql`

Ten tables and six added columns. **Each table has exactly one owner.** A
feature reads another feature's table only where this document says so, and
never writes it.

| Table | Owner | Purpose |
| --- | --- | --- |
| `workforce_prefs` | shared (singleton, `id = 1`) | `office_hours_enabled`, `autonomy_streak_required`, `self_heal_failure_threshold`, `human_hourly_rate_usd`, `review_period_days` |
| `plan_execute_pairs` | F1 | the approval gate between a plan run and its execute run |
| `agent_memories` | F2 | per-task shift memory; F6 appends human notes |
| `office_hours` | F3 | windows the human can answer approvals in |
| `sentinels` | F4 | sentinel task → trigger binding |
| `sentinel_trips` | F4 | every evaluation, tripped or not |
| `repo_jobs` | F5 | discovered `.clockwork/jobs.*` offers |
| `run_outcomes` | F6 | **the acceptance signal** — read by F7, F10, F11 |
| `autonomy_offers` | F7 | offered rung promotions |
| `remediation_proposals` | F8 | diagnostic proposals awaiting a human |

Added columns: `profiles.may_require_approval` (F3),
`profiles.autonomy_rung` + `profiles.autonomy_streak_required` (F7),
`tasks.plan_stage` (F1), `task_failure_streaks.diagnostic_run_id` +
`task_failure_streaks.diagnostic_at` (F8).

F9, F10, F11 and F12 own **no** table. That is deliberate: they are derived
views over `runs`, `runs.report_json` and `run_outcomes`, and a cache would be a
second source of truth for numbers that must not disagree.

Read the migration itself for column-level comments. Column conventions, all
enforced by the migration and by `workforce-foundation.test.ts`:

- ids are ULIDs from `newId()` (`packages/shared/src/ids.ts`)
- timestamps are **epoch milliseconds** from `Date.now()` — never seconds, never
  ISO text; every existing comparison in the codebase is ms-based
- `created_at` / `updated_at` carry no SQL default; the application supplies them
- booleans are `INTEGER NOT NULL DEFAULT 0/1`
- structural FKs cascade; informational back-references carry no FK at all
  (see the migration header for why — the retention sweep runs a bare
  `DELETE FROM runs`)

### 1.2 Shared types — `packages/shared/src/workforce.ts`

Every cross-package shape is declared once, exported through
`@clockwork/shared`. Import them; do not redeclare them.

`WorkforcePrefs` · `PlanExecutePair` `PlanExecuteStatus` `PlanExecuteCreate` ·
`AgentMemory` `AgentMemoryWrite` `MemoryAuthor` `MemoryKind` ·
`OfficeHourWindow` `OfficeHourCreate` · `Sentinel` `SentinelCreate`
`SentinelTrip` · `RepoJobSpec` `RepoJobsFile` `RepoJobOffer` `RepoJobStatus` ·
`RunOutcomeRecord` `RunOutcomeWrite` `OutcomeDecision` · `AutonomyRung`
`AUTONOMY_RUNG_SETTINGS` `nextRung()` `AutonomyOffer` `AutonomyOfferStatus` ·
`RemediationProposal` `RemediationTarget` `RemediationStatus` ·
`ProposedEvent` · `TimesheetRow` `Timesheet` · `PerformanceScorecard` ·
`ProofOfWorkOptions`.

Two names to know about:

- **`RunOutcomeRecord`, not `RunOutcome`.** `RunOutcome` is already taken in
  `runner.ts` for the *engine's* terminal outcome. Renaming it back collides in
  the barrel export and fails `tsc -b`.
- **`RunReport.proposedEvents` is `.optional()`, not `.default([])`.**
  `RunReport` is the zod *output* type, so a default would make the key required
  in the report literal at `run-manager.ts:453` — an edit to a frozen file.
  Read it as `report?.proposedEvents ?? []`.

A schema edit is invisible to daemon and UI until `@clockwork/shared` is rebuilt
(`main`/`types` point at `dist/`). `pnpm typecheck` does it.

### 1.3 Capability registry

All twelve keys are registered in `features.ts` with `status: 'planned'`:
`plan_then_execute`, `shift_handoff`, `office_hours`, `sentinel_worker`,
`repo_shipped_jobs`, `accept_with_note`, `earned_autonomy`, `self_healing`,
`proposed_events`, `agent_timesheets`, `performance_reviews`,
`proof_of_work_export`.

---

## 2. Conventions every feature follows

### 2.1 Routes

**Every workforce route lives under `/workforce/`.** One prefix means the auth
hook needs one new alternation, applied once, instead of twelve.

Handlers follow `api.ts` exactly: registered inside `buildServer` under a
`// ---- <area> ----` banner, params cast (`(req.params as any).id`), bodies
validated with `<Schema>.safeParse(req.body)` at the top of the handler.

### 2.2 Status codes

| Code | Body | When |
| --- | --- | --- |
| 200 | the resource | default success |
| 201 | the created resource | create |
| 204 | *(empty)* | delete |
| 401 | `{ error: 'unauthorized' }` | the auth hook, automatically |
| 403 | `{ violation }` | policy rejection, from `evaluatePolicy` |
| 404 | `{ error: 'not_found' }` | unknown id |
| 409 | `{ error: '<reason>' }` | conflict — see below |
| 422 | `{ error: 'validation', details }` | zod failure |
| 422 | `{ error: '<sentence a human can act on>' }` | semantic failure |

**409 is overloaded in this codebase** (`version_conflict`, `not_cancellable`,
`already_resolved`, `slug_exists`, `trigger disabled`). Every workforce
"decide once" route — resolving a plan, responding to an autonomy offer,
applying a remediation — returns `409 { error: 'already_resolved' }`, matching
`POST /approvals/:id/respond`. Callers branch on the `error` string, never on
the status alone.

Do the CAS in SQL, as approvals does — `UPDATE ... WHERE id=? AND decided_at IS
NULL`, then `if (r.changes === 0) return 'already_resolved'`. A read-then-write
races.

### 2.3 After a mutation

```ts
broadcast({ type: 'workforce.<noun>_<verb>', ...ids, at: Date.now() });
audit('<noun>.<verb>', '<targetType>', targetId, { ...detail });
```

SSE frames carry **no `event:` name** — the discriminator is the `type` string
inside the JSON. `EventSource.addEventListener('workforce.x')` will never fire;
clients parse `JSON.parse(e.data).type`.

`audit()` is already wrapped in try/catch inside `buildServer`, so logging can
never break a request. Wrap your own best-effort side work the same way, with a
comment saying why the failure is non-fatal.

### 2.4 Writing an `approvals` row (F1 and F8 only)

Two features put an item in the human's inbox by inserting into the existing
`approvals` table. That table's DDL (0001) has three `NOT NULL` columns with no
default, so an incomplete insert fails on the first test. Use exactly this:

```ts
db.prepare(
  `INSERT INTO approvals (id, run_id, kind, payload_json, requested_at, timeout_at, fallback)
   VALUES (?, ?, 'question', ?, ?, ?, 'deny-and-continue')`,
).run(newId(), runId, JSON.stringify(payload), now, now + 30 * 86_400_000);
```

- `run_id` is the run that produced the item — the plan run (F1) or the
  diagnostic run (F8). It is `NOT NULL`; there is no null-run approval.
- `timeout_at` is **inert here**. It is written only by `run-manager.ts:376` for
  *live* permission prompts and nothing sweeps the table on it, so a 30-day
  value is a placeholder that keeps the column honest. These items wait for a
  human indefinitely, by design.
- `fallback` stays inside the vocabulary already on the wire
  (`'deny-and-continue'`); the report's `ApprovalRecord.resolution` enum has no
  other value that fits.
- `payload_json` carries the discriminator the inbox dispatches on:
  `{ pairId }` for F1, `{ proposalId }` for F8.

**Both resolution paths must land in the same state.** The inbox already renders
`approvals` and posts to `POST /approvals/:id/respond` (`api.ts:657`), which
CAS-marks `responded_at` and knows nothing about pairs or proposals. Left alone,
a user who approves a plan *in the inbox* would mark the approval resolved while
the pair sat at `awaiting_approval` forever, and no execute run would ever be
booked. So:

1. the workforce route (`/plan-execute/:id/resolve`, `/remediations/:id/apply`,
   `/remediations/:id/reject`) **also** CAS-updates the linked
   `approvals.responded_at`, and
2. the wiring snippet for `POST /approvals/:id/respond` dispatches on
   `payload.pairId` / `payload.proposalId` into the owning class.

Both directions are CAS-guarded, so whichever arrives second gets
`409 already_resolved` rather than acting twice.

One inherited wart, stated so nobody is surprised: `approvals.run_id` carries no
cascade, so a retention prune of a run that still has an approvals row aborts the
sweep. That is **pre-existing** — every live-run permission approval already has
it — and F1/F8 inherit it. Do not fix it here; it is a schema change, and 0008
is closed.

### 2.5 Module shape

A daemon module is a class taking a `deps` object, or plain functions taking
`db` first. **Anything that books a run takes an injected callback** rather than
importing `enqueueRunNow` from `api.ts` — that import would close a cycle
(`api.ts` → your module → `api.ts`) and it makes the module untestable without a
whole server. `SchedulerDeps.enqueueRun` is the precedent.

Every module opens with a JSDoc block naming the feature and this spec.

### 2.6 Tests

vitest, in `packages/daemon/test/<feature>.test.ts`. Migrations load through the
canonical loader:

```ts
const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));
const db = new Database(':memory:') as unknown as DB;
db.pragma('foreign_keys = ON');          // matches openDatabase (db.ts:19)
createMigrator(db, MIGRATIONS).migrate();
```

Name each `it` with what it defends, not what it calls. Assert the failure paths
— the cooldown that suppresses a trip, the second accept that updates instead of
duplicating, the offer that is never auto-granted. A feature whose tests only
cover the happy path is not done.

Do not add routes to `api.test.ts` (frozen, order-dependent, shares one DB and
one mutable `token` across the file).

**Route tests have a named owner:** the integrator creates
`packages/daemon/test/workforce-api.test.ts` during the wiring pass, using the
`api.test.ts` harness pattern (temp dir, real `RunManager` with
`runnerChildModule: '/nonexistent/runner-child.js'`, `buildServer`, an `auth()`
helper, `app.inject`). Minimum per route: one authenticated happy case and one
unauthenticated **401** case — routes are open by default, and the 401 test is
what proves the auth prefix was actually added.

---

## 3. Wiring-snippet format

Return snippets in the final message, in this shape, one per file:

````
### WIRING: packages/daemon/src/api.ts
Anchor: after line 100, `const runs = new RunRepo(deps.db);`
```ts
const sentinels = new Sentinels({ db: deps.db, bookWorker: (taskId) => { ... } });
```
````

Three snippets recur. Write them once, exactly like this:

**Auth.** `api.ts` lines 129-133. Routes are **open by default** — a new prefix
without this line ships unauthenticated, which is why `/prefs`, `/calendar` and
`/providers` are open today.

```ts
      /^\/(tasks|runs|approvals|profiles|search|widget|queue|onboarding|pause-all|resume|capacity)/.test(url) ||
      /^\/(analytics|retention|audit|policies|capabilities|targets|byok|triggers|trigger-events|ics|usage)/.test(url) ||
      /^\/workforce\//.test(url) ||   // <-- ADD (all twelve workforce features)
```

**Booking a run.** `enqueueRunNow(db, taskRow)` is exported from `api.ts:1475`
and snapshots `taskRow.prompt` into the jobspec. To book with a materialized
prompt, pass a shallow copy — do **not** write the rendered prompt back to
`tasks.prompt`:

```ts
const runId = enqueueRunNow(deps.db, { ...taskRow, prompt: materializedPrompt });
deps.runManager.pump();
```

**Run finalize.** F1, F2, F4 and F8 all need a hook after a run reaches a
terminal state. One anchor serves all four: `run-manager.ts`, immediately after
the `UPDATE runs SET state=?, ..., report_json=?` at line 506. Each returns its
own one-liner; the integrator orders them F2 → F1 → F4 → F8 (memory first, so
the others can read it).

---

## 4. The twelve features

Each entry gives: **files** · **tables** · **exports** · **routes** ·
**wiring** · **depends on**. Signatures are the contract — an agent may add
private helpers, never change an exported signature.

---

### F1 — plan-then-execute

One booking becomes two runs: a PLAN-mode run at a human hour whose plan becomes
an approval item, then an EXECUTE run gated on that approval, reading the plan
through the existing `{{previous.report}}` binding. **Composes existing chain
and approval primitives. No new engine code.**

- **Module** `packages/daemon/src/plan-execute.ts`
- **Test** `packages/daemon/test/plan-execute.test.ts`
- **Owns** `plan_execute_pairs`, `tasks.plan_stage`
- **Reads** `tasks`, `runs`, `approvals`

**Why a table and not just `chain_after`.** Chain firing is **one-shot at the
upstream run's terminal state** and filters `enabled = 1`
(`run-manager.ts:603`). The execute half must stay disabled until a human
approves — which happens *after* the plan run has already ended. The chain can
never carry it. The pair row is the durable gate across that gap. Do not try to
be clever here; this was checked against the code.

```ts
export interface PlanExecuteDeps {
  db: DB;
  /** books a run for taskId with an already-materialized prompt; returns the run id */
  bookRun(taskId: string, promptOverride: string): string | null;
}

export class PlanExecute {
  constructor(deps: PlanExecuteDeps);
  createPair(input: PlanExecuteCreate, now?: number): PlanExecutePair | { error: string };
  get(id: string): PlanExecutePair | undefined;
  list(status?: PlanExecuteStatus): PlanExecutePair[];
  /** call at finalize; when runId is a pair's plan run, opens the approval */
  onPlanRunFinalized(runId: string, taskId: string, state: string, now?: number):
    { pairId: string; approvalId: string } | null;
  /** the human's verdict; 'approved' books the execute run */
  resolve(pairId: string, decision: 'approved' | 'rejected', now?: number):
    PlanExecutePair | 'not_found' | 'already_resolved';
}

/** prompt wrappers — plan half asks for a plan, execute half consumes it */
export function planPromptFor(basePrompt: string): string;
export function executePromptFor(basePrompt: string): string;
```

Behaviour:

- `createPair` clones the source task into two: the plan half
  (`plan_stage='plan'`, `permission_mode='plan'`, schedule `once` at `planHour`
  in `tz`, `enabled=1`) and the execute half (`plan_stage='execute'`,
  `chain_after` = plan task id, **`enabled=0`**). Both go through `TaskRepo`.
- `executePromptFor` must emit a prompt containing `{{previous.report}}` so the
  existing `renderChainPrompt` (`templates.ts:85`) binds the plan.
- `onPlanRunFinalized` inserts an `approvals` row **per §2.4** — `run_id` is the
  plan run, `payload_json` is `{ pairId, plan: <report summary> }` — and moves
  the pair to `awaiting_approval`. On a non-`completed` plan run it moves the
  pair to `rejected` and opens no approval.
- `resolve` also CAS-closes that approvals row, and the inbox's
  `POST /approvals/:id/respond` dispatches back into `resolve` on
  `payload.pairId`. Both paths, one state — see §2.4.
- `resolve('approved')` renders the execute prompt against the plan run's
  `report_json` via `renderChainPrompt`, calls `deps.bookRun`, records
  `execute_run_id`, sets status `executed`. The execute task **stays disabled** —
  it is booked directly, never re-enabled.

> **`enabled = 0` is the gate, and `chain_after` is a loaded gun.** With
> `chain_after` set, anyone who later PATCHes the execute task to `enabled: true`
> re-arms the one-shot chain, and the next plan run — a `run-now`, say — fires
> execute with **no approval at all**. The `{{previous.report}}` binding does not
> need `chain_after`: F1 calls `renderChainPrompt` itself. So set `chain_after`
> for provenance if you like, but the invariant is absolute: **nothing in this
> feature ever sets the execute task's `enabled` to 1.** A test must assert the
> execute task is still disabled after `resolve('approved')` books its run.

**Routes** (all `application/json`)

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| POST | `/workforce/plan-execute` | `PlanExecuteCreate` | 201 `PlanExecutePair` · 422 |
| GET | `/workforce/plan-execute` | `?status=` | 200 `{ pairs: PlanExecutePair[] }` |
| GET | `/workforce/plan-execute/:id` | — | 200 `PlanExecutePair` · 404 |
| POST | `/workforce/plan-execute/:id/resolve` | `{ decision: 'approved'\|'rejected' }` | 200 `PlanExecutePair` · 404 · 409 `already_resolved` |

**Wiring** — `api.ts` (construct + 4 routes + auth prefix), `run-manager.ts`
(finalize hook calling `onPlanRunFinalized`).
**Depends on** nothing.

---

### F2 — shift-handoff

Each recurring task carries a memory the agent reads at start and appends at
end: what it tried, what blocked it, what to check next. Same mechanism as the
chain's previous-report binding, **pointed at the prior occurrence of the same
task** instead of an upstream one.

- **Module** `packages/daemon/src/handoff.ts`
- **Test** `packages/daemon/test/handoff.test.ts`
- **Owns** `agent_memories`

```ts
export class HandoffMemory {
  constructor(db: DB);
  append(input: AgentMemoryWrite, now?: number): AgentMemory;
  latest(taskId: string, limit?: number): AgentMemory[];   // newest first, default 5
  /** the block injected into the next run's prompt; '' when there is no memory */
  renderBlock(taskId: string, budgetChars?: number): string;   // default 6_000
}

/** replaces {{handoff.previous}}; returns the template untouched when absent */
export function renderHandoffPrompt(promptTemplate: string, block: string): string;

/** pull tried/blocked/nextCheck out of a finished run's report_json */
export function handoffFromReport(reportJson: string | null): Omit<AgentMemoryWrite, 'taskId'> | null;
```

Behaviour:

- `renderBlock` renders newest-first, truncating at `budgetChars` with
  `… [truncated to fit context budget]` — the same discipline as
  `renderChainPrompt`. Human `note` rows render as `Note from your reviewer: …`
  so the agent can tell a human's correction from its own past self.
- `renderHandoffPrompt` short-circuits when the template has no `{{handoff`,
  mirroring `renderChainPrompt`.
- `append` never updates; the table is append-only.

**Routes**

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| GET | `/workforce/handoff/:taskId` | `?limit=` | 200 `{ memories: AgentMemory[] }` |
| POST | `/workforce/handoff/:taskId` | `AgentMemoryWrite` minus `taskId` | 201 `AgentMemory` · 422 |

**Wiring** — `api.ts` (2 routes), `run-manager.ts` twice: at run start
materialize the prompt through `renderHandoffPrompt`; at finalize
`append(handoffFromReport(...))`.
**Depends on** nothing. **Consumed by** F6.

---

### F3 — office-hours

The human declares windows in which they can answer approvals. Tasks whose
profile is flagged `may_require_approval` get `next_fire` shifted into those
windows. **Tasks not flagged are untouched.**

- **Module** `packages/daemon/src/office-hours.ts`
- **Test** `packages/daemon/test/office-hours.test.ts`
- **Owns** `office_hours`, `workforce_prefs.office_hours_enabled`,
  `profiles.may_require_approval`

> **The occurrence ledger and all 18 `scheduler.test.ts` fixtures are
> inviolable.** Follow the quiet-hours precedent exactly
> (`scheduler.ts:188-205`): mark the claimed occurrence `disposition='deferred'`,
> `INSERT OR IGNORE` a fresh claim at the resume instant, bump `next_fire` for
> non-`once` schedules. Do not change the claim transaction, the ledger PK, or
> the shape of `tick()`. If office-hours cannot be expressed that way, stop and
> report — do not "improve" the scheduler.

```ts
export class OfficeHours {
  constructor(db: DB);
  list(): OfficeHourWindow[];
  create(input: OfficeHourCreate, now?: number): OfficeHourWindow;
  remove(id: string): boolean;
  enabled(): boolean;
  setEnabled(on: boolean): void;
}

/** pure, exported for testing without a DB */
export function inOfficeHours(atMs: number, windows: OfficeHourWindow[]): boolean;
export function nextOfficeHourStart(atMs: number, windows: OfficeHourWindow[]): number | null;

/**
 * The single call the scheduler makes. Returns the shifted instant, or null
 * when nothing should move — office hours off, no windows, the task's profile
 * not flagged, or fireAt already inside a window.
 */
export function shiftForApproval(db: DB, taskId: string, fireAt: number): number | null;
```

Behaviour:

- windows never wrap midnight (`endMin > startMin`, enforced by
  `OfficeHourCreate`); a crossing window is two rows. Use `luxon` (already a
  daemon dependency) to evaluate `dow`/`startMin` in the window's own `tz`.
- `nextOfficeHourStart` searches forward at most 14 days and returns `null`
  beyond that, so a misconfigured set of windows defers rather than hangs.
- `shiftForApproval` is **fail-open**: any error returns `null` and the run
  fires on time. A broken office-hours config must never silently stop work.

**Routes**

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| GET | `/workforce/office-hours` | — | 200 `{ enabled: boolean; windows: OfficeHourWindow[] }` |
| POST | `/workforce/office-hours` | `OfficeHourCreate` | 201 `OfficeHourWindow` · 422 |
| DELETE | `/workforce/office-hours/:id` | — | 204 · 404 |
| PUT | `/workforce/office-hours/enabled` | `{ enabled: boolean }` | 200 `{ enabled }` · 422 |

**Wiring** — `api.ts` (4 routes), `scheduler.ts` (one call in the
`if (claimed && !late)` block, **after** the quiet-hours check so quiet hours
still wins).
**Depends on** nothing.

---

### F4 — sentinel-worker

A cheap sentinel run checks one condition on a tight cadence; when it trips it
books a full worker run. **Reuses the existing triggers and chains.**

- **Module** `packages/daemon/src/sentinel.ts`
- **Test** `packages/daemon/test/sentinel.test.ts`
- **Owns** `sentinels`, `sentinel_trips`
- **Reads** `triggers`, `runs`

The sentinel binds to an existing **trigger** row, not directly to a worker
task: `triggers.task_id` names the worker, and the trigger carries the enable
flag and the audit surface already. `sentinels.trigger_id` cascades, so
`DELETE /triggers/:id` keeps returning 204.

```ts
export interface SentinelDeps {
  db: DB;
  /** books the worker run; returns the run id, or null when it was refused */
  bookWorker(taskId: string): string | null;
}

export class Sentinels {
  constructor(deps: SentinelDeps);
  create(input: SentinelCreate, now?: number): Sentinel | { error: string };
  list(): Sentinel[];
  remove(id: string): boolean;
  trips(sentinelId: string, limit?: number): SentinelTrip[];
  /**
   * Evaluate a finished sentinel run. ALWAYS writes a sentinel_trips row —
   * a non-trip is as diagnostic as a trip — and books the worker only when it
   * tripped and the cooldown has expired.
   */
  evaluate(runId: string, taskId: string, reportJson: string | null, now?: number): SentinelTrip | null;
}

/** pure: case-insensitive substring match against the report summary */
export function tripped(reportJson: string | null, tripExpr: string): boolean;
```

Behaviour:

- `create` rejects (`{ error }`, surfaced as 422) when `sentinel_task_id` or
  `trigger_id` does not exist, or when the trigger's task is the sentinel task
  itself — a sentinel that books itself is an infinite loop.
- cooldown: `now - last_tripped_at < cooldown_sec * 1000` writes a trip row with
  `tripped=0, reason='cooldown'` and books nothing.
- disabled sentinel → `reason='disabled'`, books nothing.
- on a real trip: `bookWorker`, set `worker_run_id`, `last_tripped_at = now`.
- the worker run is booked through `deps.bookWorker`, which the wiring
  implements as the same `evaluatePolicy` + `enqueueRunNow` + `pump()` sequence
  the webhook handler uses (`api.ts:513-530`). A policy violation returns `null`
  and the trip row records `reason='policy_violation'`.

**Routes**

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| POST | `/workforce/sentinels` | `SentinelCreate` | 201 `Sentinel` · 422 |
| GET | `/workforce/sentinels` | — | 200 `{ sentinels: Sentinel[] }` |
| DELETE | `/workforce/sentinels/:id` | — | 204 · 404 |
| GET | `/workforce/sentinels/:id/trips` | `?limit=` | 200 `{ trips: SentinelTrip[] }` · 404 |

**Wiring** — `api.ts` (construct with `bookWorker` + 4 routes),
`run-manager.ts` (finalize hook calling `evaluate`).
**Depends on** nothing.

---

### F5 — repo-shipped-jobs

A `.clockwork/jobs.yaml` (or `.json`) inside a target repo declares recommended
jobs. Clockwork **discovers and OFFERS** them. **Import arrives DISABLED with a
security preview, exactly like template import (S-74).**

- **Module** `packages/daemon/src/repo-jobs.ts`
- **Test** `packages/daemon/test/repo-jobs.test.ts`
- **Owns** `repo_jobs`

> **Security.** The jobs file is untrusted input from a repository. `RepoJobSpec`
> deliberately has **no** `permissionMode`, `engine`, `byokId` or `budget` — a
> repo cannot choose how much power or money its job gets. Those come from the
> importing user's profile. Do not "helpfully" add them.

> **No new dependency.** The workspace has no YAML parser and this feature does
> not add one. `.clockwork/jobs.json` is fully supported. For `.yaml`, write a
> **restricted** parser inside this module: flat key/value mappings and a list of
> mappings, `#` comments, quoted and bare scalars. No anchors, aliases, multi-doc,
> block scalars or nested sequences — reject them with a clear error rather than
> guessing.

```ts
export function findJobsFile(repoPath: string): { path: string; format: 'yaml' | 'json' } | null;
export function parseJobsFile(text: string, format: 'yaml' | 'json'): RepoJobsFile | { error: string };
export function digestOf(spec: RepoJobSpec): string;   // sha256 hex of canonical JSON

export class RepoJobs {
  constructor(db: DB);
  /** read the repo, upsert offers; a changed digest re-offers rather than silently updating */
  discover(repoPath: string, now?: number): { offers: RepoJobOffer[]; error?: string };
  list(status?: RepoJobStatus): RepoJobOffer[];
  get(id: string): RepoJobOffer | undefined;
  /** creates the task DISABLED; returns the new task id */
  import(id: string, now?: number): { taskId: string } | 'not_found' | { error: string };
  dismiss(id: string, now?: number): boolean;
}
```

Behaviour:

- `discover` searches `<repoPath>/.clockwork/jobs.json` then `jobs.yaml` then
  `jobs.yml`. Missing file → `{ offers: [] }`, not an error.
- every offer stores `preview_json` from `securityPreview()`
  (`templates.ts:24`) computed at discovery, so the user reviews the same flags
  that were computed then.
- a re-`discover` whose `digest` changed resets `status` to `'offered'` and
  clears `decided_at` — a repo that edits a job the user dismissed must ask
  again.
- `import` creates the task with **`enabled = 0`**, `permission_mode` from the
  user's default profile, and records `task_id` + `status='imported'`. A job
  whose preview carries a `red` flag is refused with `{ error }` → 422.

**Routes**

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| POST | `/workforce/repo-jobs/discover` | `{ repoPath: string }` | 200 `{ offers: RepoJobOffer[] }` · 422 |
| GET | `/workforce/repo-jobs` | `?status=` | 200 `{ offers: RepoJobOffer[] }` |
| POST | `/workforce/repo-jobs/:id/import` | — | 201 `{ taskId }` · 404 · 422 |
| POST | `/workforce/repo-jobs/:id/dismiss` | — | 200 `{ dismissed: true }` · 404 |

**Wiring** — `api.ts` (4 routes).
**Depends on** nothing.

---

### F6 — accept-with-note

The inbox gains **accept / reject / accept-with-note**. The note is written into
that task's shift-handoff memory. **This is the explicit acceptance signal for
the north-star metric** — F7, F10 and F11 all read it.

- **Module** `packages/daemon/src/acceptance.ts`
- **Test** `packages/daemon/test/acceptance.test.ts`
- **Owns** `run_outcomes`
- **Writes** `agent_memories` (through F2's `HandoffMemory.append`)
- **Optional UI** `packages/ui/src/components/OutcomeControls.tsx`

```ts
export class Acceptance {
  constructor(db: DB, handoff: HandoffMemory);
  /** idempotent per run: a second decision UPDATES, never duplicates */
  record(runId: string, input: RunOutcomeWrite, actor?: string, now?: number):
    RunOutcomeRecord | 'not_found';
  get(runId: string): RunOutcomeRecord | undefined;
  listForTask(taskId: string, limit?: number): RunOutcomeRecord[];
  /** consecutive accepted decisions for a profile, newest-first, stopping at the first rejection */
  acceptedStreak(profileId: string): number;
}
```

Behaviour:

- `run_id` is the primary key. Write with
  `INSERT ... ON CONFLICT(run_id) DO UPDATE SET ...` so re-deciding is an update.
- `profile_id` is resolved once at decision time from the run's frozen jobspec:
  `json_extract(jobspec_json, '$.profile.id')` (JSON1 is available — verified on
  SQLite 3.53.2). Store the snapshot; do not join `profiles` at read time.
- `accepted_with_note` **must** carry a non-empty note (`RunOutcomeWrite`
  enforces it) and appends an `agent_memories` row with `author='human'`,
  `kind='note'`, `body` = the note, storing the new id in `memory_id`.
- `acceptedStreak` counts `accepted` **and** `accepted_with_note` — a note is
  still an acceptance — and stops at the first `rejected`.

**Routes**

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| POST | `/workforce/runs/:runId/outcome` | `RunOutcomeWrite` | 200 `RunOutcomeRecord` · 404 · 422 |
| GET | `/workforce/runs/:runId/outcome` | — | 200 `RunOutcomeRecord` · 404 |
| GET | `/workforce/tasks/:taskId/outcomes` | `?limit=` | 200 `{ outcomes: RunOutcomeRecord[] }` |

**Wiring** — `api.ts` (3 routes + construct), `packages/ui/src/api.ts` (an
`api.recordOutcome(runId, body)` method), `InboxView.tsx` (mount the controls).
UI rules: the buttons carry `data-testid` and `aria-label`; no
`dangerouslySetInnerHTML`, no `.innerHTML`, no dynamic `href={…}` / `src={…}`
anywhere in `packages/ui/src` — `agent-content-escaping.test.tsx` fails the whole
suite for any of them.
**Depends on** F2.

---

### F7 — earned-autonomy

A profile starts in plan mode; after a configurable streak of accepted outcomes
with no rejections it is **OFFERED** — never auto-granted — the next autonomy
rung: `plan → acceptEdits → unattended`. **Belongs inside the existing policy
engine, not beside it.**

- **Module** `packages/daemon/src/autonomy-policy.ts`
- **Test** `packages/daemon/test/autonomy-policy.test.ts`
- **Owns** `autonomy_offers`, `profiles.autonomy_rung`,
  `profiles.autonomy_streak_required`, `workforce_prefs.autonomy_streak_required`
- **Reads** `run_outcomes` (F6)

The module **composes** `PolicyEngine` rather than editing it, because
`policy-engine.ts` is not one of this agent's two files. The integrator folds
`AutonomyPolicy.evaluate` into `PolicyEngine.evaluate`'s fail-closed chain via a
wiring snippet — that is what "inside the policy engine" means in practice.

**The rung ladder is already decided.** `permissionModes` is
`['plan','acceptEdits','default']` and `bypassPermissions` is banned in H1
(S-74), so there is no third permission mode to promote into. `unattended` is
`acceptEdits` with the approval flag cleared. `AUTONOMY_RUNG_SETTINGS` in
`@clockwork/shared` is the single definition — read it, do not restate it:

```
plan        -> permissionMode 'plan',        may_require_approval 1
acceptEdits -> permissionMode 'acceptEdits', may_require_approval 1
unattended  -> permissionMode 'acceptEdits', may_require_approval 0
```

```ts
export interface AutonomyState {
  profileId: string;
  rung: AutonomyRung | null;      // null = not enrolled
  streakRequired: number;         // profile override, else workforce_prefs
  streak: number;                 // current accepted streak
  eligible: boolean;              // streak >= streakRequired && nextRung(rung) !== null
}

export class AutonomyPolicy {
  constructor(db: DB, policy: PolicyEngine, acceptance: Acceptance);
  state(profileId: string): AutonomyState | undefined;
  enroll(profileId: string, rung: AutonomyRung, now?: number): AutonomyState | 'not_found';
  /** fail-closed: a run exceeding the profile's rung is a policy violation */
  evaluate(input: { profileId: string | null; permissionMode: PermissionMode }): PolicyViolation | null;
  /** offers the next rung when earned; null when not earned or an offer is already open */
  maybeOffer(profileId: string, now?: number): AutonomyOffer | null;
  listOffers(status?: AutonomyOfferStatus): AutonomyOffer[];
  respond(offerId: string, decision: 'accepted' | 'declined', now?: number):
    AutonomyOffer | 'not_found' | 'already_resolved';
}
```

Behaviour:

- **`maybeOffer` never promotes.** It inserts an `autonomy_offers` row and
  nothing else. `respond('accepted')` is the only code path that writes
  `profiles.autonomy_rung` and `profiles.permission_mode`. A test must assert
  this directly: call `maybeOffer`, then assert the profile row is unchanged.
- an unenrolled profile (`autonomy_rung IS NULL`) is never offered anything and
  `evaluate` returns `null` for it — enrolment is opt-in.
- `evaluate` returns `{ code: 'autonomy_rung_exceeded', message }` when the
  requested permission mode outranks the rung. Order is the ladder order.
- a `declined` offer is not re-offered at the same streak; the next offer needs
  the streak to grow past `offer.streak`.

**Routes**

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| GET | `/workforce/autonomy/offers` | `?status=` | 200 `{ offers: AutonomyOffer[] }` |
| POST | `/workforce/autonomy/offers/:id/respond` | `{ decision: 'accepted'\|'declined' }` | 200 `AutonomyOffer` · 404 · 409 `already_resolved` |
| GET | `/workforce/autonomy/profiles/:profileId` | — | 200 `AutonomyState` · 404 |
| POST | `/workforce/autonomy/profiles/:profileId/enroll` | `{ rung: AutonomyRung }` | 200 `AutonomyState` · 404 · 422 |

**Wiring** — `api.ts` (4 routes + construct), `policy-engine.ts`, and
`maybeOffer` after an acceptance is recorded (`run-manager.ts` *or* the F6
route — integrator's choice; F6's route is simpler).

> **Say which shape the policy wiring takes.** `evaluatePolicy(engine, byokId,
> budgetUsd)` (`api.ts:111`) has three call sites and carries **no `profileId`
> and no `permissionMode`**, so "fold it into the chain" is not a one-line
> snippet. Offer the integrator both, and pick one in the snippet:
> **(a)** widen `evaluatePolicy` to take `{ profileId, permissionMode }` and
> update all three callers (task create, task patch, webhook fire), or
> **(b)** run `AutonomyPolicy.evaluate` as a second gate immediately after
> `evaluatePolicy` at each site, returning the same `403 { violation }` shape.
> (b) is smaller and touches nothing existing; (a) is the one that literally puts
> autonomy inside the policy engine. Recommend (b) first, (a) as the follow-up.
**Depends on** F6.

---

### F8 — self-healing

After N consecutive failures, book a diagnostic run with the failed transcripts
as context. Its output is an **approval item** proposing a prompt or profile
diff. A human applies it. **The agent never edits its own prompt.**

- **Module** `packages/daemon/src/self-healing.ts`
- **Test** `packages/daemon/test/self-healing.test.ts`
- **Owns** `remediation_proposals`, `task_failure_streaks.diagnostic_run_id`,
  `task_failure_streaks.diagnostic_at`
- **Reads** `runs`, `tasks`, `workforce_prefs.self_heal_failure_threshold`

> **The streak row is shared.** `task_failure_streaks` has PK `task_id` **alone**,
> and `recordAuthFailureAndMaybePause` (`policies.ts:12`) already overwrites
> `kind='auth'` on it. This feature uses the **same row**, writing `kind='failure'`
> through its own `ON CONFLICT(task_id) DO UPDATE` — so `kind` names the most
> recent failure class. **Do not add a second failure table** and **do not edit
> `policies.ts`**. `clearFailureStreak` deletes the row, which clears
> `diagnostic_at` too. That is intended: a task that recovers gets a clean slate.

```ts
export interface SelfHealingDeps {
  db: DB;
  /** books the diagnostic run with an already-materialized prompt */
  bookRun(taskId: string, promptOverride: string): string | null;
}

export class SelfHealing {
  constructor(deps: SelfHealingDeps);
  /** call after a failed run finalizes; books a diagnostic when the streak crosses the threshold */
  onRunFailed(taskId: string, runId: string, now?: number): { diagnosticRunId: string } | null;
  /** turn a diagnostic run's report into a proposal + an approvals row */
  proposeFrom(runId: string, taskId: string, reportJson: string | null, now?: number):
    RemediationProposal | null;
  list(status?: RemediationStatus, limit?: number): RemediationProposal[];
  get(id: string): RemediationProposal | undefined;
  /** the ONLY writer of tasks.prompt / tasks.profile_id in this feature */
  apply(id: string, now?: number): RemediationProposal | 'not_found' | 'already_resolved';
  reject(id: string, now?: number): RemediationProposal | 'not_found' | 'already_resolved';
}

/** the diagnostic prompt: read these transcripts, propose ONE change, change nothing */
export function diagnosticPromptFor(taskName: string, currentPrompt: string, transcriptPaths: string[]): string;
```

Behaviour:

- `onRunFailed` increments the shared streak, then books at most **one**
  diagnostic per streak: it requires `count >= self_heal_failure_threshold`
  **and** (`diagnostic_at IS NULL` **or** the streak has grown past the count at
  which the last diagnostic was booked).
- the diagnostic run is a run of the **same task** with an overridden prompt from
  `diagnosticPromptFor`, carrying the last N failed runs' `transcript_path`
  values. It must not recurse: a diagnostic run that fails does not book another
  diagnostic (mark it, e.g. by checking the run's prompt override or a
  `diagnostic_run_id` match).
- `diagnosticPromptFor` must instruct the agent to **propose, not apply** — no
  file edits, output a single suggested prompt or profile change with a rationale.
- `proposeFrom` writes the `remediation_proposals` row *and* an `approvals` row
  **per §2.4** — `run_id` is the diagnostic run, `payload_json` is
  `{ proposalId, target, proposedValue }` — so the proposal lands in the existing
  inbox. `apply`/`reject` also CAS-close that approvals row, and
  `POST /approvals/:id/respond` dispatches back on `payload.proposalId` (§2.4).
- `apply` is the only write to `tasks.prompt` / `tasks.profile_id`, guarded by a
  CAS on `decided_at IS NULL`, and bumps `tasks.version` so an open editor gets a
  409 instead of clobbering.

**Routes**

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| GET | `/workforce/remediations` | `?status=&limit=` | 200 `{ proposals: RemediationProposal[] }` |
| GET | `/workforce/remediations/:id` | — | 200 `RemediationProposal` · 404 |
| POST | `/workforce/remediations/:id/apply` | — | 200 `RemediationProposal` · 404 · 409 `already_resolved` |
| POST | `/workforce/remediations/:id/reject` | — | 200 `RemediationProposal` · 404 · 409 `already_resolved` |

**Wiring** — `api.ts` (4 routes + construct), `run-manager.ts` (finalize hook:
`onRunFailed` on failure, `proposeFrom` when the finished run was a diagnostic).
**Depends on** nothing hard; shares the approval pattern with F1.

---

### F9 — proposed-events

A run report may carry `proposedEvents[]`: calendar events the agent suggests
("review PR 42, 10 min"). The UI offers them as a downloadable `.ics`.
**Clockwork NEVER writes to the user's real calendar.**

- **Module** `packages/daemon/src/proposed-events.ts`
- **Test** `packages/daemon/test/proposed-events.test.ts`
- **Owns no table.** Reads `runs.report_json`.
- **Optional UI** `packages/ui/src/components/ProposedEvents.tsx`

```ts
/** [] when the run has no report, no proposals, or a report predating the field */
export function proposedEventsFor(db: DB, runId: string): ProposedEvent[];

/** RFC 5545 VCALENDAR text; CRLF line endings, folded at 75 octets */
export function toIcs(events: ProposedEvent[], opts?: { calName?: string; defaultAtMs?: number }): string;

export function icsFilenameFor(runId: string): string;   // e.g. clockwork-<runId>.ics
```

Behaviour:

- reports are read with bare `JSON.parse` and never re-validated, so
  `proposedEvents` may be `undefined`. Read it as `report?.proposedEvents ?? []`
  and validate each entry with `ProposedEvent.safeParse`, dropping the bad ones
  rather than failing the whole request.
- `UID` is `<runId>-<event.key>@clockwork.local` — stable, so re-importing
  updates rather than duplicating in the user's calendar.
- `suggestedAt === null` falls back to `opts.defaultAtMs`, else the next whole
  hour. `DTSTART`/`DTEND` are UTC (`...Z`). `DTEND = DTSTART + durationMin`.
- escape `SUMMARY`/`DESCRIPTION` per RFC 5545: `\` → `\\`, `;` → `\;`,
  `,` → `\,`, newline → `\n`.
- **the module has no write path.** No ICS source is added, no calendar is
  contacted. `ics.ts` subscriptions stay read-only and are not touched.

**Routes**

| Method | Path | Response |
| --- | --- | --- |
| GET | `/workforce/runs/:runId/proposed-events` | 200 `{ events: ProposedEvent[] }` · 404 |
| GET | `/workforce/runs/:runId/proposed-events.ics` | 200 `text/calendar; charset=utf-8`, `Content-Disposition: attachment; filename="…"` · 404 |

**Wiring** — `api.ts` (2 routes), `packages/ui/src/api.ts`
(`api.proposedEvents(runId)`), `InboxView.tsx` (render in `ReportDetail`).
**Depends on** `RunReport.proposedEvents` (already landed). Nothing populates it
yet; the field is optional, so this feature ships returning `[]` and starts
returning data the moment a runner writes one.

---

### F10 — timesheets

Per-agent punch clock: hours worked, dollars spent, outcomes accepted, and an
effective hourly rate. **Plain SQL over existing `runs`/report data plus the new
acceptance signal.**

- **Module** `packages/daemon/src/timesheets.ts`
- **Test** `packages/daemon/test/timesheets.test.ts`
- **Owns no table.** Reads `runs`, `run_outcomes`, `profiles`,
  `workforce_prefs.human_hourly_rate_usd`.

```ts
export function timesheet(db: DB, opts: { fromMs: number; toMs: number; profileId?: string }): Timesheet;
export function humanHourlyRate(db: DB): number | null;
export function setHumanHourlyRate(db: DB, rate: number | null): void;
```

Behaviour — these definitions are the contract, because two features must agree
on them:

- **grouping key**
  `COALESCE(run_outcomes.profile_id, json_extract(runs.jobspec_json, '$.profile.id'))`.
  The jobspec fallback makes historical runs count with **zero** wiring —
  `jobSpecForTask` has always written `$.profile.id` (`api.ts:1505`). Runs with
  no profile group under `profileId: null`, `profileName: 'Unassigned'`.
- **window** `COALESCE(ended_at, scheduled_for)` in `[fromMs, toMs)`.
- **hoursWorked** `SUM(MAX(0, ended_at - started_at)) / 3_600_000`, counting only
  rows where both are non-null. A run that never started contributes 0 hours and
  still contributes its cost.
- **dollarsSpent** `SUM(COALESCE(cost_usd, 0))`.
- **effectiveHourlyRateUsd** `dollarsSpent / hoursWorked`, **`null`** when
  `hoursWorked` is 0 — never `Infinity`, never 0.
- **outcomesAccepted** counts `accepted` **and** `accepted_with_note`.
- rows sort by `dollarsSpent` descending.

**Routes**

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| GET | `/workforce/timesheets` | `?from=&to=&profileId=` (ms; default: last 30 days) | 200 `Timesheet` · 422 on a bad range |
| PUT | `/workforce/prefs/hourly-rate` | `{ humanHourlyRateUsd: number \| null }` | 200 `{ humanHourlyRateUsd }` · 422 |

**Wiring** — `api.ts` (2 routes).
**Depends on** F6.

---

### F11 — performance-reviews

Per-profile scorecard over a period: acceptance rate, cost trend, failure rate.
**The written verdict is itself a scheduled run using a reviewer profile; the
aggregate is plain SQL.**

- **Module** `packages/daemon/src/performance.ts`
- **Test** `packages/daemon/test/performance.test.ts`
- **Owns no table.** Reads `runs`, `run_outcomes`, `profiles`,
  `workforce_prefs.review_period_days`.

```ts
export function scorecard(db: DB, profileId: string | null, opts: { fromMs: number; toMs: number }): PerformanceScorecard;
export function scorecards(db: DB, opts: { fromMs: number; toMs: number }): PerformanceScorecard[];
/** the prompt a reviewer-profile task runs to write the prose verdict */
export function reviewPromptFor(card: PerformanceScorecard): string;
```

Behaviour:

- **this module makes no model call and writes no prose.** `reviewPromptFor`
  returns text; a scheduled task using a reviewer profile runs it. That is the
  whole design — the numbers must be reproducible without an LLM.
- use the **same grouping key and window as F10**. If the two disagree, the
  product tells a user two different numbers for the same agent.
- `acceptanceRate` = accepted / decided, `null` when `decided === 0`. Never
  report 0% for "nobody looked yet" — an unreviewed agent is not a failing one.
- `failureRate` = (`failed` + `timed_out`) / runs, `null` when `runs === 0`.
- `costTrendUsd` = mean cost/run this window minus the previous window of equal
  length, `null` when the previous window had no runs.

**Routes**

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| GET | `/workforce/performance` | `?from=&to=` | 200 `{ cards: PerformanceScorecard[] }` |
| GET | `/workforce/performance/:profileId` | `?from=&to=` | 200 `PerformanceScorecard` · 404 |
| GET | `/workforce/performance/:profileId/review-prompt` | `?from=&to=` | 200 `{ prompt: string }` · 404 |

**Wiring** — `api.ts` (3 routes).
**Depends on** F6; shares F10's definitions.

---

### F12 — proof-of-work-export

Export a run report as a redacted, **self-contained single HTML file** the user
hosts themselves. Reuses the existing secret masking. **No Clockwork-hosted
anything.**

- **Module** `packages/daemon/src/proof-of-work.ts`
- **Test** `packages/daemon/test/proof-of-work.test.ts`
- **Owns no table.** Reads `runs`; audits through the existing `audit()` helper.

```ts
export function proofOfWorkHtml(db: DB, runId: string, opts?: Partial<ProofOfWorkOptions>): string | 'not_found';
export function proofFilenameFor(runId: string): string;   // clockwork-proof-<runId>.html
```

Behaviour — the test must assert each of these on real output:

- **self-contained**: no `<script src=`, no `<link rel="stylesheet"`, no remote
  `<img src="http`. CSS inline in one `<style>`. No analytics, no telemetry
  pixel, no phone-home of any kind.
- **masked**: `maskSecrets` (from `@clockwork/runner`, `context.ts:75`) runs over
  **every** interpolated string — summary, failure reason, timeline text,
  transcript tail. Masking is not optional and has no flag.
- **escaped**: `&`, `<`, `>`, `"`, `'` escaped in every interpolation. Report
  content is agent-authored text; an unescaped `<script>` in a summary is stored
  XSS in a file the user is about to publish.
- `redactPaths` additionally replaces `repoPath`, `worktreePath` and `branch`
  with `[redacted]`.
- `includeTranscript` is **off by default** — a transcript is the most
  sensitive artifact a run produces, so exporting it is an explicit choice.
- the route calls `audit('run.export_proof', 'run', runId, { … })`.

**Routes**

| Method | Path | Response |
| --- | --- | --- |
| GET | `/workforce/runs/:runId/proof-of-work` | 200 `text/html; charset=utf-8`, `Content-Disposition: attachment; filename="…"` · 404 |

Query params: `includeTranscript`, `includeDiffStat`, `redactPaths`
(`'1'`/`'true'`).

**Wiring** — `api.ts` (1 route).
**Depends on** nothing.

---

## 5. Dependency graph and build order

```
        F2 handoff ──────┐
                         ├──> F6 accept-with-note ──┬──> F7  earned-autonomy
                         │    (the acceptance       ├──> F10 timesheets
                         │     signal)              └──> F11 performance-reviews
  F1 plan-then-execute   │
  F3 office-hours        │   independent
  F4 sentinel-worker     │   of everything
  F5 repo-shipped-jobs   │
  F8 self-healing        │
  F9 proposed-events     │
  F12 proof-of-work  ────┘
```

- **Wave 1** (parallel, no dependencies): F1, F2, F3, F4, F5, F8, F9, F12
- **Wave 2**: F6 (needs F2's `HandoffMemory`)
- **Wave 3** (parallel): F7, F10, F11 (all need F6's `Acceptance`)

A wave-2 or wave-3 agent imports the earlier module's **exported class** as
specified here. Those signatures are frozen; an earlier agent who changes one
breaks three later ones.

---

## 6. Definition of done

A feature is done when all of these hold:

1. Exactly two new files exist (plus at most one UI component), and no frozen
   file was modified.
2. `pnpm lint` → 0 errors. Warnings are pre-existing `no-explicit-any`; add none
   in a new file.
3. `pnpm typecheck` passes (`tsc -b packages/shared packages/runner packages/daemon`).
4. `pnpm test` passes with **no fewer than 274 tests across 38 files** — the
   260-test baseline plus the 14 foundation tests — and the feature's own tests
   on top.
5. Every wiring snippet is in the final message, in the §3 format, and applies
   cleanly against the stated anchor.
6. The feature's tests cover the refusal paths, not just the happy one.
7. `features.ts` still says `planned` — the integrator flips it.

**The honest failure.** If a feature cannot be built inside these constraints,
say so plainly and say which constraint blocks it. A returned "this needs a
column 0008 does not have, here is why" is a good outcome. Quietly adding a
migration, editing a frozen file, or relaxing a test is not.
