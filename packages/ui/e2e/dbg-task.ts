import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();
const res = await fetch('http://127.0.0.1:4747/tasks', { headers: { authorization: `Bearer ${TOKEN}` } });
const d: any = await res.json();
for (const t of (d.tasks ?? d).slice(0, 5)) console.log(t.id, t.enabled, t.name);
