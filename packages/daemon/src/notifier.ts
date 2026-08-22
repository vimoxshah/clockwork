/**
 * Daemon-side native notifier (T-109, stack #13): the daemon must notify with
 * the UI closed, so it cannot ride Tauri's notification API. macOS: osascript.
 * Quiet hours suppress notifications but never affect runs or inbox (S-65).
 */
import { spawn } from 'node:child_process';

export interface NotifierDeps {
  quietHours?: { startHour: number; endHour: number } | null; // local time, may wrap midnight
  enabled?: boolean;
  /** 'chime' plays the generated Clockwork tone at volumePct; 'system' uses a macOS sound name; 'none' silent */
  soundMode?: 'chime' | 'system' | 'none';
  volumePct?: number; // 0–100 (afplay scale)
  chimeFile?: string;
  dataDir?: string;
  exec?: (script: string) => Promise<void>;
}

export class Notifier {
  private readonly exec: (script: string) => Promise<void>;
  private readonly soundMode: 'chime' | 'system' | 'none';
  private readonly volumePct: number;

  constructor(private readonly deps: NotifierDeps = {}) {
    this.soundMode = deps.soundMode ?? 'chime';
    this.volumePct = Math.max(0, Math.min(100, deps.volumePct ?? 60));
    this.exec =
      deps.exec ??
      ((script) =>
        new Promise((resolve) => {
          const child = spawnProcess(script);
          child.on('close', () => resolve());
          child.on('error', () => resolve());
        }));
  }

  private get quietActive(): boolean {
    if (!this.deps.quietHours) return false;
    const h = new Date().getHours();
    const { startHour, endHour } = this.deps.quietHours;
    return startHour <= endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
  }

  /** Delivery failures never fail the run (S-43). */
  async send(title: string, body: string): Promise<boolean> {
    if (this.deps.enabled === false) return false;
    if (this.quietActive) return false; // suppressed; inbox badge still increments
    try {
      await this.exec(buildOsascript(title, body));
      await this.playSound();
      return true;
    } catch {
      return false;
    }
  }

  private async playSound(): Promise<void> {
    if (this.soundMode === 'none') return;
    if (this.soundMode === 'system') {
      // system sound name rides the notification itself via a second script
      try {
        await this.exec(`(display notification "" with title "" sound name "Glass")`);
      } catch {}
      return;
    }
    // generated chime through afplay at user volume
    try {
      const file = this.deps.chimeFile ?? requireChime(this.deps.dataDir);
      const vol = Math.max(0.05, this.volumePct / 100);
      spawn('/usr/bin/afplay', ['-v', String(vol), file], { stdio: 'ignore' });
    } catch {}
  }
}

function buildOsascript(title: string, body: string): string {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `display notification "${esc(body)}" with title "${esc(title)}"`;
}

function spawnProcess(script: string): import('node:child_process').ChildProcess {
  const osascript = process.platform === 'darwin' ? 'osascript' : null;
  if (!osascript) {
    // non-macOS dev fallback: no-op process that exits immediately
    return spawn('/usr/bin/true');
  }
  return spawn(osascript, ['-e', script]);
}

import { chimePath } from './chime.js';
import path from 'node:path';
function requireChime(dataDir?: string): string {
  return chimePath(path.join(dataDir ?? `${process.env.HOME}/.clockwork`));
}
