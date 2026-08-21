# Clockwork

> **The calendar where your agents show up for work.**

Clockwork is a local-first desktop app that turns AI agents into a schedulable workforce. You don't watch agents — you **book** them: pick a calendar slot, attach a prompt + context + budget, and at exactly that time a Claude agent runs the job in isolation and files a structured report to your inbox. Recurring jobs, human-in-the-loop approvals, and budget bounds make unattended agent work trustworthy.

**Scope for v1: Claude agents only** — executed through your own installed Claude Code, headless (`claude -p`, subscription login, **no API key required**), with the Agent SDK as an opt-in engine. The runner is an interface, not a hardcoding — other agent CLIs come later.

## Status

| | |
|---|---|
| Stage | **M1 core implemented** — daemon + scheduler + runner + sandbox + API + UI; Phase-0 engine proofs complete |
| Verified on | macOS 26 (Apple Silicon), Node 24, Claude Code CLI 2.1.238 |
| Engine evidence | Real headless `claude -p` runs on subscription login (`spikes/reports/T001…T009`) |
| Containment | Seatbelt escape suite **13/13 green** — writes default-denied, credentials unreadable, engine functional inside profile (`spikes/reports/T008-sandbox.md`) |
| Test gauntlet | 88+ tests: fake-clock scheduler fixtures, double-fire attacks, DST ×4 zones, crash recovery w/ real orphan kills, full-loop child-process integration, API contracts |

## Quick start

```bash
pnpm install && pnpm build
node packages/daemon/dist/main.js
# open http://127.0.0.1:4747 — token: cat ~/.clockwork/api-token
```

Full instructions incl. login-service install & `doctor`: [docs/install.md](docs/install.md).

## The honest execution model

Runs execute **when your machine is awake**. Clockwork arms keep-awake before scheduled runs when you're plugged in, tells you loudly when sleep caused a miss, and makes missed-run policies (`run-late` / `skip` / `ask`) explicit per task. For true overnight jobs use an always-on machine. We market what's true.

## Trust architecture

1. **OS sandbox is the security boundary** — default-deny writes scoped to the run; SSH/AWS/GPG/shell-history reads denied; symlink escapes refused at profile generation.
2. **Worktrees = accident isolation** — branch-only outputs (`clockwork/<task>/<run-id>`), never direct commits to your branches.
3. **Budgets are enforced between messages** — USD soft cap with measured overshoot; turns/time are hard bounds.
4. **Safety journal** — every deny-list hit, sandbox event, and budget stop recorded locally.

Details: [docs/security.md](docs/security.md) · scheduling semantics: [docs/scheduling.md](docs/scheduling.md) · as-built architecture: [docs/architecture.md](docs/architecture.md) · privacy: [docs/privacy.md](docs/privacy.md) · troubleshooting: [docs/troubleshooting.md](docs/troubleshooting.md).

## Repository map

| Path | What it holds |
|---|---|
| `packages/shared` | zod schemas, FSM states, JobSpec, report schema — the contracts |
| `packages/runner` | AgentRunner engines (Claude CLI default, SDK opt-in), worktree lifecycle, sandbox profile generation, deny-list, stream parser |
| `packages/daemon` | occurrence-ledger scheduler, run manager FSM, Fastify REST+SSE API, notifier, delivery channels, launchd service CLI |
| `packages/ui` | React calendar · composer · inbox · approvals · settings |
| `resources/skill-pack` | bundled versioned profile skills (dependency-triage, test-doctor, docs-writer) |
| `spikes/reports` | Phase-0 engine contract matrix, T-001..T-009 verification reports |
| `plan/` `vision/` | source-of-truth product documents (spec, architecture, scenarios, roadmap) |
| `decisions/DECISIONS.md` | append-only ADR log (ADR-001..025) |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Scenario-driven development: no feature is done until its scenario IDs have tests. Decisions log is append-only. Security boundaries are not negotiable in review.

## License

[FSL-1.1 (Functional Source License)](LICENSE) — converts to MIT two years after each release. Free to use, modify, and redistribute; competing hosted products are the one restriction.
