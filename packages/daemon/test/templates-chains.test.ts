/**
 * Templates (S-74/S-75) + chaining (S-70/S-71/S-72/S-73) behavior tests.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import {
  securityPreview,
  validateTemplateApply,
  validateChain,
  renderChainPrompt,
} from '../src/templates.js';

function freshDb(): { db: DB; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-tpl-'));
  const db = openDatabase(dir).db;
  createMigrator(db, loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'))).migrate();
  return { db, dir };
}

describe('S-74 template security preview', () => {
  it('flags bypassPermissions red', () => {
    const p = securityPreview({
      schema: 'clockwork.template.v1',
      name: 'evil',
      prompt: 'do things',
      permissionMode: 'bypassPermissions',
      budget: { maxUsd: 2, maxTurns: 50, timeoutSec: 3600 },
    });
    expect(p.flags.some((f) => f.level === 'red')).toBe(true);
  });

  it('notes template variables and always arrives disabled', () => {
    const p = securityPreview({
      schema: 'clockwork.template.v1',
      name: 'ok',
      prompt: 'check {{repo_name}} for drift',
      permissionMode: 'acceptEdits',
      budget: { maxUsd: 2, maxTurns: 50, timeoutSec: 3600 },
    });
    expect(p.arrivesDisabled).toBe(true);
    expect(p.flags.some((f) => f.text.includes('repo_name'))).toBe(true);
  });
});

describe('S-75 apply-time variable validation', () => {
  it('rejects unfilled variables', () => {
    const r = validateTemplateApply(
      { schema: 'clockwork.template.v1', name: 'x', prompt: 'scan {{target_path}} now', permissionMode: 'acceptEdits', budget: { maxUsd: 1, maxTurns: 5, timeoutSec: 60 } },
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('target_path');
  });

  it('accepts fully filled variables', () => {
    const r = validateTemplateApply(
      { schema: 'clockwork.template.v1', name: 'x', prompt: 'scan {{target_path}} now', permissionMode: 'acceptEdits', budget: { maxUsd: 1, maxTurns: 5, timeoutSec: 60 } },
      { target_path: '/tmp/x' },
    );
    expect(r.ok).toBe(true);
  });
});

describe('S-72 chain validation (linear only)', () => {
  it('rejects self-chain and cycles at save', () => {
    const { db, dir } = freshDb();
    try {
      const now = Date.now();
      db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES ('a','a','p',?,?)`).run(now, now);
      db.prepare(`INSERT INTO tasks (id, name, prompt, chain_after, created_at, updated_at) VALUES ('b','b','p','a',?,?)`).run(now, now);

      expect(validateChain(db, 'a', 'a')).toMatch(/itself/);
      // a -> b would close the cycle a->b->a
      expect(validateChain(db, 'a', 'b')).toMatch(/cycle/);
      expect(validateChain(db, 'c', 'ghost')).toMatch(/not found/);
      // c -> a is rejected: b already occupies a's single successor slot
      expect(validateChain(db, 'c', 'a')).toMatch(/already has a chained successor/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a second successor on the same predecessor (linear invariant)', () => {
    const { db, dir } = freshDb();
    try {
      const now = Date.now();
      db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES ('a','a','p',?,?)`).run(now, now);
      db.prepare(`INSERT INTO tasks (id, name, prompt, chain_after, created_at, updated_at) VALUES ('b','b','p','a',?,?)`).run(now, now);
      db.prepare(`INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES ('c','c','p',?,?)`).run(now, now);
      // c also chaining to a would give a two children — fan-out is not supported
      expect(validateChain(db, 'c', 'a')).toMatch(/already has a chained successor/);
      // re-pointing b itself stays legal (id != self exemption)
      expect(validateChain(db, 'b', 'a')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('S-73 previous-run binding with truncation', () => {
  it('binds {{previous.report}} to the exact report summary', () => {
    const prev = { report_json: JSON.stringify({ summary: 'Fixed three flaky tests.', artifacts: ['report.md'] }) };
    const out = renderChainPrompt('Previous findings:\n{{previous.report}}\nArtifacts: {{previous.artifacts}}', prev);
    expect(out).toContain('Fixed three flaky tests.');
    expect(out).toContain('report.md');
  });

  it('truncates oversized reports with an honest marker', () => {
    const big = 'x'.repeat(20_000);
    const prev = { report_json: JSON.stringify({ summary: big }) };
    const out = renderChainPrompt('{{previous.report}}', prev, 12_000);
    expect(out.length).toBeLessThan(13_000);
    expect(out).toContain('[truncated');
  });

  it('renders ghost block when no previous run exists', () => {
    const out = renderChainPrompt('{{previous.report}}', undefined);
    expect(out).toContain('no previous run output');
  });
});
