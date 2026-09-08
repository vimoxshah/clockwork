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

  cpSync(path.join(ROOT, 'resources', 'skill-pack'), path.join(STAGE, 'resources', 'skill-pack'), {
    recursive: true,
  });

  // Tauri finds an external binary by the target triple appended to the name,
  // so the file has to be spelled for the machine this build targets.
  const triple = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
    .split('\n')
    .find((l) => l.startsWith('host:'))
    ?.slice('host:'.length)
    .trim();
  if (!triple) throw new Error('could not read the host target triple from `rustc -vV`');
  mkdirSync(BINARIES, { recursive: true });
  const nodeDest = path.join(BINARIES, `node-${triple}`);
  rmSync(nodeDest, { force: true });
  cpSync(process.execPath, nodeDest);
  chmodSync(nodeDest, 0o755);

  // Prove the staged pair works together before it is ever bundled. Opening a
  // database rather than requiring the package: better-sqlite3 loads its
  // binding lazily, so a require-only probe exits 0 under a Node whose ABI the
  // compiled .node cannot satisfy (packages/daemon/src/cli.ts says the same).
  const binding = path.join(daemonDest, 'node_modules', 'better-sqlite3');
  execFileSync(nodeDest, ['-e', `new (require(${JSON.stringify(binding)}))(':memory:')`], { stdio: 'inherit' });

  const leftover = countSymlinks(STAGE);
  console.log(`staged ${STAGE}`);
  console.log(`  node: ${nodeDest} (${process.version}, ${triple})`);
  console.log(`  symlinks remaining: ${leftover}`);
  console.log(`  better-sqlite3: opens a database under the staged node`);
  if (leftover > 0) {
    throw new Error(`${leftover} symlink(s) remain under the staged tree — a bundler may not copy them`);
  }
}

main();
