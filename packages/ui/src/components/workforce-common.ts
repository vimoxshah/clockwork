/**
 * Small shared pieces for the workforce sections that live inside Tasks
 * (F1 plan-then-execute, F4 sentinels, F5 repo-shipped jobs).
 *
 * `openRunInInbox` is the ONLY honest way to link a run from here: every
 * daemon route needs the bearer header, so a plain <a href> to /runs/:id 401s
 * (api.ts says the same of the proof-of-work URL). The Inbox already owns run
 * display and already has a deep-link entry point — App's toast uses it — so
 * this reuses it rather than inventing a second run viewer.
 */
import { setPendingRunId } from './InboxView';

/**
 * Select `runId` in the Inbox and switch to it.
 *
 * Order matters: `setPendingRunId` stashes the id at module scope and nudges a
 * mounted InboxView; the hash write is what mounts it (App listens for
 * hashchange). Writing the hash first would race the mount against the stash.
 *
 * Only `#/inbox` is written — App's `tabFromHash` falls back to the calendar
 * for any hash it does not recognise, so a sub-path would silently navigate
 * somewhere else entirely.
 */
export function openRunInInbox(runId: string): void {
  setPendingRunId(runId);
  window.location.hash = '#/inbox';
}

/** Approvals live at the top of the Inbox list; there is no per-approval route. */
export function openInbox(): void {
  window.location.hash = '#/inbox';
}

/** Event triggers are created in Settings — the sentinel form links there. */
export function openSettings(): void {
  window.location.hash = '#/settings';
}

/** Epoch ms → local date-time, or an em dash when there is no timestamp. */
export function fmtWhen(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Seconds → "45m" / "2h" / "30s", for cooldowns a human has to reason about. */
export function fmtDuration(sec: number): string {
  if (sec <= 0) return 'none';
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}
