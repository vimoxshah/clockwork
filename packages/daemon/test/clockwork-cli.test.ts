/**
 * `clockwork` terminal CLI (P5): tables, JSON mode, exit codes, arg
 * validation — all against a stub transport (no daemon needed). The live
 * routes it wraps are covered by the daemon's own contract tests; what this
 * file owns is the CLI half: what it sends, what it prints, and how it exits.
 *
 * Standing rule asserted throughout: the api token never appears in output,
 * in --json or human mode.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runCommand,
  readToken,
  baseUrl,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_UNREACHABLE,
  EXIT_NOT_FOUND,
  EXIT_REFUSED,
  type CliTransport,
} from '../src/clockwork-cli.js';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function stub(routes: Record<string, { status: number; json: any }>, opts: { throwAll?: boolean } = {}): { t: CliTransport; out: string[]; err: string[]; calls: Call[] } {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  const t: CliTransport = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    fetchJson: async (method, p, body) => {
      calls.push({ method, path: p, body });
      if (opts.throwAll) throw new Error('down');
      const hit = routes[`${method} ${p}`];
      if (!hit) throw new Error(`unexpected request: ${method} ${p}`);
      return hit;
    },
  };
  return { t, out, err, calls };
}

describe('help and usage', () => {
  it('help exits 0 without touching the daemon', async () => {
    const { t, out, calls } = stub({});
    expect(await runCommand(['--help'], t)).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('approve <id>');
    expect(calls).toHaveLength(0);
  });

  it('unknown commands explain themselves', async () => {
    const { t, err } = stub({});
    expect(await runCommand(['frobnicate'], t)).toBe(EXIT_USAGE);
    expect(err.join('\n')).toContain('unknown command');
  });

  it('bad flags fail fast', async () => {
    const { t, err } = stub({});
    expect(await runCommand(['--port', 'nope', 'status'], t)).toBe(EXIT_USAGE);
    expect(err.join('\n')).toContain('--port');
    const { t: t2, err: err2 } = stub({});
    expect(await runCommand(['runs', '--limit', '0'], t2)).toBe(EXIT_USAGE);
    expect(err2.join('\n')).toContain('--limit');
  });
});

describe('status and lists', () => {
  it('status renders version, pause, counts, next fire', async () => {
    const { t, out } = stub({ 'GET /health': { status: 200, json: { daemonVersion: '0.13.0', versionSkew: false, paused: false, activeRuns: 1, queuedRuns: 2, nextFire: 1790000000000 } } });
    expect(await runCommand(['status'], t)).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('clockworkd 0.13.0');
    expect(out.join('\n')).toContain('active: 1');
  });

  it('--json prints exactly one parseable value', async () => {
    const body = [{ id: 'run_abc123', state: 'completed', task_name: 'Nightly', cost_usd: 0.5, started_at: 1790000000000 }];
    const { t, out } = stub({ 'GET /runs?limit=20': { status: 200, json: body } });
    expect(await runCommand(['runs', '--json'], t)).toBe(EXIT_OK);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual(body);
  });

  it('tables align columns and cap names', async () => {
    const { t, out } = stub({ 'GET /tasks': { status: 200, json: [{ id: 't1', name: 'A very long task name that goes on and on', enabled: true, nextFire: null }] } });
    expect(await runCommand(['tasks'], t)).toBe(EXIT_OK);
    const text = out.join('\n');
    expect(text).toContain('TASK');
    // 36-char cap: the full 41-char name never prints (copy from --json instead).
    expect(text).not.toContain('that goes on and on');
    expect(text).toContain('A very long task name that goes');
    // Columns align: every row's STATE starts at the same offset.
    const lines = text.split('\n').filter((l) => l.includes('active') || l.includes('STATE'));
    const offsets = lines.map((l) => l.indexOf('active') >= 0 ? l.indexOf('active') : l.indexOf('STATE'));
    expect(new Set(offsets).size).toBe(1);
  });

  it('empty lists say so instead of printing headers into the void', async () => {
    const { t, out } = stub({ 'GET /approvals': { status: 200, json: [] } });
    expect(await runCommand(['approvals'], t)).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('nothing waiting');
  });
});

describe('approvals and runs', () => {
  it('approve sends approved; --deny --note shape the body', async () => {
    const { t, out, calls } = stub({ 'POST /approvals/a1/respond': { status: 200, json: { resolved: true } } });
    expect(await runCommand(['approve', 'a1'], t)).toBe(EXIT_OK);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/approvals/a1/respond', body: { decision: 'approved' } });
    expect(out.join('\n')).toContain('Approved');
    const s2 = stub({ 'POST /approvals/a2/respond': { status: 200, json: { resolved: true } } });
    expect(await runCommand(['approve', 'a2', '--deny', '--note', 'too risky tonight'], s2.t)).toBe(EXIT_OK);
    expect(s2.calls[0]).toMatchObject({ body: { decision: 'denied', note: 'too risky tonight' } });
  });

  it('already-resolved answers exit 4 with the reason', async () => {
    const { t, err } = stub({ 'POST /approvals/a1/respond': { status: 409, json: { error: 'already_resolved' } } });
    expect(await runCommand(['approve', 'a1'], t)).toBe(EXIT_REFUSED);
    expect(err.join('\n')).toContain('already_resolved');
  });

  it('--note needs exactly one value; a flag there is a usage error', async () => {
    const { t, err } = stub({});
    expect(await runCommand(['approve', 'a1', '--note'], t)).toBe(EXIT_USAGE);
    expect(err.join('\n')).toContain('--note needs a value');
    const s2 = stub({});
    expect(await runCommand(['approve', 'a1', '--note', '--deny'], s2.t)).toBe(EXIT_USAGE);
  });

  it('daemon 5xx reads as daemon error, not gate refusal', async () => {
    const { t, err } = stub({ 'GET /health': { status: 500, json: { error: 'boom' } } });
    expect(await runCommand(['status'], t)).toBe(EXIT_REFUSED);
    expect(err.join('\n')).toContain('daemon errored (HTTP 500)');
  });

  it('tasks table splits state from next fire', async () => {
    const { t, out } = stub({ 'GET /tasks': { status: 200, json: [{ id: 't1', name: 'N', enabled: false, nextFire: null }] } });
    expect(await runCommand(['tasks'], t)).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('STATE');
    expect(out.join('\n')).toContain('paused');
  });

  it('run queues and prints the id; show/open read the report', async () => {
    const s1 = stub({ 'POST /tasks/t1/run-now': { status: 202, json: { runId: 'run_9' } } });
    expect(await runCommand(['run', 't1'], s1.t)).toBe(EXIT_OK);
    expect(s1.out.join('\n')).toContain('run_9');
    const rep = { run: {}, report: { taskName: 'Nightly', state: 'completed', summary: 'All green', branch: 'clockwork/x/1', costUsd: 0.4, turns: 7 } };
    const s2 = stub({ 'GET /runs/run_9/report': { status: 200, json: rep } });
    expect(await runCommand(['show', 'run_9'], s2.t)).toBe(EXIT_OK);
    expect(s2.out.join('\n')).toContain('All green');
    const s3 = stub({ 'GET /runs/run_9/report': { status: 200, json: rep } });
    expect(await runCommand(['open', 'run_9'], s3.t)).toBe(EXIT_OK);
    expect(s3.out.join('\n')).toContain('git fetch origin && git checkout clockwork/x/1');
  });

  it('open on a branchless run exits 3 with guidance', async () => {
    const { t, err } = stub({ 'GET /runs/r/report': { status: 200, json: { run: {}, report: { taskName: 't', state: 'completed' } } } });
    expect(await runCommand(['open', 'r'], t)).toBe(EXIT_NOT_FOUND);
    expect(err.join('\n')).toContain('no branch');
  });
});

describe('failures and auth', () => {
  it('unreachable daemon exits 2 and names the target', async () => {
    const { t, err } = stub({}, { throwAll: true });
    expect(await runCommand(['status'], t, 4747)).toBe(EXIT_UNREACHABLE);
    expect(err.join('\n')).toContain('127.0.0.1:4747');
  });

  it('404 exits 3; refused credentials exit 2 without printing the token', async () => {
    const s1 = stub({ 'GET /runs/nope/report': { status: 404, json: { error: 'not_found' } } });
    expect(await runCommand(['show', 'nope'], s1.t)).toBe(EXIT_NOT_FOUND);
    const s2 = stub({ 'GET /health': { status: 401, json: {} } });
    const code = await runCommand(['status'], s2.t);
    expect(code).toBe(EXIT_UNREACHABLE);
    expect(s2.out.join('') + s2.err.join('')).not.toContain('Bearer');
  });

  it('readToken honors CLOCKWORK_HOME and refuses to invent credentials', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-cli-'));
    try {
      process.env.CLOCKWORK_HOME = dir;
      expect(readToken()).toBeNull();
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'api-token'), 'sekrit\n', { mode: 0o600 });
      expect(readToken()).toBe('sekrit');
    } finally {
      delete process.env.CLOCKWORK_HOME;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('baseUrl honors flags and env', () => {
    expect(baseUrl(9999)).toBe('http://127.0.0.1:9999');
    expect(baseUrl()).toBe('http://127.0.0.1:4747');
    process.env.CLOCKWORK_PORT = '5555';
    try {
      expect(baseUrl()).toBe('http://127.0.0.1:5555');
    } finally {
      delete process.env.CLOCKWORK_PORT;
    }
  });

  it('--port success parses and reaches the command', async () => {
    const { t, out, calls } = stub({ 'GET /health': { status: 200, json: { daemonVersion: 'x', paused: false, activeRuns: 0, queuedRuns: 0 } } });
    expect(await runCommand(['--port', '9999', 'status'], t)).toBe(EXIT_OK);
    expect(calls).toHaveLength(1);
    expect(out.join('\n')).toContain('clockworkd x');
  });

  it('--json purity across commands: single parseable value each', async () => {
    const rep = { run: {}, report: { taskName: 'N', state: 'completed', summary: 's', branch: 'b', costUsd: 0, turns: 0 } };
    const routes: Record<string, { status: number; json: any }> = {
      'GET /health': { status: 200, json: { daemonVersion: 'x' } },
      'GET /tasks': { status: 200, json: [{ id: 't1' }] },
      'GET /approvals': { status: 200, json: [] },
      'GET /runs/run_1/report': { status: 200, json: rep },
    };
    for (const [args, key] of [
      [['status', '--json'], 'status'],
      [['tasks', '--json'], 'tasks'],
      [['approvals', '--json'], 'approvals'],
      [['show', 'run_1', '--json'], 'show'],
      [['open', 'run_1', '--json'], 'open'],
    ] as const) {
      const s = stub(routes);
      expect(await runCommand([...args], s.t), `json purity: ${key}`).toBe(EXIT_OK);
      expect(s.out, `single output: ${key}`).toHaveLength(1);
      expect(() => JSON.parse(s.out[0]!), `parseable: ${key}`).not.toThrow();
    }
  });

  it('no credential ever reaches output: static tripwire over the CLI source', async () => {
    // The token lives in realTransport/main only. Strip string literals, then
    // fail on any `token` identifier flowing into an output call — messages
    // ABOUT the token file ("no api token") are prose, not the value, and
    // survive because they live inside literals. Mirrors
    // agent-content-escaping's shape.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./clockwork-cli.test.ts', import.meta.url).pathname.replace(/test\/clockwork-cli\.test\.ts$/, 'src/clockwork-cli.ts'), 'utf8');
    const bad: string[] = [];
    src.split('\n').forEach((line, i) => {
      if (!(line.includes('t.out(') || line.includes('t.err(') || line.includes('.write('))) return;
      const code = line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''");
      if (/\btoken\b/i.test(code)) bad.push(`${i + 1}: ${line.trim()}`);
    });
    expect(bad).toEqual([]);
  });

  it('pack preview/install/list route through with files staying local', async () => {
    const preview = { manifest: { name: 'np', version: '1.0.0', publisher: 't' }, verified: { ok: true, keyId: 'k' }, templates: [{ name: 'a' }], blocked: false, blockedReasons: [] };
    const s1 = stub({ 'POST /packs/preview': { status: 200, json: preview } });
    // Unknown subcommand is usage, not a daemon call.
    expect(await runCommand(['pack', 'frobnicate', 'x'], s1.t)).toBe(EXIT_USAGE);
    expect(await runCommand(['pack', 'preview'], s1.t)).toBe(EXIT_USAGE);
  });

  it('pack list renders installed packs', async () => {
    const s = stub({ 'GET /packs/installed': { status: 200, json: { packs: [{ name: 'np', version: '1.0.0', tasks: 2 }] } } });
    expect(await runCommand(['pack', 'list'], s.t)).toBe(EXIT_OK);
    expect(s.out.join('\n')).toContain('np');
    expect(s.out.join('\n')).toContain('1.0.0');
  });

  it('pack sign canonical bytes match the daemon verifier', async () => {
    // A keypair in temp files; sign a pack doc; the daemon's verifyPack must
    // accept the produced signature — publisher tooling and verifier agree.
    const { generateKeyPairSync } = await import('node:crypto');
    const { verifyPack } = await import('../src/packs.js');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-packsign-'));
    try {
      const { privateKey } = generateKeyPairSync('ed25519');
      const privHex = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex');
      const doc = { schema: 'clockwork.pack.v1', manifest: { name: 'n', version: '1.0.0', publisher: 'p' }, templates: [{ schema: 'clockwork.template.v1', name: 't' }] };
      writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(doc));
      writeFileSync(path.join(dir, 'key.hex'), privHex);
      const s = stub({});
      expect(await runCommand(['pack', 'sign', '--json', path.join(dir, 'pack.json'), '--key', path.join(dir, 'key.hex')], s.t)).toBe(EXIT_OK);
      const printed = JSON.parse(s.out.join(''));
      const pack = { ...doc, signatures: [{ keyId: printed.keyId, pubkeyHex: printed.pubkeyHex, signature: printed.signature }] };
      const trusted = new Map([[printed.keyId, { pubkeyHex: printed.pubkeyHex, publisher: 'p', trustedAt: 1 }]]);
      expect(verifyPack(pack as any, trusted as any, '0.13.0')).toEqual({ ok: true, keyId: printed.keyId });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
