import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();
const api = async (m: string, p: string, b?: unknown): Promise<any> => {
  const r = await fetch(`http://127.0.0.1:4747${p}`, { method: m, headers: { authorization: `Bearer ${TOKEN}`, ...(b ? {'content-type':'application/json'} : {}) }, body: b ? JSON.stringify(b) : undefined });
  return r.json();
};
// trigger run now
const r = await api('POST', '/tasks/01M0PVF481WJS7T5MD1RCNGGES/run-now');
console.log('RUN NOW:', JSON.stringify(r).slice(0, 200));
for (let i = 0; i < 40; i++) {
  await new Promise((res) => setTimeout(res, 6000));
  const runs: any = await api('GET', '/runs?limit=8');
  const row = (runs.runs ?? runs).find((x: any) => String(x.task_id) === '01M0PVF481WJS7T5MD1RCNGGES');
  if (row && ['completed','failed','timed_out','cancelled'].includes(row.state)) {
    console.log('STATE:', row.state, 'cost:', row.cost_usd, 'reason:', row.outcome_reason);
    if (row.id) {
      const rep: any = await api('GET', `/runs/${row.id}/report`);
      console.log('SUMMARY:', String(rep?.report?.summary ?? '').slice(0, 250));
    }
    break;
  }
  if (row) console.log('...', row.state);
}
