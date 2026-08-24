/* BYOK end-to-end verification: create → keychain stored → test → rotate → delete.
 * Uses a local mock OpenAI-compatible server so no real API key is needed. */
import { createServer } from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
const BASE = 'http://127.0.0.1:4747';

let issues = 0;
const ok = (name: string, cond: boolean): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) issues += 1;
};

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(BASE + path, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: unknown = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

// --- mock provider endpoint (validates credential via Bearer check) ---
let receivedAuth = '';
const mock = createServer((req, res) => {
  receivedAuth = String(req.headers.authorization ?? '');
  res.setHeader('content-type', 'application/json');
  if (!receivedAuth.includes('sk-test-mock-9876')) {
    res.statusCode = 401; res.end(JSON.stringify({ error: 'bad key' })); return;
  }
  res.end(JSON.stringify({ object: 'list', data: [{ id: 'llama3.2' }] }));
});
await new Promise<void>((r) => mock.listen(0, r)); // dual-stack: daemon fetch may resolve localhost to ::1
const mockUrl = `http://localhost:${(mock.address() as { port: number }).port}/v1`;

// --- 1. create with keychain auth ---
const created = await call('POST', '/byok', {
  kind: 'custom_openai',
  label: 'Mock local gateway',
  base_url: mockUrl,
  auth: 'keychain',
  secret: 'sk-test-mock-9876abcd',
  default_model: 'llama3.2',
});
ok('create returns 201', created.status === 201);
const cfg = created.json as { id: string; hint?: string; last_error?: string | null };
ok('config id present', Boolean(cfg.id?.length >= 6));
ok('hint is redacted (no raw key)', !JSON.stringify(cfg).includes('sk-test-mock'));
console.log('   hint:', cfg.hint);

// --- 2. keychain actually holds it ---
let kcValue = '';
try {
  kcValue = execFileSync('security', ['find-generic-password', '-s', `clockwork-byok-${cfg.id}`, '-w'], { encoding: 'utf8' }).trim();
} catch {}
ok('keychain stores the real key', kcValue.includes('sk-test-mock-9876'));

// --- 3. validation ran and succeeded against the mock ---
ok('last_validated_at set after auto-validate', typeof cfg.last_validated_at === 'number' && cfg.last_validated_at > 0);
ok('no last_error after good validate', cfg.last_error == null);
ok('mock received the bearer token', receivedAuth.includes('Bearer sk-test-mock'));

// --- 4. list does not leak the secret ---
const listed = await call('GET', '/byok');
ok('list does not contain raw key', !JSON.stringify(listed.json).includes('sk-test-mock'));

// --- 5. explicit test connection ---
const test = await call('POST', `/byok/${cfg.id}/test`);
ok('test connection ok:true', (test.json as { ok: boolean }).ok === true);

// --- 6. bad-key config reports invalid ---
const bad = await call('POST', '/byok', {
  kind: 'custom_openai',
  label: 'Bad creds',
  base_url: mockUrl,
  auth: 'keychain',
  secret: 'sk-wrong-key-000000000',
  default_model: 'x',
});
const badCfg = bad.json as { id: string; last_error?: string | null };
ok('bad credential flagged with last_error', typeof badCfg.last_error === 'string' && badCfg.last_error.length > 0);
await call('DELETE', `/byok/${badCfg.id}`);

// --- 7. rotate ---
const rot = await call('POST', `/byok/${cfg.id}/rotate`, { secret: 'sk-test-mock-rotated-5555' });
ok('rotate returns new hint', ((rot.json as { hint?: string }).hint ?? '').includes('5555'));
const test2 = await call('POST', `/byok/${cfg.id}/test`);
ok('test passes with rotated key', (test2.json as { ok: boolean }).ok === true);

// --- 8. env-mode ---
process.env.CW_TEST_KEY = 'sk-env-mode-12345678';
const envCfg = await call('POST', '/byok', {
  kind: 'openrouter',
  label: 'Env-based',
  auth: 'env',
  env_var: 'CW_TEST_KEY',
  default_model: 'anthropic/claude-sonnet-4.5',
});
ok('env-mode create works', envCfg.status === 201);
await call('DELETE', `/byok/${(envCfg.json as { id: string }).id}`);

// --- 9. delete removes keychain entry ---
await call('DELETE', `/byok/${cfg.id}`);
let kcGone = false;
try {
  execFileSync('security', ['find-generic-password', '-s', `clockwork-byok-${cfg.id}`], { encoding: 'utf8' });
} catch { kcGone = true; }
ok('delete removes keychain entry', kcGone);

mock.close();
console.log(`\n=== BYOK E2E: ${issues === 0 ? 'ALL PASS' : issues + ' FAILURES'} ===`);
process.exit(issues === 0 ? 0 : 1);
