# Clockwork — Architecture (H1)

Three local processes with hard boundaries. No cloud. SQLite is the single source of truth; the daemon is the single writer for run state.

```
┌───────────────────────────────────────────────────────────────┐
│  UI — Tauri 2 shell + React                                   │
│  Calendar · Composer · Inbox · Approvals · Settings · Tray    │
│  (stateless: renders daemon API responses; no direct DB write │
│   for run state; direct read-only SQLite for history queries) │
└──────────────┬────────────────────────────────────────────────┘
               │ HTTP + SSE, 127.0.0.1:<port>, bearer token
┌──────────────┴────────────────────────────────────────────────┐
│  DAEMON — Node.js 22, installed as user service               │
│  ┌─────────────┐ ┌──────────────┐ ┌───────────────────────┐   │
│  │ Scheduler    │ │ Run manager  │ │ API server (Fastify)  │   │
│  │ tick loop +  │ │ queue, locks,│ │ REST + SSE events     │   │
│  │ RRULE expand │ │ lifecycle FSM│ │                       │   │
│  └─────────────┘ └──────┬───────┘ └───────────────────────┘   │
│  ┌─────────────┐ ┌──────┴───────┐ ┌───────────────────────┐   │
│  │ Capacity     │ │ Notifier     │ │ SQLite (WAL) + Drizzle│   │
│  │ model (M3)   │ │ OS/chat/hook │ │ migrations            │   │
│  └─────────────┘ └──────────────┘ └───────────────────────┘   │
└──────────────┬────────────────────────────────────────────────┘
               │ spawn per run (child process, own pgid)
┌──────────────┴────────────────────────────────────────────────┐
│  RUNNER — Node.js child process (one per run)                 │
│  AgentRunner engine: ClaudeCliRunner (default — headless      │
│  `claude -p`, subscription login, no API key) OR              │
│  ClaudeSdkRunner (opt-in) · profile materializer (.claude/)   │
│  · worktree lifecycle · budget guard · deny-list hooks        │
│  · report serializer · heartbeat to daemon                    │
└───────────────────────────────────────────────────────────────┘
```

**Why three processes** (not UI-embedded): scheduled execution must survive UI close, login/logout, and crashes independently (per-boundary rationale in DECISIONS ADR-002). The runner is a separate child so a hung/OOM'd agent run can be killed by pgid without touching the daemon, and a daemon restart can re-adopt or reap orphaned runners (S-31).

---

## 1. Data model (SQLite, Drizzle-managed; abridged DDL)

```sql
-- An agent profile is a reusable persona: skills, model, permissions, budgets.
CREATE TABLE profiles (
  id            TEXT PRIMARY KEY,          -- ulid; 3 built-ins seeded at install
  slug          TEXT NOT NULL UNIQUE,      -- @mention handle, e.g. 'dep-surgeon'
  name          TEXT NOT NULL, color TEXT, avatar TEXT,
  engine        TEXT NOT NULL DEFAULT 'cli',   -- cli | sdk (ADR-016)
  model         TEXT, permission_mode TEXT,
  budget_usd REAL, max_turns INTEGER, timeout_sec INTEGER,
  skills_json   TEXT NOT NULL DEFAULT '[]',    -- skills/subagents materialized into run .claude/
  mcp_allow_json TEXT NOT NULL DEFAULT '[]',
  context_roots_json TEXT NOT NULL DEFAULT '[]',
  system_prompt_extra TEXT,
  delivery_json TEXT,
  builtin       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

-- A task is the definition; a run is one execution of it.
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,          -- ulid
  name          TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  profile_id    TEXT REFERENCES profiles(id),  -- resolved from selector or @mention
  repo_path     TEXT,                      -- NULL = scratch/no-repo task
  model         TEXT,                      -- NULL = inherit from profile
  permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
  budget_usd    REAL NOT NULL DEFAULT 2.0,
  max_turns     INTEGER NOT NULL DEFAULT 50,
  timeout_sec   INTEGER NOT NULL DEFAULT 3600,
  base_branch   TEXT,                        -- repo tasks; NULL = repo default branch
  context_json  TEXT NOT NULL DEFAULT '[]',   -- attachments: files/urls/mcp/chain refs
  delivery_json TEXT NOT NULL DEFAULT '{}',
  missed_policy TEXT NOT NULL DEFAULT 'run-late', -- skip|run-late|ask
  missed_window_sec INTEGER NOT NULL DEFAULT 21600,
  overlap_policy TEXT NOT NULL DEFAULT 'skip',    -- skip|queue (S-8)
  retry_on_transient INTEGER NOT NULL DEFAULT 0,  -- off by default (S-89)
  flexible      INTEGER NOT NULL DEFAULT 0,  -- capacity auto-shift opt-in (flagged)
  chain_after   TEXT REFERENCES tasks(id),   -- H1: linear chains, single parent
  chain_on      TEXT DEFAULT 'success',      -- success|always|failure
  template_id   TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  deleted_at    INTEGER,                     -- soft delete (S-6)
  created_at    INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE schedules (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                 -- once|rrule|cron
  rrule      TEXT,                          -- iCal RRULE string
  cron       TEXT,
  run_at     INTEGER,                       -- for 'once' (UTC epoch)
  tz         TEXT NOT NULL,                 -- IANA zone for expansion
  next_fire  INTEGER,                       -- materialized next occurrence (UTC)
  enabled    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_schedules_next ON schedules(enabled, next_fire);

-- THE double-fire guard: every recurring occurrence is claimed exactly once,
-- in the same transaction that inserts its run row (review finding #14).
CREATE TABLE schedule_occurrences (
  schedule_id   TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  occurrence_at INTEGER NOT NULL,           -- the nominal fire instant (UTC)
  run_id        TEXT,                       -- NULL if coalesced/skipped/missed
  disposition   TEXT NOT NULL,              -- fired|coalesced|skipped|missed
  claimed_at    INTEGER NOT NULL,
  PRIMARY KEY (schedule_id, occurrence_at)
);

CREATE TABLE runs (
  id           TEXT PRIMARY KEY,            -- ulid
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  occurrence_at INTEGER,                    -- NULL for run-now; FK-pair into schedule_occurrences
  schedule_id  TEXT,
  jobspec_json TEXT NOT NULL,               -- frozen snapshot of task def at enqueue (S-5)
  state        TEXT NOT NULL,               -- FSM below
  state_changed_at INTEGER NOT NULL,
  worktree_path TEXT, branch TEXT,
  session_id   TEXT,                        -- SDK session ref
  pid          INTEGER, pgid INTEGER, proc_started_at INTEGER, -- identity-verified reaping (pid reuse guard)
  journal_path TEXT,                        -- runner's on-disk progress journal
  transcript_path TEXT,                     -- transcripts live on disk, never as DB blobs
  heartbeat_at INTEGER,
  cost_usd     REAL DEFAULT 0, turns INTEGER DEFAULT 0,
  started_at   INTEGER, ended_at INTEGER,
  outcome_reason TEXT,                      -- budget_exceeded|timed_out|orphaned|...
  report_json  TEXT                         -- Run Report SUMMARY + pointers (big payloads on disk)
);
CREATE INDEX idx_runs_state ON runs(state);
CREATE INDEX idx_runs_task_time ON runs(task_id, scheduled_for);

CREATE TABLE approvals (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id),
  kind       TEXT NOT NULL,                 -- permission|question
  payload_json TEXT NOT NULL,               -- what's being asked
  requested_at INTEGER NOT NULL,
  responded_at INTEGER, response_json TEXT,
  timeout_at INTEGER NOT NULL, fallback TEXT NOT NULL -- deny-and-continue|abort
);

CREATE TABLE capacity_samples (              -- M3: telemetry for window model
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL, window_kind TEXT, used_pct REAL, source TEXT
);

CREATE TABLE events (                        -- append-only audit trail
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL, run_id TEXT, kind TEXT NOT NULL, data_json TEXT
);

-- Search-everywhere (FR-29): FTS5 over the read surfaces; updated on finalize.
CREATE VIRTUAL TABLE search_idx USING fts5(
  kind,            -- task|run|template|profile|approval
  ref_id UNINDEXED,
  title, body,     -- name+prompt / summary+transcript-text / etc.
  tokenize='porter unicode61'
);
```

Write discipline: **daemon is the only writer** for `runs`/`approvals`/`schedule_occurrences`/`schedules.next_fire`; runners report via IPC (not direct DB); UI writes only `tasks`/`schedules` definitions **through the daemon API** (so validation + next_fire materialization happen in one place; task edits use optimistic versioning to prevent lost updates, S-82). UI may open the DB read-only for fast history rendering.

Durability: WAL mode with `synchronous=FULL` for state-transition and occurrence-claim transactions (correctness beats write latency at this volume); large payloads (transcripts, artifacts, full reports) live on disk under `~/.clockwork/runs/<run-id>/` — the DB stores summaries and pointers only.

## 2. Run lifecycle FSM

```
scheduled ──(next_fire due)──▶ queued ──(slot+repo lock free)──▶ preparing
  │                                                                │ worktree created,
  │ (machine asleep past window)                                   │ context assembled
  ▼                                                                ▼
missed ──(policy: run-late)──▶ queued                           running ◀──────────┐
     └──(policy: ask)──▶ ask_user                                  │               │
                                                                   ├─(SDK permission│
                                                                   │  needs human)  │
                                                                   ▼               │
                                                            waiting_approval ──────┘
                                                                   │ (approve/deny/answer; runner process stays
                                                                   │  ALIVE holding the callback — keep-alive model;
                                                                   │  runner death while waiting → documented
                                                                   │  fresh-session fallback, decided at T-003)
running ──▶ finalizing ──▶ completed | failed | cancelled | budget_exceeded | timed_out
                │ report serialized, branch pushed nowhere (local), notifications sent,
                │ worktree retained per policy, chain successors enqueued
```

Every transition = one synchronous SQLite write + one `events` row + one SSE broadcast. Crash between any two steps is recoverable by re-reading state (see S-30..S-34 in `04-scenarios.md`).

## 3. The Runner contract (multi-vendor-ready interface)

```ts
interface AgentRunner {
  /** Execute one job to completion or interruption. Must be resumable. */
  start(job: JobSpec, io: RunnerIO): Promise<RunOutcome>;
  resume(sessionRef: string, decision: ApprovalDecision, io: RunnerIO): Promise<RunOutcome>;
  cancel(sessionRef: string): Promise<void>;
}
interface RunnerIO {
  onUsage(u: {costUsd: number; turns: number}): void;      // budget guard hook
  onPermissionRequest(p: PermissionRequest): Promise<Decision | 'ESCALATE'>; // deny-list floor, then task allow-set, then ESCALATE→HITL
  onHeartbeat(): void;
  onArtifact(path: string): void;
}
```

Two implementations ship behind the interface (ADR-016) — the seam ADR-007 designed for multi-vendor pays off immediately, vendor-internally:

- **`ClaudeCliRunner` (default).** Spawns headless Claude Code: `claude -p <prompt> --output-format stream-json --permission-mode <mode> --max-turns <n>` inside the sandboxed worktree. Rides the machine's **existing Claude Code subscription login — no API key**. Usage/cost/turn telemetry parsed from stream-json events → `onUsage`; permission escalation via the CLI's permission-prompt MCP hook (a tiny local MCP server the runner exposes) → `onPermissionRequest`; session id captured from the stream for `resume` (`claude -p --resume <id>`). **Profile materialization:** before launch, the runner writes the profile's skills/subagents/system-prompt-extra into the worktree's `.claude/` directory (and `--append-system-prompt`), so the booked profile's skill set loads for exactly that run — no global config mutation.
- **`ClaudeSdkRunner` (opt-in, global setting or per-profile).** Wraps `@anthropic-ai/claude-agent-sdk` `query()` with `canUseTool` → `onPermissionRequest`, message-stream usage accounting → `onUsage`, and session persistence → `resume`. For API-key users and the richer programmatic surface.

Engine capabilities are **feature-detected at Phase 0 and recorded in the contract matrix per engine** (usage granularity, HITL hold semantics, resume fidelity, structured output); the daemon reads the matrix at runtime and the UI degrades honestly per engine. Nothing outside the runner package may import the SDK **or** spawn `claude`.

HITL semantics (post-review): `canUseTool` is an in-process pending callback — the **primary approval model keeps the runner process alive** through `waiting_approval` (idle process, near-zero cost), answering the callback when the human decides. `resume(sessionRef, decision)` is the **fallback** for runner-death-while-waiting, and restarts the turn with the decision injected rather than resuming mid-tool-call; its fidelity is verified (or the fallback re-designed) at T-003 before any product code depends on it. The runner also writes an on-disk **progress journal** (`journal_path`) so a report can be assembled even if the process dies.

## 4. Scheduler design

- **Tick loop, not OS cron**: daemon wakes every 30s and runs `SELECT … WHERE next_fire <= now AND enabled` — plus subscribes to OS wake/power events (macOS `caffeinate`-style IOKit notifications via a small helper; systemd `PrepareForSleep`; Windows power broadcasts) to trigger an immediate catch-up sweep on wake (S-10).
- **next_fire materialization**: on task save and after each fire, expand RRULE in the schedule's IANA zone → store UTC. DST rules: nonexistent local time → fire at the post-transition instant; ambiguous local time → first occurrence (documented; S-20/S-21).
- **Fire = one transaction**: claim the occurrence (`INSERT INTO schedule_occurrences` — the PK makes double-fire impossible even across crash/restart races), insert the run row with the frozen JobSpec snapshot, advance `next_fire`. Crash at any point either committed all three or none (finding #14).
- **Missed detection**: on every tick and on wake, any unclaimed occurrence older than grace(120s) is claimed with disposition `missed` → policy applied. Recurring tasks never "pile up": catch-up runs **at most one** instance per schedule regardless of how many occurrences were slept through; the covered occurrences are claimed as `coalesced` (S-11).
- **Queue discipline**: global semaphore (default 2) + per-repo mutex. Priority = scheduled_for asc; `run-now` jumps queue but respects locks.

## 5. Worktree & repo strategy

- Worktree at `~/.clockwork/worktrees/<task-slug>/<run-id>`, branch `clockwork/<task-slug>/<run-id>` cut from the task's configured base branch (default: repo's default branch, **fetched first if remote configured**; falls back to local HEAD offline — recorded in report).
- Dirty main tree is irrelevant by construction; dirty *base branch on remote* is the user's normal flow.
- Repo-level advisory lock file + DB mutex prevents two Clockwork runs sharing a repo concurrently (git worktree add is safe, but npm installs etc. contending for global caches are not worth the flake risk at default concurrency 2).
- Repo-managed git hooks are **disabled by default inside Clockwork worktrees** (per-worktree `core.hooksPath` override; configurable per task) — a scheduled unattended run silently executing a repo's pre-commit stack is surprise, not safety (S-84). Submodules/LFS: fetched only if the task opts in; otherwise documented as present-but-not-initialized (S-85).
- Cleanup: `git worktree remove --force` + branch retained; prune per FR-19 retention. Orphaned worktrees from crashes are reconciled at daemon start by directory-scan vs DB (S-33).

## 6. API surface (daemon ⇄ UI)

REST (localhost, bearer token generated at install, stored `0600`):
`GET/POST/PATCH /tasks` · `POST /tasks/:id/run-now` · `GET /runs?filter` · `POST /runs/:id/cancel` · `GET /runs/:id/report` · `POST /approvals/:id/respond` · `GET/POST/PATCH /profiles` · `GET /search?q=` (FTS5, kind-filterable — powers inbox search, ⌘K, calendar filter, and the widgets) · `GET /widget/snapshot` (compact today-view for Mini/WidgetKit) · `GET /capacity/forecast` · `GET /health` · `POST /pause-all`.

**Delivery adapters** (daemon-side `DeliveryChannel` interface — `send(report, channelConfig)`): `os-native` · `telegram` (Bot API) · `whatsapp-gateway` (POST to a user-configured gateway URL: Meta Cloud API, Twilio, or self-hosted bridge — Clockwork never implements WhatsApp itself) · `webhook` (HMAC-signed JSON — fronts Slack/Discord/ntfy/anything) · `smtp`. One payload schema for all channels; creds in OS keychain; failures retried ×3 and reported in the run footer, never failing the run (S-43).

**The gateway pattern is the local-bridge mechanism** (same shape as Hermes/OpenClaw-style personal gateways): a gateway is any HTTP endpoint — **including `http://127.0.0.1:<port>` for a self-hosted bridge running as its own LaunchAgent/service on the same machine** — that accepts the signed Run Report payload and relays it to the messaging platform under the user's own account/session. Clockwork's contract stops at the POST: payload schema + HMAC signature + retry semantics; the bridge owns platform auth, session state, and delivery. This keeps messaging-platform ToS/compliance entirely in the user's bridge, and means an existing personal WhatsApp/Telegram gateway plugs in with zero Clockwork changes. **H2 note:** the same mechanism runs in reverse for chat-based approvals — the bridge POSTs inbound replies ("approve", "deny", an answer) to a daemon endpoint (`POST /approvals/:id/respond` with a channel-scoped token), so approving from WhatsApp/Telegram reuses the identical gateway contract rather than a new integration.
SSE `/events`: `run.state_changed`, `approval.requested`, `report.ready`, `daemon.health`. UI is a pure client; anything scriptable via this API is scriptable by users too (deliberate — power users get a CLI for free later).

## 7. Security model (H1) — layered, honestly labeled (rewritten after review round 1)

1. **Containment = OS sandbox (FR-26).** Each runner executes inside a per-run OS sandbox (macOS Seatbelt profile; Linux bubblewrap): FS allowlist = worktree/scratch (rw) + repo (ro) + toolchain + configured context-roots (ro); credential paths (`~/.ssh`, `~/.aws`, keychains, browser profiles) excluded; profile versioned and shipped. This — not pattern matching — is what bounds a prompt-injected agent.
2. **Policy = deny-list + permission modes (FR-11).** Ergonomic guardrails (force-push protection, publish blocking) that shape normal behavior and surface intent. Explicitly *not* claimed to stop adversarial inputs; findings logged to the safety journal (FR-27).
3. **Runner hygiene.** Runner spawns with a **sanitized environment** (only SDK-required vars); it never receives the UI bearer token, delivery credentials (Telegram/gateway/webhook/SMTP), or keychain access — deliveries are performed by the daemon after run completion. Runner⇄daemon IPC is a per-run unix socket with a single-run nonce.
4. **Secrets**: Clockwork stores no Anthropic credentials (pointer to the user's existing auth only); delivery creds (Telegram bot token, gateway keys, webhook secrets, SMTP) in OS keychain, never SQLite, never runner-visible.
5. **Local API**: loopback-only + bearer token (0600); no CORS; UI token injected by Tauri at spawn; token rotated on daemon reinstall.
6. **Supervision identity**: kills/reaps verify (pid, pgid/Job Object, process-start-time) triples — never bare pids (pid-reuse guard). Windows uses Job Objects (post-v1).
7. **Prompt-injection stance (documented, not solved)**: attached URLs/files are untrusted input; the sandbox + budgets bound the damage; `plan`-mode dry-run exists for exactly this; imported templates arrive disabled (S-74); H2 investigates content-sandboxing. We never market this as solved.

## 8. Sequence — the happy path (US-1)

1. UI `POST /tasks` (schedule once, tomorrow 02:00, tz local) → daemon validates, materializes `next_fire`, stores.
2. 02:00 tick: scheduler moves occurrence → `queued`; run manager acquires slot + repo lock → `preparing`.
3. Runner child spawned: fetch base branch → `git worktree add` → assemble context (snapshot excerpts, live refs) → SDK `query()` with budget/permission hooks → heartbeats every 15s.
4. Agent finishes; runner emits Run Report JSON (summary is SDK structured output; diffstat computed by runner; cost from usage telemetry) → daemon `finalizing`: persist report, release locks, schedule next RRULE occurrence, notify OS notification → `completed`.
5. 08:30: user clicks notification → inbox deep-link → report → "Open branch in editor" / "Create PR".

Failure paths for every step: `04-scenarios.md` §S-30–S-45.
