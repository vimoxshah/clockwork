import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assembleContext, maskSecrets } from '../src/context.js';

describe('FR-2a context assembly', () => {
  it('includes readable files with content', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-ctx-'));
    try {
      const f = path.join(dir, 'notes.md');
      writeFileSync(f, '# Notes\nfix the parser');
      const r = assembleContext([{ path: f }]);
      expect(r.included).toEqual([f]);
      expect(r.block).toContain('fix the parser');
      expect(r.refused).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses credential-path attachments (S-67 floor)', () => {
    const r = assembleContext([
      { path: `${os.homedir()}/.ssh/id_ed25519` },
      { path: '/Users/x/Library/Keychains/login.keychain-db' },
    ]);
    expect(r.included).toHaveLength(0);
    expect(r.refused.length).toBe(2);
  });

  it('truncates oversized files honestly', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-ctx2-'));
    try {
      const f = path.join(dir, 'big.log');
      writeFileSync(f, 'x'.repeat(20_000));
      const r = assembleContext([{ path: f }]);
      expect(r.truncatedFiles).toEqual([f]);
      expect(r.block).toContain('[truncated');
      expect(r.block.length).toBeLessThan(10_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports unreadable paths as refused instead of crashing', () => {
    const r = assembleContext([{ path: '/definitely/not/here.txt' }]);
    expect(r.included).toHaveLength(0);
    expect(r.refused[0]).toContain('unreadable');
  });
});

describe('S-68 secret masking (best-effort, documented)', () => {
  it('masks common credential shapes in report text', () => {
    const input = [
      'key AKIAIOSFODNN7EXAMPLE used',
      'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456',
      'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaa-bb',
      'password=hunter2',
      '-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = maskSecrets(input);
    expect(out).toContain('[AWS-KEY-MASKED]');
    expect(out).toContain('[GITHUB-TOKEN-MASKED]');
    expect(out).toContain('[ANTHROPIC-KEY-MASKED]');
    expect(out).toMatch(/password=\[MASKED\]/i);
    expect(out).toContain('[PEM-BLOCK-MASKED]');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('AKIA');
  });

  it('leaves normal text untouched', () => {
    const t = 'Fixed three flaky tests in scheduler.spec.ts; cost $0.42.';
    expect(maskSecrets(t)).toBe(t);
  });
});
