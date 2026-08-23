/* Live end-to-end: book a Hermes-provider task via the API, wait for the run, verify report. */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();
const BASE = 'http://127.0.0.1:4747';

const api = async (method: string, path: string, body?: unknown): Promise<any> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
};

const run = async (): Promise<void> => {
  const providers = await api('GET', '/providers');
  console.log('PROVIDERS:', providers.map((p: any) => `${p.id}:${p.detected ? p.version : 'MISSING'}`).join(' | '));

  const task = await api('POST', '/tasks', {
    name: 'Hermes live E2E',
    prompt: 'Reply with exactly: HERMES-E2E-OK',
    engine: 'hermes',
    repoPath: '',
    permissionMode: 'default',
    budget: { maxUsd: 1, maxTurns: 6, timeoutSec: 240 },
    schedule: { kind: 'queue', tz: 'Asia/Kolkata' },
  });
  if (task.error) { console.log('BOOK FAILED:', JSON.stringify(task).slice(0, 300)); return; }
  console.log('TASK BOOKED:', task.id ?? task.task?.id);

  // poll for run completion up to 4 min
  const deadline = Date.now() + 240_000;
  let runRow: any = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const runs = await api('GET', '/runs?limit=10');
    const rows = runs.runs ?? runs;
    runRow = (Array.isArray(rows) ? rows : []).find((r: any) => String(r.jobspec_json ?? '').includes('Hermes live E2E'));
    if (runRow && ['completed', 'failed', 'timed_out', 'cancelled'].includes(runRow.state)) break;
    console.log('...state:', runRow?.state ?? 'no row yet');
  }
  if (!runRow) { console.log('NO RUN ROW FOUND'); return; }
  console.log('RUN STATE:', runRow.state, '| cost:', runRow.cost_usd, '| turns:', runRow.turns);
  const rep = await api('GET', `/runs/${runRow.id}/report`);
  const summary = rep?.report?.summary ?? '';
  console.log('SUMMARY CONTAINS TOKEN:', summary.includes('HERMES-E2E-OK') ? 'YES ✓' : `NO — got: ${summary.slice(0, 200)}`);
};
void run();
