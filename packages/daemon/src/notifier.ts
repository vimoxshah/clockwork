/**
 * Daemon-side native notifier (T-109, stack #13): the daemon must notify with
 * the UI closed, so it cannot ride Tauri's notification API. macOS: osascript.
 * Quiet hours suppress notifications but never affect runs or inbox (S-65).
 */
import { spawn } from 'node:child_process';

export interface NotifierDeps {
  quietHours?: { startHour: number; endHour: number } | null; // local time, may wrap midnight
  enabled?: boolean;
  exec?: (script: string) => Promise<void>;
}

export class Notifier {
  private readonly exec: (script: string) => Promise<void>;

  constructor(private readonly deps: NotifierDeps = {}) {
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
      return true;
    } catch {
      return false;
    }
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
