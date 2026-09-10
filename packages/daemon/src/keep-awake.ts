/**
 * Keep-awake window (FR-25 / S-15): arms a macOS power assertion before
 * scheduled runs when plugged in; released after finalize. The OS still wins
 * if the user closes the lid on battery/clamshell — we never claim otherwise.
 *
 * Since T1-9 this class also OBSERVES the window it armed, so the report can
 * say whether the Mac slept through it. See `observe()`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';

/**
 * The cadence `observe()` is called at: the run watchdog's own interval
 * (run-manager.ts `setInterval(..., 15_000)`), which is also the runner
 * child's heartbeat interval (claude-cli-runner.ts:316, codex-runner.ts:203).
 * A gap wider than this is time the daemon's event loop did not get.
 */
export const SLEEP_SAMPLE_MS = 15_000;

/**
 * How wide a gap between two consecutive samples counts as a sleep.
 *
 * 60s where 15s was scheduled = three consecutive missed ticks = at least 45s
 * with the event loop frozen. Why not lower:
 *   - a GC pause is milliseconds, and a synchronous better-sqlite3
 *     transaction or a report `JSON.stringify` is milliseconds too;
 *   - a saturated or swapping Mac starves a timer for seconds, not for 45
 *     seconds without a single tick.
 * Why not higher: the daemon ALREADY treats 60s of silence as fatal
 * (`HEARTBEAT_GAP_MS`), so a sleep just over 60s kills the run as
 * `runner_crashed` on wake. A 120s bar would leave that band reporting
 * "crashed" and "did not sleep" on the same card — the exact defect T1-9
 * exists to remove. A 60s sleep yields `gap - SLEEP_SAMPLE_MS` = 45s of lost
 * time in the worst phase, so this bar catches every sleep the heartbeat
 * watchdog can punish.
 *
 * What it does NOT distinguish: a daemon stopped with SIGSTOP and continued
 * later looks exactly like a sleep, because to a frozen process it is one.
 * That is a human at a debugger, and we would rather name it a sleep than
 * miss a real one.
 */
export const SLEEP_GAP_MS = 60_000;

/** One observed window: the last sample, and the frozen time found so far. */
interface SleepWatch {
  wall: number;
  mono: number;
  lostMs: number;
}

export interface KeepAwakeDeps {
  /** allow assertions on battery (default false per FR-25) */
  allowOnBattery?: boolean;
  execFile?: typeof execFileSync;
  /** test seam: which platform to behave as. Defaults to the real one. */
  platform?: NodeJS.Platform;
  /**
   * Monotonic clock in ms. Test seam, and the reason it is a seam: a fake
   * wall clock alone cannot express "42 minutes of real time passed", which
   * is precisely what separates a sleep from a clock that was reset.
   */
  monoNow?: () => number;
}

export class KeepAwake {
  private readonly procs = new Map<string, ChildProcess>();
  private readonly watches = new Map<string, SleepWatch>();
  private readonly execFile: typeof execFileSync;
  private readonly platform: NodeJS.Platform;
  private readonly monoNow: () => number;

  constructor(private readonly deps: KeepAwakeDeps = {}) {
    this.execFile = deps.execFile ?? execFileSync;
    this.platform = deps.platform ?? process.platform;
    this.monoNow = deps.monoNow ?? ((): number => performance.now());
  }

  /** Best-effort power-source probe; unknown => assume plugged (desktop default). */
  pluggedIn(): boolean {
    if (this.platform !== 'darwin') return true;
    try {
      const out = this.execFile('pmset', ['-g', 'ps'], { encoding: 'utf8' });
      return !/Battery Power/i.test(out);
    } catch {
      return true;
    }
  }

  /**
   * Arm an assertion for the given window. Returns false when skipped
   * (battery without opt-in). Idempotent per key.
   */
  arm(key: string, durationSec: number): boolean {
    if (this.platform !== 'darwin') return false;
    if (!this.deps.allowOnBattery && !this.pluggedIn()) return false;
    if (this.procs.has(key)) return true;
    try {
      const child = spawn('/usr/bin/caffeinate', ['-i', '-t', String(Math.max(1, Math.floor(durationSec)))], {
        stdio: 'ignore',
        detached: false,
      });
      this.procs.set(key, child);
      child.on('close', () => this.procs.delete(key));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sample the window named by `key` (T1-9). Seeded once when the run's child
   * is spawned and then sampled on every watchdog tick, `SLEEP_SAMPLE_MS`
   * apart. The seed sits beside the watchdog rather than at the top of
   * `startRun` on purpose: preflight and `git worktree add` run between the
   * two, and a slow repo's setup inside the first gap would read as a sleep.
   *
   * WHY A SAMPLER AND NOT `wall elapsed - monotonic elapsed`
   *   The obvious test — total wall time against the process's own monotonic
   *   time — detects nothing on macOS, because Node's monotonic clock keeps
   *   running through sleep. Measured here on 2026-09-10 (Node 24.13.1,
   *   libuv 1.51.0, `uv__hrtime` -> `CLOCK_MONOTONIC_RAW`), seconds since
   *   boot at one instant:
   *     process.hrtime.bigint()   92469.7   CLOCK_MONOTONIC_RAW  92469.7
   *     CLOCK_UPTIME_RAW          92406.9   (the only one that stops)
   *   The 62.8s difference is the one real sleep in that boot, which
   *   `pmset -g log` records as 2026-09-10 06:38:10 Sleep -> 06:39:15 Wake.
   *   Darwin's `CLOCK_MONOTONIC_RAW` behaves like Linux's `CLOCK_BOOTTIME`,
   *   and Node exposes no sleep-excluding clock. Re-check those four numbers
   *   before trusting any elapsed-time comparison here.
   *
   *   What a sleep DOES change is when the timer fires: a frozen process runs
   *   nothing, so a tick due 15s out arrives when the Mac wakes. The gap
   *   between consecutive samples is therefore the signal, and because it is
   *   measured PER TICK rather than over the whole run, a four-hour run whose
   *   ticks all land on time reports no sleep however slow it was.
   *
   * `min(wall, monotonic)` is the guard against a wall clock that jumped:
   * NTP stepping the clock forward by an hour advances `wall` and not
   * `monotonic`, and an hour of real time did not pass. On Darwin the
   * monotonic clock spans a sleep (above), so a real sleep advances both.
   *
   * Off macOS this records nothing at all: there is no keep-awake window
   * there to sleep through, and Linux's `CLOCK_MONOTONIC` excludes suspend,
   * which would make the guard above zero out every real suspend. Saying
   * "unknown" is honest; saying "false" would not be.
   */
  observe(key: string, wallNow: number): void {
    if (this.platform !== 'darwin') return;
    const mono = this.monoNow();
    const prev = this.watches.get(key);
    if (!prev) {
      this.watches.set(key, { wall: wallNow, mono, lostMs: 0 });
      return;
    }
    const elapsed = Math.min(wallNow - prev.wall, mono - prev.mono);
    prev.wall = wallNow;
    prev.mono = mono;
    // The frozen time is the overshoot, not the whole gap: up to one sample
    // interval of the gap was scheduled. Reporting the overshoot makes the
    // number a floor, never an exaggeration.
    if (elapsed >= SLEEP_GAP_MS) prev.lostMs += elapsed - SLEEP_SAMPLE_MS;
  }

  /**
   * How long the Mac was asleep inside the window named by `key`.
   *
   * `null` means NOBODY KNOWS — off macOS, or a window this process never
   * observed (a run recovered after a daemon restart). `0` means the window
   * was watched from end to end and no sleep was found. The caller must keep
   * the two apart: collapsing `null` to `false` is the defect T1-9 fixes.
   */
  sleepDuring(key: string): number | null {
    if (this.platform !== 'darwin') return null;
    return this.watches.get(key)?.lostMs ?? null;
  }

  release(key: string): void {
    const child = this.procs.get(key);
    if (child?.pid) {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {}
    }
    this.procs.delete(key);
    // Bounded with `procs`, and dropped at the same moment. finalize() reads
    // sleepDuring() while it builds the report, well before it releases.
    this.watches.delete(key);
  }

  releaseAll(): void {
    for (const k of [...this.procs.keys()]) this.release(k);
  }
}
