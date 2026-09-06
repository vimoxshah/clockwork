# Clockwork — Decision Log

ADR-style, append-only. Format: Decision → Context → Alternatives rejected → Why → Consequence. New entries at the bottom; never rewrite an accepted entry — supersede it.

---

## ADR-001 — Product shape: schedule-first calendar, not observability dashboard
**Decision:** Clockwork's primary object is the *future run* (a booking); history rendering is secondary.
**Context:** AgentCalendar proved demand but is observability-first (visualize past sessions, queue on capacity reset).
**Alternatives rejected:** (a) Fork/extend AgentCalendar — MIT allows it, but its architecture centers on log collection, not authoring/execution; the hard parts we need (composer, FSM, HITL) don't exist there. (b) Observability-first with scheduling later — repeats their shallow-scheduling trap.
**Why:** The unclaimed position is "book agents like contractors"; booking implies composer + executor + inbox as the spine.
**Consequence:** We build an execution engine (harder), and log-collection interop (reading Claude Code session history for the capacity model) is a *feature*, not the foundation.

## ADR-002 — Three-process split: UI / daemon / per-run runner
**Decision:** Scheduler daemon is a user-level service independent of the UI; each run is a separate child process (own pgid).
**Alternatives rejected:** UI-embedded scheduler (dies with the window — breaks the core promise); daemon-inline runs (a hung run or SDK OOM takes down the scheduler; can't kill by pgid safely).
**Why:** S-60 ("closed for a week, everything ran") *is* the product. Crash isolation per run enables S-31 orphan adoption.
**Consequence:** IPC + service-install complexity accepted; `clockworkd doctor` exists because service debugging is now a user-facing concern.

## ADR-003 — SQLite as single source of truth; daemon as single writer for run state
**Decision:** One WAL-mode SQLite DB; UI writes definitions only via daemon API; runners report via IPC, never direct DB.
**Alternatives rejected:** UI direct-writes (validation and next_fire logic duplicated); per-run JSON files (no transactional FSM); Postgres (infra for a local app).
**Why:** Crash-safe FSM transitions need transactions + a single serialization point.
**Consequence:** Daemon API is mandatory even for local UI; read-only DB access allowed for history queries as a pragmatic exception.

## ADR-004 — Claude Agent SDK as the entire execution engine
**Decision:** No custom agent loop; the SDK's `query()`, permission callbacks, sessions, and usage telemetry are the engine.
**Alternatives rejected:** Raw Messages API + custom tool loop (months, and we'd rebuild permissions badly); shelling `claude -p` (no programmatic permission callbacks / streaming usage — kills HITL and budget caps).
**Why:** The differentiation is scheduling + trust + review UX, not agent internals.
**Consequence:** SDK capability assumptions become existential (risk R-2/R-3) → Phase 0 verifies each; SDK pinned; all SDK contact confined to `packages/runner`.

## ADR-005 — Time model: tick loop + materialized next_fire + wake-event sweeps
**Decision:** 30s DB-driven tick loop with `next_fire` materialization; OS sleep/wake hooks trigger catch-up; missed occurrences coalesce to at most one catch-up run.
**Alternatives rejected:** OS cron/launchd timers per task (unmanageable at N tasks, no queue/mutex semantics, hostile to policy logic); long-armed setTimeout (drifts, dies on sleep).
**Why:** Laptops sleep. The product's credibility = deterministic behavior across sleep/DST/clock-jump (S-10…S-25).
**Consequence:** Scheduler is custom code with a heavy fixture suite — the deepest-tested module in the codebase.

## ADR-006 — Isolation: git worktree per run; output as branch, never direct commits
**Decision:** Every repo run gets a fresh worktree + `clockwork/<task>/<run>` branch; main working tree untouchable by construction.
**Alternatives rejected:** Running in the user's tree (one dirty-state collision destroys trust forever); full repo clones (slow, disk-hungry); containers (heavyweight for H1; revisit for content-sandboxing H2).
**Why:** NFR-2's "guaranteed by construction" beats any behavioral promise.
**Consequence:** Repo-level mutex + reconciliation logic required; non-git tasks get scratch dirs.

## ADR-007 — `AgentRunner` interface from day 0; exactly one implementation in H1
**Decision:** Multi-vendor seam (start/resume/cancel + IO callbacks) is structural now; Codex/Gemini implementations wait for H3.
**Alternatives rejected:** Hardcode SDK calls throughout (cheap now, rewrite later); build 2+ runners now (breadth before the loop is loved — the AgentCalendar mistake).
**Why:** Interface cost ≈ zero now; migration cost later ≈ months. Also cleanly bounds R-2 (SDK churn) into one package.
**Consequence:** Some SDK-specific richness must be generalized through the interface; where it can't be (session semantics), the interface documents Claude-specific contracts explicitly.

## ADR-008 — Deny-list floor is global-only, never per-task
**Decision:** The blast-radius floor (force-push protected branches, credential-path reads, writes outside worktree) cannot be relaxed per task; global override requires a deliberately scary settings flow.
**Alternatives rejected:** Per-task overrides (one convenient checkbox = the trust incident that kills the category, R-4).
**Why:** Users under deadline pressure will click through per-task warnings; making the unsafe path *annoying and global* is the honest design.
**Consequence:** Some legitimate power-user workflows are friction-full in H1; acceptable trade.

## ADR-009 — Source-available core; paid Pro features; local-first with no accounts in H1
**Decision:** Core app source-available (license TBD: FSL/BUSL-style or MIT core + closed Pro — finalize before public beta); no Clockwork accounts or cloud until H2 relay.
**Alternatives rejected:** Fully closed (a closed daemon running autonomous agents on your machine fails the HN trust test); fully MIT everything (funds nothing; AgentCalendar occupies the free-tool slot already).
**Why:** Trust is the adoption gate; revenue needs a gate too. Source-available + paid convenience is the proven middle (see: n8n, Sentry).
**Consequence:** License choice is a launch blocker to resolve in Phase 2; contribution policy needed.

## ADR-010 — H1 ships without solving prompt injection; scope bounded instead
**Decision:** Untrusted-content risks are bounded (sandbox containment, budgets, branch isolation, URL/MCP context deferred to M3, imported templates arrive disabled) and documented — not "solved."
**Alternatives rejected:** Claiming mitigation via content filtering (false safety); blocking all external content forever (kills legitimate use).
**Why:** Honest posture + damage-bounding beats security theater; the industry has no real solution yet.
**Consequence:** Public security page states the stance; R-10 tripwires monitored; content-sandboxing is a named H2 investigation.

---

*Entries below this line were appended 2026-07-16 after adversarial review round 1 (`reviews/codex-sol-review-round1.md`).*

## ADR-011 — (post-review) Orphan runners are terminated + journal-reported, never re-adopted in H1
**Decision:** On daemon restart, live orphaned runners are identity-verified (pid+pgid+start-time) and terminated; the report is assembled from the runner's on-disk progress journal. Re-adoption (IPC reattach to a live orphan) is explicitly out of H1 scope.
**Context:** Review round 1 (#18) showed re-adoption is a disguised distributed-systems problem (pid reuse, socket reattach, split-brain on state).
**Alternatives rejected:** Re-adoption (weeks of correctness work for a rare case); letting orphans run to completion unsupervised (unbounded spend, no budget guard).
**Why:** A terminated run with a truthful journal-based report is honest and testable; a "recovered" run that might be double-supervised is neither.
**Consequence:** A daemon crash mid-run costs that run (rare, visible, explained in the report). Runner journals become a first-class artifact.

## ADR-012 — (post-review) OS sandbox is the security boundary; deny-list is demoted to policy UX — supersedes the containment claims of ADR-006/ADR-008
**Decision:** Every run executes inside a per-run OS sandbox (Seatbelt/bubblewrap): FS allowlist, credential-path exclusion, versioned profile. The deny-list remains as ergonomic policy but is no longer described as preventing anything adversarial. Worktrees are re-labeled *accident isolation*. `bypassPermissions` is removed from H1. Sandbox + env hygiene are alpha gate blockers.
**Context:** Review round 1 (#9–#12): same-user pattern-matching is not containment; "guaranteed by construction" was false as a security claim; safety was sequenced after external exposure (#31).
**Alternatives rejected:** Containers (H1-heavyweight); keeping the deny-list story (security theater); shipping alpha before sandbox (indefensible for this product category).
**Why:** The product's entire premise is trusting unattended runs; the boundary must be OS-enforced or the premise is marketing.
**Consequence:** T-008 spike + T-111 productionization added; ADR-008's "floor" language is superseded (the *sandbox* is the non-negotiable layer; the deny-list stays global-only but is honestly scoped).

## ADR-013 — (post-review) Repo-managed git hooks are disabled by default in Clockwork worktrees
**Decision:** Per-worktree hooks override; per-task opt-in to run repo hooks; report notes which applied.
**Context:** Review round 1 (#26): husky-style hook stacks executing inside scheduled unattended runs is surprise behavior in both directions (hooks blocking runs; hooks running arbitrary code the user didn't schedule).
**Alternatives rejected:** Running hooks by default (surprise execution); stripping hooks silently with no opt-in (breaks legitimate workflows that rely on them).
**Why:** Least surprise for an unattended context; explicit opt-in preserves the legit cases.
**Consequence:** Documented divergence from interactive-git behavior; S-84 covers it.

## ADR-014 — (post-review) HITL primary model is keep-alive runner; fresh-session resume is the fallback
**Decision:** `waiting_approval` holds the runner process alive with the `canUseTool` callback pending; decisions answer the callback. Fresh-session resume (decision injected into a new session) exists only as the runner-death fallback, with its restart-a-turn semantics documented.
**Context:** Review round 1 (#17): the callback is in-process; "persist and resume in a new process" mis-modeled the SDK's actual mechanics.
**Alternatives rejected:** Resume-as-primary (turn-restart fidelity loss on every approval); denying-by-default with no HITL (kills the flagship differentiator).
**Why:** An idle held process costs almost nothing; correctness of the flagship trust feature is worth a resident process per pending approval.
**Consequence:** T-003 rewritten as a comparison/decision task; S-58 defines runner-death-while-waiting; approval scale (many held runners) is an accepted H1 limit.

## ADR-015 — (post-review) Evidence sprint gates build spend; estimates re-baselined ~2×; Windows/Linux post-v1
**Decision:** Phase −1 (15 interviews + landing smoke test) must clear its bar before Phase 1; totals re-baselined from ~86 ed/"16–18 wk" to ~137 ed/25–30 wk solo (macOS v1); Windows+Linux move post-v1; adversarial review round 2 is mandatory after Phase 0.
**Context:** Review round 1 (#4, #29, #30): zero demand evidence; internally inconsistent arithmetic; systematic underestimation of correctness/safety work.
**Alternatives rejected:** Keeping optimistic numbers with a bigger buffer (the error was structural, not marginal); skipping evidence because "we feel the pain ourselves" (n=1).
**Why:** A plan that survives contact is worth more than a plan that flatters; the first ~$11k now buys the go/no-go answer.
**Consequence:** Longer stated timeline; honest costs (~$95–115k to macOS v1); ROADMAP/costs/spec updated in lockstep.

---

*Entries below were appended 2026-07-16 (scope revision: founder direction — CLI-first engine, agent profiles, chat delivery, search, widgets).*

## ADR-016 — Headless Claude Code (`claude -p`) is the default engine; the Agent SDK is the opt-in option — amends ADR-004
**Decision:** Two `AgentRunner` implementations: `ClaudeCliRunner` (default — spawns the user's installed Claude Code headless with stream-json output, permission-prompt MCP hook, `--resume`, per-run `.claude/` profile injection; rides the existing subscription login, **no API key required**) and `ClaudeSdkRunner` (configurable globally or per-profile). Engine capabilities are feature-detected into a per-engine contract matrix; the UI degrades honestly.
**Context:** The founder's user base (including the founder) runs Claude on subscription plans without API keys; ADR-004's SDK-only stance silently imposed API-key economics. The original "claude -p is disqualifying" claim was wrong for current CLI versions (stream-json telemetry and the permission-prompt hook exist) — re-verified at T-001/T-003 rather than assumed in either direction.
**Alternatives rejected:** SDK-only (excludes the primary persona's auth reality); CLI-only (closes the richer programmatic lane for API-key users); auto-detect with no user control (magic engine switching under a scheduled run is a debugging nightmare).
**Why:** Meet users where their auth already is; scheduling the user's own tool under their own login also materially narrows the R-5 policy risk.
**Consequence:** Phase 0 spike retargeted at the CLI engine; contract matrix becomes per-engine; +~5 ed for dual-engine conformance; the ADR-007 interface seam is exercised from day one.

## ADR-017 — Agent profiles are the booking-time identity: skills, model, permissions, budgets travel as a named persona
**Decision:** A `profiles` table of reusable agent personas (slug, color, engine, model, permission mode, budget defaults, skill set, MCP allow-list, context roots, system-prompt extra, delivery prefs). Booking selects a profile or `@mention`s it in the prompt; the runner materializes the profile's skills/subagents into the run worktree's `.claude/` so they load for exactly that run. M1 ships three built-ins; editor + import/export in M2 (imported profiles arrive disabled, same as templates).
**Context:** Founder direction: "mention agent name/profile while scheduling so default skills load for that agent and execute."
**Alternatives rejected:** Per-task raw config only (repetition, no identity, no shareability); global `.claude/` mutation (cross-run contamination, races between concurrent runs); free-text skill lists per booking (unvalidatable).
**Why:** Profiles turn configuration into identity — "book the Dep Surgeon" is how people think about delegation, and profile chips give runs a face across calendar/inbox/approvals. Also the natural H2 sharing unit alongside templates.
**Consequence:** New DDL + composer UX + @mention resolver; templates and profiles are separate but composable (a template references a profile); T-009 spike verifies materialization actually loads skills.

## ADR-018 — Delivery is a channel-adapter interface; WhatsApp only via user-configured gateway, never an embedded client
**Decision:** One daemon-side `DeliveryChannel` interface with adapters: os-native, Telegram Bot API (first chat channel, M2), WhatsApp **via a user-configured gateway** (Meta Cloud API / Twilio / self-hosted bridge — Clockwork POSTs to the gateway and never implements WhatsApp), generic HMAC-signed webhook (fronts Slack/Discord/ntfy/anything), SMTP. Same Run Report payload schema for every channel; creds keychain-only; failures never affect run outcome.
**Context:** Founder direction: Telegram + WhatsApp + "gateway support" alongside/instead of Slack-first.
**Alternatives rejected:** Embedding an unofficial WhatsApp library (ToS violation, ban risk for users, unmaintainable); Slack-first (the founder's users live in Telegram/WhatsApp); one-off per-channel code paths (N channels × M surfaces combinatorial mess — the interface collapses it).
**Why:** The webhook adapter makes the channel list effectively open-ended at zero marginal cost; the gateway pattern keeps Clockwork out of the messaging-platform compliance business.
**Consequence:** Slack demotes from a named integration to a webhook preset; channel setup UX (token/test-send flows) is new M2/M3 scope (+~5 ed); the H2 relay reuses the same payload schema.

## ADR-019 — Search-everywhere via SQLite FTS5 + ⌘K palette; widgets read a dumb snapshot endpoint
**Decision:** One FTS5 index (`search_idx`) over tasks/runs/transcripts/templates/profiles/approvals, updated on finalize; surfaced as inbox search (M1), global ⌘K command palette with quick actions (M2), and calendar filter. Widgets — Clockwork Mini always-on-top window (M3) and native WidgetKit (post-v1) — consume a read-only `GET /widget/snapshot`, never the full API.
**Context:** Founder direction: "inbox should be searchable, keep search wherever needed" + "support of widget too."
**Alternatives rejected:** UI-side search libs (can't reach on-disk transcripts, re-index per load); vector/semantic search now (H2 candidate, overkill for exact recall); widgets as full API clients (scope creep on the token surface).
**Why:** FTS5 is already in our database — search-everywhere costs one virtual table; the snapshot endpoint keeps glanceable surfaces safe and dumb.
**Consequence:** Index maintenance joins the finalize path; palette becomes the power-user front door; WidgetKit requires a native companion target (accepted post-v1).

---

*Entries below were appended 2026-08-21 during Phase 0 execution (engine contract verification).*

## ADR-020 — (Phase 0 finding) CLI engine cannot do keep-alive HITL on 2.1.238: M1 ships fail-safe-on-permission; SDK engine promoted to M1 for HITL users; permission modes reduced to plan/acceptEdits
**Decision:** (a) The `--permission-prompt-tool` MCP hook assumed by the architecture is ABSENT in Claude Code CLI 2.1.238 — the CLI engine ships M1 with **fail-safe on permission**: permission-blocked runs stop with a clear report (per the MVP cut-line's pre-authorized fallback), never hang. (b) `ClaudeSdkRunner` moves up from M2 to M1 as the HITL-capable engine for users who opt in with an API key. (c) Clockwork's composer offers only `plan` and `acceptEdits` for the CLI engine — the CLI 2.1.238 mode list (`acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`) has no `default`, `manual`/`dontAsk` hang or over-ask headless, and `bypassPermissions` was already banned (ADR-012). (d) Turn caps are enforced exclusively by Clockwork's BudgetGuard (kill between messages from usage events); the `--max-turns` flag does not exist in this CLI.
**Context:** T-007 contract matrix verified against the real binary on 2026-08-21 (`spikes/reports/T007-engine-contract-matrix.md`, T-001 real run evidence). Gate G0 pre-decided exactly this branch: "if the CLI can't support HITL, M1 ships CLI with fail-safe-on-permission and the SDK engine moves up to M1 for HITL users."
**Alternatives rejected:** Emulating HITL by killing + resuming sessions on each permission event (turn-restart semantics make it dishonest); waiting for Anthropic to ship the hook (no date); shipping `manual` mode headless (hangs the run until timeout — worst possible unattended behavior).
**Why:** Honest capability detection beats assuming the architecture doc's flags exist. The G0 gate anticipated this outcome and pre-authorized the redesign.
**Consequence:** FR-12/HITL stays M2-flagged behind engine choice; contract matrix becomes a runtime input (UI hides approval affordances for CLI-engine tasks); re-run matrix on every observed CLI version change.

## ADR-021 — Deviation: Node 24 runtime in this build environment (plan pins Node 22 LTS)
**Decision:** Development proceeds on Node v24.13.1 (the machine's installed LTS-line runtime); `engines >=22` declared. No API surface used by the daemon/runner is 24-only.
**Context:** Build environment has Node 24; installing a parallel 22 toolchain adds no correctness value for the code written here.
**Alternatives rejected:** Pinning nvm to 22 (environment friction with zero behavioral delta for our APIs).
**Why:** The plan's Node 22 pin targets LTS stability of child-process/IPC semantics, which are unchanged in 24 for our usage.
**Consequence:** CI should pin both 22 and 24 when it lands; release packaging bundles its own Node anyway (arch stack #6).

## ADR-022 — Deviation: Drizzle used as migration runner only; queries are typed repositories over better-sqlite3 prepared statements
**Decision:** Schema DDL lives verbatim in forward-only SQL migrations executed through Drizzle's migrator; all queries are hand-written repository functions using better-sqlite3 prepared statements (single writer = daemon, per ADR-003).
**Context:** Architecture §1 specifies "SQLite (WAL) + Drizzle" with the normative DDL given inline. Drizzle's query DSL would force re-expressing that DDL in TS schema objects — a translation layer between the normative doc and reality.
**Alternatives rejected:** Full Drizzle schema DSL (DDL drift risk vs the normative arch doc); raw fs-based migration script (loses transactional bookkeeping).
**Why:** The DDL in `02-architecture.md` is the contract; executing it verbatim removes an entire class of transcription bugs. Drizzle still owns ordering/bookkeeping.
**Consequence:** Migration files are plain SQL reviewable against arch §1 line-by-line; no ORM row-lifecycle magic; type-safety comes from repository-layer interfaces instead.

## ADR-023 — (Phase 0 finding) Seatbelt profile enforces default-deny WRITES + credential-path read denies; full read-default-deny is infeasible on macOS 26
**Decision:** The per-run containment profile denies all writes outside the run scope and explicitly denies reads of credential paths (`~/.ssh`, `~/.aws`, keychains, browser profiles). File READS remain same-user-broad (system + home), matching an interactive `claude` session. The architecture's "repo (ro where feasible)" is honestly resolved as NOT enforced by Seatbelt on macOS 26; the repo-ro claim is withdrawn from marketing/docs until a feasible mechanism exists.
**Context:** T-008 empirical bisect (crash reports in `~/Library/Logs/DiagnosticReports`): under `(deny default)` with read-restricted subpath allows, dyld4's `CacheFinder` aborts (`__abort_with_payload`, SIGABRT) before `main()` for every toolchain binary — /bin/echo, git, node, claude alike — regardless of which system paths were allowlisted (Preboot, dyld caches, /System, /private/var, etc.). Only unrestricted `file-read*` produces functioning processes. Verified on macOS 26.6.
**Alternatives rejected:** Read-restricted profile that breaks every run (unusable); App Sandbox entitlement helper (new Xcode target + notarization complexity — named H2 investigation); pretending the doc's ideal held (dishonest).
**Why:** The containment properties that matter for trust — no writes outside scope, credentials unreadable, process-group control, budgets — are fully enforceable today. Read-breadth equals what the user's own interactive agent already has, so unattended runs are not a new exposure class on that axis.
**Consequence:** docs/security.md states this plainly; S-86 escape tests target writes + credential reads; FR-26 implemented per this shape; revisit when Apple restores read-restriction viability or via entitlement-based helper.

## ADR-024 — (deviation) IPC transport is stdio JSONL with nonce, not unix socket
**Decision:** Runner⇄daemon IPC uses JSONL over the child's stdio instead of a per-run unix socket. Nonce passed via argv; child never receives the bearer token or delivery credentials (verified by sanitized env construction).
**Context:** Same isolation properties (own pgid, killable group, no shared state); stdio removes socket-file lifecycle management (cleanup on crash, path collision).
**Alternatives rejected:** Unix socket (extra lifecycle complexity, identical security properties for this topology).
**Why:** Transport choice doesn't change the threat model when the channel is parent↔direct-child.
**Consequence:** Architecture doc §7.3 wording updated by this entry; protocol messages typed in runner-protocol.ts.

## ADR-025 — (deviation) UI ships as a React+Vite web app in v1 builds; Tauri desktop wrapper added at packaging when a Rust toolchain is present

> **UPDATE 2026-08-22:** Rust toolchain installed; Tauri 2 shell implemented (window onto daemon-served UI + autolaunch hook). Unsigned DMG built: Clockwork_0.1.0_aarch64.dmg (2.7MB). Signing/notarization remain external-blocked.
**Decision:** `packages/ui` is React 18 + Vite speaking the daemon's REST+SSE API (pure-client architecture unchanged from arch §6). The Tauri 2 window/tray/updater wrapper is layered onto the same UI bundle during release engineering; the build environment used for this implementation has no Rust toolchain, so the JS layer proceeds without blocking.
**Context:** Arch stack #2 specifies Tauri 2. The three-process architecture (UI/daemon/runner) is unaffected: the UI remains stateless, reads/writes only through the daemon API with bearer token.
**Alternatives rejected:** Electron fallback (heavier; not needed since nothing blocks on native yet); blocking all UI work on Rust installation (schedule risk for zero architectural delta).
**Why:** The UI code is identical under both wrappers (fetch/EventSource only); Tauri contributes the window chrome, tray, autostart, updater — all packaging-time concerns.
**Consequence:** Token handshake currently manual (file read) until Tauri injects it at spawn; tray/menubar surfaces land with the Tauri step; stack #4 FullCalendar replaced by a purpose-built week/month grid matching designs/DESIGN.md (bundle size + we control booking UX end-to-end; FullCalendar's recurring-event model fights our occurrence-ledger source of truth).

## ADR-034 — Supersedes ADR-020: CLI keep-alive approvals via a loopback permission bridge; Seatbelt sandbox wired into production for every engine; S-39 narrowed to preserve interrupted worktrees
**Decision:** (a) The Claude CLI engine asks Clockwork before every gated tool call through `--permission-prompt-tool`, served by an HTTP MCP server hosted inside `runner-child` (`packages/runner/src/permission-server.ts`, zero deps). The hold is bounded by the run's remaining wall-clock budget, not a fixed window; `MCP_TOOL_TIMEOUT` and the per-server `timeout` are set to the same bound. (b) Every engine spawn — Claude, Codex, OpenCode, Hermes, and the BYOK agent's bash — is routed through `applySandbox()`; `runner-child` builds the spec with `buildSandboxSpec()`. The only way out is `CW_SANDBOX=off`, which is logged, written to the safety journal (`sandbox_disabled`), and stamped on the report (`sandboxed:false`). (c) Profile v2 admits the CLI's per-cwd work dir (`/tmp/claude-<uid>/<slug>`, pre-created) and its cwd-tracking file (`regex ^/private/tmp/claude-[0-9a-f]+-cwd$`), plus `SandboxSpec.writeRegexes` for engine staging files. (d) `runner-child` scrubs `CW_BYOK_KEY`/`CW_BYOK_BASE_URL` from its own env after reading them; the BYOK bash gets `buildRunEnv()` + the sandbox wrap. (e) S-39 prunes a worktree only when the run ended cleanly (`completed`/non-crash `failed`) AND the worktree is clean with no git operation in flight; otherwise it is preserved and the report says so (`worktreeState`).
**Context:** 2026-09-05, the day after the Product Hunt launch. Three public statements did not match the code: approvals "hold until you approve" (they never fired — `onPermissionRequest` was called only by `mock-runner.ts`); "runs execute inside a macOS Seatbelt sandbox" (`new ClaudeCliRunner()` at `runner-child.ts:67` passed no spec; the other engines had no hook; T-111's "productionized" meant generator + tests only); "the worktree is preserved" after a timeout (`removeWorktree` ran `git worktree remove --force` + `rmSync` whenever the agent committed nothing, including on `timed_out`). ADR-020's premise — `--permission-prompt-tool` absent — was verified against 2.1.238 and is false on the installed 2.1.261; ADR-020 itself required this re-run. Evidence: `spikes/reports/T007-engine-contract-matrix-2.1.261.md` (real runs: 100s hold honoured inside the sandbox; `/tmp` write and `~/.zsh_history` read denied with a live shell; OpenCode verified; Hermes 0.21.0 resolves `write_file` against `$HOME` even outside the sandbox — pre-existing, now loud; Codex unverifiable here due to a local `config.toml` error).
**Alternatives rejected:** stdio MCP bridge (the CLI spawns it INSIDE the sandbox with stdio owned by the CLI → needs a side channel and a profile allow for it); extending the fixed 120s window (still a lie about "holds"); `--strict-mcp-config` (drops the repo's own `.mcp.json` servers — behaviour change for existing tasks); falling back to an unsandboxed spawn when the profile is refused (fail-open); a blanket allow on `/tmp` for the CLI's cwd file (the regex admits one filename and was tested against near-misses).
**Why:** The launch's credibility argument is "check it rather than believe it". Every one of the three gaps was a missing call site in front of working, tested code — so the fix is wiring plus guards that read the sources (`runner-env-wiring.test.ts` "sandbox wiring") so the call sites cannot silently disappear again.
**Consequence:** T-003/T-201 unblocked for the CLI engine; the composer may offer `default` permission mode meaningfully. `docs/security.md`, README, `plan/STATUS.md` T-111 corrected to describe what ships. Open, surfaced not decided: the run inherits `HOME`, so `~/.claude/settings.json` `permissions.allow` rules pre-empt the prompt tool — `--setting-sources` (2.1.261) can pin what an unattended run loads. ADR-026…033 are cited in code but never written here; this entry takes 034 to avoid collision. Re-run the matrix on every observed CLI/engine version change (unchanged from ADR-020).

## ADR-035 — The policy floor as a fail-closed PreToolUse hook; exactly one Seatbelt layer; engine cwd pinning

**Decision:** (a) Every Claude CLI run injects a `PreToolUse` hook (matcher `Bash`) via `--settings`; the generated hook (`packages/runner/src/floor-hook.ts`) POSTs `{tool_name, tool_input}` to the permission bridge's `/floor` route, the supervisor runs `evaluateCommand`, and a floor hit exits 2 (CLI refuses the call with the reason). Every error path exits 2 — bridge unreachable, malformed input, timeout, watchdog — so the hook is fail-closed and a CLI contract change breaks runs loudly. Floor hits are sent to the daemon (`{t:'floor'}`), recorded as `policy_deny` events and `deny_list_hit` journal entries. (b) Codex runs with `-s danger-full-access` when Clockwork's Seatbelt profile is on and `workspace-write` only under `CW_SANDBOX=off`. (c) `HermesRunner` sets `TERMINAL_CWD` to the worktree.

**Context:** 2026-09-05/06. The ADR-034 bridge only sees tool calls the CLI chooses to gate; under `acceptEdits` on CLI 2.1.261 `git push --force origin main` ran with no prompt (production probe, `permission_denials: []`). macOS refuses to apply codex's own profile inside ours (`sandbox_apply: Operation not permitted` under any `(deny default)` outer profile; bisected every allow, only `(allow default)` nests). hermes 0.21.0's oneshot (`-z`) path never applies `--in`, so writes resolved against `$HOME` — silently before the sandbox, loudly (EPERM) after it.

**Alternatives rejected:** running unattended tasks in `default` mode (every call prompts — turns a 2am run into a wall of asks); injecting deny-list patterns as CLI `permissions.deny` rules (pattern dialect differs from ours, two sources of truth, still mode-dependent); a hook that imports the runner's dist (a packaging path baked into a run; an exec failure would be fail-open); exempting codex from the sandbox (loses credential-read denial and the "every engine wrapped" guard); making nesting work (no outer allow unblocks it).

**Why:** hooks fire in every permission mode, so coverage no longer depends on the CLI's gating heuristics; evaluation stays in the supervisor with the real deny-list; the hook has zero imports beyond `node:http`, so packaging cannot break it. One containment layer that is ours is simpler to reason about than two that fight. Measured cost: ~60 ms per Bash call (Node start + one loopback round trip, median of ten).

**Consequence:** docs/security.md "Known gap" closed with dated evidence; codex users lose codex's own shell-command network block (network is allowed under Clockwork's profile for every engine — documented). Open: the run inherits `HOME`, so a developer's `permissions.allow` rules and `SessionStart`/`SessionEnd` hooks apply unattended (`--setting-sources` pinning is a product decision); repo-declared MCP servers that run shell are not matched by the `Bash` matcher; the bridge has no per-run bearer token yet; LICENSE §12's audit set does not yet list `permission-server.ts` or `floor-hook.ts`.

**Review findings folded in (2026-09-06, Opus read-only pass, both reproduced on this machine):** (1) the `--settings` payload must pin `disableAllHooks: false` — the CLI honours that switch from a repo's own `.claude/settings.json`, and without the pin one committed key disabled the hook while the report still said `sandboxed: true`; CLI-flag settings outrank project settings, so the pin wins (unit-tested in `floor-hook.test.ts`). (2) The BYOK provider key must not travel in the child's environment at all: macOS keeps a process's exec-time env readable via `sysctl KERN_PROCARGS2`, the profile must allow `sysctl-read` (Node needs it), and a sandboxed agent read the key out of a sibling `runner-child` after it had been deleted from `process.env`. The credential now arrives over the daemon⇄child stdin channel as a `credential` message; the env never contains it.

**Open item closed (2026-09-06):** "the bridge has no per-run bearer token yet" (Consequence, above) is WON'T-DO, not deferred. Any secret the sandboxed CLI must present to reach the bridge is readable by the agent running inside that same CLI — a token cannot separate the CLI from its own agent, it would just be one more readable file, so it buys no real containment. The mitigation is the bounds hardened this round instead: the bridge counts bytes as they arrive (not just Content-Length, which a chunked request omits) and stops reading past 4 MiB, holds at most 16 concurrent `tools/call`s per run and denies the rest outright, and releases a held slot immediately if the client disconnects before a decision resolves. Documented in `docs/security.md`.

## ADR-036 — Reachable approvals, inbound half: an outbound-only Telegram poll resolves the same approval a human answers in the Inbox

**Decision:** The daemon long-polls the Telegram Bot API's `getUpdates` (`packages/daemon/src/telegram-approvals.ts`), started from `main.ts` only when a Telegram bot token is configured, and stopped on daemon shutdown. `TelegramChannel.sendApproval` (`delivery.ts`) now carries an inline keyboard (`Approve`/`Deny`, `callback_data: a:<approvalId>` / `d:<approvalId>` — a 26-char ULID keeps this at 28 bytes, well under Telegram's 64-byte cap). A button press is honoured only when `callback_query.message.chat.id` matches the task's configured `delivery.telegram.chatId`, and — because a group or supergroup lets anyone present tap the button — additionally only when the pressing user's id is on that task's `telegram.allowedUserIds`; no list configured for a group chat refuses every callback there. A refused callback answers "Not allowed", changes nothing, and is logged once; every callback, trusted or not, gets an `answerCallbackQuery` reply so the tap never sits spinning. The body of the existing `POST /approvals/:id/respond` route is now `RunManager.respondToApproval(approvalId, decision, source)` — the CAS on `responded_at` (first writer wins), the forward into a still-live child (`respondToChild`), the `approval.responded` broadcast, and the journal write for non-local sources are exactly one code path for both the local API and the Telegram callback, so a decision cannot behave differently depending on which door it came through. The offset `getUpdates` needs to never re-deliver an already-consumed update is persisted in a new single-row table (`telegram_poll_state`, migration `0009`) after every update, not just every batch, so a daemon crash mid-batch replays at most the updates not yet written. A `409` from `getUpdates` (a webhook is set, or another process already owns this bot token) stops the poller for this daemon run — logged loudly, once — rather than fighting whatever else holds the token; it retries on the next daemon start. Any other error backs off 1s→30s and keeps polling.

**Context:** 2026-09-06. The outbound half (ADR-034/FR-18 sibling) already pushed a permission request to Telegram; the reply had nowhere to land except opening the app. The chat a user is in when the ping arrives is the one placed to answer it — a poll, not a webhook, gets the reply back without asking the operator to open anything to their network.

**Alternatives rejected:** a tunnelled inbound webhook (ngrok/Cloudflare Tunnel or similar) so Telegram calls the daemon directly — this needs a per-daemon secret and replay protection the daemon would have to invent and rotate itself, and unlike an HMAC webhook Clockwork already verifies elsewhere (triggers.ts), nothing here is signed by Telegram in a way the daemon could check; it also means opening something to the network from a product whose whole security pitch is "loopback only, nothing exposed." A stateful park/resume flow that lets a Telegram reply arrive after the child's decision window has already closed — adds an FSM state reachable only from an unattended, un-auditable path (a message sent while nobody is watching the app), for a case ADR-036's `run_gone` result already reports honestly instead of pretending to resolve.

**Why:** the poller is a client of api.telegram.org, never a server — `docs/security.md`'s loopback-only claim needs no exception. Trust reduces to one fact Telegram itself reports on every callback (which chat it came from) plus one the operator configures once (the allow-list), rather than a secret the daemon has to mint, store, and rotate. Sharing `respondToApproval` between the API route and the poller means the CAS, the forward-to-child, and the audit trail cannot drift between the two entry points — there is only one entry point with two front doors.

**Consequence:** anyone holding the bot token can act as the bot — including answering approvals — so the token is a credential, not a convenience string; this is unavoidable for a bot API and is documented, not solved. The trust check is per-task (via `delivery.telegram.chatId`), so a task never configured for Telegram grants no button any authority regardless of who presses it. Open, surfaced not decided: `telegram.allowedUserIds` is set today only by hand-editing `delivery_json` (no UI affordance yet) — the zod schema (`packages/shared/src/schemas.ts`) accepts it so the field survives task create/patch instead of being silently stripped, but there is no settings-page control for it.

## Referenced but unwritten ADRs

ADR-034 already noted in passing that "ADR-026…033 are cited in code but never written here" (see above). This section makes that concrete: every citing comment found by `grep -rn "ADR-02[6-9]\|ADR-03[0-3]" packages/` (excluding `dist/`), grouped by number, with the one-line topic each citation implies. These are owed — nobody should treat the numbers as resolved just because code comments reference them.

**ADR-026 — engine/provider selection (which CLI runs a task: claude/codex/opencode/hermes)**
`packages/shared/src/schemas.ts:14,19,270`; `packages/runner/src/opencode-runner.ts:2`; `packages/runner/src/hermes-runner.ts:2`; `packages/runner/src/codex-runner.ts:2`; `packages/daemon/src/api.ts:1113` (provider detection); `packages/daemon/migrations/0002_task_engine.sql:1` (per-task engine override column). Also cited by `packages/ui/src/components/FolderBrowserDialog.tsx:2` ("daemon-backed Finder-style repo picker") — that comment's own topic doesn't obviously match the others; the mismatch itself is a reason this ADR is owed, not something to paper over here.

**ADR-027 — BYOK provider configuration store (user-supplied API keys/endpoints, Keychain-backed)**
`packages/shared/src/schemas.ts:27,271,325`; `packages/daemon/src/byok.ts:2`; `packages/daemon/src/api.ts:1282`; `packages/daemon/migrations/0003_byok.sql:1`; `packages/ui/src/components/ByokCard.tsx:2`; `packages/daemon/src/run-manager.ts:211,784` (co-cited with ADR-028).

**ADR-028 — API-agent execution adapter (running a task through a BYOK OpenAI-compatible endpoint instead of a CLI)**
`packages/runner/src/api-agent-runner.ts:2`; `packages/daemon/src/runner-child.ts:197` (co-cited with ADR-035); `packages/daemon/src/run-manager.ts:211,784` (co-cited with ADR-027).

**ADR-029 — cost & reliability analytics (spend/success-rate aggregation surfaced to the user)**
`packages/daemon/src/api.ts:1000`; `packages/ui/src/components/AnalyticsView.tsx:2`.

**ADR-030 — quiet hours (defer a fire into a task's local-time no-run window)**
`packages/shared/src/schemas.ts:216`; `packages/daemon/src/scheduler.ts:188,301`; `packages/daemon/test/quiet-hours.test.ts:2`.

**ADR-031 — retention + audit log (goal #41 retention controls, goal #40 append-only audit log)**
`packages/daemon/src/retention-audit.ts:2`.

**ADR-032 — policy engine (goal #38 enterprise guardrails: engine allow-lists, cost ceilings, approval thresholds)**
`packages/daemon/src/policy-engine.ts:2`.

**ADR-033 — Docker as the first remote execution target (ephemeral container runner)**
`packages/runner/src/docker-runner.ts:2`. Note: as of this audit the module this ADR would document (`runInDocker`) has no caller outside two standalone test scripts — the decision it would record was never wired to an actual task run (see README roadmap, corrected in this pass).
