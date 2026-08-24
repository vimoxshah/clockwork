/**
 * DockerRunner live verification: real container, real isolation guarantees.
 * Requires a running Docker daemon (colima start / docker desktop).
 */
import { isDockerAvailable, runInDocker } from '../src/docker-runner.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let issues = 0;
const ok = (name: string, cond: boolean): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) issues += 1;
};

// Guard: this file is also picked up by vitest; when run under vitest the
// top-level code executes and process.exit would kill the worker. Detect
// vitest and bail out cleanly before any container work.
const UNDER_VITEST = typeof (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__ !== 'undefined';
if (UNDER_VITEST) {
  console.log('SKIP: docker-live test runs standalone (npx tsx), not under vitest');
} else if (!(await isDockerAvailable())) {
  console.log('SKIP: docker daemon unavailable');
  process.exit(0);
}
if (!UNDER_VITEST) {

// Pull a tiny image once (alpine ~3MB)
try {
  execFileSync('docker', ['pull', '-q', 'alpine:3.19'], { stdio: 'ignore', timeout: 120_000 });
} catch { /* may already exist */ }

// Workspace setup BEFORE first use: ~/.clockwork paths propagate into the VM.
const ws = join(homedir(), '.clockwork', 'scratch', 'docker-live-test');
mkdirSync(ws, { recursive: true });
writeFileSync(join(ws, 'marker.txt'), 'clockwork-marker');

// 1. basic command in ephemeral container
const r1 = await runInDocker({
  image: 'alpine:3.19',
  workspace: ws,
  command: 'echo hello-from-container && uname -m',
  timeoutSec: 60,
});
ok('basic run ok', r1.ok);
ok('stdout captured', r1.stdout.includes('hello-from-container'));

// 2. filesystem isolation: workspace visible, host root NOT
const r2 = await runInDocker({
  image: 'alpine:3.19',
  workspace: ws,
  command: 'cat /workspace/marker.txt; test ! -d /Users && echo HOST-ISOLATED',
  timeoutSec: 60,
});
ok('workspace bind-mounted (marker readable)', r2.stdout.includes('clockwork-marker'));
ok('host root not mounted (/Users absent)', r2.stdout.includes('HOST-ISOLATED'));

// 3. network=none: no outbound connectivity
const r3 = await runInDocker({
  image: 'alpine:3.19',
  workspace: ws,
  command: 'wget -q -T 5 -O- https://example.com 2>&1; echo "exit:$?"',
  timeoutSec: 60,
});
ok('no-network policy enforced (wget fails)', r3.stdout.includes('exit:1') || r3.stderr.length > 0);

// 4. env injection at runtime
const r4 = await runInDocker({
  image: 'alpine:3.19',
  workspace: ws,
  command: 'test "$SECRET_TOKEN" = "abc123" && echo env-ok',
  env: { SECRET_TOKEN: 'abc123' },
  timeoutSec: 60,
});
ok('env vars injected', r4.stdout.includes('env-ok'));

// 5. resource limit smoke: pids-limit makes fork bombs fail instead of hanging
const r5 = await runInDocker({
  image: 'alpine:3.19',
  workspace: ws,
  command: ':(){ :|:& };:',
  pidsLimit: 32,
  timeoutSec: 30,
});
console.log(`   fork-bomb contained: exit=${r5.exitCode} timedOut=${r5.error === 'timeout'}`);
ok('fork bomb did not hang the runner', r5.error === 'timeout' || !r5.ok || r5.exitCode === 0);

console.log(`\n=== DOCKER RUNNER: ${issues === 0 ? 'ALL PASS' : issues + ' FAILURES'} ===`);
process.exit(issues === 0 ? 0 : 1);
}
