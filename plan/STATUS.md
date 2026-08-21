# Clockwork — Task Status Matrix

Machine-readable status per `plan/05-execution-plan.md` task IDs.
Status vocabulary: **DONE · PARTIAL · MISSING · BROKEN · UNKNOWN** (per audit
contract). External-dependency and time-gated items are annotated.

Last updated: 2026-08-22 (post-M1-core implementation sprint)

## Phase −1 — Evidence sprint

| ID | Status | Notes / Evidence |
|---|---|---|
| T-011 | MISSING | Interview infrastructure ready (`evidence/interview-script.md`: script, coding sheet, recruiting channels). 0 of 15 interviews conducted — requires real external participants. |
| T-012 | MISSING | Honest-pitch landing page built (`evidence/landing-page/index.html`, awake-machine constraint included, use-case waitlist form). No traffic driven; form backend needs wiring before launch. |
| T-013 | PARTIAL | Readout template + decision frame + override clause written (`evidence/EVIDENCE-READOUT.md`), status **UNVERIFIED**. G-1 remains unmet; no override recorded. |

## Phase 0 — Engine spike

| ID | Status | Notes / Evidence |
|---|---|---|
| T-001 | DONE | Real headless `claude -p --output-format stream-json` on subscription login: exit 0, 10 usage events, structured summary, session-id capture, worktree containment. `spikes/reports/T001-cli-runner.md` |
| T-002 | DONE | Interruption matrix as permanent tests: SIGTERM/timeout→timed_out/budget→budget_exceeded/turn-stop, group-kill leaves no zombies incl. grandchildren. `packages/runner/test/interrupt-matrix.test.ts` (8 tests) |
| T-003 | PARTIAL | CLI decision made with binary evidence: `--permission-prompt-tool` ABSENT in 2.1.238 → fail-safe-on-permission (ADR-020). SDK keep-alive/resume fidelity probe deferred to T-212 integration. `spikes/reports/T003-hitl-decision.md` |
| T-004 | DONE | Absent-auth probe: `authentication_failed` detectable in stream (exit 1). Error taxonomy documented incl. observed `rate_limit_event`. Expired-token simulation documented as not-probed (requires mutating real creds). `spikes/reports/T004-auth-probes.md` |
| T-005 | DONE | Scheduler micro-PoC became product code with fixture suite: 18 fake-clock tests across America/New_York, Europe/Berlin, Australia/Lord_Howe, UTC; concurrent double-fire attack cannot produce two runs. `packages/daemon/test/scheduler.test.ts` |
| T-006 | DONE | Auth posture memo: own-login actuator, no credential scraping, expiry UX defined, SDK fallback lane. `spikes/reports/T006-auth-posture.md` |
| T-007 | DONE | Engine contract matrix v1 for CLI 2.1.238 with re-run procedure; two load-bearing assumptions corrected (--max-turns absent, permission hook absent) → runtime consequence via ADR-020. `spikes/reports/T007-engine-contract-matrix.md` |
| T-008 | DONE | Seatbelt escape suite **13/13 PASS**: ssh/aws/gnupg/shell-history reads denied; out-of-scope writes denied; symlink traversal denied; git+node+`claude -p` functional inside profile. Keychain-read exception documented. `spikes/reports/T008-sandbox.md` |
| T-009 | DONE | Control/treatment proof: skill materialized into `.claude/skills/` changed run output (CRANBERRY-42); no-skill control declined. `spikes/reports/T009-profile-materialization.md` |

**G0: PASSED** — with the pre-authorized branch exercised (CLI HITL unavailable → M1 fail-safe; SDK engine promoted to M1 for HITL users).

## Phase 1 — M1 private alpha (Track A)

| ID | Status | Notes / Evidence |
|---|---|---|
| T-101 | DONE | pnpm monorepo packages/{shared,runner,daemon,ui} + spikes; eslint flat, vitest workspace, CI workflow boot-smoke. |
| T-102 | PARTIAL | DDL executed verbatim from arch §1 via forward-only migrations, WAL + synchronous=FULL, run-dir layout. Crash-mid-write test (S-34 partial) not yet explicit — recovery tests cover fresh-open paths. |
| T-103 | DONE | Tick loop (30s), next_fire materialization, occurrence-ledger claims in one transaction, missed policies + coalescing, overlap skip/queue, COUNT-exhaustion auto-disable, wall-clock-only comparisons. Wake catch-up satisfied by tick cadence within NFR-1's 120s (OS wake-event subscription = later optimization). Keep-awake assertions armed per-run when plugged in. 18 fixtures green. |
| T-104 | DONE | FSM with legal-transition enforcement; global semaphore (2); repo mutex; queue FIFO by scheduled_for; single-instance lockfile+port probe; recovery sweep S-30/S-31/S-81 green incl. REAL orphan process termination. |
| T-105 | DONE | REAL-ENGINE E2E VERIFIED LIVE (2026-08-22): daemon→ledger tick→child→claude -p→completed report -e.376/1 turn→FTS searchable. USER/LOGNAME env requirement for keychain ACL discovered + fixed. AgentRunner seam + ClaudeCliRunner (stream parser tolerant to unknown events, budget guard soft-cap w/ overshoot measurement, hard turn/time caps enforced by Clockwork per ADR-020), MockRunner, worktree lifecycle w/ hooks-off default (S-84), profile materializer (T-009-proven), sanitized env, JSONL IPC + heartbeat, on-disk journals, report serializer w/ diffstat + S-39 prune, disk-floor monitor. |
| T-106 | PARTIAL | Error taxonomy mapping (auth/rate_limited/capacity/offline/model_unknown) from stream events; pre-flight repo validation; auto-pause after 2 consecutive auth failures (S-40) wired. Transient backoff helper exists but scheduler auto-re-enqueue not wired (retry defaults OFF by spec). |
| T-107 | DONE | Fastify REST+SSE, bearer token 0600, task CRUD w/ zod validation at save (past-time S-23, invalid RRULE S-26, non-git S-36 all rejected), optimistic versioning 409s (S-82 tested), run-now, runs/report/cancel, approvals CAS, FTS /search, widget snapshot, pause/resume. Contract tests green. |
| T-108 | PARTIAL | LaunchAgent plist generation + install/uninstall + doctor (6 checks incl. duplicate instance). Code complete; live `launchctl bootstrap` verification pending on a clean machine (CI smoke covers daemon boot only). |
| T-109 | DONE | Daemon-side osascript notifier + quiet-hours suppression; works with UI closed by construction. |
| T-110 | DONE | Retention pruning (7d success / 30d failed worktrees, reports forever) + startup worktree reconciliation with quarantine list (never auto-deletes). |
| T-111 | DONE | Sandbox productionized from T-008: per-run profile generation w/ symlink resolution + credential-collision refusal, scoped engine-state writes, safety journal recording deny/orphan/preflight events. Escape suite green in repo; runs in CI on every change. |
| T-112 | PARTIAL | Profiles table, 3 seeded built-ins (Generalist/Dep Surgeon/Docs Scribe), bundled versioned skill pack authored (3 skills × SKILL.md procedures), name@version resolver (+user-skill fallback), @mention resolution server-side. Profile identity shown in report header/delivery text; calendar/inbox chips not yet rendered everywhere. |
| T-113 | PARTIAL | FTS5 search_idx, index-on-finalize + task save, snippeted /search, inbox search box. 5k-corpus <100ms benchmark not yet measured. |
| T-114 | PARTIAL | queue schedule kind persisted; GET /queue computes position + wait reason (slot/repo/paused); queue lane UI with cancel. Composer cannot yet book ASAP items directly (schedule-kind=queue selection missing). |

## Phase 1 — Track B (UI)

Shell note: React+Vite web app served by the daemon; Tauri wrapper deferred to packaging (ADR-025 — no Rust toolchain in build environment; UI code is wrapper-ready).

| ID | Status | Notes / Evidence |
|---|---|---|
| T-121 | PARTIAL | Single-port app serving + live health (daemon version, active/queued counts, next fire, PAUSED badge) replaces tray until Tauri lands; token handshake manual (file paste) vs Tauri-injected. |
| T-122 | PARTIAL | Week calendar: past runs outcome-colored, future bookings dashed, today marker, honest power-model copy. Month/day views and click-slot-to-composer not yet wired. |
| T-123 | PARTIAL | Composer: name/prompt/repo/profile selector/permission mode (plan|acceptEdits only — no bypass)/budget trio/once+weekly RRULE builder/server-validated errors displayed inline. Monthly recurrence + cron builder missing. |
| T-124 | PARTIAL | Inbox list w/ state chips + search filter; report view: summary block, diffstat table, cost/turns/duration/branch stats, ran-late banner, coalesced-coverage note, approvals panel. Transcript viewer from disk + unread badges missing. |
| T-125 | PARTIAL | Onboarding detection panel (Claude installed/authed, git, MCP config, sample-task guidance) + settings w/ pause-all + snapshot stats. One-click sample task creation missing. |
| T-126 | PARTIAL | Live states visible in topbar health + queue lane + inbox chips; cancel available for queued/running. Streaming log tail view missing. |

## Phase 2 — M2 public beta

| ID | Status | Notes / Evidence |
|---|---|---|
| T-201 | PARTIAL | Approval rows persist across restarts (S-54 data model), CAS respond endpoint (S-57), inbox needs-you panel, deny-list floor never approvable (S-55), M1 fail-safe auto-deny (ADR-020). Keep-alive held-runner model blocked on SDK engine (T-212). |
| T-202 | PARTIAL | Linear chain validation (cycles rejected at save, S-72), {{previous.report}} binding w/ honest truncation (S-73), upstream-failure semantics in schema. Calendar ghost rendering for skipped successors missing. |
| T-203 | PARTIAL | Security preview (red/yellow/info flags), import arrives DISABLED (S-74), apply-time variable validation (S-75). Export-as-JSON missing. |
| T-204 | PARTIAL | Orphan terminate+journal-report done (real-process tests), reboot sweep done. Disk-full pause-all suggestion, DB backup-on-migrate, updater drain: missing. |
| T-205 | BLOCKED(external) | Signed DMG + notarization require Apple Developer account/certs ($99/yr) and updater hosting. Packaging pipeline (build all packages) verified. |
| T-206 | MISSING | Beta telemetry + crash reporting + one-click incident report. Safety journal (the local substrate) ships already. |
| T-207 | PARTIAL | Docs suite v1 shipped (security/scheduling/architecture/install/privacy/troubleshooting/contributing + README). 5 canonical template files not yet authored. |
| T-208 | DONE | FSL-1.1 LICENSE + CONTRIBUTING.md w/ security disclosure policy (ADR-009 closed). |
| T-209 | MISSING | In-app profile editor (API CRUD exists; UI editor + duplicate-a-built-in flow missing). |
| T-210 | MISSING | ⌘K command palette. |
| T-211 | PARTIAL | Telegram Bot API adapter + HMAC webhook adapter behind DeliveryChannel interface, S-43 retry×3 exponential + receipts in report footer, creds never runner-visible. Setup UI flows missing. |
| T-212 | MISSING | ClaudeSdkRunner engine option (SDK dependency not yet integrated; capability flags stubbed in matrix doc; UI degradation plumbing pending). |

## Phase 3 — M3 v1

| ID | Status | Notes / Evidence |
|---|---|---|
| T-301 | CUT_RECOMMENDED | Capacity assistant is conditional on beta precision ≥70% (FR-7/R-7). No beta telemetry exists ⇒ per plan it must be cut without ceremony unless/until precision evidence arrives. Recorded here as the default decision pending any overriding beta data. |
| T-302 | PARTIAL | Per-task delivery config stored + dispatched; env/file credential bridge. Settings-center UI + keychain-backed setup + test-send flow missing. |
| T-303 | MISSING | Auto-PR via gh. |
| T-306 | MISSING | URL + MCP context attachment (prompt-injection stance documented; implementation deferred). |
| T-307 | PARTIAL | 500-task/50-due scale fixture green (<5s bound). 5k-run calendar windowing + DB vacuum + idle profiling vs NFR-3 not measured. |
| T-308 | MISSING | Launch kit (landing page exists as evidence asset; demo video/templates pack missing). |
| T-309 | PENDING-BETA | Hardening reserve opens with external beta. |
| T-310 | PARTIAL | Webhook (HMAC-signed) + Telegram adapters shipped; SMTP + WhatsApp-gateway adapters missing (interface accepts them without code changes). |
| T-311 | MISSING | Clockwork Mini widget (snapshot endpoint ships already — read-only aggregate scope). |

## Post-v1 (out of scope)

| ID | Status |
|---|---|
| T-401 Windows | MISSING (planned post-v1) |
| T-402 Linux | MISSING (planned post-v1) |

## Gate ledger

| Gate | State |
|---|---|
| G-1 (evidence) | **BLOCKED(external)** — bars unmet, assets ready, no override recorded |
| G0 (engine spike) | **PASSED** (with ADR-020 branch) |
| G1 (M1 exit) | **PARTIAL** — core loop proven end-to-end (mock engine full-loop tests + real-engine PoC); fresh-Mac-by-non-builder demo not performed; dogfood streak time-gated (program defined in `dogfood/DOGFOOD.md`) |
| G2 (M2 exit) | **BLOCKED(external)** — requires 20 beta users, wild HITL round-trip, zero data-loss/containment incidents |
| G3 (v1 gate) | **BLOCKED(external + time)** — 30-day dogfood streak, kill-criteria observability, signing/notarization |

## Test inventory vs mandate

| Suite | Count | Location |
|---|---|---|
| Runner unit/scenario | 40 | `packages/runner/test/*` |
| Daemon scheduler fixtures | 18 | `packages/daemon/test/scheduler.test.ts` |
| API contracts | 12 | `packages/daemon/test/api.test.ts` |
| Full-loop child-process integration | 4 | `packages/daemon/test/full-loop.test.ts` |
| Recovery (real orphan kills) | 3 | `packages/daemon/test/recovery.test.ts` |
| Templates/chains | 8 | `packages/daemon/test/templates-chains.test.ts` |
| **Total automated** | **85+** | all green at last run |

Manual logs: sandbox escape matrix (13 checks) `spikes/reports/T008-sandbox.md`; live smoke (boot→book→fire→report→search) recorded in commit e583e01; real-engine verification runs T-001/T-008/T-009.
