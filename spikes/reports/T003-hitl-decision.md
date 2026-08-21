# T-003 — HITL Model Decision Memo (Phase 0)

**Date:** 2026-08-21 · **Status:** DECIDED — supersedes the architecture doc's keep-alive assumption for the CLI engine (ADR-020)

## What was verified

| Probe | Result |
|---|---|
| `claude --help` (2.1.238) exposes `--permission-prompt-tool` | **ABSENT** — grep count 0 |
| Any flag enabling an external permission callback for `-p` runs | **ABSENT** (only `--permission-mode`, `--allowedTools`, `--disallowedTools`) |
| SDK `canUseTool` keep-alive | not yet probed (SDK engine integration is T-212); assumed viable per SDK docs, TO VERIFY at T-201 |

## Decision

1. **CLI engine (default): HITL is NOT available on 2.1.238.** M1 behavior = fail-safe:
   runs execute under `plan` or `acceptEdits`; any permission-blocked action surfaces in
   the report as a policy event and the run completes/fails honestly — it never hangs
   waiting for a human that cannot be reached.
2. **SDK engine becomes the HITL path** and moves up to M1 as an opt-in engine for
   API-key users (G0 pre-authorized this promotion). `canUseTool` keep-alive +
   `resume()` fallback fidelity MUST be verified before the M2 HITL gate (T-201).
3. The FSM's `waiting_approval` state remains implemented end-to-end behind MockRunner
   tests now, so CLI→SDK parity is a runner swap, not a daemon rewrite.

## Consequences

- FR-12 contract confirmed for SDK, redesigned for CLI (fail-safe) — recorded ADR-020.
- Composer hides approval affordances when engine=cli (capability flags from T-007 matrix).
- Re-run this probe on every observed CLI version change: if `--permission-prompt-tool`
  ships, CLI keep-alive HITL becomes available without daemon changes.
