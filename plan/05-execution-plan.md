# Clockwork — Execution Plan

Phased task breakdown. Each task: ID, deliverable, acceptance criteria (AC), scenario coverage (S-xx from `04-scenarios.md`), estimate in ideal engineer-days (ed) assuming AI-assisted development. **Do tasks in order within a phase; phases gate on exit criteria.**

Team assumption: 1 senior full-stack engineer (TypeScript-strong) + AI pairing. A second engineer parallelizes UI vs daemon tracks from Phase 1 (≈35–40% calendar compression).

> **Re-baselined after adversarial review round 1** (`reviews/codex-sol-review-round1.md` #29/#30/#31): original totals were internally inconsistent and ~2× optimistic; safety work was sequenced after external exposure. This version fixes both. Windows/Linux moved post-v1.

---

## Phase −1 — Evidence sprint (Weeks 1–2, overlaps Phase 0; mostly founder-work, not eng-days)

| ID | Task | AC | Est |
|---|---|---|---|
| T-011 | 15 problem interviews with target personas (Claude Max subscribers with ≥2 active repos; recruit via X/Discord/HN) using a written script: current recurring chores, what they'd schedule, what they'd trust unattended, willingness to run a daemon | Recordings + coded notes; ≥40% independently describe a concrete job they would schedule *this week* | 4 |
| T-012 | Landing page smoke test: the honest pitch (awake-machine constraint included) + waitlist asking "what job would you schedule?" | ≥5% visitor→waitlist-with-use-case conversion on ≥300 visitors | 2 |
| T-013 | Evidence readout: proceed / pivot-persona / stop memo appended to DECISIONS | Written verdict with the numbers | 0.5 |

**Gate G-1:** Phase 1 spend is not authorized until the evidence bar is met or a conscious, written override is logged.

## Phase 0 — Spike: prove the engine (Weeks 1–2, go/no-go gate)

Goal: kill the riskiest assumptions cheaply. **No product code — throwaway allowed.**

| ID | Task | AC | Est |
|---|---|---|---|
| T-001 | **CLI runner PoC (the default engine)**: script takes `{prompt, repoPath, budgetUsd, timeoutSec}` → creates worktree → runs `claude -p --output-format stream-json` → writes report JSON (summary, diffstat, cost/turns from stream events). Verify: per-event usage granularity, `--permission-mode` behavior, `--resume <session>`, structured summary extraction. **Runs on the subscription login — no API key.** | Real run completes on a toy repo; report JSON matches draft schema; telemetry granularity recorded; soft-cap overshoot measured | 2 |
| T-002 | Interruption matrix on T-001: SIGTERM/SIGKILL the run; enforce timeout; enforce cost cap mid-run; verify worktree state after each | All four interruptions leave: recoverable repo state, truthful final state, no zombie processes (identity-verified pgid kill) | 1.5 |
| T-003 | **HITL model decision, per engine**: CLI — permission-prompt MCP hook held open ≥4h, answer, verify continuation; `--resume` fallback fidelity. SDK — `canUseTool` keep-alive + session resume. Document what each "resume" actually replays | Written comparison; primary model verified per engine; FR-12/S-58 contract confirmed or redesigned | 2 |
| T-004 | Auth + capacity probes: run with expired/absent auth (S-40); identify error classes for rate-limit vs capacity-window vs auth — from CLI stream-json and SDK errors | Error taxonomy documented per engine → feeds runner error mapper | 1 |
| T-005 | Scheduler micro-PoC: 30s tick loop + rrule + Luxon + **occurrence-ledger claim transaction**; fake-clock DST fixtures for S-20/S-21/S-25 + double-fire attack test | Fixtures pass across 4 zones; concurrent-claim test cannot double-fire | 1 |
| T-006 | **Auth posture memo (R-5, now narrower)**: CLI-default means users drive their *own* installed Claude Code under their own login — document that posture, remaining ToS considerations for a scheduler, daemon-context (no TTY) auth expiry UX, and the SDK/API-key option | Written memo; expiry UX defined; SDK option posture stated | 0.5 |
| T-007 | **Engine contract matrix v1**: every assumption in `06 §5` tested **per engine** (CLI and SDK) against pinned versions; matrix doc records version, test, result, capability flags the daemon reads at runtime | `plan/engine-contract-matrix.md` exists; re-run procedure documented for every pin/CLI-version bump | 1.5 |
| T-008 | Sandbox PoC: run T-001 inside a Seatbelt profile (worktree rw, repo ro, credential paths denied); attempt escapes (S-86 cases); confirm the spawned `claude` CLI + its tools function inside the profile | Escapes denied + logged; agent still functions (npm/git work inside allowlist) | 1.5 |
| T-009 | **Profile materialization PoC**: write a profile's skills/subagents + system-prompt-extra into the worktree `.claude/`, run via CLI, verify the skill actually loads and fires | A booked profile demonstrably changes run behavior; no global config mutation | 1 |

**Gate G0 (exit):** all green, including: CLI engine proves usage telemetry + HITL hook + resume (T-001/T-003 — if the CLI can't support HITL, M1 ships CLI with fail-safe-on-permission and the SDK engine moves up to M1 for HITL users), auth posture written (T-006), sandbox viable with the CLI toolchain inside it (T-008), profiles demonstrably load skills (T-009). Any red → redesign before Phase 1, or stop. Results feed adversarial review round 2 (mandatory before Phase 1).

## Phase 1 — MVP core loop (Weeks 3–14) → M1 private alpha

### Track A — Daemon & runner

| ID | Task | AC / Scenarios | Est |
|---|---|---|---|
| T-101 | Monorepo scaffold (pnpm, packages/{daemon,runner,ui,shared}), CI (lint, vitest, build) | CI green on empty packages | 1 |
| T-102 | SQLite schema + Drizzle migrations + WAL/`synchronous=FULL` config + on-disk run-dir layout (`02-architecture.md` §1) | Migration up/down; crash-mid-write test (S-34 partial) | 2 |
| T-103 | Scheduler service: tick loop, next_fire materialization, **occurrence-ledger claims**, missed detection + policies + coalescing, wake/power-event hooks (macOS), keep-awake assertions (FR-25) | S-1…S-17, S-20…S-26 fixtures green incl. double-fire attacks | 7 |
| T-104 | Run manager: FSM (incl. `awaiting_user`), global semaphore, per-repo mutex, queue, overlap policies; synchronous state persistence + events table; single-instance lock | S-2, S-3, S-4, S-8, S-80, S-81; kill -9 recovery suite S-30…S-33 | 7 |
| T-105 | Runner package: `AgentRunner` interface + **`ClaudeCliRunner`** (productionize T-001/T-002): worktree lifecycle (hooks-off default, S-84), **profile materializer (.claude/ injection, T-009)**, context assembly (files), stream-json telemetry parser, budget guard (soft-cap + hard turn/time), deny-list policy hooks, sanitized env, per-run socket IPC + heartbeat, on-disk journal, report serializer, disk-floor monitor | S-13, S-35…S-39, S-44, S-45, S-55(M1 fail-safe), S-67, S-85, S-88 | 10 |
| T-106 | Runner error mapper (from T-004 taxonomy): auth, rate-limit, capacity, offline pre-flight, auto-pause-after-2 rule | S-40…S-42, S-46…S-48, S-87 | 2.5 |
| T-107 | Daemon API (Fastify): tasks/runs/reports/health CRUD + SSE events + bearer token + optimistic task versioning | API contract tests; UI-less curl walkthrough of US-1; S-82 | 3 |
| T-108 | Service install: launchd LaunchAgent gen + health check + `clockworkd doctor` CLI | Starts at login, restarts on crash; doctor detects 6 canned misconfigs incl. duplicate instance | 3 |
| T-109 | Notifier v1: daemon-side native OS notifications + quiet hours | S-65; notifications work with UI closed | 1.5 |
| T-110 | Retention/pruning job + startup worktree reconciliation | S-33, FR-19 | 2 |
| T-111 | **Sandbox containment productionized** (from T-008): per-run Seatbelt profile generation, context-roots allowlist, symlink resolution, safety journal (FR-26/27) | Sandbox escape suite green in CI; S-86; **gate blocker for any external user** | 5 |
| T-112 | **Profiles-lite (FR-28)**: profiles table, 3 seeded built-ins (Generalist / Dep Surgeon / Docs Scribe), **bundled skill pack authored + shipped in-app (versioned, name@version pinning)**, composer selector + `@mention` resolution, profile identity chips across calendar/inbox/reports | US-11; profile defaults flow into JobSpec snapshot; built-in skills demonstrably load with zero user setup | 4 |
| T-113 | **Inbox search (FR-29-lite)**: FTS5 `search_idx`, index-on-finalize, `GET /search`, inbox search box with highlight | US-14 (inbox scope); 5k-run corpus <100ms | 2.5 |
| T-114 | **ASAP queue mode (FR-4/FR-6)**: `queue` schedule kind, wait-reason computation, queue lane UI (position, reorder, bump, cancel), calendar unscheduled tray | US-16; S-27…S-29 | 2 |

### Track B — UI (parallelizable from T-107 stub)

| ID | Task | AC / Scenarios | Est |
|---|---|---|---|
| T-121 | Tauri shell: window + tray (daemon health, next 3 runs, pause-all), token handshake, auto-launch daemon if down | Tray reflects live SSE health | 3 |
| T-122 | Calendar view (FullCalendar): month/week/day; past runs colored by outcome; future occurrences rendered from schedules; click-slot → composer; machine-availability hint | S-60, S-64 (windowed fetch) | 5 |
| T-123 | Composer v1: prompt, repo picker (validated), base branch, model, permission mode, budget, schedule (once + RRULE builder), missed/overlap policies; zod-shared validation | S-23, S-26, S-36, S-69 | 4.5 |
| T-124 | Inbox + Run Report view: list, unread, filters; report page (summary, diff viewer, transcript viewer from disk, cost, timeline); "open branch in editor" | US-1 review path; S-39, S-68 masking | 5 |
| T-125 | Settings + onboarding (detect Claude auth incl. API-key path, power-model expectations screen, sample task) | S-40 surfaced in onboarding; FR-21, FR-25, S-17 | 2.5 |
| T-126 | Run detail live view: streaming state + heartbeat + cancel button | S-12 visibility, FR-14 | 2 |

**Gate G1 (M1 exit):** US-1/US-2/US-4/US-9 demo end-to-end on a fresh Mac by someone who didn't build it, using only the app (no terminal). Fixture suites (scheduler, FSM, MockRunner, **sandbox escape**) green in CI. **T-111 sandbox + T-105 env hygiene are hard blockers — no build leaves the builder's machine without them.** Dogfood starts: ≥3 real recurring jobs on the builder's machine for 2 weeks with zero silent failures (silent failure = anything wrong that produced no inbox/notification signal).

## Phase 2 — Trust & leverage (Weeks 15–20) → M2 public beta

| ID | Task | AC / Scenarios | Est |
|---|---|---|---|
| T-201 | HITL end-to-end (keep-alive model from T-003): ESCALATE path, `waiting_approval` persistence, approval inbox UI, CAS on responses, runner-death fallback, timeouts + fallbacks | S-50…S-58 (MockRunner + real-SDK tests incl. a 4h-held approval) | 7 |
| T-202 | Chaining (linear): validation, `{{previous.*}}` prompt assembly bound to triggering run, ghost rendering on calendar | S-70…S-73, S-76 | 4 |
| T-203 | Templates: save/apply/param-fill; export/import JSON with security preview (imported = disabled) | S-74, S-75 | 3 |
| T-204 | Crash-recovery hardening pass: orphan terminate+journal-report (S-31), reboot sweep, disk-full behavior, DB backup-on-migrate, updater drain | S-31, S-34, S-61, S-81, S-83 | 5 |
| T-205 | Packaging: signed DMG, notarization, tauri-updater channel, versioned daemon handshake | S-61, S-62; update applied on a dogfood machine | 4 |
| T-206 | Beta telemetry (consent-screened, on-by-default in beta, structure-only) + crash reporting + one-click incident report | Documented in privacy note; kill-criteria metrics observable (finding #33) | 2 |
| T-207 | Docs site v1 + 5 canonical templates (nightly deps, test triage, TODO digest, changelog draft, repo health) | A stranger sets up first recurring job in <10 min | 2.5 |
| T-208 | License finalized (default: FSL-style source-available) + repo published + contribution policy | ADR-009 closed before first external build | 1 |
| T-209 | **Profile editor + custom profiles, fully in-app** (FR-28 full): create/edit/duplicate-a-built-in from the composer's "＋ New profile", skill picker across bundled ∪ user ∪ repo skills, export/import (disabled-on-import), per-profile engine choice | US-11/US-17; a new profile is bookable within 2 minutes, no config files; S-74 rule applied to profiles | 3.5 |
| T-210 | **⌘K command palette** (FR-29): global search across tasks/runs/templates/profiles/approvals + quick actions | US-14 full | 2.5 |
| T-211 | **Telegram delivery** (`DeliveryChannel` interface + first chat adapter): bot-token setup flow, per-task channel selection, payload schema | US-13 (Telegram); S-43 retry semantics | 2 |
| T-212 | **`ClaudeSdkRunner` engine option** (from T-00x SDK probes): global + per-profile engine switch, capability-flag plumbing, degraded-UI states | Engine matrix drives UI; both engines pass the MockRunner conformance suite | 3 |

**Gate G2 (M2 exit):** 20 external beta users; ≥60% create a recurring job in week 1; HITL round-trip demonstrated in the wild; zero data-loss incidents; **zero containment escapes**.

## Phase 3 — v1 launch, macOS (Weeks 21–30) → M3

| ID | Task | AC / Scenarios | Est |
|---|---|---|---|
| T-301 | Capacity assistant (**feature-flagged**): usage sampling, window forecasting, calendar band labeled "estimate", collision warnings; auto-shift behind flag | S-47; ships only if beta precision ≥70% (FR-7), else cut | 5 |
| T-302 | Delivery settings center: per-task channel config UI, keychain-backed credential setup, test-send flow per channel | S-43; channel setup <2 min each | 2.5 |
| T-303 | Auto-PR option via `gh` (draft PR, template body from report) | US-1 full; S-37 | 1.5 |
| T-306 | URL + MCP context attachment (per-task MCP allow-list from user's Claude config; retry-off default for side-effect tasks) | FR-2b/c; S-89; prompt-injection stance documented in-product | 3.5 |
| T-307 | Performance pass: 5k-run calendar, DB vacuum, idle profiling vs NFR-3 | NFR-3 numbers met on a base M1 Air | 3 |
| T-308 | Launch kit: landing page (honest power-model copy), demo video, 10 templates, launch narrative | Launch | 2.5 |
| T-309 | Beta-feedback hardening reserve (bugs, polish, the unknowns every beta surfaces) | Burn-down of P0/P1 beta issues to zero | 10 |
| T-310 | **WhatsApp-gateway + generic webhook + SMTP adapters**: gateway URL config + test-send flow, HMAC signing, channel docs (incl. self-hosted bridge recipe) | US-13 full; S-43 | 3 |
| T-311 | **Clockwork Mini widget**: always-on-top compact window, `GET /widget/snapshot`, click-through to inbox/approvals | US-15; snapshot read-only scope | 2.5 |

**Gate G3 (v1):** All fixture suites green; 30-day dogfood streak without a trust incident; kill-criteria metrics observable; capacity assistant ship/cut decision recorded.

## Post-v1 — platform expansion (first two releases after launch)

| ID | Task | AC / Scenarios | Est |
|---|---|---|---|
| T-401 | Windows: Job-Object supervision, power broadcasts, toast notifier, MSI + EV signing, sandbox equivalent investigation | Full fixture suite on Windows CI runner | 10 |
| T-402 | Linux: systemd --user, bubblewrap sandbox, notify-send, AppImage | Fixture suite on Ubuntu runner | 4 |

---

## Effort & calendar summary (re-baselined)

| Phase | Ideal eng-days | Calendar (1 eng) | Calendar (2 eng) |
|---|---|---|---|
| −1 — Evidence | 6.5 | 2 wk (overlaps) | 2 wk (overlaps) |
| 0 — Spike | 12 | 2.5 wk | 1.5 wk |
| 1 — MVP | ~73 | 11–13 wk | 7–8 wk |
| 2 — Beta | ~39.5 | 7–9 wk | 4–5 wk |
| 3 — v1 (macOS) | ~33.5 | 7–9 wk | 4–5 wk |
| **Total to v1** | **~165 ed** | **~29–35 wk (7–8 mo)** | **~17–20 wk (4–5 mo)** |
| Post-v1 Win+Linux+WidgetKit | ~18 ed | +4–5 wk | +2.5 wk |

Calendar math is explicit: 1 engineer ≈ 4.5 effective ed/week (meetings, support, dogfood ops, review); ranges include a 20% integration buffer. The deepest-padded items are **T-103/T-104/T-105 (time + crash + runner correctness), T-201 (HITL), T-111 (sandbox)** — matching the risk register (R-3, R-6) and review findings #29/#30/#31. The dual-engine + profiles + channels + search additions (2026-07-16 scope revision, ADR-016…019) added ~25 ed; they were priced in rather than absorbed silently.

> **Note — the bundled skill pack is a content workstream, not just engineering.** T-112's three built-in profiles are only as good as their skills: `dependency-triage`, `test-doctor`, and `docs-writer` need real authoring, testing against real repos, and their own quality bar (each skill gets a golden-fixture eval before it ships; a bad built-in skill poisons first-run trust — the moment we most need it). Budget the authoring inside T-112's 4 ed and treat pack updates as release-noted product changes, never silent bumps (name@version pinning per FR-28).

## Working agreements

1. **Scenario-driven development**: no task is "done" until its listed S-IDs have tests or a written [manual] verification log.
2. **Decisions log discipline**: any deviation from `02/03/04` docs → DECISIONS.md entry same day.
3. **Dogfood from M1**: the builder's own machine runs ≥3 real jobs continuously; every silent failure becomes a P0.
4. **No scope creep across the cut-line**: new ideas go to `vision/ROADMAP.md`, not the current phase.
