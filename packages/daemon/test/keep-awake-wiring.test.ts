/**
 * FR-25/S-15 keep-awake, and the reason this file exists.
 *
 * `KeepAwake` shipped complete: it probes the power source, spawns
 * `caffeinate`, is idempotent per run and swallows a spawn failure. The run
 * manager already called `arm()` before a run and `release()` after it. And it
 * did nothing at all, because the class was CONSTRUCTED BY NOTHING — the dep is
 * optional, so `this.deps.keepAwake?.arm(...)` silently no-opped on every
 * scheduled run while `docs/scheduling.md` told users a power assertion was
 * armed.
 *
 * No unit test of KeepAwake could catch that; each one passes against a class
 * nobody builds. This is the same defect shape as `single-instance.ts` being
 * imported by no file, which is what let a three-day-old daemon keep serving.
 * So the guard here is on the WIRING, not the behaviour.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { KeepAwake } from '../src/keep-awake.js';

const MAIN = path.resolve(import.meta.dirname, '../src/main.ts');
const src = (): string => readFileSync(MAIN, 'utf8');

describe('keep-awake is actually wired into the daemon', () => {
  it('main.ts constructs a KeepAwake', () => {
    expect(src(), 'nothing builds KeepAwake, so every arm() call is a silent no-op').toMatch(/new KeepAwake\(/);
  });

  it('main.ts hands it to the RunManager, which is the only thing that arms it', () => {
    expect(src(), 'KeepAwake is built but never passed, so the run manager still no-ops').toMatch(
      /new RunManager\(\{[^}]*keepAwake/s,
    );
  });

  it('releases every assertion on shutdown, so no caffeinate child outlives the daemon', () => {
    expect(src()).toMatch(/shutdown[\s\S]{0,200}releaseAll\(\)/);
  });

  it('the run manager still calls arm and release — the other half of the wire', () => {
    const rm = readFileSync(path.resolve(import.meta.dirname, '../src/run-manager.ts'), 'utf8');
    expect(rm).toMatch(/keepAwake\?\.arm\(/);
    expect(rm).toMatch(/keepAwake\?\.release\(/);
  });
});

describe('KeepAwake refuses rather than lying', () => {
  it('declines on battery unless explicitly opted in', () => {
    const onBattery = new KeepAwake({ execFile: (() => 'Now drawing from Battery Power') as never });
    expect(onBattery.pluggedIn()).toBe(false);
    // arm() must report FALSE rather than pretending it armed something.
    if (process.platform === 'darwin') expect(onBattery.arm('run_1', 60)).toBe(false);
  });

  it('treats an unreadable power source as plugged in, which is the desktop default', () => {
    const unknown = new KeepAwake({
      execFile: (() => {
        throw new Error('pmset missing');
      }) as never,
    });
    expect(unknown.pluggedIn()).toBe(true);
  });

  it('is a no-op off macOS, where there is no power assertion to take', () => {
    if (process.platform === 'darwin') return;
    expect(new KeepAwake().arm('run_1', 60)).toBe(false);
  });
});
