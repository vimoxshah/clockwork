/**
 * The published audit repo must match the code the app actually builds from.
 *
 * public/clockwork-sandbox/ is a COPY of the security boundary, pushed to a
 * public repository so people can read and run it. A copy rots. The Homebrew
 * tap taught this the expensive way: its README carried a broken install
 * command for as long as it did precisely because no test in this repo could
 * see it.
 *
 * A stale published sandbox is worse than none — it invites trust in code the
 * shipped app no longer runs. So this guard fails the build the moment a
 * runner source changes without `packaging/sync-public-sandbox.sh` being run.
 *
 * Byte-identical, not "equivalent": any normalisation here would be a hole
 * someone could drive a real difference through.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PUB = resolve(ROOT, 'public/clockwork-sandbox');

// Listed explicitly, never globbed — a guard that enumerates its own inputs
// goes quiet exactly when a file is dropped from the publish set.
const SRC_FILES = ['sandbox.ts', 'deny-list.ts', 'run-env.ts', 'service-path.ts'];
const TEST_FILES = [
  'sandbox-credentials.test.ts',
  'control-plane-escape.test.ts',
  'run-env-allowlist.test.ts',
  'deny-list.test.ts',
];

describe('published sandbox mirror', () => {
  it('publishes every file it claims to', () => {
    for (const f of [...SRC_FILES.map((f) => `src/${f}`), ...TEST_FILES.map((f) => `test/${f}`)]) {
      expect(existsSync(resolve(PUB, f)), `${f} missing from the published copy`).toBe(true);
    }
    expect(SRC_FILES.length + TEST_FILES.length).toBe(8);
  });

  it('is byte-identical to the runner sources', () => {
    const drifted: string[] = [];
    for (const f of SRC_FILES) {
      const a = readFileSync(resolve(ROOT, 'packages/runner/src', f));
      const b = readFileSync(resolve(PUB, 'src', f));
      if (!a.equals(b)) drifted.push(`src/${f}`);
    }
    for (const f of TEST_FILES) {
      const a = readFileSync(resolve(ROOT, 'packages/runner/test', f));
      const b = readFileSync(resolve(PUB, 'test', f));
      if (!a.equals(b)) drifted.push(`test/${f}`);
    }
    expect(
      drifted,
      `published sandbox is stale — run ./packaging/sync-public-sandbox.sh:\n${drifted.join('\n')}`,
    ).toEqual([]);
  });

  it('carries the licence and the honesty section', () => {
    // The README's value is its limits section. Publishing the code without
    // "what these tests do NOT prove" would turn an audit invitation into a
    // marketing page.
    const readme = readFileSync(resolve(PUB, 'README.md'), 'utf8');
    expect(readme).toContain('What they do NOT prove');
    expect(readme).toContain('cannot prove the shipped binary runs this code');
    expect(readme).toMatch(/SYNCED_FROM: clockwork@[0-9a-f]{7,}/);

    const licence = readFileSync(resolve(PUB, 'LICENSE'), 'utf8');
    expect(licence).toContain('Apache License');
    // Publishing under Apache while the main LICENSE says "all rights
    // reserved" needs the scope stated in both places, or it reads as a
    // contradiction.
    expect(licence).toContain('desktop application itself is proprietary');
  });
});
