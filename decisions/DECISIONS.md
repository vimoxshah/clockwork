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
