/**
 * F3 office-hours (plan/AGENT-WORKFORCE-SPEC.md §4 F3).
 *
 * The human declares windows in which they can answer an approval. A task
 * whose profile carries `may_require_approval = 1` has its fire instant
 * shifted forward into the next such window. Every other task is untouched —
 * `profiles.may_require_approval` defaults to 0, so switching office hours on
 * moves nothing by surprise.
 *
 * Windows never wrap midnight (`endMin > startMin`, enforced by
 * `OfficeHourCreate`); a crossing window is stored as two rows, so containment
 * is always a plain `[startMin, endMin)` test in the window's own IANA zone.
 *
 * THE WHOLE FEATURE FAILS OPEN. `shiftForApproval` returns `null` — meaning
 * "do not move this run" — for every refusal and every error: office hours
 * off, no windows, an unusable window, an unknown task, a missing table. A
 * broken office-hours config must delay work, never silently stop it.
 */
import { DateTime } from 'luxon';
import { newId } from '@clockwork/shared';
import type { OfficeHourCreate, OfficeHourWindow } from '@clockwork/shared';
import type { DB } from './db.js';

/** How far `nextOfficeHourStart` looks ahead before giving up (spec §4 F3). */
const SEARCH_DAYS = 14;

interface OfficeHourRow {
  id: string;
  label: string | null;
  dow: number;
  start_min: number;
  end_min: number;
  tz: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

function toWindow(row: OfficeHourRow): OfficeHourWindow {
  return {
    id: row.id,
    label: row.label,
    dow: row.dow,
    startMin: row.start_min,
    endMin: row.end_min,
    tz: row.tz,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Does luxon know this IANA zone? Used by the create route to refuse a window that could never match. */
export function isKnownZone(tz: string): boolean {
  if (!tz) return false;
  return DateTime.local().setZone(tz).isValid;
}

/**
 * A window a shift computation can trust. `OfficeHourCreate` guards the API
 * door, but `office_hours` carries no CHECK constraints, so a hand-edited or
 * restored row can hold a degenerate range or a zone luxon cannot resolve.
 * Such a window is ignored rather than obeyed: ignoring it lets the run fire
 * on time, obeying it would defer against a window that never opens.
 */
function usable(w: OfficeHourWindow): boolean {
  return (
    w.enabled &&
    Number.isInteger(w.dow) &&
    w.dow >= 0 &&
    w.dow <= 6 &&
    Number.isInteger(w.startMin) &&
    Number.isInteger(w.endMin) &&
    w.startMin >= 0 &&
    w.startMin <= 1439 &&
    w.endMin > w.startMin &&
    w.endMin <= 1440 &&
    isKnownZone(w.tz)
  );
}

/** luxon weekday is 1=Monday..7=Sunday; `office_hours.dow` is 0=Sunday..6=Saturday. */
function dowOf(dt: DateTime): number {
  return dt.weekday % 7;
}

/** Is `atMs` inside any enabled, usable window? Start inclusive, end exclusive. */
export function inOfficeHours(atMs: number, windows: OfficeHourWindow[]): boolean {
  for (const w of windows) {
    if (!usable(w)) continue;
    const dt = DateTime.fromMillis(atMs).setZone(w.tz);
    if (!dt.isValid || dowOf(dt) !== w.dow) continue;
    const minute = dt.hour * 60 + dt.minute;
    if (minute >= w.startMin && minute < w.endMin) return true;
  }
  return false;
}

/**
 * The earliest window START at or after `atMs`, or `null` when no usable
 * window opens inside the next `SEARCH_DAYS` days. The bound is what keeps a
 * misconfigured window set from spinning: the caller gets `null` and the run
 * fires on time.
 */
export function nextOfficeHourStart(atMs: number, windows: OfficeHourWindow[]): number | null {
  let best: number | null = null;
  for (const w of windows) {
    if (!usable(w)) continue;
    let day = DateTime.fromMillis(atMs).setZone(w.tz).startOf('day');
    if (!day.isValid) continue;
    for (let i = 0; i < SEARCH_DAYS; i++) {
      if (dowOf(day) === w.dow) {
        // .set() is calendar-aware: a duration add of `startMin` minutes would
        // land an hour off on a spring-forward day.
        const start = day
          .set({ hour: Math.floor(w.startMin / 60), minute: w.startMin % 60, second: 0, millisecond: 0 })
          .toMillis();
        if (start >= atMs) {
          if (best === null || start < best) best = start;
          break; // later days of this same window are strictly later
        }
      }
      day = day.plus({ days: 1 }).startOf('day');
    }
  }
  return best;
}

/**
 * The single call the scheduler makes. Returns the shifted instant, or `null`
 * when nothing should move — office hours off, no usable window, the task's
 * profile not flagged, `fireAt` already inside a window, or any error at all.
 */
export function shiftForApproval(db: DB, taskId: string, fireAt: number): number | null {
  try {
    const prefs = db
      .prepare('SELECT office_hours_enabled AS v FROM workforce_prefs WHERE id = 1')
      .get() as { v: number } | undefined;
    if (!prefs?.v) return null;

    // Only a task whose profile is flagged is eligible. A task with no profile
    // has nobody to ask, so the join drops it.
    const flagged = db
      .prepare(
        `SELECT p.may_require_approval AS v FROM tasks t
         JOIN profiles p ON p.id = t.profile_id
         WHERE t.id = ?`,
      )
      .get(taskId) as { v: number } | undefined;
    if (!flagged?.v) return null;

    const windows = (
      db.prepare('SELECT * FROM office_hours WHERE enabled = 1').all() as unknown as OfficeHourRow[]
    )
      .map(toWindow)
      .filter(usable);
    if (windows.length === 0) return null;
    if (inOfficeHours(fireAt, windows)) return null;

    const start = nextOfficeHourStart(fireAt, windows);
    // A start at or before fireAt would re-defer the same instant forever.
    if (start === null || start <= fireAt) return null;
    return start;
  } catch {
    // Fail open: office hours delay work, they never stop it. A missing table,
    // a corrupt row or a locked DB must not cost the user a scheduled run.
    return null;
  }
}

/** CRUD over the `office_hours` table plus the `workforce_prefs` master switch. */
export class OfficeHours {
  constructor(private readonly db: DB) {}

  /** Every window, enabled or not — the UI has to be able to re-enable one. */
  list(): OfficeHourWindow[] {
    const rows = this.db
      .prepare('SELECT * FROM office_hours ORDER BY dow, start_min, id')
      .all() as unknown as OfficeHourRow[];
    return rows.map(toWindow);
  }

  create(input: OfficeHourCreate, now = Date.now()): OfficeHourWindow {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO office_hours (id, label, dow, start_min, end_min, tz, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.label ?? null,
        input.dow,
        input.startMin,
        input.endMin,
        input.tz,
        input.enabled === false ? 0 : 1,
        now,
        now,
      );
    return this.byId(id) as OfficeHourWindow;
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM office_hours WHERE id = ?').run(id).changes > 0;
  }

  enabled(): boolean {
    const row = this.db
      .prepare('SELECT office_hours_enabled AS v FROM workforce_prefs WHERE id = 1')
      .get() as { v: number } | undefined;
    return Boolean(row?.v);
  }

  setEnabled(on: boolean): void {
    // The singleton is seeded by 0008; the OR IGNORE keeps setEnabled honest on
    // a DB whose prefs row was deleted, so the route never reports a write that
    // updated nothing.
    this.db.prepare('INSERT OR IGNORE INTO workforce_prefs (id) VALUES (1)').run();
    this.db.prepare('UPDATE workforce_prefs SET office_hours_enabled = ? WHERE id = 1').run(on ? 1 : 0);
  }

  private byId(id: string): OfficeHourWindow | undefined {
    const row = this.db.prepare('SELECT * FROM office_hours WHERE id = ?').get(id) as unknown as
      | OfficeHourRow
      | undefined;
    return row ? toWindow(row) : undefined;
  }
}
