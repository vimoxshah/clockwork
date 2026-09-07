/**
 * F2 shift-handoff (plan/AGENT-WORKFORCE-SPEC.md).
 *
 * Each recurring task carries a memory the agent reads at the start of a run
 * and appends to at the end: what it tried, what blocked it, what to check
 * next. This is the same mechanism as the chain's {{previous.report}} binding
 * (templates.ts `renderChainPrompt`), pointed at the PRIOR OCCURRENCE OF THE
 * SAME TASK instead of an upstream task.
 *
 * Owns `agent_memories` (migration 0008). F6 (accept-with-note) appends
 * human-authored notes into the same table through `append()` — it does not
 * get its own table.
 *
 * ASSUMPTION, recorded for the integrator (no algorithm was specified for
 * `handoffFromReport` — see the module's JSDoc below for the reasoning):
 * `RunReport` (packages/shared/src/report.ts) carries no dedicated
 * tried/blocked/nextCheck fields, and every runner
 * (packages/runner/src/*-runner.ts) emits `summary` as one free-text
 * paragraph. `handoffFromReport` therefore looks for optional labeled
 * sections in `summary` and otherwise falls back to `state`/`failureReason`.
 * This is a reasonable default, not a contract fixed elsewhere in the repo;
 * flag it if a different mapping is wanted.
 */
import type { DB } from './db.js';
import { newId } from '@clockwork/shared';
import type { AgentMemory, AgentMemoryWrite } from '@clockwork/shared';

/** `latest()`'s default row count, and the number `renderBlock` reads from before truncating. */
const DEFAULT_LATEST_LIMIT = 5;
/** `renderBlock`'s default output budget — matches `renderChainPrompt`'s discipline (templates.ts:89). */
const DEFAULT_RENDER_BUDGET_CHARS = 6_000;
/** Per-field cap, matching `AgentMemoryWrite`'s `.max(4_000)` on tried/blocked/nextCheck. */
const FIELD_CHAR_CAP = 4_000;

interface MemoryRow {
  id: string;
  task_id: string;
  run_id: string | null;
  author: string;
  kind: string;
  tried: string | null;
  blocked: string | null;
  next_check: string | null;
  body: string | null;
  created_at: number;
}

function rowToMemory(row: MemoryRow): AgentMemory {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    author: row.author as AgentMemory['author'],
    kind: row.kind as AgentMemory['kind'],
    tried: row.tried,
    blocked: row.blocked,
    nextCheck: row.next_check,
    body: row.body,
    createdAt: row.created_at,
  };
}

export class HandoffMemory {
  constructor(private readonly db: DB) {}

  /**
   * Append-only: the table has no update path, so an earlier shift's memory
   * can never be silently overwritten by a later one. Unknown `taskId` fails
   * closed — `agent_memories.task_id` cascades from `tasks(id)` and
   * `foreign_keys = ON` throws rather than writing an orphaned row; callers
   * (the route, run-manager's finalize hook) must check the task exists first.
   */
  append(input: AgentMemoryWrite, now = Date.now()): AgentMemory {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO agent_memories (id, task_id, run_id, author, kind, tried, blocked, next_check, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.runId ?? null,
        input.author ?? 'agent',
        input.kind ?? 'handoff',
        input.tried ?? null,
        input.blocked ?? null,
        input.nextCheck ?? null,
        input.body ?? null,
        now,
      );
    const row = this.db.prepare('SELECT * FROM agent_memories WHERE id=?').get(id) as unknown as MemoryRow;
    return rowToMemory(row);
  }

  /**
   * Newest first, default 5. `rowid DESC` breaks ties on identical
   * `created_at` — ULIDs are not guaranteed monotonic within the same
   * millisecond, so `created_at` alone can leave insertion order undefined.
   */
  latest(taskId: string, limit = DEFAULT_LATEST_LIMIT): AgentMemory[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_memories WHERE task_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(taskId, limit) as unknown as MemoryRow[];
    return rows.map(rowToMemory);
  }

  /**
   * The block injected into the next run's prompt via `{{handoff.previous}}`.
   * '' when there is no memory. Renders newest-first; a human note (F6) reads
   * "Note from your reviewer: …" so the agent can tell a human's correction
   * from its own past self. Truncated at `budgetChars` with the same
   * discipline as `renderChainPrompt` (templates.ts:100).
   */
  renderBlock(taskId: string, budgetChars = DEFAULT_RENDER_BUDGET_CHARS): string {
    const memories = this.latest(taskId, DEFAULT_LATEST_LIMIT);
    if (memories.length === 0) return '';
    const parts = memories
      .map((m) => {
        if (m.author === 'human') {
          return `Note from your reviewer: ${m.body ?? ''}`;
        }
        const lines: string[] = [];
        if (m.tried) lines.push(`Tried: ${m.tried}`);
        if (m.blocked) lines.push(`Blocked: ${m.blocked}`);
        if (m.nextCheck) lines.push(`Next check: ${m.nextCheck}`);
        if (lines.length === 0 && m.body) lines.push(m.body);
        return lines.join('\n');
      })
      .filter((p) => p.length > 0);
    let block = parts.join('\n\n');
    if (block.length > budgetChars) {
      block = `${block.slice(0, budgetChars)}… [truncated to fit context budget]`;
    }
    return block;
  }
}

/**
 * Replaces `{{handoff.previous}}`; returns the template untouched when the
 * placeholder is absent — mirrors `renderChainPrompt`'s short-circuit
 * (templates.ts:91), so a prompt with no handoff placeholder is never
 * re-allocated.
 */
export function renderHandoffPrompt(promptTemplate: string, block: string): string {
  if (!promptTemplate.includes('{{handoff')) return promptTemplate;
  return promptTemplate.replace(/\{\{handoff\.previous\}\}/g, block);
}

/**
 * Pull tried/blocked/nextCheck out of a finished run's report_json.
 *
 * `RunReport` has no dedicated tried/blocked/nextCheck fields; every runner
 * emits `summary` as one free-text paragraph. So:
 *   1. optional labeled sections in `summary` — case-insensitive `Tried:`,
 *      `Blocked:`, `Next check:`/`Next:` at the start of a line — are used
 *      verbatim when present. This lets a prompt author opt into structure
 *      (the same precedent as the runners' own `SUMMARY:` output contract)
 *      without any runner change.
 *   2. otherwise `tried` falls back to the whole summary, `blocked` becomes
 *      `<state>: <failureReason>` (or just `<state>`) for any non-`completed`
 *      terminal state — a cancelled or timed-out shift is still a fact the
 *      next shift should know — and is `null` for a `completed` run, and
 *      `nextCheck` is `null` (nothing in the report names one).
 * Every field is capped at 4_000 chars, matching `AgentMemoryWrite`'s
 * per-field max, so a long summary can never fail validation at the route.
 */
export function handoffFromReport(reportJson: string | null): Omit<AgentMemoryWrite, 'taskId'> | null {
  if (!reportJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reportJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const r = parsed as { state?: unknown; summary?: unknown; failureReason?: unknown };
  const state = typeof r.state === 'string' && r.state.length > 0 ? r.state : 'unknown';
  const summary = typeof r.summary === 'string' ? r.summary : '';
  const failureReason = typeof r.failureReason === 'string' && r.failureReason.length > 0 ? r.failureReason : null;

  const cap = (s: string | null): string | null =>
    s === null ? null : s.length > FIELD_CHAR_CAP ? s.slice(0, FIELD_CHAR_CAP) : s;

  const triedMatch = summary.match(/^[ \t]*tried:[ \t]*(.+)$/im);
  const blockedMatch = summary.match(/^[ \t]*blocked:[ \t]*(.+)$/im);
  const nextMatch = summary.match(/^[ \t]*next(?:[ \t]*check)?:[ \t]*(.+)$/im);

  let tried: string | null;
  let blocked: string | null;
  let nextCheck: string | null;

  if (triedMatch || blockedMatch || nextMatch) {
    tried = triedMatch ? triedMatch[1]!.trim() : summary.trim() || null;
    blocked = blockedMatch ? blockedMatch[1]!.trim() : null;
    nextCheck = nextMatch ? nextMatch[1]!.trim() : null;
  } else {
    tried = summary.trim() || null;
    blocked = state !== 'completed' ? `${state}${failureReason ? `: ${failureReason}` : ''}` : null;
    nextCheck = null;
  }

  return {
    author: 'agent',
    kind: 'handoff',
    tried: cap(tried),
    blocked: cap(blocked),
    nextCheck: cap(nextCheck),
    body: null,
  };
}
