/**
 * Regression test for a verified sandbox escape (iteration 13).
 *
 * Before the fix a run could `cat ~/.clockwork/api-token`, reach the daemon on
 * loopback with it — the profile allows network* — and read every task through
 * the authenticated API. From there it could book a task with any repo path,
 * escaping the write restrictions of the run it started in. Each step was
 * confirmed by execution, not inferred.
 *
 * The fix is deliberately narrow, and the second half of this file is why: a
 * blanket deny on ~/.clockwork would break EVERY run, because worktrees live
 * at ~/.clockwork/worktrees and journals at ~/.clockwork/runs. Closing the
 * escape must not cost the agent its own workspace.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateSeatbeltProfile, wrapWithSandbox, CONTROL_PLANE_PATHS, CREDENTIAL_PATHS } from '../src/sandbox.js';

const onMac = process.platform === 'darwin';
const DATA = process.env.CLOCKWORK_HOME ?? path.join(os.homedir(), '.clockwork');
const WT = path.join(DATA, 'worktrees', 'cw-escape-test');
const RUNS = path.join(DATA, 'runs', 'cw-escape-test');

let tmp: string;
let profilePath: string;

function inSandbox(argv: string[]): boolean {
  const w = wrapWithSandbox(argv, profilePath);
  try {
    execFileSync(w[0]!, w.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
    return true;
  } catch { return false; }
}

beforeAll(() => {
  mkdirSync(WT, { recursive: true });
  mkdirSync(RUNS, { recursive: true });
  writeFileSync(path.join(WT, 'source.ts'), 'export const x = 1;\n');
  writeFileSync(path.join(RUNS, 'events.jsonl'), '{"kind":"log"}\n');
  tmp = mkdtempSync(path.join(os.tmpdir(), 'cw-esc-'));
  const { profile } = generateSeatbeltProfile({ writePaths: [WT], readPaths: [WT] });
  profilePath = path.join(tmp, 'p.sb');
  writeFileSync(profilePath, profile);
});

afterAll(() => {
  rmSync(WT, { recursive: true, force: true });
  rmSync(RUNS, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!onMac)('control-plane escape', () => {
  it('the control-plane paths are part of the deny list', () => {
    expect(CONTROL_PLANE_PATHS.length).toBeGreaterThan(0);
    for (const p of CONTROL_PLANE_PATHS) expect(CREDENTIAL_PATHS).toContain(p);
  });

  it('a run cannot read the daemon token — this was the escape', () => {
    expect(inSandbox(['/bin/cat', path.join(DATA, 'api-token')])).toBe(false);
  });

  it('a run cannot read the task database', () => {
    expect(inSandbox(['/bin/cat', path.join(DATA, 'clockwork.sqlite')])).toBe(false);
  });

  // The fix must not cost the agent its workspace. Without these, a blanket
  // deny would look "secure" while breaking every run.
  it('a run CAN still read its own worktree', () => {
    expect(inSandbox(['/bin/cat', path.join(WT, 'source.ts')])).toBe(true);
  });

  it('a run CAN still write to its own worktree', () => {
    expect(inSandbox(['/bin/sh', '-c', `echo ok > ${JSON.stringify(path.join(WT, 'out.txt'))}`])).toBe(true);
  });

  it('a run CAN still read its own journal', () => {
    expect(inSandbox(['/bin/cat', path.join(RUNS, 'events.jsonl')])).toBe(true);
  });
});
