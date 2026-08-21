# Clockwork — Risks & Costs

## 1. Risk register

Scored Impact × Likelihood (H/M/L). Every H×* risk has a mitigation **and** a tripwire (the observable that says the risk is materializing).

| ID | Risk | I×L | Mitigation | Tripwire |
|---|---|---|---|---|
| R-1 | **Anthropic ships first-party scheduling/calendar** in Claude Code or claude.ai | H×M | Differentiate where a platform vendor won't: cross-repo local orchestration, capacity intelligence, template library, multi-vendor seam (ADR-007). Ship fast; own the UX layer, not the API layer. | Anthropic changelog mentions "scheduled tasks/routines" for Code surfaces |
| R-2 | **Engine churn**: Claude Code CLI flag/stream-format changes (users update it themselves — we don't pin their CLI) or Agent SDK breaking changes | H×M | Engine contract matrix re-run on CLI version change (runner records `claude --version` per run); stream parser tolerant + versioned; nightly real-engine smoke suite; runner isolates 100% of engine contact (ADR-007/016) so migrations touch one package | Smoke suite red; parse errors in run journals after a user's CLI update |
| R-3 | **HITL mechanics fail** — keep-alive callback can't be held long, and fresh-session resume degrades badly | H×M | Phase 0 T-003 decides the primary model *before* product code; keep-alive is primary, resume is fallback; S-58 defines the runner-death contract | T-003 comparison shows both paths degraded |
| R-4 | **Trust incident**: unattended run does something destructive | H×L | **OS sandbox containment (the boundary)** + worktree accident-isolation + budgets + `plan` dry-run + branch-never-main; safety journal + incident reporting; zero-tolerance stop-ship on containment escape; post-mortems public | Any safety-journal containment event; any user report |
| R-5 | **Auth/economics premise fails** — materially narrowed by the CLI-default decision (ADR-016): Clockwork now schedules the user's *own installed Claude Code* under their own login (the same thing their cron jobs or CI already do), rather than a third-party SDK integration borrowing subscription auth. Residual risk: Anthropic restricting automated/headless use of subscription accounts generally | H×L | **T-006 documents the posture at Phase 0**; SDK/API-key engine is the fallback lane if subscription-headless tightens; no auth scraping ever; usage stays within the user's own plan limits by construction | ToS update on automated subscription use; `claude -p` auth behavior change |
| R-6 | **Scheduler/time correctness bugs** (DST, sleep, clock jumps) erode the core promise | M×H | Fixture-first development (fake clock, 4 zones); missed-run coalescing rule; wake-event hooks; S-matrix coverage gates every task | Any dogfood "it didn't run and didn't tell me" |
| R-7 | **Capacity model is wrong** (no official quota API) → false warnings destroy the flagship feature's credibility | M×M | Ship as clearly-labeled estimate; confidence intervals; learn from observed telemetry; kill the feature behind a flag if precision <70% | Beta feedback "the warning was wrong" ×3 |
| R-8 | **Windows platform reliability** (service supervision, Job Objects, power events, sandbox equivalent) | M×M | Windows deferred to **post-v1** entirely (T-401); dedicated CI runner; native Job-Object wrapper evaluated against node-windows | Windows fixture suite flake rate >2% |
| R-9 | Tauri friction (native APIs, updater edge cases) stalls UI velocity | M×M | Electron fallback decision gate at end of Phase 1 (stack #2); UI is plain web tech either way | 2+ blocked days on shell-layer issues |
| R-10 | **Prompt injection** via attached URLs/files steers agent into harmful actions | M×M | Permission floor + budgets bound damage; URL/MCP context deferred to M3; import preview (S-74); documented stance — never claim "solved" | Security researcher report; deny-list triggers correlated with URL tasks |
| R-11 | Solo-builder bus factor / burnout | M×M | Plan is executable-by-anyone (this repo); phase gates allow pause-resume; second engineer option priced in | Two consecutive slipped gates |
| R-12 | AgentCalendar or a well-funded clone wins mindshare first | L×M | They're observability-first; our moat list (VISION §5); speed to M2 beta; open-source core builds community faster than closed | Their scheduling UX ships composer+inbox |
| R-13 | Retention fails: novelty wears off, recurring jobs get disabled | H×M | This is the kill-criteria metric; counter with template quality (jobs that stay valuable: deps, triage, digests) and result quality bar (report must be worth reading) | 30-day recurring-job survival <20% in beta |

## 2. Build cost (re-baselined after review round 1 — findings #29/#30)

Rates: blended senior contractor $85/hr ≈ $680/ed. Solo-founder building = opportunity cost, not cash.

| Milestone | Effort (from `05` §summary) | Contracted cost | Cumulative |
|---|---|---|---|
| Phase −1 evidence | 6.5 ed | $4.4k | $4.4k |
| Phase 0 spike | 12 ed | $8.2k | $12.6k |
| Phase 1 → M1 alpha | ~73 ed | $49.6k | $62.2k |
| Phase 2 → M2 beta | ~39.5 ed | $26.9k | $89.1k |
| Phase 3 → M3 v1 (macOS) | ~33.5 ed | $22.8k | **$111.9k** |
| +20% integration buffer | — | — | **~$134k** |
| Post-v1 Windows + Linux + WidgetKit | ~18 ed | $12.2k | **~$146k** |

One-off costs: Apple Developer $99/yr · Windows EV code-signing ~$300–400/yr (post-v1) · domain/site ~$200 · design assets (icon, landing) ~$1–2k if outsourced. **All-in to macOS v1: ~$110–135k contracted, or ~7–8 months of one strong founder-engineer (4–5 months with two). Cross-platform: ~$144–155k.** *(The 2026-07-16 scope revision — dual engine, profiles, chat channels, search, widgets — added ~25 ed / ~$17k over the round-1 re-baseline; priced, not absorbed.)*

The earlier draft of this plan said ~$70–75k and 4 months; the adversarial review correctly showed that number was built on inconsistent arithmetic and underestimated correctness/safety work. This is the honest figure. The cheap de-risking property still holds: **the first ~$11k (Phases −1+0) buys the answer to whether the rest is worth spending.**

H2 (team tier + relay + commercialization: payments, licensing, support tooling) adds ~50–65 ed ≈ $34–44k plus the first real infra.

## 3. Run cost (the structural advantage)

- **H1 COGS ≈ $0.** Local-first: no servers, no accounts, no storage. Agent tokens bill to the **user's** subscription/API key. Our cost of a user's 1,000th run is zero.
- Fixed opex: code-signing certs + CI (~$50–100/mo GitHub Actions incl. Windows/mac runners) + update/download hosting (GitHub Releases, free) + docs hosting (~$0–20/mo).
- Development-time API spend: nightly real-SDK smoke ≈ $2/day; spike + manual testing budget $300 total is generous.
- H2 relay (the only cloud): stateless push relay for approvals, metadata-only, E2E-encrypted → single small instance + APNs/FCM ≈ **$100–300/mo** to thousands of users. Deliberately designed to stay boring.

## 4. Monetization math (gross-revenue sanity check ONLY — not a financial model; the full willingness-to-pay argument lives in `../vision/COMMERCIALIZATION.md`)

- H1 is unmonetized by design. Pricing lands with H2: Free core (3 active recurring jobs) → Pro $15/mo → Team $30/user/mo.
- Gross-revenue sanity: recovering the ~$112k build ≈ 620 Pro-user-years. Against the wedge audience (Claude subscribers with repos), that's an attach-rate problem, not a TAM problem. **What this math deliberately ignores** (and H2 must budget): payments/licensing infrastructure, support load, refunds/churn mechanics, and conversion reality between free and paid — treat this section as "the ceiling isn't obviously too low," nothing more. The real risk remains R-13 (retention).
- Source-available core decision (DECISIONS ADR-009, finalized at T-208): community trust for a daemon that runs agents on your machine is *the* adoption gate; closed-source daemons die in HN comments.

## 5. Assumptions register → verified contract matrix

The load-bearing assumptions below are **hypotheses until Phase 0 closes**; T-001…T-009 test each, and the results live in `plan/engine-contract-matrix.md` (created at T-007), pinned per engine version and **re-run on every SDK pin bump or observed CLI version change**.

1. `claude -p --output-format stream-json` emits usable per-event usage/turn telemetry (→ T-001; if absent/laggy, budget = turns/time and the UI says so).
2. The CLI's permission-prompt MCP hook can hold an approval open for hours (keep-alive HITL on the default engine, → T-003); SDK `canUseTool` ditto for the opt-in engine.
3. `claude -p --resume <session>` (and SDK session resume) exist and their replay semantics are acceptable as a *fallback* (→ T-003; resume restarts a turn, it does not resume mid-tool-call — plan accordingly).
4. `claude -p` runs headless from a daemon (no TTY) context under the machine's existing subscription login, and expiry surfaces detectably (→ T-006).
5. Rate-limit / capacity / auth errors are programmatically distinguishable, per engine (→ T-004).
6. A Seatbelt sandbox profile can contain the runner **including the spawned `claude` process** while leaving git/npm/toolchain functional inside the allowlist (→ T-008).
7. Per-run `.claude/` materialization actually loads a profile's skills/subagents for that run without touching global config (→ T-009).
8. `git worktree` semantics are stable across git ≥2.38 (macOS scope for v1).
9. Tauri 2 tray + updater + always-on-top mini window work on macOS 13+ without entitlement drama beyond standard notarization (notifications are daemon-side native — no longer a Tauri assumption).
