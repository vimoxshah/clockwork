# Clockwork — Scenario & Edge-Case Matrix

The contract for "handle all scenarios." Every implementation task in `05-execution-plan.md` cites the S-IDs it must satisfy; every S-ID gets at least one automated test (fake-clock harness, MockRunner, or Playwright) unless marked **[manual]**.

Legend: **Required behavior** is normative — deviations need a DECISIONS entry.

---

## A. Scheduling & time (S-1 … S-29)

| ID | Scenario | Required behavior |
|---|---|---|
| S-1 | One-off task fires while machine awake, daemon healthy | Run starts within 60s of `next_fire` (NFR-1); state `scheduled→queued→…` |
| S-2 | Two tasks fire at the same instant, concurrency limit 2 | Both start; a third queues FIFO by `scheduled_for` |
| S-3 | Two tasks same instant, **same repo** | Repo mutex: second waits; report notes queue delay |
| S-4 | "Run now" clicked while same task's scheduled run is running | Second instance queues behind repo mutex; warn in UI ("already running — queue another?") |
| S-5 | Task edited while a run of it is `running` | Running run keeps its captured JobSpec snapshot; edits affect next occurrence only |
| S-6 | Task deleted while run in-flight | Run completes/cancels per user choice prompt; history + report retained (task row soft-deleted) |
| S-7 | Task disabled mid-queue | Queued occurrence cancelled with state `cancelled`, reason `task_disabled` |
| S-8 | Recurring schedule's next occurrence lands while previous run still executing | Skip-or-queue per task setting (`overlap_policy`, default **skip** with report note) — never unbounded pileup |
| S-9 | 500 tasks defined, 50 due in same minute | Scheduler tick remains O(due) via `idx_schedules_next`; queue drains at concurrency; no tick starvation (tick loop must not await run completion) |
| S-10 | **Machine asleep at fire time**, wakes 20 min later | Wake event triggers catch-up sweep ≤120s; missed-run policy applies: `run-late` (within `missed_window_sec`) → run with report banner "ran 20m late"; `skip` → `missed` + notification; `ask` → inbox item |
| S-11 | Machine asleep over a weekend; daily task missed 2 occurrences | **Coalescing rule:** at most ONE catch-up run per schedule; report lists occurrences it covers; `next_fire` re-materialized forward |
| S-12 | Laptop lid closed mid-run (sleep during `running`) | Runner process suspended with system; on wake, heartbeat gap detected → if process alive, continue (timeout clock = wall-clock, so long sleeps may trigger S-13 path); if dead, S-31 |
| S-13 | Run exceeds `timeout_sec` (incl. sleep-inflated wall-clock) | SIGTERM to pgid → 30s grace → SIGKILL; state `timed_out`; worktree preserved; report includes partial transcript. Sleep-inflation nuance: timeout guard uses *monotonic active* time where OS exposes it, else wall-clock with a report note |
| S-14 | Daemon not running at fire time (crashed, was upgrading) | On next start: startup sweep = same path as wake catch-up (S-10/S-11) |
| S-15 | Keep-awake window: run scheduled in 10 min, machine plugged in | Power assertion armed (FR-25); released when run finalizes; never armed on battery unless user opted in |
| S-16 | Keep-awake armed but user closes lid anyway (clamshell sleep) | OS wins; on wake, standard missed/late path with an explicit "slept through keep-awake" report note |
| S-17 | True-overnight expectation on a laptop | Onboarding + composer availability hint set expectations (FR-25); docs recommend always-on machine; never silently pretend it will run |
| S-20 | Schedule at 02:30 local; DST spring-forward makes 02:30 nonexistent | Fire at post-transition instant (03:00→03:30 zone-dependent); documented; test fixture per zone (US, EU, AU) |
| S-21 | DST fall-back makes 01:30 occur twice | Fire on first occurrence only |
| S-22 | User changes system timezone / travels | Schedules follow their stored IANA zone, not system zone; UI shows both when they differ |
| S-23 | User sets schedule in the past ("today 9am" at 10am) | Composer blocks with inline fix suggestions (tomorrow 9am / run now) |
| S-24 | RRULE with no future occurrences (COUNT exhausted) | Schedule auto-disables; task remains; inbox note |
| S-25 | System clock jumps (NTP correction, manual change) | Tick loop uses wall-clock comparisons only (no cached deltas); backward jump must not re-fire completed occurrences — guaranteed by the `schedule_occurrences` PK claim (arch §1/§4) |
| S-26 | Cron string invalid / RRULE unparsable | Rejected at save with zod + rrule validation; daemon never sees invalid rows |
| S-27 | Five ASAP items queued, concurrency 2, three different repos | Two start immediately; remaining three show position + wait reason; drain in order as slots free |
| S-28 | ASAP item queued for a repo whose scheduled run is mid-flight | Queue shows "waiting for repo"; starts when the mutex frees — never a parallel run in the same repo |
| S-29 | Machine sleeps with a non-empty ASAP queue | Queue persists; drains on wake (no missed-policy — ASAP items have no "missed" concept, only "not yet"); wait-time visible in queue lane |

## B. Execution & git (S-30 … S-39)

| ID | Scenario | Required behavior |
|---|---|---|
| S-30 | **Daemon crashes** between `queued` and `preparing` | On restart: rows in transient states with stale `state_changed_at` are re-queued (idempotent — no worktree exists yet) |
| S-31 | Daemon crashes while runner `running` | Restart: for each `running` row, verify process identity via (pid, pgid, proc_started_at): alive → **terminate** (SIGTERM→KILL) — re-adoption is explicitly out of H1 scope (ADR-011); state `failed`, reason `orphaned`; report assembled from the runner's on-disk journal; worktree preserved; notification |
| S-32 | Runner crashes (OOM, unhandled) mid-run | Daemon detects heartbeat gap (>60s) + child exit; `failed` with captured stderr tail in report |
| S-33 | Crash left orphan worktrees/branches | Startup reconciliation: scan `~/.clockwork/worktrees` vs DB; unknown dirs → quarantine list in settings UI (never auto-delete unknown data) |
| S-34 | SQLite corruption / disk full mid-transition | WAL + synchronous=NORMAL; on open-failure: backup-and-recreate flow with exported reports; disk-full → pause-all + persistent notification **[manual]** |
| S-35 | Repo's base branch fetch fails (offline, auth) | Proceed from local HEAD of base branch; report banner "based on local state (fetch failed: reason)" |
| S-36 | Repo has no commits / not a git repo / path missing | Composer validates at save; daemon re-validates at `preparing` → `failed` reason `repo_invalid` with actionable message |
| S-37 | Agent's changes conflict with upstream by review time | Not Clockwork's problem to solve — report shows branch base SHA; "Create PR" surfaces conflicts naturally; template docs recommend fetch-first tasks |
| S-38 | `git worktree add` fails (locked index, permissions) | One retry after 10s; then `failed` reason `worktree_error` + exact git stderr |
| S-39 | Agent commits nothing (analysis-only task) | Valid outcome: report with summary + no diff section; branch auto-pruned immediately (nothing on it) |

## C. Budget, auth, API (S-40 … S-49)

| ID | Scenario | Required behavior |
|---|---|---|
| S-40 | Claude auth expired / revoked at run start | Fail fast at `preparing` with a **pre-flight auth check**; state `failed`, reason `auth`; actionable notification ("Open Claude Code and re-login"); recurring schedules keep firing into same failure at most twice, then auto-pause task with inbox alert |
| S-41 | Auth expires **mid-run** | SDK errors; runner maps to `failed:auth`; same auto-pause rule |
| S-42 | Rate limit / overloaded API mid-run | SDK retries internally; on terminal 429/529: `failed`, reason `rate_limited`; scheduler applies task-level backoff (next retry +30min, max 2) if task opted into `retry_on_transient` |
| S-43 | Slack webhook / SMTP delivery fails | Never affects run outcome; delivery marked failed in report footer; retry ×3 exponential |
| S-44 | Run hits `budget_usd` cap | Hard-stop after current message; state `budget_exceeded`; partial work committed to branch + report explains where it stopped |
| S-45 | Run hits `max_turns` | Same pattern, reason `max_turns` |
| S-46 | Anthropic model deprecated / renamed | Model validated at save-time against SDK model list; run-time unknown-model error → `failed` + task auto-pause + suggested replacement in notification |
| S-47 | Capacity window exhausted (subscription 5-hour cap hit) | Detected via SDK error class; `failed:capacity` **or** (if task `flexible`) auto-defer to predicted window reset with inbox note — never silent |
| S-48 | Network offline at fire time | Pre-flight connectivity probe; task `flexible` → defer 15min ×4 then missed-policy; else `failed:offline` |
| S-49 | SDK minor upgrade changes behavior | SDK pinned (stack #17); upgrade only via explicit release with nightly real-SDK smoke suite green |

## D. HITL & approvals (S-50 … S-56)

| ID | Scenario | Required behavior |
|---|---|---|
| S-50 | Agent requests permission outside allow-set | Run → `waiting_approval`; state + session persisted; OS notification + inbox item with the exact command/diff being approved |
| S-51 | User approves | Runner resumes via session_id; approval + decision recorded in report timeline |
| S-52 | User denies | Agent continues with denial (SDK deny message); if agent cannot proceed → normal completion paths |
| S-53 | Approval times out (default 4h) | Task-level fallback: `deny-and-continue` (default) or `abort`; report flags the timeout prominently |
| S-54 | Approval pending when daemon restarts | `waiting_approval` rows survive; inbox still actionable; resume path re-validated on restart |
| S-55 | Deny-list floor triggered (`rm -rf /`, force-push protected, `~/.ssh` read) | M1: auto-deny + run continues (agent told why); M2+: auto-deny + escalate visibility (inbox security banner). Never approvable per-task; global override requires the scary settings toggle + typed confirmation |
| S-56 | Multiple approvals pile up across runs | Inbox approval queue view; oldest-first; each with its own timeout clock |
| S-57 | Approval answered from two surfaces at once, or timeout fires during a click | Compare-and-set on `responded_at` — first writer wins, second surface shows "already resolved"; timeout handler uses the same CAS |
| S-58 | Runner process dies while `waiting_approval` (keep-alive model) | Detected via heartbeat + process identity; approval item stays actionable; on decision, fallback fresh-session resume path (T-003 contract) or clean `failed:orphaned` with journal-based report — never a dangling approval |

## E. UI, upgrade, misc (S-60 … S-69)

| ID | Scenario | Required behavior |
|---|---|---|
| S-60 | UI closed for a week; reopened | Everything ran on schedule; inbox shows unread reports; calendar backfilled — the *product proof* moment |
| S-61 | Daemon/UI version mismatch after app update | API version handshake; older daemon → UI triggers daemon self-update flow; never silent incompatibility |
| S-62 | App uninstalled | Uninstaller offers: keep or export `~/.clockwork` (reports/DB); removes service registration cleanly **[manual]** |
| S-63 | Two UI windows / instances open | Both are stateless SSE clients; safe by construction |
| S-64 | User on 5,000-run history opens calendar year view | Windowed fetch + aggregation (counts per day, not events) — NFR-3 |
| S-65 | Quiet hours active when run completes | Notification suppressed, inbox badge still increments; delivery integrations unaffected |
| S-66 | Laptop battery <10% at fire time | Default: run anyway; optional setting "defer non-flexible runs on battery" — never silently skip |
| S-67 | Prompt references files outside repo (`~/notes.md`) | Allowed read-only if inside user-configured "context roots"; else deny-list floor applies |
| S-68 | Report contains secrets agent happened to read | Report renderer masks common credential patterns (best-effort, documented as such); transcripts stay local either way |
| S-69 | Machine has no `git` / repo task on machine without repo path | Composer + preflight validation with install/fix guidance |

## F. Chaining & templates (S-70 … S-75) — M2

| ID | Scenario | Required behavior |
|---|---|---|
| S-70 | Chain A→B, A fails, B `on: success` | B skipped with state `cancelled`, reason `upstream_failed`; visible on calendar as ghost |
| S-71 | Chain A→B, A `budget_exceeded` | Treated as failure for chaining purposes (documented) |
| S-72 | Chain cycle attempted (A→B→A) | Rejected at save (DAG validation) |
| S-73 | `{{previous.report}}` exceeds context budget | Truncate to summary + artifact refs, note in prompt assembly log |
| S-74 | Template imported from untrusted source | Import preview shows full prompt/permissions/budget diff vs defaults; `bypassPermissions` templates flagged red; never auto-enable — imported tasks arrive disabled |
| S-75 | Template applied to repo lacking assumed structure | Template variables validated (paths exist) at apply time |
| S-76 | User asks for fan-in/fan-out chains (A→B and A→C, or A+B→C) | H1: linear chains only (single parent, spec FR-8); composer explains; DAG semantics are H2 scope |

## G. Process, upgrade & git edge cases (S-80 … S-89) — added after review round 1

| ID | Scenario | Required behavior |
|---|---|---|
| S-80 | Second daemon instance started (manual launch, installer race) | Single-instance lock (lockfile + port bind); loser exits 0 with a log line; `doctor` reports it |
| S-81 | Machine **reboots** mid-run | Startup sweep finds `running` rows with dead identities → S-31 orphan path; scheduler catch-up runs after |
| S-82 | Two UI surfaces edit the same task concurrently | Optimistic version column on tasks; stale write → 409 + UI merge prompt — never silent last-writer-wins |
| S-83 | Auto-updater replaces daemon binary while a run is active | Updater waits for drain (pause-new + active-runs-complete, max 30 min) or defers to next idle; never kills active runs for an update |
| S-84 | Repo has pre-commit/post-checkout hooks (husky etc.) | Hooks **disabled by default** in Clockwork worktrees via per-worktree hooksPath override; per-task opt-in to run them; report notes which applied |
| S-85 | Repo uses submodules / LFS | Not initialized unless task opts in; preflight detects and reports; agent sees a truthful repo state description in context |
| S-86 | Context root contains a symlink escaping the allowlist (`~/notes → ~/.ssh`) | Sandbox resolves real paths; escape denied + safety-journal entry (FR-26/27) |
| S-87 | Base branch is detached-HEAD / task's base branch deleted upstream | Preflight fails with actionable message; recurring task auto-pauses after 2 consecutive preflight failures (same rule as S-40) |
| S-88 | Disk fills **during** a run (agent generates GBs) | Runner monitors free space; below floor (default 2GB) → graceful stop, `failed:disk_full`, worktree preserved, pause-all suggested |
| S-89 | Task with external side effects (MCP email/tickets) retried after transient failure | `retry_on_transient` defaults **off** for tasks with MCP attachments; per-run idempotency key injected into prompt context; docs state the double-send risk plainly |

---

## Test-fixture inventory (minimum)

1. **Fake-clock scheduler suite**: S-1…S-11, S-20…S-26 as table-driven fixtures (zones: America/New_York, Europe/Berlin, Australia/Lord_Howe, UTC), including double-fire attack tests against the occurrence ledger.
2. **FSM crash-recovery suite**: kill -9 the daemon at each transition boundary (S-30…S-34, S-81, S-83), assert recovery invariants.
3. **MockRunner suite**: budget/turn/timeout/approval paths (S-13, S-44, S-45, S-50…S-58, S-89) without API spend.
4. **Nightly real-SDK smoke**: one tiny scheduled run end-to-end on macOS runner, $2 cap (S-1, S-40 pre-flight, sandbox-on).
5. **Playwright**: composer validation (S-23, S-26, S-36), inbox/approval flows (S-57), S-60 cold-reopen, S-82 edit conflict.
6. **Sandbox escape suite**: credential-path reads, symlink escapes (S-86), out-of-allowlist writes — must be denied and journaled; runs in CI on every sandbox-profile change.
