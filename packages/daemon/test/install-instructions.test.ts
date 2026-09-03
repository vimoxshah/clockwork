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
 *   - the tap repo's copy of the cask. `packaging/homebrew/clockwork.rb` is
 *     the source of truth here; publishing is a manual copy step.
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
const SURFACES = ['docs/install.md', 'landing-page/index.html', 'packaging/README.md', 'packaging/homebrew/clockwork.rb'];

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
