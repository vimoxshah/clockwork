/**
 * Runner⇄daemon IPC protocol (arch §7.3): per-run child process, own pgid,
 * JSONL over stdio. The child NEVER receives the UI bearer token or delivery
 * credentials; its env is sanitized by the runner package. A single-run nonce
 * authenticates the channel (transport simplification vs unix-socket recorded
 * in DECISIONS ADR-024 — identical isolation properties).
 */
import type { RunOutcome } from '@clockwork/shared';

export type ChildToDaemon =
  | { t: 'ready'; nonce: string }
  | { t: 'usage'; costUsd: number; turns: number }
  | { t: 'heartbeat' }
  | { t: 'log'; line: string }
  | { t: 'artifact'; path: string }
  | { t: 'rateLimit'; info: Record<string, unknown> }
  | { t: 'permission'; reqId: string; tool: string; input: unknown }
  /** Sent once before the engine spawns; enabled=false is the CW_SANDBOX=off escape hatch. */
  | { t: 'sandbox'; enabled: boolean; profileVersion: number | null }
  /** A PreToolUse policy-floor hit (FR-11/T-114) — the deny-list floor denied
   *  a command outside the normal permission flow; see safety-journal.ts. */
  | { t: 'floor'; tool: string; command: string; reason: string }
  | { t: 'outcome'; outcome: RunOutcome };

export type DaemonToChild =
  | { t: 'decision'; reqId: string; behavior: 'allow' }
  | { t: 'decision'; reqId: string; behavior: 'deny'; message: string }
  /** BYOK credential delivery (ADR-034): stdin, never env — see run-manager.ts
   *  spawnChild and runner-child.ts's credential promise for why. */
  | { t: 'credential'; byokKey: string; byokBaseUrl: string };
