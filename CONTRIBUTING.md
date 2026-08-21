# Contributing

## Repository layout

```
packages/shared    zod schemas, FSM states, JobSpec, report schema (the contracts)
packages/runner    AgentRunner engines, worktrees, sandbox profile, deny-list
packages/daemon    scheduler, run manager, API server, notifier, delivery, CLI
packages/ui        React calendar/composer/inbox (served by the daemon)
resources/skill-pack   bundled versioned profile skills
spikes/            Phase-0 engine probes + evidence reports
plan/ vision/     source-of-truth product documents
```

## Ground rules

1. **Scenario-driven development** — no task is done until its S-IDs from
   `plan/04-scenarios.md` have tests or a written manual verification log.
2. **Decisions log is append-only** — any deviation from the architecture docs
   gets an ADR in `decisions/DECISIONS.md` the same day.
3. **No scope creep across the cut-line** — new ideas go to the roadmap, not
   the current milestone.
4. **Security boundaries are not negotiable in review**: the sandbox profile,
   credential-path exclusions, and sanitized runner env cannot be weakened to
   make a test pass. Containment escape = stop-ship.
5. The daemon is the single writer of run state. Runners never touch SQLite.

## Development loop

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm --filter @clockwork/daemon dev          # watch mode
CW_ENGINE=mock node packages/daemon/dist/main.js   # full loop, zero API spend
```

## Reporting security issues

Email the maintainer or open a minimal GitHub issue marked `[security]`
describing the class of issue without exploit detail; coordinate disclosure
within 90 days. Confirmed containment escapes are treated as stop-ship with a
public post-mortem.
