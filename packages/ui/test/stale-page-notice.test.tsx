/**
 * An old window against a NEW daemon has to say so.
 *
 * `VersionSkewNotice` covers the opposite direction — a new bundle calling an
 * old daemon — and it keys off `/health`'s `versionSkew`, which compares the
 * DAEMON with the BUILD ON DISK. After an upgrade-and-restart those two agree,
 * so `versionSkew` is false and the flag is structurally blind to the case
 * where only the open page is behind.
 *
 * That case reached a user. The daemon was upgraded to a build whose composer
 * saves "ASAP" as a runnable one-off, but their window still ran the
 * pre-upgrade bundle, so ASAP kept writing the `queue` kind the scheduler
 * cannot fire. The app looked broken; the fix was a reload nobody knew to do.
 *
 * Same shape as version-skew.test.tsx: the banner is exercised directly, and
 * the wiring is asserted against the source, so neither the copy nor the mount
 * point can quietly disappear.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { StalePageNotice } from '../src/App';
import { renderComponent } from './helpers/dom';
import type { Health } from '../src/api';

const APP = readFileSync(path.resolve(import.meta.dirname, '../src/App.tsx'), 'utf8');

/** The state AFTER an upgrade: daemon and disk agree, so `versionSkew` is false. */
const HEALTH = {
  ok: true,
  apiVersion: 1,
  daemonVersion: '0.10.0',
  installedVersion: '0.10.0',
  versionSkew: false,
  paused: false,
  activeRuns: 0,
  queuedRuns: 0,
  nextFire: null,
} as unknown as Health;

describe('StalePageNotice', () => {
  it('names the version now answering and offers the reload the user cannot guess', async () => {
    const container = await renderComponent(<StalePageNotice stale health={HEALTH} />);

    const banner = container.querySelector('[data-testid="stale-page"]');
    expect(banner, 'banner missing').not.toBeNull();
    expect(banner!.getAttribute('role'), 'must be announced, not just drawn').toBe('alert');
    expect(banner!.textContent).toContain('Reload this window');
    expect(banner!.textContent, 'names the version now answering').toContain('0.10.0');
    // The whole reason it exists: the page cannot fix itself.
    const reload = [...container.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('Reload'),
    );
    expect(reload, 'no reload control').not.toBeUndefined();
  });

  it('says nothing until the daemon version has actually changed', async () => {
    const container = await renderComponent(<StalePageNotice stale={false} health={HEALTH} />);
    expect(container.querySelector('[data-testid="stale-page"]')).toBeNull();
    expect((container.textContent ?? '').trim()).toBe('');
  });

  it('renders even before the first /health lands, without inventing a version', async () => {
    const container = await renderComponent(<StalePageNotice stale health={null} />);
    const banner = container.querySelector('[data-testid="stale-page"]');
    expect(banner, 'banner missing with no health yet').not.toBeNull();
    expect(banner!.textContent, 'must not print "undefined"').not.toContain('undefined');
  });
});

describe('the shell wires it to a real change, not to versionSkew', () => {
  it('mounts the notice beside the skew notice', () => {
    const skew = APP.indexOf('<VersionSkewNotice health={health} />');
    const stale = APP.indexOf('<StalePageNotice stale={stalePage} health={health} />');
    expect(skew, 'skew notice no longer mounted').toBeGreaterThan(-1);
    expect(stale, 'stale notice not mounted').toBeGreaterThan(-1);
    // Same region of the shell — both are top-of-page alerts.
    expect(stale - skew, 'the two notices drifted apart in the tree').toBeLessThan(200);
  });

  it('compares the daemon version against the one this window first saw', () => {
    // The detection lives in the health poll. `versionSkew` cannot express it,
    // so the poll has to remember the first version it ever saw and diff it.
    expect(APP, 'no remembered load-time version').toContain('loadedDaemonVersion');
    expect(APP, 'stale flag never set from the poll').toMatch(/setStalePage\(/);
    // Latching: once behind, a later identical poll must not clear it.
    expect(APP, 'stale flag is not latched').toMatch(/setStalePage\(\(was\) => was \|\|/);
  });
});
