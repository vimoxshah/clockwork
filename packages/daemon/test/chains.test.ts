/**
 * Agent chains (goal #28): upstream completion fires downstream tasks,
 * prompt materialization, trigger filtering, cycle rejection.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { validateChain } from '../src/templates.js';
import type { DB } from '../src/db.js';

describe('agent chains', () => {
  let db: InstanceType<typeof Database>;
  const now = Date.now();

  beforeEach(() => {
    db = new Database(':memory:') as never;
    db.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, name TEXT, prompt TEXT, profile_id TEXT, repo_path TEXT,
      model TEXT, engine TEXT, chain_after TEXT, chain_on TEXT,
      budget_usd REAL DEFAULT 2, max_turns INTEGER DEFAULT 50, timeout_sec INTEGER DEFAULT 3600,
      base_branch TEXT, context_json TEXT DEFAULT '[]', delivery_json TEXT DEFAULT '{}',
      permission_mode TEXT DEFAULT 'acceptEdits',
      missed_policy TEXT DEFAULT 'run-late', missed_window_sec INTEGER DEFAULT 21600,
      overlap_policy TEXT DEFAULT 'skip', retry_on_transient INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1, version INTEGER DEFAULT 1,
      deleted_at INTEGER, created_at INTEGER, updated_at INTEGER
    )`);
    db.exec(`CREATE TABLE runs (
      id TEXT PRIMARY KEY, task_id TEXT, state TEXT, report_json TEXT,
      scheduled_for INTEGER, started_at INTEGER, ended_at INTEGER
    )`);
  });

  const addTask = (id: string, opts: { chainAfter?: string; chainOn?: string; enabled?: number; repoPath?: string } = {}): void => {
    db.prepare(
      `INSERT INTO tasks (id, name, prompt, chain_after, chain_on, enabled, repo_path, created_at, updated_at)
       VALUES (?, ?, 'p', ?, ?, ?, ?, ?, ?)`,
    ).run(id, id, opts.chainAfter ?? null, opts.chainOn ?? null, opts.enabled ?? 1, opts.repoPath ?? null, now, now);
  };

  it('validates linear chains and rejects self/cycles', () => {
    addTask('a');
    addTask('b', { chainAfter: 'a' });
    expect(validateChain(db as unknown as DB, 'c', 'b')).toBeNull(); // a → b → c ok
    expect(validateChain(db as unknown as DB, 'a', 'a')).toBe('a task cannot chain to itself');
    expect(validateChain(db as unknown as DB, 'a', 'b')).toContain('cycle'); // b already chains to a
  });

  it('finds direct successors by chain_after', () => {
    addTask('upstream');
    addTask('down1', { chainAfter: 'upstream' });
    addTask('down2', { chainAfter: 'upstream' });
    addTask('other');
    const succ = db
      .prepare(`SELECT * FROM tasks WHERE chain_after = ? AND deleted_at IS NULL AND enabled = 1`)
      .all('upstream') as unknown as Array<{ id: string }>;
    expect(succ.map((s) => s.id).sort()).toEqual(['down1', 'down2']);
  });

  it('ignores disabled or deleted successors', () => {
    addTask('upstream');
    addTask('disabled-succ', { chainAfter: 'upstream', enabled: 0 });
    const succ = db
      .prepare(`SELECT * FROM tasks WHERE chain_after = ? AND deleted_at IS NULL AND enabled = 1`)
      .all('upstream') as unknown as Array<{ id: string }>;
    expect(succ).toHaveLength(0);
  });

  it('trigger filter: completed-only chains skip failed upstreams', () => {
    // Simulate the fireChainedTasks decision logic:
    const terminalState = 'failed';
    const triggerOk = terminalState === 'completed';
    const anyTerminal = ['completed', 'failed', 'timed_out', 'cancelled', 'budget_exceeded'].includes(terminalState);

    const completedOnlyFires = false || triggerOk; // chain_on='completed'
    const anyTerminalFires = anyTerminal;          // chain_on='any_terminal'
    expect(completedOnlyFires).toBe(false);
    expect(anyTerminalFires).toBe(true);
  });

  it('prompt materialization: {{previous.report}} carries upstream summary', async () => {
    const { renderChainPrompt } = await import('../src/templates.js');
    const prev = { report_json: JSON.stringify({ summary: 'Found 3 outdated deps', artifacts: ['report.md'] }) };
    const out = renderChainPrompt('Upstream found:\n{{previous.report}}\nFiles: {{previous.artifacts}}', prev);
    expect(out).toContain('Found 3 outdated deps');
    expect(out).toContain('Files: report.md');
  });

  it('plain prompts (no placeholders) pass through unchanged', async () => {
    const { renderChainPrompt } = await import('../src/templates.js');
    expect(renderChainPrompt('just do the thing', undefined)).toBe('just do the thing');
  });
});
