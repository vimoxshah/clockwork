/**
 * T-004 — Auth + error-class probes: absent-auth behavior, error taxonomy
 * from stream-json. Expired-token simulation is documented in the memo
 * (requires tampering real credentials — not done on the dev machine).
 * Output: spikes/reports/T004-auth-probes.md
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fold, newAccumulator, parseStreamLine } from '../../packages/runner/src/stream-parser.js';

const OUT_DIR = path.resolve(import.meta.dirname, '../reports');

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const rows: string[] = [];

  // ---- probe 1: absent auth via CLAUDE_CONFIG_DIR pointing at an empty dir ----
  const emptyCfg = mkdtempSync(path.join(os.tmpdir(), 'cw-emptycfg-'));
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'cw-t004-'));
  const r = spawnSync(
    '/usr/bin/env',
    [
      'claude', '-p', 'hi', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'acceptEdits',
    ],
    {
      cwd: scratch,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, CLAUDE_CONFIG_DIR: emptyCfg } as Record<string, string>,
    },
  );
  const acc = newAccumulator();
  for (const line of (r.stdout || '').split('\n')) {
    const ev = parseStreamLine(line);
    if (ev) fold(acc, ev);
  }
  const sawAuthError =
    (r.stdout || '').includes('authentication_failed') ||
    (r.stdout || '').includes('Not logged in');
  rows.push(
    `| Absent auth (empty CLAUDE_CONFIG_DIR) | exit=${r.status} | authentication_failed in stream: ${sawAuthError} | ${sawAuthError ? 'DETECTABLE' : 'NOT DETECTABLE'} |`,
  );
  rmSync(emptyCfg, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });

  // ---- probe 2: healthy run sanity (already proven by T-001; skip repeat spend) ----
  rows.push(`| Healthy auth | verified at T-001 (real run, exit=0) | — | DETECTABLE (absence of error) |`);

  const md = `# T-004 — Auth & error-class probe report

- Date: ${new Date().toISOString()}

| Probe | Observed | Detail | Class |
|---|---|---|---|
${rows.join('\n')}

## Error taxonomy (from observed streams + docs)

| Class | Detection signal (stream-json / exit) |
|---|---|
| auth | result event \`error:"authentication_failed"\` or "Not logged in"; also pre-flight \`claude doctor\`-style check possible |
| rate_limited | \`rate_limit_event\` stream events (observed in T-001 even on success); terminal 429 surfaces in result error text |
| capacity | usage-limit/overload strings ("limit reached", 529 overloaded) |
| offline | ENOTFOUND/ECONNREFUSED/fetch-failed before any API event |
| model_unknown | model-not-found/deprecated strings in result error |
| other/internal | anything else non-zero |

## Not probed here (documented)
- **Expired token**: requires mutating real credentials; not done on dev machine.
  Same detection signal as absent-auth expected (\`authentication_failed\`) — runner maps both to \`failed:auth\`.
- **Rate-limit terminal state**: needs a throttled account; \`rate_limit_event\` type existence verified in T-001 stream.
`;
  writeFileSync(path.join(OUT_DIR, 'T004-auth-probes.md'), md);
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
