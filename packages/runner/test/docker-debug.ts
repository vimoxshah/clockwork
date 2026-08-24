import { runInDocker } from '../src/docker-runner.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ws = mkdtempSync(join(tmpdir(), 'cw-dbg-'));
writeFileSync(join(ws, 'marker.txt'), 'clockwork-marker');
console.log('host path:', ws);
async function main(): Promise<void> {
  const r = await runInDocker({ image: 'alpine:3.19', workspace: ws, command: 'ls -la /workspace/ 2>&1 | head -5; echo ---; cat /workspace/marker.txt 2>&1', timeoutSec: 60 });
  console.log('ok:', r.ok);
  console.log('stdout:', JSON.stringify(r.stdout.slice(0, 300)));
  console.log('stderr:', JSON.stringify(r.stderr.slice(0, 400)));
}
void main();
