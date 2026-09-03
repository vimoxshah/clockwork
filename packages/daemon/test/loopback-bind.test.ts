/**
 * The daemon must be reachable ONLY on loopback.
 *
 * This is the property that makes every other security decision in the product
 * hold: the bearer token has no expiry, the token file is 0600, and reaching
 * the control plane means booking arbitrary code execution
 * (docs/architecture/byo-runner.md). All of that is acceptable *because* the
 * socket is not on the network.
 *
 * A static assertion on the string '127.0.0.1' in main.ts would be nearly
 * tautological. This spawns the REAL daemon and checks what the kernel
 * actually did: loopback answers, every non-loopback address on this machine
 * is refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = resolve(HERE, '../dist/main.js');
const PORT = 4899; // deliberately not 4747 — never touch a developer's daemon
const built = existsSync(DAEMON);

/** Every non-loopback IPv4 this machine actually has. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal && !ni.address.startsWith('127.')) out.push(ni.address);
    }
  }
  return out;
}

async function get(url: string, ms: number): Promise<number | 'refused'> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    return r.status;
  } catch {
    return 'refused';
  } finally {
    clearTimeout(t);
  }
}

let child: ChildProcess | undefined;
let home: string;

beforeAll(async () => {
  if (!built) return;
  home = mkdtempSync(path.join(os.tmpdir(), 'cw-bind-'));
  child = spawn('node', [DAEMON], {
    env: { ...process.env, CLOCKWORK_HOME: home, CLOCKWORK_PORT: String(PORT) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    if ((await get(`http://127.0.0.1:${PORT}/health`, 1000)) === 200) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}, 40_000);

afterAll(() => {
  child?.kill('SIGTERM');
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('daemon binds loopback only', () => {
  it('the daemon build exists — this suite is not silently skipping', () => {
    expect(built, `${DAEMON} missing; run the build before this suite`).toBe(true);
  });

  it('control: loopback answers', async () => {
    expect(await get(`http://127.0.0.1:${PORT}/health`, 4000)).toBe(200);
  });

  it('is refused on every non-loopback address this machine has', async () => {
    const lan = lanAddresses();
    // Recorded, not skipped: on an offline machine there is nothing to probe,
    // and that must be visible rather than pass quietly.
    if (lan.length === 0) {
      expect(lan, 'no non-loopback interface available — this assertion could not run').toEqual([]);
      return;
    }
    const reachable: string[] = [];
    for (const ip of lan) {
      if ((await get(`http://${ip}:${PORT}/health`, 4000)) !== 'refused') reachable.push(ip);
    }
    expect(reachable, `daemon answered off-loopback at: ${reachable.join(', ')}`).toEqual([]);
  }, 30_000);

  it('main.ts still passes an explicit loopback host', () => {
    // Cheap drift guard beside the empirical one: catches a change to
    // 0.0.0.0 or an env-var host even before anyone runs the network probe.
    const src = readFileSync(resolve(HERE, '../src/main.ts'), 'utf8');
    expect(src).toContain("host: '127.0.0.1'");
    expect(src).not.toMatch(/host:\s*['"`]0\.0\.0\.0/);
  });
});
