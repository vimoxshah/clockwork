# Clockwork — Product Specification (H1)

Scope: Horizon 1 (personal agent calendar, Claude-only, local-first). Requirement IDs (FR-xx / NFR-xx) are referenced from `05-execution-plan.md` tasks and `04-scenarios.md`.

---

## 1. Personas (H1)

- **P1 — Solo dev "Asha"**: Claude Max subscriber, 6 side repos, wants overnight chores done. Terminal-fluent, impatient with setup.
- **P2 — Tech lead "Marcus"**: 8-person team, wants recurring hygiene jobs + results in the team chat (Telegram/WhatsApp), needs to trust before delegating.
- **P3 — Platform engineer "Dana"**: already runs `claude -p` in CI, wants a unified pane + HITL + budgets across repos.

## 2. User stories

| ID | Story | Priority |
|---|---|---|
| US-1 | As Asha, I book "update deps + run tests + open PR" against repo X with a $3 cap for a time my machine is awake (or with keep-awake armed / on my always-on mini), and find a report with a PR link when I return. | P0 |
| US-2 | As Asha, I make US-1 recur every Monday 2am and stop thinking about it. | P0 |
| US-3 | As Marcus, when the agent wants to force-push, the run pauses and I get a notification; I approve/deny from the inbox and the run resumes. | P0 |
| US-4 | As Dana, I see every past/future run on one calendar across all repos, with cost per run. | P0 |
| US-5 | As Asha, I chain "triage failing tests" → "fix the top issue" so job 2 consumes job 1's report. | P1 |
| US-6 | As Asha, Clockwork warns me the 2pm job will eat the capacity window I need for afternoon coding, and offers to move it to 11pm. | P1 |
| US-7 | As Marcus, I save "nightly flaky-test triage" as a template and apply it to three repos. | P1 |
| US-8 | As Dana, results also post to our team channel — Telegram directly, or Slack/anything through the webhook adapter. | P1 |
| US-9 | As Asha, my laptop was asleep at 2am; Clockwork applies the job's missed-run policy and tells me what it did. | P0 |
| US-10 | As Marcus, I dry-run a new job (plan-only, no writes) before trusting it on a schedule. | P1 |
| US-11 | As Asha, I book "@dep-surgeon update everything minor" — the **Dep Surgeon** profile loads its skills, model, budget, and permission defaults so I don't re-configure every booking. | P0 |
| US-12 | As Asha, I run on my Claude subscription via `claude -p` — **no API key required, ever** — and it just works with my existing Claude Code login. | P0 |
| US-13 | As Marcus, run results land in my Telegram (and my team's WhatsApp group via our gateway), not just the inbox. | P1 |
| US-14 | As Dana, I search the inbox for "vitest" and instantly find every run that touched it; ⌘K searches everything from anywhere. | P0 |
| US-15 | As Asha, a glanceable desktop widget shows today's runs and the needs-you count without opening the app. | P2 |
| US-16 | As Dana, I don't want to pick a time — I **queue** five refactor chores and Clockwork works through them whenever a slot is free, in the order I set. | P0 |
| US-17 | As Marcus, I create a new agent profile **inside the app** — name it, pick its skills, set its budget — and book it a minute later. | P1 |

## 3. Functional requirements

### 3.1 Task authoring (the composer)

- **FR-1** Create a task from a calendar slot or a "New task" button. A task = **agent profile** (FR-28; selectable, or `@mention`ed in the prompt; provides defaults for everything below), **prompt** (required), **working directory** (required for repo tasks; a "no-repo" mode runs in a scratch dir), **base branch** (repo tasks; default = repo default branch), **model** (from profile, overridable), **permission mode** (`plan` | `acceptEdits` | `default` — `bypassPermissions` is **not offered in H1**; it contradicts the trust story), **budget** (max USD soft cap, max turns, max wall-clock — turns/time are the hard bounds, see FR-10), **schedule** (see FR-4), **overlap policy** (`skip` | `queue`, default `skip` — see S-8), **delivery** (inbox always; OS notification default on; Telegram / WhatsApp-gateway / webhook / email optional — FR-18), **missed-run policy** (`skip` | `run-late` | `ask`, default `run-late` with a staleness window), **retry-on-transient** (default off for tasks with external side effects — see S-89).
- **FR-2** Context attachment: (a) files/globs snapshotted or referenced live (user choice, default live-reference with snapshot for prompt-injected excerpts); (b) URLs (fetched at run time); (c) MCP servers from a per-task allow-list drawn from the user's existing Claude Code MCP config; (d) output of a prior task (chaining, FR-8).
- **FR-3** Templates: save any task as a template (parameterized: repo, schedule, budget); apply template → prefilled composer; export/import as a single JSON file.

### 3.2 Scheduling

- **FR-4** Three scheduling modes: **one-off** (specific datetime, user timezone), **recurring** (RRULE subset: daily/weekly/monthly + custom cron for power users), and **queue/ASAP** (no time at all — the run enters the work queue and starts as soon as a slot and its repo are free; optionally gated on `flexible` capacity). All times stored UTC + IANA zone; DST transitions resolved per `04-scenarios.md` S-20/S-21.
- **FR-5** Manual "Run now" on any task; ad-hoc runs recorded like scheduled ones.
- **FR-6** Concurrency + queue management: global max parallel runs (default 2, configurable); per-repo mutex (two runs never share a repo working tree — enforced via worktrees + repo-level queue); ordering = priority class, then scheduled/enqueued time. **The queue is a first-class UI surface**: a queue lane shows waiting items with position and reason ("waiting for slot" / "waiting for repo" / "waiting for capacity"); items can be drag-reordered, bumped to front, or cancelled; "Run now" jumps the queue but never breaks a repo mutex. Queued items appear on the calendar as an unscheduled tray, not fake time slots.
- **FR-7** Capacity assistant (M3, **feature-flagged, estimate-grade**): model subscription window usage heuristically from run telemetry; render forecast band labeled "estimate"; warn on booking into a predicted-exhausted window; auto-shift for `flexible` tasks only behind the flag. Ships in v1 **only** if beta precision ≥70% on collision warnings (R-7); otherwise cut without ceremony.
- **FR-8** Chaining (M2): **linear chains only in H1** — task B declares `after: task A` with `on: success | always | failure`; a task has at most one predecessor; cycles rejected at save. B's prompt can reference `{{previous.report}}` / `{{previous.artifacts}}`, bound to the exact triggering run id. DAG fan-in/fan-out is H2 scope (S-76).

### 3.3 Execution

- **FR-9** Runs execute through the `AgentRunner` interface in a dedicated **git worktree** (repo tasks) or scratch directory (no-repo tasks). The main working tree is never touched. **Two engines ship (ADR-016):**
  - **`ClaudeCliRunner` — the default.** Headless Claude Code (`claude -p --output-format stream-json`) riding the user's **existing Claude Code subscription login — no API key required.** Usage/turn telemetry from the stream-json events; permission escalation via the CLI's permission-prompt MCP hook; per-run skills/agents injected via the worktree's `.claude/` config (FR-28).
  - **`ClaudeSdkRunner` — configurable option** (global setting or per-profile) for API-key users who want the richer programmatic surface.
  - Engine capabilities are feature-detected, not assumed: the Phase 0 contract matrix records what each engine supports (usage granularity, HITL mechanics, structured output), and the UI degrades honestly (e.g., if the CLI can't stream cost, the budget meter shows turns/time only).
- **FR-10** Every run enforces: wall-clock timeout (SIGTERM → grace → SIGKILL; platform-appropriate process-group/Job-Object supervision), max-turns (hard), and max-cost — a **soft cap with bounded overshoot**: usage telemetry is per-message, so the stop lands after the in-flight message; overshoot is measured in Phase 0 (T-001) and surfaced in the report. Under subscription auth (no dollar meter), turns/time are the operative bounds and the UI says so.
- **FR-11** Permission model — two distinct layers, honestly labeled:
  - **Containment (the security boundary): OS sandbox per run** (FR-26). What a run *cannot* do is enforced by the OS, not by pattern-matching.
  - **Policy (UX layer): SDK permission mode per task + a deny-list** for obviously-dangerous commands (force-push to protected branches, package publish, credential-path reads). The deny-list improves ergonomics and surfaces intent; it is *not* claimed to stop an adversarial prompt — the sandbox is.
- **FR-12** HITL (M2): when the SDK surfaces a permission request outside the task's auto-allow set — or the agent asks a question — the run transitions to `waiting_approval` with the **runner process kept alive** (callback held open; the process is idle-cheap). State + question are persisted so the inbox survives daemon restarts; if the runner dies while waiting, the fallback is a documented fresh-session resume with the decision injected (decided at T-003). Approval timeout (default 4h) → configurable fallback (`deny-and-continue` | `abort`).
- **FR-13** Run lifecycle states: `scheduled → queued → preparing → running → waiting_approval → finalizing → completed | failed | cancelled | budget_exceeded | timed_out | missed | awaiting_user` (missed-policy `ask`). Transitions persisted synchronously (crash-safe; see S-30..S-34).
- **FR-14** Cancellation: user can cancel `queued`/`running`/`waiting_approval` runs from UI; graceful stop, worktree preserved for inspection per retention policy.

### 3.4 Results & review

- **FR-15** Run Report per run: outcome, human-readable summary (agent-authored, structured-output-forced), diff stat + link to branch, artifacts list (files the agent nominated + anything under `artifacts/`), full transcript (collapsible), token/cost breakdown, duration, all approvals asked/answered.
- **FR-16** Inbox: reverse-chron run reports; unread badges; filters (task, repo, outcome); mark-read; deep-link from notifications.
- **FR-17** Repo-task outputs land as a **branch** (`clockwork/<task-slug>/<run-id>`) — never direct commits to the user's branch; report links the branch and (optional per task) opens a draft PR via `gh`.
- **FR-18** Delivery through a pluggable **`DeliveryChannel` adapter interface** (daemon-side, creds in OS keychain, never runner-visible): OS notification (always available); **Telegram** (bot token + chat id — the simplest chat channel, M2); **WhatsApp via a user-configured gateway** (Meta Cloud API, Twilio, or self-hosted bridge — Clockwork speaks to the gateway, never implements WhatsApp itself, M3); **generic webhook** (HMAC-signed JSON POST — fronts Slack, Discord, ntfy, or anything else, M3); email via user-supplied SMTP (M3). Per-task channel selection with global defaults. Delivery failures never fail the run (S-43); every channel gets the same Run Report payload schema.
- **FR-19** Retention: transcripts + worktrees pruned by policy (default: worktrees of successful runs deleted after 7 days; failed runs kept 30; reports kept forever; all configurable).

### 3.5 App & platform

- **FR-20** Daemon runs as a **login-session service** (launchd LaunchAgent / systemd --user / Windows autostart+Job supervision): starts at login, restarts on crash, independent of the UI window. It does **not** run while logged out or while the machine sleeps — Clockwork never claims otherwise (S-10, FR-25). Tray/menubar shows daemon health + next 3 runs + pause-all. A single-instance lock prevents duplicate daemons (S-80).
- **FR-25** Execution/power model: the composer shows a machine-availability hint for the chosen slot; a **keep-awake window** (OS power assertion, opt-out, only-when-plugged-in by default) arms before scheduled runs; scheduled-wake is attempted where the OS allows it without privileges; sleep-caused misses produce loud, actionable notifications ("ran late / skipped because the machine slept"). Marketing and onboarding state the awake-machine constraint plainly and recommend an always-on machine for true overnight jobs.
- **FR-26** OS sandbox containment: every run executes inside an OS-level sandbox (macOS Seatbelt profile; Linux bubblewrap; Windows post-v1 equivalent) whose filesystem allowlist is: the run's worktree/scratch dir (rw), the repo (ro where feasible), the toolchain, and an explicit user-configured context-roots list (ro). Credential paths (`~/.ssh`, `~/.aws`, keychains, browser profiles) are excluded by default. Network egress is permitted (the agent needs Anthropic + package registries) but the sandbox profile is versioned, auditable, and shipped with the app. Sandbox violations are logged to the local safety journal (FR-27).
- **FR-27** Safety journal: an always-on, local-only, append-only log of deny-list hits, sandbox violations, budget hard-stops, and approval decisions; surfaced in settings; exportable; feeds the one-click anonymized incident report.
- **FR-28** **Agent profiles** — a profile is a named, reusable agent persona: display name + color/avatar, **skill set** (Claude Code skills/subagents materialized into the run worktree's `.claude/` config so they load for that run), model, permission mode, budget defaults, MCP allow-list, context roots, delivery preferences, and optional system-prompt addition. Booking selects a profile explicitly **or by `@mention` in the prompt** (`@dep-surgeon update everything minor`). Runs display their profile identity everywhere (calendar, inbox, reports, approvals). M1 ships three built-ins (**Generalist**, **Dep Surgeon**, **Docs Scribe**) — **and their skills ship with the app**: a versioned, curated **bundled skill pack** (`resources/skill-pack/`, e.g. `dependency-triage`, `test-doctor`, `docs-writer`) that installs nothing globally and is materialized per-run like any profile skill. The pack updates with app releases (a profile references skills by name@version, so an app update never silently changes a scheduled run's behavior — the profile pins until the user accepts the bump). Custom profiles may also reference the user's own skills (`~/.claude/skills`, repo `.claude/skills`). **Profiles are created and edited entirely in-app** (M2): the composer's "＋ New profile" opens the profile editor — name + @handle + color/glyph, skill picker (bundled pack ∪ user skills ∪ repo skills, with per-skill descriptions), engine/model, permission mode, budget defaults, MCP allow-list, context roots, delivery prefs — with **duplicate-a-built-in** as the fastest path. No config files required, though power users can still drop skill folders. Profiles are exportable/importable like templates (same disabled-on-import security rule, S-74).
- **FR-29** **Search everywhere**: SQLite FTS5 index over task names, prompts, report summaries, transcript text, branch names, and profile names. Surfaces: inbox search box (M1), a global **⌘K command palette** (M2) that searches tasks/runs/templates/profiles/approvals and executes quick actions ("book run", "pause all"), and calendar filter-by-search. Index updates on report finalize; search is local-only like everything else.
- **FR-30** **Widgets** (glanceable, no-window surfaces): (a) **Clockwork Mini** — a compact always-on-top desktop widget window (Tauri, cross-platform: today's runs, needs-you count, next run countdown), M3; (b) **native macOS WidgetKit widget** (Notification Center / desktop) via a small Swift companion reading a shared read-only snapshot — post-v1, since it requires a native extension target. The menubar popover remains the primary no-window surface.
- **FR-21** First-run onboarding: detect Claude Code install + auth; detect MCP config; create sample task ("tomorrow 9am: summarize my repo's open TODOs") in one screen.
- **FR-22** Auth: reuse the user's existing Claude Code credentials (subscription OAuth or `ANTHROPIC_API_KEY`); Clockwork stores nothing beyond a pointer; auth-expiry surfaces as actionable notification (S-40).
- **FR-23** Settings: defaults (model, budgets, permission mode), concurrency, quiet hours (no notifications, runs still fire), retention, capacity plan type.
- **FR-24** Full functionality offline except the agent call itself; UI reads/writes SQLite locally; no Clockwork account, no telemetry without opt-in.

## 4. Non-functional requirements

- **NFR-1 Reliability**: a scheduled run fires within 60s of its time when machine awake; missed-run detection within 120s of wake. Daemon crash never loses task definitions or completed reports (WAL + synchronous commits at state transitions).
- **NFR-2 Safety**: containment is layered and honestly described — (1) OS sandbox = the security boundary against a misbehaving/prompt-injected agent (FR-26); (2) worktree isolation = accident isolation for the user's repo state (not a security claim); (3) deny-list + permission modes = policy ergonomics. The sandbox and the credential-path exclusions cannot be disabled per-task — only globally, behind an explicit multi-step "I understand" flow.
- **NFR-3 Performance**: UI cold start <2s; calendar renders 5,000 historical runs <500ms (indexed queries + windowed fetch); daemon idle CPU <0.5%, RSS <150MB.
- **NFR-4 Privacy**: no Clockwork-hosted cloud and no Clockwork account. Data leaves the machine only via: the Anthropic API (prompts/context — inherent to running an agent), deliveries the user configures (Telegram / WhatsApp gateway / webhooks / SMTP), update-check (disable-able), and — beta builds only — consent-screened structure-only telemetry. Never claim "code never leaves your machine"; claim "it goes only where you pointed it."
- **NFR-5 Portability**: macOS 13+ (Apple Silicon first) through v1; Windows 11 and Ubuntu 22+ as first post-v1 releases; single codebase throughout.
- **NFR-6 Upgradability**: SQLite schema migrations forward-only with backup-on-migrate; daemon and UI version-handshake (S-50).

## 5. MVP cut-line (M1 — what we ship first)

**In:** FR-1 (chat channels deferred), FR-2a only (file attachment), FR-4, FR-5, FR-6, **FR-9 (`ClaudeCliRunner` only — the SDK engine lands M2)**, FR-10, FR-11, FR-13, FR-14, FR-15, FR-16, FR-17 (branch only, no auto-PR), FR-20, FR-21, FR-22, FR-24, **FR-25 (keep-awake + honest miss handling), FR-26 (sandbox — alpha gate blocker), FR-27 (safety journal), FR-28-lite (3 built-in profiles, @mention + selector), FR-29-lite (inbox FTS search)**. macOS only.
**Out (M2/M3/post-v1):** HITL resume (M2 — in M1, permission-blocked runs fail safe with a clear report), SDK engine option (M2), profile editor/custom profiles (M2), ⌘K palette (M2), Telegram (M2), chaining, templates, capacity assistant, WhatsApp-gateway/webhook/email (M3), Clockwork Mini widget (M3), WidgetKit + Windows/Linux (post-v1), auto-PR, URL/MCP context.
**Rationale:** M1 must prove the loop end-to-end (book → unattended run → trustworthy report) — everything else is leverage on a proven loop.

## 6. Anti-requirements (explicit non-goals for H1)

- No cloud execution, no Clockwork accounts, no server-side anything.
- No agent-loop code of our own (no custom tool-use loop, no prompt-chain framework).
- No multi-vendor runners (interface yes, implementation no).
- No editing agent transcripts / "steering" mid-run beyond approve/deny/answer — that's a chat app, not a calendar.
- No attempt to schedule *interactive* sessions — Clockwork owns unattended work only.
