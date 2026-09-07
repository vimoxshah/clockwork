# Clockwork — Architecture (as built)

Three local processes, no cloud. SQLite is the single source of truth; the
daemon is the single writer for run state. Deviations from the original plan
are recorded in `decisions/DECISIONS.md` (ADR-020..025).

```
┌───────────────────────────────────────────────────────────────┐
│  UI — React 18 + Vite (Tauri 2 wrapper at packaging, ADR-025) │
│  Calendar · Composer · Inbox · Approvals · Settings           │
│  (stateless: REST + SSE client; token from ~/.clockwork or    │
│   Tauri-injected at spawn; static bundle served by daemon)    │
└──────────────┬────────────────────────────────────────────────┘
               │ HTTP + SSE · 127.0.0.1:4747 · bearer token (0600)
┌──────────────┴────────────────────────────────────────────────┐
│  DAEMON — Node ≥22, login-session LaunchAgent                 │
│  Scheduler (tick loop + occurrence ledger)                    │
│  Run manager (FSM · semaphore · repo mutex · supervision)     │
│  API server (Fastify REST + SSE) · Notifier · Delivery        │
│  SQLite (WAL, synchronous=FULL on state transitions)          │
│  Keep-awake (caffeinate power assertions, plugged-in only)    │
└──────────────┬────────────────────────────────────────────────┘
               │ spawn per run — child process, own pgid,
               │ sanitized env, JSONL IPC with per-run nonce (ADR-024)
┌──────────────┴────────────────────────────────────────────────┐
│  RUNNER CHILD                                                 │
│  AgentRunner engine: ClaudeCliRunner (default: headless       │
│  `claude -p --output-format stream-json`, your subscription   │
│  login, no API key) OR ClaudeSdkRunner (opt-in, M2+)          │
│  profile materializer (.claude/) · budget guard · deny-list   │
│  Seatbelt sandbox wrap · stream-json parser · journal         │
└───────────────────────────────────────────────────────────────┘
```

## Data model

The DDL in `packages/daemon/migrations/0001_init.sql` executes the normative
schema from `plan/02-architecture.md` §1 **verbatim** (ADR-022), plus two
additions: `tasks.version` (optimistic concurrency, S-82), `runs.scheduled_for`
(queue ordering / calendar windowing), `task_failure_streaks` (S-40 auto-pause)
and `runs.worktree_pruned` (retention).

Durability: WAL mode; `synchronous=FULL`. Large payloads (transcripts,
artifacts) live under `~/.clockwork/runs/<run-id>/`; the DB stores summaries +
pointers.

## Run lifecycle FSM

```
scheduled → queued → preparing → running → finalizing → completed | failed
                     │             │            |→ cancelled | budget_exceeded
                     │             │→ waiting_approval (M2 HITL, SDK engine)
                     │→ failed (preflight)
missed-policy 'ask' → awaiting_user → queued | missed
timed_out ← running (wall-clock cap, SIGTERM → grace → SIGKILL by pgid)
```

Every transition = one synchronous SQLite write + one `events` row + one SSE
broadcast. Illegal transitions throw (`assertTransition`) — they are never
silently persisted.

## The Runner seam

```ts
interface AgentRunner { start(job, ctx): Promise<RunOutcome>; resume(...); cancel(...) }
interface RunnerIO { onUsage; onPermissionRequest; onHeartbeat; onArtifact }
```

- **ClaudeCliRunner** (default): tolerant stream-json parser (R-2 — unknown
  events never crash the run), soft-cap USD budget with measured overshoot
  between messages, hard turn/time caps enforced by Clockwork (the CLI has no
  `--max-turns` flag; ADR-020), `claude --version` recorded per run.
- **MockRunner**: deterministic engine powering the full-loop test suite.
- Engine contact is confined to `packages/runner` + runner-child. Nothing else
  spawns `claude`.

## Supervision & recovery

- Kills verify identity (pgid + command match); group kills only (S-13/S-31).
- Heartbeat watchdog (>60s gap ⇒ S-32) and wall-clock timeout watchdog per run.
- Startup sweep: requeue transient rows (S-30), terminate orphans + assemble
  journal-based reports (S-31/S-81, ADR-011 — re-adoption is out of scope),
  quarantine unknown worktrees without deleting them (S-33).
- Single-instance lockfile + port probe; loser exits cleanly (S-80).

## API surface

Loopback-only Fastify: tasks CRUD (+409 optimistic versioning), run-now,
runs/report/cancel, approvals w/ CAS respond, profiles CRUD, FTS `/search`,
`/widget/snapshot` (aggregate-only scope), pause/resume, SSE `/events`.
Static UI served from the same port. Contract tests in
`packages/daemon/test/api.test.ts`.

### Pause (`POST /pause-all` / `POST /resume`)

Pause is enforced by the run manager, not by the API. `RunManager.pump()` is
the only caller of `startRun`, and every path that books work — scheduler
tick, run-now, webhook fire, chain firing, sentinel booking, self-healing,
plan-then-execute — inserts a `'queued'` row and then calls `pump()`. One gate
in `pump()` therefore holds all of them.

- **A paused daemon starts nothing new.** Held rows stay `'queued'` and the
  `/queue` lane reports `reason: 'paused'`.
- **Runs already in flight finish.** Killing a run mid-turn throws away work
  that is already paid for and can leave a half-written worktree behind. This
  is the contract the Settings UI states verbatim: "Queued and future runs
  hold until resumed. Active runs finish."
- **Pause survives a daemon restart.** The flag is a marker file at
  `${dataDir}/paused` (`~/.clockwork/paused`); its presence is the state and
  its `{pausedAt}` body is diagnostics only. `RunManager`'s constructor loads
  it, and `buildServer` wraps `Scheduler.start` so `main.ts`'s unconditional
  `scheduler.start(30_000)` cannot silently un-pause a restarted daemon.
- `/health`, `/widget/snapshot` and `/support/bundle` all report
  `RunManager.isPaused()` — there is no second copy of the flag.
