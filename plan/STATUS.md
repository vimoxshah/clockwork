# Clockwork — Task Status Matrix

Machine-readable status per `plan/05-execution-plan.md` task IDs.
Status vocabulary: **DONE · PARTIAL · MISSING · BROKEN · UNKNOWN** (per audit
contract). External-dependency and time-gated items are annotated.

Last updated: 2026-09-06 (Agent Workforce integration pass: F1–F12 wired,
T-113/T-307 benchmarks measured — see Phase 4 below)

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
| T-003 | DONE | Re-run 2026-09-05 against CLI 2.1.261: `--permission-prompt-tool` now PRESENT and proven by run (tool called, 100s hold honoured inside the sandbox). Keep-alive HITL wired for the CLI engine via a loopback HTTP MCP bridge (ADR-034 supersedes ADR-020). `spikes/reports/T007-engine-contract-matrix-2.1.261.md` |
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
| T-111 | DONE (2026-09-05) | **Correction:** until 2026-09-05 this row overstated — the profile generator, symlink resolution, credential-collision refusal and escape suite were done, but NO production spawn used them (`new ClaudeCliRunner()` passed no spec; other engines had no hook). Now every engine spawn incl. BYOK bash routes through `applySandbox()`; `runner-child` builds the spec; profile v2 admits the CLI work dir + cwd file; `CW_SANDBOX=off` is journaled and stamped on the report. Guarded by `runner-env-wiring.test.ts` "sandbox wiring". Verified in-sandbox: Claude ✅, OpenCode ✅, Hermes ⚠️ (pre-existing `$HOME` cwd bug), Codex ❓ (local config error). ADR-034. |
| T-112 | PARTIAL | Profiles table, 3 seeded built-ins (Generalist/Dep Surgeon/Docs Scribe), bundled versioned skill pack authored (3 skills × SKILL.md procedures), name@version resolver (+user-skill fallback), @mention resolution server-side. Profile identity shown in report header/delivery text; calendar/inbox chips not yet rendered everywhere. |
| T-113 | DONE (measured 2026-09-06) | FTS5 search_idx, index-on-finalize + task save, snippeted /search, inbox search box. **5k-corpus <100ms benchmark now measured**: 5,060-document index (5,000 run docs + 60 task docs), common-term case (`repo*`, which matches nearly the whole index — the hard case, since FTS5 bm25-ranks every match before `LIMIT 50`). Ten runs on 2026-09-06, six of the bench alone and four inside the full suite: median **3.24–27.58ms**, p95 **3.32–31.70ms** — **the <100ms claim held in all ten**, the only bound in this bench that did. Other cases across those runs: rare term 0.02–0.26ms, multi-term + `kind=run` filter 2.50–24.54ms, real `GET /search?q=repo` HTTP round trip 3.49–10.05ms median. The verdict is stable here where T-307's is not, because the bound is ~4x away at the worst measurement rather than straddling it — but the number itself still moved 8x with machine load, so read it as a range, never as a constant. `packages/daemon/test/workforce-bench.test.ts`. |
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
| T-201 | DONE for CLI engine (2026-09-05) | Approval rows persist across restarts (S-54), CAS respond endpoint (S-57), inbox needs-you panel, deny-list floor never approvable (S-55). **Now actually reachable:** the CLI engine raises permission requests through the loopback bridge and HOLDS until a human answers or the run's wall-clock ends (was: never raised in production; fixed 120s window). Codex/OpenCode/Hermes have no permission hook — their containment is the sandbox alone. ADR-034. |
| T-202 | PARTIAL | Linear chain validation (cycles rejected at save, S-72), {{previous.report}} binding w/ honest truncation (S-73), upstream-failure semantics in schema. Calendar ghost rendering for skipped successors missing. |
| T-203 | PARTIAL | Security preview (red/yellow/info flags), import arrives DISABLED (S-74), apply-time variable validation (S-75). Export-as-JSON missing. |
| T-204 | PARTIAL | Orphan terminate+journal-report done (real-process tests), reboot sweep done. Disk-full pause-all suggestion, DB backup-on-migrate, updater drain: missing. |
| T-205 | PARTIAL | **UNSIGNED DMG BUILT** (2026-08-22): `src-tauri/target/release/bundle/dmg/Clockwork_0.1.0_aarch64.dmg` (2.7MB) + Clockwork.app via Tauri 2 shell — Rust toolchain installed in-session, mount-tested. Signing + notarization remain BLOCKED(external): Apple Developer cert ($99/yr). |
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
| T-307 | PARTIAL (measured 2026-09-06, acceptance criterion still unmet as stated) | 500-task/50-due scale fixture green: 63.46ms, unchanged (63.22ms) after this pass — no regression. **5k-run calendar windowing now measured**: `GET /calendar` year view (5,000 runs + 480 expanded bookings). A single two-decimal number here would be a false claim — the VERDICT moves with machine load, so what is recorded is a whole run set rather than one figure taken from it. **Ten runs on 2026-09-06**, one Apple M4 MacBook Pro (10 cores, 16GB, Node v24.13.1), one commit, inside 90 minutes. Six were `CLOCKWORK_BENCH_ASSERT=1 npx vitest run test/workforce-bench.test.ts`: at `uptime` load averages of 12.5–27.1 the year-view **medians were 623.17 / 684.26 / 579.59ms** and all three runs went **red** (1, 2 and 2 failed assertions of 16); at load 7.4–7.9 the same command on the same commit gave **383.93 / 376.56 / 349.59ms** and all three went **green** (16 of 16). The four full-suite runs bracket the same way — **670.53ms** loaded against **368.80 / 368.11 / 375.31ms** quiet. **So NFR-3's 500ms median claim (`plan/01-product-spec.md:91`) held in six of the ten runs and missed in the other four, decided by how busy the laptop was rather than by anything in the code.** The p95 is worse: 429.41–1163.14ms, above the 500ms ceiling in seven of the ten. The cheaper default window behaves the same way (medians 329.21–738.97ms, over the ceiling in three of ten). **No headroom figure is stated here**, because none is honest for a number that ranged 349.59–684.26ms; an earlier revision of this row read a fixed multiple off three quiet runs, and that is the claim being corrected — not the numbers, which reproduce when the machine is quiet. An independent review run measured 585.49ms inside the full suite, which sits in the loaded band above. A later confirmation run of the full suite, made after these corrections landed, measured 421.02ms — inside the band above, and neither its best nor its worst. That is why the bound is no longer asserted by default (see the bench-gate note under "Test inventory" below): asserting it inside `pnpm test` made the suite's colour a property of the machine. Acceptance text (`plan/05-execution-plan.md:100`) is "NFR-3 numbers met on a **base M1 Air**" — every number here was measured on an Apple M4 MacBook Pro (10 cores, 16GB, Node v24.13.1); the M1 Air was NOT measured and no number is extrapolated for it, so this criterion is **unproven, not passing, on the actual acceptance machine**. DB vacuum and idle CPU/RSS profiling — also named in this task's scope — remain unmeasured. **Root cause found and NOT fixed** (a scheduler-algorithm change, out of this pass's scope — see `docs/architecture/scalability.md` and ADR list): `recurrence.ts` seeds a missing RRULE `DTSTART` at 1970-01-01, forcing `RRule.between()` to replay every occurrence since 1970 before returning any — measured at 25.76ms per enabled daily schedule, 6.18ms per weekly schedule, vs 0.11ms for the same rule with a near-window DTSTART (234x). This is CPU cost inside the RRULE library, not the SQL: the runs query alone is 12.43ms at 5,000 rows. Windowed-projection optimization landed anyway (`api.ts` GET /calendar now selects `task_name` via `json_extract` instead of the full frozen `jobspec_json` blob per row; `CalendarRunRowT` in `packages/ui/src/api.ts`; dead `safeName()` helper removed from `CalendarView.tsx`): payload dropped 10.16MB→1.15MB (8.8x) on the year view, satisfying NFR-3's "windowed fetch" language, but did **not** move latency (353.55ms→358.69ms in the single before/after pair that was measured; both numbers sit inside the run-to-run spread above, so that pair shows no latency win rather than proving no latency change) — the cost is CPU, not serialization. S-64's "counts per day, not events" aggregation is still not implemented; `/calendar` still returns one row per run. `packages/daemon/test/workforce-bench.test.ts`. |
| T-308 | MISSING | Launch kit (landing page exists as evidence asset; demo video/templates pack missing). |
| T-309 | PENDING-BETA | Hardening reserve opens with external beta. |
| T-310 | PARTIAL | Webhook (HMAC-signed) + Telegram adapters shipped; SMTP + WhatsApp-gateway adapters missing (interface accepts them without code changes). |
| T-311 | MISSING | Clockwork Mini widget (snapshot endpoint ships already — read-only aggregate scope). |

## Phase 4 — Agent Workforce (F1–F12)

Twelve features from `plan/AGENT-WORKFORCE-SPEC.md` (a separate spec from
`05-execution-plan.md`, hence F-IDs not T-IDs here). Migration `0008_agent_workforce.sql`
landed the schema; all twelve daemon modules, their `/workforce/*` routes, and
scheduler/run-manager wiring landed in the integration pass. `features.ts` now
reports each one's real implementation status (three `enforced`, nine
`available` — no `planned` placeholders remain for this batch). Full
per-feature detail, routes, and refusal-path notes: `docs/agent-workforce.md`.

| ID | Status | Notes / Evidence |
|---|---|---|
| F1 plan-then-execute | DONE | `plan_then_execute` (**enforced**): execute half of a booking stays `enabled=0` permanently; only a human's `resolve('approved')` books its run. ADR-041. `packages/daemon/test/plan-execute.test.ts`. |
| F2 shift-handoff | DONE | `shift_handoff` (available): per-task memory injected only when the prompt contains `{{handoff.previous}}`; human notes from F6 land here. `packages/daemon/test/handoff.test.ts`. |
| F3 office-hours | DONE | `office_hours` (**enforced**): defers approval-flagged tasks into declared windows. It marks the claimed occurrence `deferred` the way quiet hours does, but it deliberately does **not** pre-claim a ledger row at the resume instant, and it bumps `next_fire` for every schedule kind including `once` — both differences are the opposite of quiet hours and both are load-bearing (`scheduler.ts`, and the F3 section of `docs/agent-workforce.md`). Off by default, and **three setup steps, not two**: enable the pref, define windows, and enrol the task's profile in F7 autonomy — nothing else in the product sets `profiles.may_require_approval`, which is the flag this feature gates on. Fails open on any error. ADR-038. `packages/daemon/test/office-hours.test.ts`. |
| F4 sentinel-worker | DONE | `sentinel_worker` (available): cheap sentinel run books a worker through the existing trigger/policy path on trip; every evaluation (trip or not) is logged. `packages/daemon/test/sentinel.test.ts`. |
| F5 repo-shipped-jobs | DONE | `repo_shipped_jobs` (available): discovers `.clockwork/jobs.json`/`.yaml`, offers only, imports disabled with a security preview; job file cannot set permission mode/engine/budget — hardcoded to template-import defaults. ADR-040. `packages/daemon/test/repo-jobs.test.ts`. |
| F6 accept-with-note | DONE | `accept_with_note` (available): inbox accept/reject/accept-with-note; the acceptance signal F7/F10/F11 all read. `packages/daemon/test/acceptance.test.ts`, UI `OutcomeControls.tsx` mounted in `InboxView.tsx`. |
| F7 earned-autonomy | DONE | `earned_autonomy` (**enforced**): offer-only, opt-in ladder `plan→acceptEdits→unattended`; unenrolled profiles are unconstrained; ceiling enforced as a second 403 gate at 3 call sites, ahead of the write. **Only the bottom rung refuses anything.** `acceptEdits` and `unattended` both map to permission mode `acceptEdits` (`AUTONOMY_RUNG_SETTINGS`, `packages/shared/src/workforce.ts`), so the gate — which fires only on `allowed === 'plan'` — never fires for either. The `acceptEdits → unattended` promotion changes no permission and blocks no run; it only clears `may_require_approval`, whose one reader is F3 office hours, so its whole effect is "this profile's tasks stop being deferred into office hours", and only while F3 is on. Enrolling or accepting an offer also **overwrites** `profiles.permission_mode` with the rung's mode. ADR-037. `packages/daemon/test/autonomy-policy.test.ts`. |
| F8 self-healing | DONE | `self_healing` (available): N-failure streak books one diagnostic run in `plan` mode; output is an approval item, never a self-applied edit. ADR-039. `packages/daemon/test/self-healing.test.ts`. |
| F9 proposed-events | DONE | `proposed_events` (available): report `proposedEvents[]` → downloadable `.ics`; no write path to any real calendar. **Currently returns `[]` for every run** — no shipped runner/profile populates the field yet. ADR-042. `packages/daemon/test/proposed-events.test.ts`, UI `ProposedEvents.tsx` mounted in `InboxView.tsx`. |
| F10 agent-timesheets | DONE | `agent_timesheets` (available): per-profile hours/cost/effective-rate over a date range. Measured on 2026-09-06 over ten runs (six of the bench alone, four inside the full suite), 5k-run corpus, n=25 each: full 365d window median **16.95–47.49ms**, p95 **17.45–64.94ms**. Filtering to one profile is the same SQL with a JS-side filter, so it costs the same to within the noise (median 16.66–35.75ms). The low end of the range is a quiet machine and the high end a loaded one; two earlier revisions of this row gave first a single-run number and then a three-run range, and neither survived a loaded machine. `packages/daemon/test/timesheets.test.ts`. |
| F11 performance-reviews | DONE | `performance_reviews` (available): per-profile scorecard (acceptance/failure rate, cost trend), plain SQL, no model call; `/review-prompt` returns prompt text only — no seeded reviewer profile writes the prose automatically. Measured on 2026-09-06 over ten runs (six of the bench alone, four inside the full suite): one profile (2 windowed scans) median **13.06–34.45ms**, p95 **13.62–64.35ms** (n=25); all 7 groups (15 full scans of `runs`) median **101.97–232.68ms**, p95 **112.87–269.04ms** (n=15) — the most expensive workforce query, driven by scan count rather than row count. No bound is claimed for it. The low end of each range is a quiet machine and the high end a loaded one; a single number for either would be that machine's number, not the code's. `packages/daemon/test/performance.test.ts`. |
| F12 proof-of-work-export | DONE | `proof_of_work_export` (available): self-contained masked/escaped HTML export, no external references, `includeTranscript` off by default, audited. `packages/daemon/test/proof-of-work.test.ts`. |

**S-9 tick loop at scale, recurring shape (new coverage, pre-existing cost, no workforce regression):** the pre-existing 500-task/50-due scale fixture (`scheduler.test.ts:317-325`) has only ever seeded `kind:'once'` schedules, which short-circuit `occurrencesBetween` — it never measured the recurring path production actually runs. `workforce-bench.test.ts` adds that case: 500 tasks/50 due, all `FREQ=DAILY`: 1439.55–1581.01ms across three isolated runs (2026-09-06), and 1497.04ms in one earlier run under full-suite contention, vs 12.92–17.97ms for the `'once'` shape — same DTSTART-1970 replay cost as the T-307 calendar finding above (26.89ms per fire). This is pre-existing T-103 scheduler code; none of the twelve workforce features touch it, so it is not a workforce regression, and it is still inside both the fixture's 5s bound and the 30s tick budget.

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

Every row below was re-counted from one `rtk proxy pnpm test` run on
2026-09-06, and the rows now sum to the total — an earlier version of this
table listed only some suites while calling the last row a total, and
overstated the feature-module row by 36.

| Suite | Count | Location |
|---|---|---|
| Runner unit/scenario | 116 | `packages/runner/test/*` (15 files) |
| Daemon scheduler fixtures | 18 | `packages/daemon/test/scheduler.test.ts` |
| API contracts | 31 | `packages/daemon/test/api.test.ts` |
| Full-loop child-process integration | 4 | `packages/daemon/test/full-loop.test.ts` |
| Recovery (real orphan kills) | 3 | `packages/daemon/test/recovery.test.ts` |
| Templates/chains | 9 | `packages/daemon/test/templates-chains.test.ts` |
| Agent Workforce F1–F12 (feature modules) | 321 | `packages/daemon/test/{plan-execute,handoff,office-hours,sentinel,repo-jobs,acceptance,autonomy-policy,self-healing,proposed-events,timesheets,performance,proof-of-work}.test.ts` |
| Agent Workforce foundation + API contracts | 97 | `packages/daemon/test/workforce-foundation.test.ts` (16), `packages/daemon/test/workforce-api.test.ts` (81) |
| Agent Workforce performance bench (T-113/T-307/S-9) | 16 | `packages/daemon/test/workforce-bench.test.ts` |
| Claim tripwires (this table, the bench gate, the F3/F7 prose, the latency record) | 33 | `packages/daemon/test/claims-honesty.test.ts` |
| Other daemon suites (13 files) | 71 | chains, entitlements, event-prompts, feature-honesty, gates, ics, ics-ssrf, install-instructions, landing-honesty, loopback-bind, policy-engine, quiet-hours, triggers |
| UI component tests (5 files) | 33 | `packages/ui/test/*` |
| **Total automated (measured 2026-09-06, `rtk proxy pnpm test`)** | **752 passed, 0 failed, across 54 files** | full run: daemon + runner + shared + ui workspaces (`packages/shared` ships no test file of its own) |

**The bench does not assert its latency bounds in this run.** Every wall-clock
bound in `workforce-bench.test.ts` goes through `assertLatency`
(`packages/daemon/test/helpers/bench-gate.ts`), which measures and prints the
number but only fails when `CLOCKWORK_BENCH_ASSERT=1` is set. One session on
2026-09-06 is the demonstration: six gated runs of that bench, on one laptop
at one commit inside 90 minutes, split **three red / three green** — red at
`uptime` load averages of 12.5–27.1, green at 7.4–7.9, and every single
failure a T-307 calendar bound. The default `rtk proxy pnpm test` was green
across all 54 files in both conditions. Correctness assertions in that file
(corpus size, row counts, HTTP status, response shape) are never gated, and
they are what a green run actually proves. To gate on the numbers, run
`CLOCKWORK_BENCH_ASSERT=1 npx vitest run test/workforce-bench.test.ts` from
`packages/daemon` — and read a red result as "this machine is busy, or this
code got slower", because the bench cannot tell you which.

**One caveat on the total, from the same session.** The count reproduces; the
process exit code does not always agree with it. Of the full-suite runs made
on 2026-09-06 while this pass was adding and then removing tripwires (totals
748 → 754 → 752 as the tripwire set changed, and 752 on every run after
that), **two reported their full count with zero failures and still exited
non-zero**, on the same unhandled rejection originating in
`packages/daemon/test/api.test.ts`:
`TypeError: The database connection is not open` inside `RunManager.finalize`
→ `recordEvent` (`packages/daemon/src/run-manager.ts:649`, then line 876).
No test failed; a run finalized asynchronously after its test had closed the
database. So the count reproduces and the exit code does not — read "752
passed, 0 failed" as the claim, and treat a non-zero exit with no failing test
as this race until it is fixed. It is recorded rather than fixed here because
it is a teardown race in daemon code this pass did not own.

Manual logs: sandbox escape matrix (13 checks) `spikes/reports/T008-sandbox.md`; live smoke (boot→book→fire→report→search) recorded in commit e583e01; real-engine verification runs T-001/T-008/T-009.
