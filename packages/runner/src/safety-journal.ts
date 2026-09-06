/**
 * Safety journal (FR-27): always-on, local-only, append-only log of deny-list
 * hits, sandbox violations, budget hard-stops, approval decisions. Feeds the
 * incident report; never transmitted anywhere by itself.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type JournalKind =
  | 'deny_list_hit'
  | 'sandbox_violation'
  | 'budget_hard_stop'
  | 'approval_decision'
  | 'orphan_terminated'
  | 'preflight_failure'
  /** CW_SANDBOX=off escape hatch used for a run — loud by design. */
  | 'sandbox_disabled'
  /** Reachable approvals (inbound half, ADR-036): a decision made from a
   *  remote channel (Telegram inline keyboard) rather than the local UI. */
  | 'remote_decision';

export interface JournalEntry {
  at: number;
  kind: JournalKind;
  runId?: string;
  detail: string;
}

export class SafetyJournal {
  constructor(private readonly filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }

  record(kind: JournalKind, detail: string, runId?: string): void {
    const entry: JournalEntry = { at: Date.now(), kind, detail, ...(runId ? { runId } : {}) };
    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      // The journal must never crash a run; disk-full is surfaced elsewhere.
    }
  }

  /** Read the whole journal (settings surface / export). */
  readAll(): JournalEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return [];
    }
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as JournalEntry);
  }
}
