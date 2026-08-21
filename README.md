# Clockwork

> **The calendar where your agents show up for work.**

Clockwork is a local-first desktop app that turns AI agents into a schedulable workforce. You don't watch agents — you **book** them: pick a calendar slot, attach a prompt + context + budget, and at exactly that time a Claude agent runs the job in isolation and files a structured report to your inbox. Recurring jobs, task chains, human-in-the-loop approvals, and capacity-aware scheduling make unattended agent work trustworthy.

**Scope for v1: Claude agents only** — executed through the user's own installed Claude Code, headless (`claude -p`, subscription login, **no API key required**), with the Agent SDK as an opt-in engine. The runner is an interface, not a hardcoding — other agent CLIs come later.

---

## Repository map

| Path | What it holds | Read it when |
|---|---|---|
| [`vision/VISION.md`](vision/VISION.md) | Product thesis, personas, differentiation, moats, business model, where this can go (H1→H3) | You want to know **why** this exists and where it ends up |
| [`vision/ROADMAP.md`](vision/ROADMAP.md) | Three-horizon roadmap with themes and exit criteria | You want to know **what ships when** |
| [`vision/COMMERCIALIZATION.md`](vision/COMMERCIALIZATION.md) | Why people pay: the four value propositions + ROI math, pricing ladder, honest counter-arguments, revenue scenarios, what-must-be-true checkpoints | You're asking **"will this make money?"** |
| [`plan/01-product-spec.md`](plan/01-product-spec.md) | Personas, user stories, functional requirements (FR-xx), non-functional requirements, MVP cut-line | You're deciding **what to build** |
| [`plan/02-architecture.md`](plan/02-architecture.md) | Components, data model (SQLite DDL), run lifecycle state machine, API contracts, sequence flows | You're deciding **how to build it** |
| [`plan/03-tech-stack.md`](plan/03-tech-stack.md) | Every stack choice with rationale + rejected alternatives | You're challenging a technology decision |
| [`plan/04-scenarios.md`](plan/04-scenarios.md) | Exhaustive scenario & edge-case matrix with required behavior (S-xx) | You're implementing or testing **any** feature |
| [`plan/05-execution-plan.md`](plan/05-execution-plan.md) | Phase-by-phase task breakdown (T-xxx) with acceptance criteria, estimates, definition of done | You're **starting work** — begin at Phase 0 |
| [`plan/06-risks-and-costs.md`](plan/06-risks-and-costs.md) | Risk register (R-xx) with mitigations, build cost, run cost, monetization math | You're funding or de-risking the project |
| [`designs/DESIGN.md`](designs/DESIGN.md) + [`designs/prototype.html`](designs/prototype.html) | Visual identity (ink + brass tokens, 6 design principles) and the interactive 5-screen prototype (calendar · composer · inbox · approvals · menubar) | You want to **see** the product |
| [`decisions/DECISIONS.md`](decisions/DECISIONS.md) | ADR-style log of the load-bearing decisions | You're about to relitigate something — check here first |
| [`reviews/`](reviews/) | Adversarial reviews (Codex gpt-5.6-sol) and how each finding was resolved | You want proof the plan survived hostile scrutiny |

## How to execute this plan

1. Read `vision/VISION.md` (10 min) — internalize the core loop: **Book → Run → Review → Repeat**.
2. Read `plan/01-product-spec.md` §MVP cut-line — know what is explicitly **not** in scope.
3. Start `plan/05-execution-plan.md` **Phase 0 (the spike)**. Phase 0 is a go/no-go gate: if the spike fails its exit criteria, stop and rethink — do not proceed on momentum.
4. During any implementation task, keep `plan/04-scenarios.md` open — every task lists the S-xx scenarios it must satisfy.
5. Log every new decision in `decisions/DECISIONS.md`. Append-only; never rewrite history.

## Status

| | |
|---|---|
| Stage | Planning complete, pre–Phase −1/0 |
| Plan reviewed by | Codex gpt-5.6-sol — adversarial round 1: verdict RETHINK, 33 findings, **all incorporated same day** (see `reviews/codex-sol-review-round1.md` for the triage + what changed) |
| Headline numbers | macOS v1: ~165 eng-days · 7–8 months solo (4–5 with two) · ~$110–135k contracted · first ~$13k (evidence sprint + spike) buys the go/no-go answer |
| Scope revision 2026-07-16 | CLI-first engine (`claude -p`, subscription login — no API key) · agent profiles with @mention + per-run skill loading · Telegram/WhatsApp-gateway/webhook delivery · FTS search + ⌘K · desktop widgets (ADR-016…019) |
| Next action | Run Phase −1 evidence sprint + Phase 0 spike **in parallel** (`plan/05-execution-plan.md`); then mandatory review round 2 before Phase 1 |
| Created | 2026-07-16 |
