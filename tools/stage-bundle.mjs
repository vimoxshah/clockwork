#!/usr/bin/env node
/**
 * Stage everything the .app needs to run the daemon by itself, so installing
 * the DMG is the whole install (BUN-1, BUN-2).
 *
 * Two destinations, because Tauri treats them differently:
 *
 *   src-tauri/binaries/node-<target-triple>  -> Contents/MacOS/node
 *       `externalBin`, not `resources`. Tauri keeps the exec bit and, more
 *       importantly, code-signs it as part of the app. A Node dropped into
 *       Resources is an unsigned executable inside a signed bundle, which
 *       Gatekeeper refuses to run.
 *
 *   src-tauri/resources/app/                 -> Contents/Resources/app/
 *       A miniature of the repo, NOT a flat dump. main.js resolves its
 *       package.json at ../, its migrations at ../migrations, the UI at
 *       ../../ui/dist and the skill pack at ../../../resources/skill-pack.
 *       Those relative walks are load-bearing, so the staged tree reproduces
 *       packages/daemon, packages/ui and resources/ at the same depths.
 *
 * The Node staged here is the Node running THIS script, and better-sqlite3 is
 * installed by the same `pnpm deploy` invocation. That is deliberate: the ABI
 * mismatch that makes the LaunchAgent crash-loop on `NODE_MODULE_VERSION 137
 * ... requires 147` comes from installing with one Node and running with
 * another, so the build makes them the same binary by construction rather than
 * checking afterwards that they happen to agree.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = path.join(ROOT, 'src-tauri', 'resources', 'app');
const BINARIES = path.join(ROOT, 'src-tauri', 'binaries');

/**
 * pnpm's default store links every package into node_modules/.pnpm and points
 * at it, and a bundler that copies a symlink tree either follows it into a
 * cycle or ships dangling links. `node-linker=hoisted` writes real directories
 * instead — same 68MB, nothing to resolve at runtime.
 */
function deployDaemon(dest) {
  // `pnpm deploy` writes the flags it ran with into the ROOT workspace state,
  // so this command leaves the developer's checkout believing it should be a
  // hoisted production-only install. Every later `pnpm <script>` then tries to
  // purge node_modules and reinstall, and outside a TTY it just fails:
  // ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY. The real tree is untouched —
  // only the state file lies — so snapshot it and put it back.
  const state = path.join(ROOT, 'node_modules', '.pnpm-workspace-state-v1.json');
  const before = existsSync(state) ? readFileSync(state) : null;
  try {
    execFileSync(
      'pnpm',
      ['deploy', '--filter', '@clockwork/daemon', '--prod', '--legacy', '--config.node-linker=hoisted', dest],
      { cwd: ROOT, stdio: 'inherit' },
    );
  } finally {
    if (before === null) rmSync(state, { force: true });
    else writeFileSync(state, before);
  }
}

/** Source, tests and build config ride along in `pnpm deploy` output and are dead weight in a .app. */
const PRUNE = ['src', 'test', 'tsconfig.json', 'tsconfig.tsbuildinfo', 'vitest.config.ts'];

/**
 * Delete every node_modules/.bin directory.
 *
 * These are the only symlinks `pnpm deploy --config.node-linker=hoisted`
 * leaves behind (8 of them here), they point at CLI shims nothing in the
 * daemon ever executes, and removing them means the staged tree copies as
 * plain files however the bundler chooses to walk it.
 */
function stripBinShims(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name === '.bin') rmSync(full, { recursive: true, force: true });
      else stripBinShims(full);
    }
  }
}

function countSymlinks(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) n += 1;
    else if (entry.isDirectory()) n += countSymlinks(full);
  }
  return n;
}

function main() {
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });

  const daemonDest = path.join(STAGE, 'packages', 'daemon');
  mkdirSync(path.dirname(daemonDest), { recursive: true });
  deployDaemon(daemonDest);
  for (const name of PRUNE) rmSync(path.join(daemonDest, name), { recursive: true, force: true });
  stripBinShims(path.join(daemonDest, 'node_modules'));

  const uiDist = path.join(ROOT, 'packages', 'ui', 'dist');
  if (!existsSync(uiDist)) throw new Error(`packages/ui/dist is missing — run \`pnpm build\` first`);
  cpSync(uiDist, path.join(STAGE, 'packages', 'ui', 'dist'), { recursive: true });

  // Both bundled resource trees. `resources/templates` was missing until
  // 2026-09-10 and the omission was invisible from inside the repo: the daemon
  // resolves it relative to its own compiled location, so it works in a source
  // checkout and returns nothing in the shipped app. GET /templates/bundled
  // answered `{"templates":[]}` on a real install of v0.12.0 while the
  // CHANGELOG claimed the five were reachable. Found by installing the DMG,
  // which is the only place it could be found.
  for (const tree of ['skill-pack', 'templates']) {
    const src = path.join(ROOT, 'resources', tree);
    if (!existsSync(src)) throw new Error(`resources/${tree} is missing — the app would ship without it`);
    cpSync(src, path.join(STAGE, 'resources', tree), { recursive: true });
  }

  // Tauri finds an external binary by the target triple appended to the name,
  // so the file has to be spelled for the machine this build targets.
  //
  // T1-2: that used to be `rustc -vV`'s HOST triple with `process.execPath`
  // copied beside it — correct only when building for the machine you are on.
  // GitHub retired the macos-13 Intel runner and every remaining x64 image is
  // a Larger Runner restricted to Team/Enterprise orgs, so an Intel DMG has to
  // be cross-compiled from the free arm64 runner. Without an override this
  // script would have named an arm64 binary `node-x86_64-apple-darwin`: a file
  // claiming an architecture its bytes do not have, which is a lie inside the
  // build and worse than shipping nothing.
  //
  // CW_TARGET_TRIPLE names the target; CW_STAGE_NODE points at a Node built
  // for it. Both or neither — a triple with the running Node beside it is
  // exactly the mismatch above, so that combination is refused.
  const hostTriple = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
    .split('\n')
    .find((l) => l.startsWith('host:'))
    ?.slice('host:'.length)
    .trim();
  if (!hostTriple) throw new Error('could not read the host target triple from `rustc -vV`');

  const wantTriple = process.env.CW_TARGET_TRIPLE?.trim();
  const wantNode = process.env.CW_STAGE_NODE?.trim();
  if (Boolean(wantTriple) !== Boolean(wantNode)) {
    throw new Error(
      'CW_TARGET_TRIPLE and CW_STAGE_NODE must be set together. '
        + `Got triple=${wantTriple ?? '(unset)'} node=${wantNode ?? '(unset)'}. `
        + 'A target triple with the running Node beside it names a binary for an '
        + 'architecture it is not.',
    );
  }
  const triple = wantTriple || hostTriple;
  const nodeSrc = wantNode || process.execPath;
  if (wantNode && !existsSync(nodeSrc)) throw new Error(`CW_STAGE_NODE does not exist: ${nodeSrc}`);

  mkdirSync(BINARIES, { recursive: true });
  const nodeDest = path.join(BINARIES, `node-${triple}`);
  rmSync(nodeDest, { force: true });
  cpSync(nodeSrc, nodeDest);
  chmodSync(nodeDest, 0o755);

  // The name promises an architecture; check the bytes deliver it. `file`
  // reports the Mach-O arch, and a cross-staged binary that silently turned
  // out to be the host's would otherwise only fail on a user's machine.
  const arch = triple.startsWith('x86_64') ? 'x86_64' : 'arm64';
  const machO = execFileSync('file', ['-b', nodeDest], { encoding: 'utf8' }).trim();
  if (!machO.includes(arch)) {
    throw new Error(`staged node is "${machO}" but is named node-${triple} — refusing to bundle a mislabelled binary`);
  }

  // Prove the staged pair works together before it is ever bundled. Opening a
  // database rather than requiring the package: better-sqlite3 loads its
  // binding lazily, so a require-only probe exits 0 under a Node whose ABI the
  // compiled .node cannot satisfy (packages/daemon/src/cli.ts says the same).
  const binding = path.join(daemonDest, 'node_modules', 'better-sqlite3');
  // Cross-staged: the probe runs the TARGET's Node, which on an arm64 host
  // needs Rosetta. It is present on GitHub's arm64 macOS images, so this still
  // runs in CI — but say which case failed rather than surfacing a bare ENOEXEC.
  try {
    execFileSync(nodeDest, ['-e', `new (require(${JSON.stringify(binding)}))(':memory:')`], { stdio: 'inherit' });
  } catch (e) {
    const cross = triple !== hostTriple;
    throw new Error(
      cross
        ? `the staged ${triple} node could not open a database on this ${hostTriple} host. `
          + 'Either Rosetta is absent, or better-sqlite3 was not installed for the target '
          + `(set npm_config_arch/npm_config_platform before staging). Original: ${e.message}`
        : e.message,
    );
  }

  const leftover = countSymlinks(STAGE);
  console.log(`staged ${STAGE}`);
  console.log(`  node: ${nodeDest} (${machO})${triple !== hostTriple ? ` — CROSS-STAGED from ${hostTriple}` : ''}`);
  console.log(`  symlinks remaining: ${leftover}`);
  console.log(`  better-sqlite3: opens a database under the staged node`);
  if (leftover > 0) {
    throw new Error(`${leftover} symlink(s) remain under the staged tree — a bundler may not copy them`);
  }
}

main();
