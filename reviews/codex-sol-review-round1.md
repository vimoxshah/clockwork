# Adversarial Review — Round 1

- **Reviewer:** Codex `gpt-5.6-sol` (codex CLI 0.144.1, read-only sandbox, hostile-reviewer prompt)
- **Date:** 2026-07-16 · **Raw transcript:** `codex-raw-output.txt`
- **Verdict: RETHINK** — 33 findings (12 CRITICAL, 15 HIGH, 6 MEDIUM/LOW)
- **Reviewer's top-3 survival changes:** (1) validate the auth/economics premise and demand evidence before building; (2) replace the security *posture* with a real containment boundary before any external user; (3) re-baseline estimates and fix the scheduler/HITL correctness core.

**Disposition: accepted.** The plan was revised in place on 2026-07-16 (same day). Triage below; every ACCEPTED row names where the fix landed. Two findings are PARTIAL with written rationale; none rejected outright.

---

## Triage table

| # | Sev | Finding (condensed) | Disposition | Resolution |
|---|---|---|---|---|
| 1 | CRIT | **Auth/ToS premise unproven** — plan assumes subscription (Claude Max) auth may power a third-party daemon's SDK runs; if Anthropic restricts that, "zero COGS / rides your subscription" collapses and unit economics change | ACCEPT | API-key mode is now the **baseline**; subscription reuse is an upside to be verified at Phase 0 (new T-006 policy/tech probe, gate G0). VISION §4/§8, risks R-5→top-tier, assumptions §5 rewritten |
| 2 | CRIT | **Sleeping-laptop fallacy** — "wake up to results" requires an awake machine at 2am; the flagship story is physically false for default laptop users | ACCEPT | Honest execution model added everywhere: runs fire when the machine is awake; H1 ships **power assertions** (keep-awake window when plugged in, macOS first) + scheduled-wake attempt where OS allows + explicit "always-on machine / run before sleep" guidance; overnight story reframed. Spec FR-25, scenarios S-16/S-17, VISION §2 |
| 3 | HIGH | Competitive scan too shallow (Anthropic cloud routines, OpenAI/Codex equivalents, cron+CI incumbents) | ACCEPT | VISION §4 competition paragraph expanded; R-1 tripwire broadened to any first-party scheduled-agents surface |
| 4 | HIGH | **No demand evidence** — plan builds 4 months on zero user interviews | ACCEPT | New **Phase −1: evidence sprint** (2 wks, overlaps Phase 0): 15 target-persona interviews + landing-page smoke test with explicit evidence bar before Phase 1 spend |
| 5 | CRIT | Capacity-aware scheduling oversold as flagship — no official quota API; heuristic model will be wrong and burn credibility | ACCEPT | Demoted from flagship to "estimate-grade, feature-flagged, ships only if precision bar met" (VISION §5 rewritten; FR-7 relabeled; T-301 gated) |
| 6 | HIGH | North-star metric gameable; "reviewed runs" measures opens, not value | ACCEPT | North-star → **accepted outcomes/user/week** (branch merged, artifact used, or explicit 👍) + 8-week recurring-job survival as guardrail (VISION §9) |
| 7 | MED | Break-even math ignores payments/licensing/support build cost + conversion reality | ACCEPT | §4 of risks/costs reframed as gross-revenue sanity only; commercialization named as unbuilt H2 scope; H1 explicitly unmonetized |
| 8 | MED | License stance ambiguous ("source-available TBD" undermines the trust argument it's invoked for) | ACCEPT | ADR-009 amended: default = FSL-style source-available, decision deadline = before first external beta build (T-208) |
| 9 | CRIT | **Worktree ≠ security boundary** — same-user process can touch anything; "guaranteed by construction" claim is false as a security statement | ACCEPT | Reframed: worktree = *accident isolation*; **OS sandbox = containment** (macOS Seatbelt profile: FS allowlist worktree+scratch+repo-read, credential paths excluded; Linux bubblewrap; leverages the sandboxing the Claude Code toolchain already ships). New FR-26, T-111, NFR-2 rewritten |
| 10 | CRIT | Deny-list floor is pattern-matching theater (aliases, scripts, indirect writes bypass it) | ACCEPT | Deny-list demoted to *policy/UX layer* on top of sandbox containment; docs no longer claim it prevents anything an adversarial prompt couldn't route around (FR-11 rewritten, ADR-008 superseded by ADR-012) |
| 11 | HIGH | `bypassPermissions` mode present in H1 spec contradicts the whole trust story | ACCEPT | Removed from H1 composer entirely (FR-1); revisit post-v1 behind the global scary flow |
| 12 | HIGH | Runner env/secret hygiene unspecified (runner inherits daemon env; delivery creds reachable) | ACCEPT | Architecture §7: runner spawns with sanitized env (only what the SDK needs); delivery creds never enter runner process (notifier is daemon-side, now explicit); per-run IPC socket + one-run nonce, runner never holds the UI bearer token |
| 13 | HIGH | "Code never leaves the machine" is false (Anthropic API, Slack, SMTP) | ACCEPT | All privacy copy now: "no Clockwork-hosted cloud; data flows only to Anthropic and deliveries you configure" (VISION §5, NFR-4) |
| 14 | CRIT | **Double-fire hole** — no occurrence ledger; crash between fire and next_fire rewrite → duplicate runs; S-25 dedupe index referenced but absent from DDL | ACCEPT | New `schedule_occurrences` table, UNIQUE(schedule_id, occurrence_at), atomically claimed in the same transaction that enqueues the run (arch §1 + §4) |
| 15 | HIGH | Schema gaps: overlap_policy, retry flags, base_branch, soft-delete, runs→occurrence link, `ask_user` state missing from FSM/DDL | ACCEPT | DDL updated; FSM includes `awaiting_user` (missed-policy *ask*) |
| 16 | HIGH | "Chains are DAGs" but schema is single-parent; no fan-in semantics; successor/run binding undefined | ACCEPT | H1 chains are **linear** (single parent), stated honestly; successor binds to triggering run id; DAG/fan-in deferred to H2 (FR-8, S-76) |
| 17 | CRIT | **HITL resume-from-new-process is the wrong primary design** — `canUseTool` is an in-process pending callback; session resume restarts a turn rather than resuming mid-tool-call | ACCEPT | Primary model now **keep-alive runner** (process stays alive in `waiting_approval`, callback pending; cheap — it's idle); resume-from-new-process demoted to fallback probe. T-003 rewritten to decide between them; FSM + FR-12 updated |
| 18 | HIGH | Orphan-runner "re-adoption" hand-waves a distributed-systems problem (pid reuse, IPC reattach, split-brain) | ACCEPT | Re-adoption **cut from H1**: daemon restart terminates orphaned runners (start-time-verified pgid), marks `failed:orphaned`, report built from the runner's on-disk journal. Honest and testable (S-31 rewritten, ADR-011) |
| 19 | HIGH | pgid semantics are POSIX-only; Windows needs Job Objects | ACCEPT | Arch notes per-platform supervision (POSIX pgid / Windows Job Objects); Windows already M3+ and now explicitly post-v1 (see #29) |
| 20 | HIGH | Service lifecycle claims wrong (launchd user agents are login-session scoped; "survives logout" false; node-windows flaky) | ACCEPT | FR-20 rewritten: login-session service, starts at login, restarts on crash; docs stop claiming logout survival; `doctor` checks reflect reality |
| 21 | HIGH | Daemon can't use Tauri notification API (it's not the Tauri process) when UI closed | ACCEPT | Notifier: daemon-side native path (osascript/notify-send/PowerShell toast) + tray as rich surface when UI alive (stack #13 fixed) |
| 22 | HIGH | SQLite durability under-specified; transcripts as DB blobs will bloat + slow | ACCEPT | `synchronous=FULL` on state-transition writes; transcripts/artifacts on disk under `~/.clockwork/runs/<id>/`, DB stores summary + pointers (arch §1, stack #9) |
| 23 | HIGH | Budget cap is a **soft** cap (telemetry lags; last message overshoots); subscription mode has no dollar meaning | ACCEPT | FR-10 relabeled "soft cap with bounded overshoot"; turn/time caps are the hard bounds; T-001 measures overshoot; subscription mode surfaces turns/time not dollars |
| 24 | HIGH | SDK assumptions unversioned — no contract matrix pinning what was verified against which SDK version | ACCEPT | Phase 0 deliverable: `plan/sdk-contract-matrix.md`, re-run on every pin bump (T-007) |
| 25 | HIGH | Missing scenarios: daemon single-instancing, concurrent task edits (UI race), reboot mid-run, updater replacing daemon mid-run | ACCEPT | New scenario section G (S-80…S-88) |
| 26 | HIGH | Git edge cases missing: repo-managed hooks firing in worktrees, submodules, LFS, symlink escape from context roots, detached HEAD base | ACCEPT | S-84…S-88 added; runner sets `core.hooksPath=/dev/null` equivalent per-worktree… **no** — decision: hooks *disabled by default* in Clockwork worktrees (documented), configurable per task |
| 27 | MED | Approval response race (two UI surfaces respond; timeout fires while user clicks) | ACCEPT | Approvals get compare-and-set on `responded_at` (S-57) |
| 28 | MED | Side-effect idempotency beyond git (agent sends email/creates tickets twice across retry) | ACCEPT | Retry policy defaults to **no auto-retry** for tasks with MCP/external side effects; S-89 documents the stance; per-run idempotency key passed into prompt context |
| 29 | CRIT | **Estimate arithmetic broken** — 41 ed ≠ 6–7 wk for 1 eng; ~86 ed total vs 16–18 wk claim is internally inconsistent; scope is 120–300 ed in reality | ACCEPT | Re-baselined honestly: macOS-only v1, Windows/Linux moved post-v1; new totals ~120–170 ed, calendar 5–7 months solo; costs updated (~$95–130k contracted) |
| 30 | CRIT | T-103/104/105/201/205/301/304/306 individually underestimated 2–4× | ACCEPT | Per-task estimates raised (see revised tables); the four correctness-critical tasks (scheduler, FSM, runner, HITL) now carry the largest numbers |
| 31 | HIGH | Safety sequencing wrong: external alpha (G1) precedes sandbox hardening | ACCEPT | Resequenced: sandbox (T-111) + env hygiene are Phase 1 gate G1 blockers — no external user before containment |
| 32 | MED | Dangling references (S-15 cited but doesn't exist; ID gaps) | ACCEPT | Fixed; scenario IDs now contiguous per section or explicitly reserved |
| 33 | HIGH | Kill-criteria tripwires unobservable under privacy stance (no telemetry → can't measure incidents/1,000 runs) | ACCEPT | Local-only always-on **safety journal** (deny/sandbox events, per-machine) + one-click anonymized incident report; beta builds default telemetry-on with consent screen; kill-criteria wording updated |
| — | — | (PARTIAL notes) #7: we keep the simple break-even table *labeled as sanity math* rather than building a full financial model pre-evidence; #26: hooks-off default chosen over hooksPath surgery after checking git behavior — both rationales recorded in DECISIONS ADR-011/ADR-013 | | |

## What did NOT change

- The core thesis (schedule-first calendar; Book→Run→Review; local-first; SDK as engine; three-process split; SQLite single-writer). The reviewer attacked execution and honesty, not the shape — no finding argued the product shouldn't exist. Verdict RETHINK is honored by re-baselining economics-proof, containment, correctness core, and estimates *before* Phase 1, not by restarting the plan.

## Round 2

A second adversarial pass is required after Phase 0 completes, reviewing: sdk-contract-matrix.md results, the Phase −1 evidence readout, and the revised Phase 1 scope. Do not start Phase 1 without it.
