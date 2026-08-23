import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();
const res = await fetch('http://127.0.0.1:4747/runs?limit=6', { headers: { authorization: `Bearer ${TOKEN}` } });
const d: any = await res.json();
for (const r of (d.runs ?? d).slice(0, 6)) console.log(r.id, r.state, String(r.jobspec_json ?? '').slice(0, 50));
