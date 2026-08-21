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
  | { t: 'permission'; reqId: string; tool: string; input: unknown }
  | { t: 'outcome'; outcome: RunOutcome };

export type DaemonToChild =
  | { t: 'decision'; reqId: string; behavior: 'allow' } 
  | { t: 'decision'; reqId: string; behavior: 'deny'; message: string };
