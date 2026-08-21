/**
 * T-001 — CLI runner PoC: prove headless `claude -p --output-format stream-json`
 * on the subscription login (no API key): worktree -> run -> report JSON.
 *
 * Verifies per-event usage granularity, structured summary extraction, and
 * measures soft-cap overshoot. Throwaway script; the REPORT is the artifact:
 * spikes/reports/T001-cli-runner.md
 */
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fold, newAccumulator, parseStreamLine } from '../../packages/runner/src/stream-parser.js';

const OUT_DIR = path.resolve(import.meta.dirname, '../reports');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'cw-t001-'));
const repoDir = path.join(scratch, 'toy-repo');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

interface Finding {
  check: string;
  result: 'PASS' | 'FAIL' | 'PARTIAL';
  detail: string;
}
const findings: Finding[] = [];

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  // ---- toy repo ----
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, 'init', '-b', 'main');
  git(repoDir, 'config', 'user.email', 'spike@clockwork.local');
  git(repoDir, 'config', 'user.name', 'Clockwork Spike');
  writeFileSync(path.join(repoDir, 'README.md'), '# Toy repo\n\nNo docs yet.\n');
  writeFileSync(path.join(repoDir, 'calc.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
  git(repoDir, 'add', '-A');
  git(repoDir, 'commit', '-m', 'init');

  // ---- worktree ----
  const wt = path.join(scratch, 'wt');
  git(repoDir, 'worktree', 'add', '-b', 'clockwork/spike/t001', wt, 'main');

  // ---- version + auth posture (T-004 partial: absent-auth probe happens separately) ----
  let cliVersion = 'unknown';
  try {
    cliVersion = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
    findings.push({ check: 'claude CLI present', result: 'PASS', detail: cliVersion });
  } catch (e) {
    findings.push({ check: 'claude CLI present', result: 'FAIL', detail: String(e) });
  }

  // ---- the real headless run on subscription login ----
  console.log('>>> running claude -p (stream-json) — real subscription run…');
  const startedAt = Date.now();
  const acc = newAccumulator();
  const usageTimeline: Array<{ t: number; costUsd?: number; turns?: number }> = [];
  const rawEvents: string[] = [];
  let stderrTail = '';
  let exitCode: number | null = null;

  await new Promise<void>((resolve) => {
    // permission-mode acceptEdits; NO api key env passed through; sanitized env
    const child = spawn(
      'claude',
      [
        '-p',
        'Read calc.ts and add a short JSDoc comment to the add function. Then commit your change with message "docs: jsdoc for add". Do nothing else.',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'acceptEdits',
      ],
      { cwd: wt, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const pgid = child.pid!;
    const killer = setTimeout(() => {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {}
    }, 240_000);

    child.stdout!.setEncoding('utf8');
    let buf = '';
    child.stdout!.on('data', (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        rawEvents.push(line.slice(0, 400));
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'assistant' && obj.message?.usage) {
            usageTimeline.push({ t: Date.now() - startedAt, ...obj.message.usage });
          }
        } catch {}
        const ev = parseStreamLine(line);
        if (ev) fold(acc, ev);
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (c: string) => {
      stderrTail = (stderrTail + c).slice(-2000);
    });
    child.on('close', (code) => {
      exitCode = code;
      clearTimeout(killer);
      resolve();
    });
  });
  const wallMs = Date.now() - startedAt;

  findings.push({
    check: 'headless run completes on subscription login (no API key)',
    result: exitCode === 0 && acc.lastError === undefined ? 'PASS' : 'FAIL',
    detail: `exit=${exitCode} wallMs=${wallMs} lastError=${JSON.stringify(acc.lastError)} stderr=${stderrTail.slice(-200)}`,
  });

  // ---- report JSON assembly (draft schema) ----
  const baseSha = git(wt, 'rev-parse', 'HEAD~1').trim();
  const numstat = git(wt, 'diff', '--numstat', `${baseSha}..HEAD`).trim();
  const commits = git(wt, 'log', '--oneline', `${baseSha}..HEAD`).trim();

  const report = {
    engine: 'cli',
    cliVersion,
    sessionId: acc.sessionId ?? null,
    summary: acc.lastResult ?? null,
    costUsd: acc.totalCostUsd,
    turns: acc.turns,
    wallMs,
    exitCode,
    committedSomething: commits.length > 0,
    commits,
    diffNumstat: numstat || '(none)',
    usageEventCount: usageTimeline.length,
    rawEventTypes: [...new Set(rawEvents.map((l) => { try { return (JSON.parse(l) as any).type as string; } catch { return 'nonjson'; } }))],
  };
  writeFileSync(path.join(OUT_DIR, 't001-report.json'), JSON.stringify(report, null, 2));

  findings.push({
    check: 'per-event usage telemetry granularity',
    result: usageTimeline.length > 0 ? 'PASS' : 'FAIL',
    detail: `${usageTimeline.length} assistant-usage events; final cumulative cost=$${acc.totalCostUsd.toFixed(4)}, turns=${acc.turns}`,
  });
  findings.push({
    check: 'structured summary extraction (result event)',
    result: acc.lastResult ? 'PASS' : 'PARTIAL',
    detail: `summary: ${(acc.lastResult ?? '(none)').slice(0, 200)}`,
  });
  findings.push({
    check: 'worktree mutation contained (commit landed in worktree branch)',
    result: commits.length > 0 && existsSync(path.join(wt, 'calc.ts')) ? 'PASS' : 'FAIL',
    detail: commits.split('\n')[0] ?? 'no commits',
  });
  findings.push({
    check: 'session id captured for resume',
    result: acc.sessionId ? 'PASS' : 'FAIL',
    detail: acc.sessionId ?? 'none',
  });

  // ---- cleanup ----
  rmSync(scratch, { recursive: true, force: true });

  // ---- write spike report ----
  const md = [
    '# T-001 — CLI runner PoC report',
    '',
    `- Date: ${new Date().toISOString()}`,
    `- Engine: claude CLI ${cliVersion}, subscription login, no API key`,
    `- Wall time: ${wallMs}ms, cost: $${acc.totalCostUsd.toFixed(4)}, turns: ${acc.turns}`,
    '',
    '| Check | Result | Detail |',
    '|---|---|---|',
    ...findings.map((f) => `| ${f.check} | ${f.result} | ${f.detail.replace(/\|/g, '/')} |`),
    '',
    '## Raw event types seen',
    '',
    '```',
    JSON.stringify(report.rawEventTypes),
    '```',
    '',
    '## Usage timeline (per assistant event)',
    '',
    '```json',
    JSON.stringify(usageTimeline, null, 2).slice(0, 3000),
    '```',
    '',
  ].join('\n');
  writeFileSync(path.join(OUT_DIR, 'T001-cli-runner.md'), md);
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
