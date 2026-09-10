/**
 * Every bundled resource tree the daemon reads at runtime must be staged into
 * the .app, and this test exists because one was not.
 *
 * `resources/templates` was absent from `tools/stage-bundle.mjs` when v0.12.0
 * shipped. The omission is invisible from inside the repository: the daemon
 * resolves these trees relative to its own compiled location, so a source
 * checkout finds them and the shipped app does not. `GET /templates/bundled`
 * answered `{"templates":[]}` on a real install while the CHANGELOG said the
 * five bundled jobs were reachable.
 *
 * So this asserts against the STAGING SCRIPT rather than the filesystem: the
 * staged output only exists after a `tauri build`, and a test that skips when
 * it is absent would be green on every developer machine and on CI, which is
 * exactly how this got out.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const STAGER = path.join(ROOT, 'tools', 'stage-bundle.mjs');

/** Every directory under resources/ that ships in the repo. */
function resourceTrees(): string[] {
  return readdirSync(path.join(ROOT, 'resources'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

describe('the staging script carries every bundled resource tree', () => {
  it('finds resource trees to check, so the assertion below is not vacuous', () => {
    const trees = resourceTrees();
    expect(trees.length, 'resources/ has no subdirectories — this test is checking nothing').toBeGreaterThan(0);
    expect(trees).toContain('templates');
    expect(trees).toContain('skill-pack');
  });

  it('names each one in CODE, so a new tree cannot be added to resources/ and silently left out of the app', () => {
    // Comments stripped first. The first version of this test matched the bare
    // word anywhere in the file and passed its own mutation, because the
    // comment explaining the v0.12.0 omission contains the word "templates".
    // A test that its own prose satisfies is the failure mode this file is
    // about. Same technique claims-honesty.test.ts uses on scheduler.ts.
    const src = readFileSync(STAGER, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const tree of resourceTrees()) {
      expect(
        src,
        `tools/stage-bundle.mjs never mentions resources/${tree}, so the shipped app will not contain it. `
          + 'The daemon resolves these relative to its own compiled location, so this works in a checkout '
          + 'and fails only on a real install — which is how resources/templates shipped missing in v0.12.0.',
      ).toContain(tree);
    }
  });

  it('ships five bookable templates, each parseable and named', () => {
    const dir = path.join(ROOT, 'resources', 'templates');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(5);
    for (const f of files) {
      const t = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      expect(t.schema, `${f} is not a clockwork template`).toBe('clockwork.template.v1');
      expect(String(t.name || '').length, `${f} has no name`).toBeGreaterThan(0);
    }
  });

  it('carries the trees into the staged app when a build has produced one', () => {
    // Only meaningful after `pnpm tauri build`; skipped rather than failed
    // because CI does not stage. The assertion above is what guards the gap.
    const staged = path.join(ROOT, 'src-tauri', 'resources', 'app', 'resources');
    if (!existsSync(staged)) return;
    for (const tree of resourceTrees()) {
      expect(existsSync(path.join(staged, tree)), `staged app is missing resources/${tree}`).toBe(true);
    }
  });
});
