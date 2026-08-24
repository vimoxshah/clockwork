/* BYOK full-loop E2E: mock provider → create BYOK config → create task bound to it
 * → run now via API → verify the report came from the API agent adapter. */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
const BASE = 'http://127.0.0.1:4747';

let issues = 0;
const ok = (name: string, cond: boolean): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) issues += 1;
};

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(BASE + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

// --- deterministic mock chat-completions provider ---
let sawAuth = '';
let sawModel = '';
let sawPrompt = '';
const mock = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  // Validation probe hits GET /models
  if (req.url?.includes('/models')) {
    if (!String(req.headers.authorization ?? '').includes('sk-loop-mock')) {
      res.statusCode = 401; res.end(JSON.stringify({ error: 'bad key' })); return;
    }
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'llama3.2' }] }));
    return;
  }
  if (req.url?.includes('/chat/completions')) {
    sawAuth = String(req.headers.authorization ?? '');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body || '{}');
      sawModel = j.model ?? '';
      const userMsg = (j.messages ?? []).find((m: any) => m.role === 'user');
      sawPrompt = String(userMsg?.content ?? '').slice(0, 60);
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: `BYOK-E2E-OK analyzed: ${sawPrompt.slice(0, 30)}` } }],
        usage: { prompt_tokens: 120, completion_tokens: 45 },
      }));
    });
    return;
  }
  res.statusCode = 404; res.end('{}');
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
const port = (mock.address() as { port: number }).port;

// --- 1. register BYOK config (keychain) ---
const created = await call('POST', '/byok', {
  kind: 'custom_openai',
  label: 'Loop mock',
  base_url: `http://127.0.0.1:${port}/v1`,
  auth: 'keychain',
  secret: 'sk-loop-mock-abcdef1234',
  default_model: 'llama3.2',
});
ok('BYOK config created', created.status === 201);
const cfg = created.json as { id: string };

// --- 2. create a task bound to it ---
const scratch = `${homedir()}/.clockwork/scratch/byok-e2e`;
mkdirSync(scratch, { recursive: true });
writeFileSync(`${scratch}/note.txt`, 'sample');
const t = await call('POST', '/tasks', {
  name: 'BYOK loop e2e',
  prompt: 'Summarize note.txt in one sentence.',
  byokId: cfg.id,
  repoPath: '', // scratch mode
  schedule: { kind: 'queue', tz: 'Asia/Kolkata' },
});
ok('task with byokId created', t.status === 201);
const taskId = (t.json as { id: string }).id;

// --- 3. run now ---
const rn = await call('POST', `/tasks/${taskId}/run-now`);
ok('run-now accepted', rn.status === 200 || rn.status === 202);
const runId = (rn.json as { runId?: string }).runId ?? '';

// --- 4. poll for completion (max ~40s) ---
let report: any = null;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const runs = await call('GET', '/runs?limit=5');
  const row = (runs.json ?? []).find?.((r2: any) => r2.id === runId);
  if (!row) continue;
  if (['completed', 'failed'].includes(row.state)) {
    const rep = await call('GET', `/runs/${runId}/report`);
    report = rep.json;
    break;
  }
}

ok('run reached terminal state', report !== null);
if (report) {
  ok('run completed', report.run.state === 'completed');
  ok('mock received bearer token', sawAuth.includes('sk-loop-mock'));
  ok('mock received model llama3.2', sawModel === 'llama3.2');
  ok('prompt reached the provider', sawPrompt.length > 0);
  ok('summary contains marker', String(report.report?.summary ?? '').includes('BYOK-E2E-OK'));
  ok('cost estimated from token usage', Number(report.run.cost_usd ?? 0) > 0);
  console.log(`   summary: ${String(report.report?.summary).slice(0, 80)}`);
  console.log(`   cost: $${report.run.cost_usd} turns: ${report.run.turns}`);
} else {
  console.log('   (no terminal report within timeout)');
}

// --- 5. cleanup: delete task + config ---
await call('DELETE', `/tasks/${taskId}`);
await call('DELETE', `/byok/${cfg.id}`);
mock.close();

console.log(`\n=== BYOK FULL LOOP: ${issues === 0 ? 'ALL PASS' : issues + ' FAILURES'} ===`);
process.exit(issues === 0 ? 0 : 1);
