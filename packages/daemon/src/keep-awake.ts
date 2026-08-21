/**
 * Keep-awake window (FR-25 / S-15): arms a macOS power assertion before
 * scheduled runs when plugged in; released after finalize. The OS still wins
 * if the user closes the lid on battery/clamshell — we never claim otherwise.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';

export interface KeepAwakeDeps {
  /** allow assertions on battery (default false per FR-25) */
  allowOnBattery?: boolean;
  execFile?: typeof execFileSync;
}

export class KeepAwake {
  private readonly procs = new Map<string, ChildProcess>();
  private readonly execFile: typeof execFileSync;

  constructor(private readonly deps: KeepAwakeDeps = {}) {
    this.execFile = deps.execFile ?? execFileSync;
  }

  /** Best-effort power-source probe; unknown => assume plugged (desktop default). */
  pluggedIn(): boolean {
    if (process.platform !== 'darwin') return true;
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
    if (process.platform !== 'darwin') return false;
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

  release(key: string): void {
    const child = this.procs.get(key);
    if (child?.pid) {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {}
    }
    this.procs.delete(key);
  }

  releaseAll(): void {
    for (const k of [...this.procs.keys()]) this.release(k);
  }
}
