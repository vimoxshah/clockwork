/**
 * Every install command we publish must actually run.
 *
 * This guard exists because a real one did not. Every shipped surface told
 * users to run:
 *
 *     brew install --cask --no-quarantine clockwork
 *
 * Homebrew 6 REMOVED that option. The real command fails outright:
 *
 *     Error: invalid option: --no-quarantine
 *
 * `HOMEBREW_CASK_OPTS` is not an escape hatch either — it accepts only
 * `--*dir`, `--language`, `--require-sha` and `--no-binaries`. So quarantine
 * is always applied and the user must clear it afterwards.
 *
 * The instructions were live on the landing page and in a PUBLIC Homebrew tap,
 * so the first command a new user ran errored. Nothing caught it: the prose
 * was plausible, the flag was real once, and no test reads command blocks.
 *
 * SCOPE — what this does NOT catch:
 *   - whether the commands succeed. This asserts they are not knowably
 *     BROKEN; only running brew proves they work.
 *   - flags other than the three rules below. A future Homebrew removal of
 *     some other option would ship exactly the way this one did.
 *   - the tap repo itself. `packaging/homebrew/{clockwork.rb,README.md}` are
 *     the source of truth; publishing them is a MANUAL copy step, so the live
 *     tap can still drift from what is guarded here. This proves what we
 *     publish is correct — not that it was published.
 *
 * T1-2 added the second describe block below. The cask now offers two
 * architectures, so "the install command runs" is no longer the whole claim:
 * `brew install --cask clockwork` on an Intel Mac downloads a DIFFERENT file
 * with a DIFFERENT digest, and either half can be missing while every command
 * block on every page still reads correctly. Those rules therefore check the
 * cask's stanzas against the release workflow that has to produce them, which
 * is the same shape as T1-5's tripwires: no claim without transport.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');

// Listed explicitly, never globbed. A guard that discovers its own inputs
// passes when the input disappears — the failure mode found in the pricing
// suite, where a rule enumerated from the very array it was meant to police.
const SURFACES = [
  'docs/install.md',
  'landing-page/index.html',
  'packaging/README.md',
  'packaging/homebrew/clockwork.rb',
  // The tap's README is the surface the broken command survived on LONGEST.
  // It used to live only in the public tap repo, hand-maintained, with no copy
  // here — so nothing could guard it. This file is now the source of truth and
  // is copied to the tap on release, exactly like the cask.
  'packaging/homebrew/README.md',
];

/**
 * The text a reader would COPY: fenced blocks in markdown, <pre> in HTML, the
 * caveats heredoc in the cask. Prose and source comments are excluded on
 * purpose — "Homebrew 6 removed --no-quarantine" is an explanation, not an
 * instruction, and must not trip rule 1.
 */
function commandBlocks(rel: string): string[] {
  const src = readFileSync(resolve(ROOT, rel), 'utf8');
  if (rel.endsWith('.rb')) {
    const m = src.match(/caveats <<~EOS\n([\s\S]*?)\n\s*EOS/);
    return m ? [m[1]!] : [];
  }
  const re = rel.endsWith('.html') ? /<pre[^>]*>([\s\S]*?)<\/pre>/g : /```[a-z]*\n([\s\S]*?)```/g;
  return [...src.matchAll(re)].map((m) => m[1]!);
}

/**
 * Rules below run PER BLOCK, never over the concatenated file. The first
 * version of this suite joined every block together, and planting proved it
 * vacuous: deleting the xattr line from the Homebrew block still passed,
 * because the unrelated manual-DMG block further down the same page mentions
 * xattr. A reader copies ONE block, so one block must stand on its own.
 */

describe('published install instructions', () => {
  it('finds every surface and extracts commands from each', () => {
    for (const rel of SURFACES) {
      expect(existsSync(resolve(ROOT, rel)), `${rel} is gone — this guard is now blind to it`).toBe(true);
      expect(commandBlocks(rel).length, `no command blocks parsed out of ${rel}`).toBeGreaterThan(0);
    }
  });

  it('never tells a user to pass an option Homebrew 6 rejects', () => {
    // Only --no-quarantine is known-removed and verified by running it. This
    // is a list of one, not a guess at what Homebrew might drop next.
    const REMOVED = ['--no-quarantine'];
    const offenders: string[] = [];
    for (const rel of SURFACES) {
      for (const cmds of commandBlocks(rel)) {
        for (const flag of REMOVED) if (cmds.includes(flag)) offenders.push(`${rel}: ${flag}`);
      }
    }
    expect(offenders, `install commands use options Homebrew rejects:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('pairs every brew install with the quarantine step it now requires', () => {
    // Homebrew always quarantines this cask (unsigned, un-notarised). A page
    // that stops at `brew install` leaves the user at a Gatekeeper wall.
    const offenders: string[] = [];
    for (const rel of SURFACES) {
      for (const cmds of commandBlocks(rel)) {
        if (!/brew install --cask\s+clockwork/.test(cmds)) continue;
        if (!/xattr -dr com\.apple\.quarantine/.test(cmds)) offenders.push(rel);
      }
    }
    expect(offenders, `documents brew install without the xattr step: ${offenders.join(', ')}`).toEqual([]);
  });

  it('pairs every brew tap with brew trust', () => {
    // Homebrew 6 refuses casks from third-party taps until trusted, so a tap
    // instruction without it dead-ends on the very next command.
    const offenders: string[] = [];
    for (const rel of SURFACES) {
      for (const cmds of commandBlocks(rel)) {
        if (!/brew tap\s+vimoxshah\/clockwork/.test(cmds)) continue;
        if (!/brew trust\s+vimoxshah\/clockwork/.test(cmds)) offenders.push(rel);
      }
    }
    expect(offenders, `documents brew tap without brew trust: ${offenders.join(', ')}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T1-2 — two architectures, or the Intel half is a claim with no transport.
// ---------------------------------------------------------------------------

const CASK = 'packaging/homebrew/clockwork.rb';
const RELEASE_WF = '.github/workflows/release.yml';

/**
 * The digest that stands in for a DMG that has not been built yet. Zeroes
 * rather than prose on purpose: `homebrew-tap-drift.yml` extracts every
 * 64-hex token from the live tap and fails when one is absent from the
 * release's checksums-sha256.txt, so this value is CAUGHT there. A "TBD"
 * would not parse as a hash and would sail past that check.
 */
const UNBUILT_DIGEST = '0'.repeat(64);

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/**
 * One cask stanza WITH its continuation lines.
 *
 *     sha256 arm:   "...",
 *            intel: "..."
 *
 * is a single stanza spread over two lines, and a regex that stops at the
 * first newline reads half of it — passing while half the digests are absent.
 * A trailing comma is what continues a stanza, so that is what this follows.
 */
function stanza(src: string, name: string): string {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^\\s*${name}\\s`).test(l));
  expect(start, `${CASK} has no \`${name}\` stanza — this guard is now blind to it`).toBeGreaterThan(-1);
  let out = lines[start]!;
  for (let i = start; /,\s*$/.test(lines[i]!); i++) out += `\n${lines[i + 1]!}`;
  return out;
}

/** Every `key: "value"` pair in a stanza — `arm`/`intel` for both of ours. */
function pairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/(\w+):\s*"([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

/** The single version the cask publishes. */
function caskVersion(src: string): string {
  const m = src.match(/^\s*version\s+"([^"]+)"/m);
  expect(m, `${CASK} has no version stanza — this guard is now blind to it`).toBeTruthy();
  return m![1]!;
}

/**
 * Every architecture the release matrix builds a DMG for, read off the matrix
 * rather than written down here: a hand-kept list is the failure mode the
 * suite header already names.
 */
function builtArches(): string[] {
  const found = [...read(RELEASE_WF).matchAll(/^\s*dmg_arch:\s*(\S+)\s*$/gm)].map((m) => m[1]!);
  expect(
    found.length,
    `fewer than two dmg_arch keys in ${RELEASE_WF} — the matrix moved and this guard is blind`,
  ).toBeGreaterThan(1);
  return found;
}

describe('the cask installs on both of the Macs the release builds for', () => {
  it('offers one artifact per architecture, spelled the way the bundler spells it', () => {
    const src = read(CASK);
    const arches = pairs(stanza(src, 'arch'));
    expect(Object.keys(arches).sort(), `${CASK} does not map both arm and intel`).toEqual(['arm', 'intel']);
    expect(new Set(Object.values(arches)).size, 'both architectures resolve to the same file name').toBe(2);
    // Without #{arch} in the url both branches download one file, and the
    // digest for the other one can never match.
    const url = stanza(src, 'url');
    expect(url, `${CASK} url does not vary by architecture`).toContain('#{arch}');
    expect(url, `${CASK} url does not carry the version`).toContain('#{version}');
    expect(url).toMatch(/Clockwork_#\{version\}_#\{arch\}\.dmg/);
  });

  it('pins one real 64-hex digest per architecture, never :no_check', () => {
    const src = read(CASK);
    const sha = stanza(src, 'sha256');
    // :no_check would make `brew install` verify nothing, which is the one
    // promise this cask's own caveats make about an un-notarised build.
    expect(sha, `${CASK} disables checksum verification`).not.toContain('no_check');
    const digests = pairs(sha);
    expect(Object.keys(digests).sort(), `${CASK} does not pin a digest per architecture`).toEqual(['arm', 'intel']);
    for (const [key, digest] of Object.entries(digests)) {
      expect(digest, `${CASK} ${key} digest is not a sha256`).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(
      new Set(Object.values(digests)).size,
      'two architectures cannot share a digest — they are different files',
    ).toBe(2);
    // The Apple Silicon DMG has shipped since 0.4.0, so its digest is never
    // allowed to be the placeholder.
    expect(digests.arm, `${CASK} has no real digest for the DMG that already ships`).not.toBe(UNBUILT_DIGEST);
  });

  it('says out loud when a digest is a placeholder, and what has to fill it', () => {
    const src = read(CASK);
    const placeheld = Object.entries(pairs(stanza(src, 'sha256')))
      .filter(([, digest]) => digest === UNBUILT_DIGEST)
      .map(([key]) => key);
    if (placeheld.length === 0) return; // every artifact exists; nothing to warn about
    expect(
      src,
      `${CASK} pins a placeholder digest for ${placeheld.join(', ')} with no warning against publishing it`,
    ).toMatch(/DO NOT copy this cask to the tap/);
    // The release-staging script is the thing that would normally fill a
    // digest in, and today it cannot — so it has to be named where the
    // person staging the release will read it.
    expect(src, `${CASK} does not name what fails to fill the placeholder`).toContain('packaging/stage-release.sh');
  });

  it('no longer refuses a Mac by architecture, and still states its OS floor', () => {
    const src = read(CASK);
    const refusals = src.split('\n').filter((l) => /^\s*depends_on\s+arch:/.test(l));
    expect(
      refusals,
      `${CASK} offers two architectures and then refuses one:\n${refusals.join('\n')}`,
    ).toEqual([]);
    // Deleting the arch dependency must not take the OS floor with it.
    expect(src, `${CASK} no longer declares a macOS floor`).toMatch(/^\s*depends_on\s+macos:/m);
  });

  it('offers only architectures the release workflow builds and publishes', () => {
    const src = read(CASK);
    const offered = Object.values(pairs(stanza(src, 'arch'))).sort();
    const built = [...builtArches()].sort();
    expect(offered, `${CASK} offers ${offered.join('/')} but ${RELEASE_WF} builds ${built.join('/')}`).toEqual(built);

    const wf = read(RELEASE_WF);
    // The stable-named copies the landing page and this cask's neighbours
    // link to are made by one loop in the release job. Its list has to be the
    // same set, or an offered architecture gets a versioned DMG and no stable
    // name — or no upload at all.
    const loop = wf.match(/for arch in ([^;]+); do/);
    expect(loop, `${RELEASE_WF} no longer loops over architectures when publishing`).toBeTruthy();
    expect(loop![1]!.trim().split(/\s+/).sort()).toEqual(built);

    const version = caskVersion(src);
    for (const arch of built) {
      // What the cask will download once stage-release.sh bumps the version.
      expect(wf, `${RELEASE_WF} never names a ${arch} DMG`).toContain(`_${arch}.dmg`);
      // What a reader of the release notes is told to download.
      expect(wf, `the release notes do not name the ${arch} download`).toContain(`Clockwork_\${VER}_${arch}.dmg`);
      expect(version, 'the cask version is not a release version').toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('has exactly one job that creates the release and writes the checksums', () => {
    const wf = read(RELEASE_WF);
    // Two build legs and one publisher. Two legs each POSTing a release and
    // each writing checksums-sha256.txt is a race whose loser is silent: both
    // files are valid, each names only its own DMG, and the one uploaded
    // second is what the release claims to contain.
    expect(builtArches().length, 'this rule is vacuous with a single build leg').toBeGreaterThan(1);
    const creates = [...wf.matchAll(/api\.github\.com\/repos\/\$\{GITHUB_REPOSITORY\}\/releases"/g)];
    expect(creates.length, `${RELEASE_WF} creates a release in ${creates.length} places`).toBe(1);
    const writes = [...wf.matchAll(/>\s*checksums-sha256\.txt/g)];
    expect(writes.length, `${RELEASE_WF} writes checksums-sha256.txt in ${writes.length} places`).toBe(1);
    // And it runs after every leg rather than beside them.
    expect(wf, `${RELEASE_WF} publishes without waiting for the build matrix`).toMatch(/^\s*needs:\s*dmg\s*$/m);
  });
});
