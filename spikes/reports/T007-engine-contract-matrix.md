# Engine Contract Matrix — v1 (Phase 0, T-007)

> **Re-run procedure:** on every observed CLI version change (runner records `claude --version`
> per run; R-2 tripwire) or SDK pin bump, re-run `pnpm --filter @clockwork/spikes` scripts and
> update this file. The daemon reads the capability flags below at runtime; the UI degrades
> honestly per engine.

## CLI engine — Claude Code `2.1.238` (verified 2026-08-21, real runs)

| Capability | Flag | Verified via | Result |
|---|---|---|---|
| Headless `-p` on subscription login, no API key | `cli.headlessSubscription` | T-001 real run | ✅ PASS (exit 0) |
| `--output-format stream-json` JSONL events | `cli.streamJson` | T-001 real run | ✅ PASS (`system`, `assistant`, `result`, `rate_limit_event`, non-JSON chatter) |
| Per-assistant-event usage tokens | `cli.usagePerEvent` | T-001 real run | ✅ PASS (10 events: input/output/cache tokens) |
| Per-event **dollar** figures | `cli.usdPerEvent` | T-001 real run | ❌ NOT EMITTED per event → budget = turns/time under subscription (FR-10 as designed); cost estimate heuristic only |
| Cumulative `total_cost_usd` in result | `cli.totalCostUsd` | T-001 report.json | ⚠️ not observed in this run's result payload — treat as absent; soft-cap USD enforced from token estimates + turns |
| Structured summary in result event | `cli.structuredSummary` | T-001 real run | ✅ PASS |
| Session id capture | `cli.sessionCapture` | T-001 real run | ✅ PASS (`3d004f08-…`) |
| `--resume <session-id>` exists | `cli.resumeFlag` | `claude --help` | ✅ EXISTS (replay fidelity probe = T-003 memo) |
| `--permission-mode <mode>` | `cli.permissionMode` | `claude --help` | ⚠️ modes are `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan` — **no `default` mode**; map Clockwork `default` → `manual`? NO: `manual` asks interactively (hangs headless). Map `acceptEdits→acceptEdits`, `plan→plan`, `default→dontAsk` is wrong too. **Decision: ship M1 with `acceptEdits` and `plan` only** (see ADR-020) |
| **`--permission-prompt-tool` MCP hook** | `cli.permissionPromptHook` | `claude --help` grep | ❌ **ABSENT in 2.1.238** → keep-alive HITL **impossible on CLI engine today** → G0 branch pre-decided: M1 ships fail-safe-on-permission; SDK engine moves up for HITL users (ADR-020) |
| `--max-turns` flag | `cli.maxTurnsFlag` | `claude --help` grep | ❌ **ABSENT** → turn cap MUST be enforced by Clockwork (BudgetGuard kill on usage event), never delegated to CLI |
| `--append-system-prompt` (profile extras) | `cli.appendSystemPrompt` | `claude --help` | ✅ EXISTS |
| Non-interactive MCP connectors usable | `cli.mcpNonInteractive` | T-001 summary note | ❌ claude.ai connectors unauthorized headless — document as limitation |

## Environment observations

- Trivial JSDoc task: 48.8s wall, ~59k cache-creation tokens first turn — every scheduled run
  pays context warm-up; budget defaults must assume ≥50k overhead tokens.
- `rate_limit_event` stream type observed even on success — parser must treat it as informational,
  not terminal (fold() already does).
- Stderr carries human chatter; JSONL on stdout only. Parser ignores stderr except for tail capture.

## SDK engine — `@anthropic-ai/claude-agent-sdk`

Status at Phase 0: probes deferred to the point of integration (T-212); the G0 decision above makes
the SDK engine the HITL path, so its contract matrix must be filled BEFORE M2 exit:

| Capability | Flag | Status |
|---|---|---|
| `canUseTool` callback held open hours | `sdk.canUseToolHold` | TO VERIFY (T-201/T-003) |
| Session resume semantics | `sdk.resumeFidelity` | TO VERIFY |
| Per-message usage dollars | `sdk.usdPerMessage` | TO VERIFY |
| Structured output forcing | `sdk.structuredOutput` | TO VERIFY |

## Capability flags consumed by daemon/UI

```jsonc
// packages/shared/src/engine-capabilities.ts shape (runtime source of truth)
{
  cli: {
    hitl: false,               // permission-prompt hook absent in 2.1.238
    usdBudgeting: false,       // subscription mode; turns/time operative
    turnCapEnforcedBy: "clockwork",
    resumeSupported: true,
    failSafeOnPermission: true // M1 behavior
  },
  sdk: { hitl: true, usdBudgeting: true } // once verified
}
```
