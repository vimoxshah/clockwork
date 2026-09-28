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
import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, mkdirSync, cpSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
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

/**
 * BUN-3: `clockwork` on PATH from the Homebrew cask needs a wrapper INSIDE
 * the .app (no system Node to run a plain script). The cask's `binary`
 * stanza (packaging/homebrew/clockwork.rb) names an exact path; if the
 * staging script ever stops placing a file there, `brew install` succeeds
 * and leaves a dangling symlink — silent until a user actually runs
 * `clockwork`. Same shape as the resource-trees guard above: check the
 * SCRIPT (so this fails on every machine, not only after a real build), then
 * check the real staged output when one exists.
 */
describe('the staging script ships a `clockwork` wrapper for the Homebrew cask', () => {
  const CASK = path.join(ROOT, 'packaging', 'homebrew', 'clockwork.rb');
  /** Comment-stripped, same technique as the resource-trees test above and
   *  for the same reason: a prose explanation of the wrapper must not be
   *  mistaken for the staging script actually shipping it. */
  const stagerSrc = () =>
    readFileSync(STAGER, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('names the wrapper source and its staged destination in CODE', () => {
    // The actual call is `path.join(ROOT, 'packaging', 'bin', 'clockwork')` —
    // four separate string arguments, not one contiguous path literal — so
    // this checks for the quoted literals rather than a joined substring.
    // The smoke test below is what proves the real output lands correctly;
    // this just proves the wiring isn't accidental. Quoted-boundary matches
    // (not a bare substring search) so 'binaries' elsewhere in this file,
    // which also contains "bin", cannot satisfy the 'bin' check.
    const src = stagerSrc();
    expect(src, `${STAGER} never spells out the 'packaging' source directory`).toMatch(/['"`]packaging['"`]/);
    expect(src, `${STAGER} never spells out a 'bin' destination directory`).toMatch(/['"`]bin['"`]/);
    expect(src, `${STAGER} never spells out a 'clockwork' destination filename`).toMatch(/['"`]clockwork['"`]/);
  });

  it('the wrapper source exists, is executable, and is a POSIX shell script', () => {
    const src = path.join(ROOT, 'packaging', 'bin', 'clockwork');
    expect(existsSync(src), `${src} is missing — the staging script has nothing to copy`).toBe(true);
    expect(readFileSync(src, 'utf8')).toMatch(/^#!\/bin\/sh/);
    expect(statSync(src).mode & 0o111, `${src} is not executable`).not.toBe(0);
  });

  it("the cask's `binary` stanza points at exactly where the staging script places the wrapper", () => {
    // Cross-file consistency, same idea as install-instructions.test.ts's
    // "offers only architectures the release workflow builds": two files
    // agreeing on a path is itself the guarantee, not a hand-kept constant.
    const cask = readFileSync(CASK, 'utf8');
    const m = cask.match(/^\s*binary\s+"([^"]+)"/m);
    expect(m, `${CASK} has no \`binary\` stanza`).toBeTruthy();
    expect(m![1], `${CASK} binary stanza does not name the staged wrapper's path`).toMatch(/Contents\/Resources\/app\/bin\/clockwork$/);
  });

  it('carries the wrapper into the staged app when a build has produced one, and it actually runs the bundled CLI', () => {
    // Only meaningful after `node tools/stage-bundle.mjs`; skipped rather than
    // failed because CI does not stage (same convention as the resources
    // check above).
    const wrapper = path.join(ROOT, 'src-tauri', 'resources', 'app', 'bin', 'clockwork');
    if (!existsSync(wrapper)) return;
    expect(statSync(wrapper).mode & 0o111, 'staged wrapper lost its exec bit').not.toBe(0);

    // Homebrew's `binary` artifact SYMLINKS this file into the prefix, and a
    // real .app nests Contents/MacOS/node three levels above
    // Contents/Resources/app/bin/ — reproduce both with the REAL staged Node
    // and REAL staged CLI (copied, not symlinked, so `cd -P` inside the
    // wrapper lands in a genuinely nested tree instead of chasing back out to
    // the flat staging layout). Only the two files the wrapper actually
    // touches are copied — clockwork-cli.js has no npm dependencies of its
    // own (Node builtins only), so copying the daemon's whole deployed
    // node_modules here would cost real minutes for no extra coverage.
    const nodeSrc = path.join(ROOT, 'src-tauri', 'binaries');
    const nodeBin = existsSync(nodeSrc) ? readdirSync(nodeSrc).find((f) => f.startsWith('node-')) : undefined;
    if (!nodeBin) return; // staged resources without a staged node: nothing to exec against
    const cliJs = path.join(ROOT, 'src-tauri', 'resources', 'app', 'packages', 'daemon', 'dist', 'clockwork-cli.js');
    if (!existsSync(cliJs)) return; // staged resources without a built CLI: nothing to exec
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cw-wrapper-'));
    try {
      const appContents = path.join(tmp, 'Clockwork.app', 'Contents');
      mkdirSync(path.join(appContents, 'MacOS'), { recursive: true });
      cpSync(path.join(nodeSrc, nodeBin), path.join(appContents, 'MacOS', 'node'));
      chmodSync(path.join(appContents, 'MacOS', 'node'), 0o755);
      mkdirSync(path.join(appContents, 'Resources', 'app', 'bin'), { recursive: true });
      cpSync(wrapper, path.join(appContents, 'Resources', 'app', 'bin', 'clockwork'));
      chmodSync(path.join(appContents, 'Resources', 'app', 'bin', 'clockwork'), 0o755);
      mkdirSync(path.join(appContents, 'Resources', 'app', 'packages', 'daemon', 'dist'), { recursive: true });
      cpSync(cliJs, path.join(appContents, 'Resources', 'app', 'packages', 'daemon', 'dist', 'clockwork-cli.js'));

      const prefixBin = path.join(tmp, 'prefix-bin');
      mkdirSync(prefixBin, { recursive: true });
      symlinkSync(path.join(appContents, 'Resources', 'app', 'bin', 'clockwork'), path.join(prefixBin, 'clockwork'));

      const noTokenHome = path.join(tmp, 'no-token-home');
      mkdirSync(noTokenHome, { recursive: true });
      const out = execFileSync(path.join(prefixBin, 'clockwork'), ['--help'], {
        encoding: 'utf8',
        env: { ...process.env, CLOCKWORK_HOME: noTokenHome },
      });
      expect(out, 'the wrapper, invoked through a brew-style symlink, did not reach the real bundled CLI').toContain('approve <id>');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
