/**
 * The stale-daemon trap, from the user's side.
 *
 * A daemon that keeps running while the build under it moves on serves an old
 * API to a new UI: routes added since answer 404 and the product fails in a
 * dozen unrelated-looking ways. It cost three days once. The daemon already
 * reports it — `/health` carries `versionSkew` — and stderr already shouts it,
 * which nobody reads. So the only thing that closes the loop is the app saying
 * it, and the two failure modes to guard are: saying nothing when there IS
 * skew, and claiming skew that cannot be proven.
 *
 * Same two kinds of assertion as workforce-inbox.test.tsx: source-level (the
 * shell actually MOUNTS the notice — an unmounted banner is a banner nobody
 * sees) and behavioural (it renders what it claims, and refuses to render when
 * it has nothing to say).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Health } from '../src/api';
// Statically imported rather than dynamically inside each case: pulling App in
// drags the whole component tree (and lucide-react's barrel) through the
// transform, and on a cold cache that blows the 5s per-test timeout. At module
// scope the cost lands in collection, where no timeout applies.
import { VersionSkewNotice } from '../src/App';
import { renderComponent, waitForElement, waitForText } from './helpers/dom';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const APP = readFileSync(resolve(SRC, 'App.tsx'), 'utf8');
const API = readFileSync(resolve(SRC, 'api.ts'), 'utf8');

const HEALTH: Health = {
  ok: true,
  apiVersion: 1,
  daemonVersion: '0.4.0',
  installedVersion: '0.6.0',
  versionSkew: true,
  paused: false,
  activeRuns: 0,
  queuedRuns: 0,
  nextFire: null,
};

describe('the shell surfaces daemon version skew', () => {
  it('types both fields the daemon /health handshake now returns', () => {
    expect(API).toContain('installedVersion: string | null;');
    expect(API).toContain('versionSkew: boolean;');
  });

  it('mounts the notice inside main, before the onboarding gate', () => {
    // Above `{tab !== 'new' && <OnboardingGate` so it also shows on the one
    // tab the onboarding gate skips.
    const notice = APP.indexOf('<VersionSkewNotice health={health} />');
    const gate = APP.indexOf("{tab !== 'new' && <OnboardingGate");
    expect(notice).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(gate);
  });

  it('keeps the restart chip in the health readout', () => {
    expect(APP).toContain('RESTART NEEDED — daemon {health.daemonVersion}, build {health.installedVersion}');
  });
});

describe('VersionSkewNotice', () => {
  it('names both versions, what broke and the command that fixes it', async () => {
    const container = await renderComponent(<VersionSkewNotice health={HEALTH} />);
    // The banner is what this test reads, so wait for the banner — not for 30ms.
    await waitForText(container, 'Restart your daemon');
    const text = container.textContent ?? '';

    expect(text).toContain('Restart your daemon');
    // what happened: the running version AND the installed one, both named
    expect(text).toContain('0.4.0');
    expect(text).toContain('0.6.0');
    // why it looks like a dozen unrelated bugs
    expect(text).toContain('404');
    // what to do about it
    expect(text).toContain('launchctl kickstart -k gui/$(id -u)/com.clockwork.daemon');
    expect(container.querySelector('[data-testid="version-skew"]')?.getAttribute('role')).toBe('alert');
  });

  it('offers no way to dismiss it — a hidden banner is the silent failure again', async () => {
    const container = await renderComponent(<VersionSkewNotice health={HEALTH} />);
    // "No buttons" is trivially true of a container that has not rendered, so
    // this waits for the notice itself before counting: zero buttons is only
    // evidence once there is a banner to count them in.
    await waitForElement(container, '[data-testid="version-skew"]');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  // These two assert an ABSENCE, and the component renders `null`, so there is
  // no content to wait for. `renderComponent` returns only after React has
  // committed the tree, which is what makes the absence real: before this fix
  // the 30ms sleep could return with nothing rendered at all and the assertion
  // would still pass.
  it('says nothing when the daemon reports no skew', async () => {
    const container = await renderComponent(<VersionSkewNotice health={{ ...HEALTH, versionSkew: false }} />);
    expect(container.querySelector('[data-testid="version-skew"]')).toBeNull();
  });

  it('says nothing while the daemon is unreachable', async () => {
    const container = await renderComponent(<VersionSkewNotice health={null} />);
    expect(container.querySelector('[data-testid="version-skew"]')).toBeNull();
  });
});
