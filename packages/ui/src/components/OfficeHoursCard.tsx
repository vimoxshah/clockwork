/**
 * F3 office hours — the windows in which you can actually answer approvals.
 *
 * Shipped with working daemon routes and no screen at all; this is the screen.
 * Turn the feature on, add and remove windows, read the windows you have.
 *
 * The honesty problem this card exists to solve is not the controls, it is the
 * PREREQUISITE. Office hours only ever shifts a task whose profile carries
 * `may_require_approval = 1`, and no profile route sets that column: the only
 * writers in the product are F7 enrolment and accepting an autonomy offer
 * (docs/agent-workforce.md F3, docs/scheduling.md). Turn office hours on with
 * no flagged profile and it defers nothing, silently, and looks exactly like a
 * correct install whose windows happen to be open. So the card reads the flag
 * off `GET /profiles` (a `SELECT *`, so the column is on the wire) and says
 * out loud which profiles are flagged — or that none are — with a way through
 * to the autonomy card that sets it.
 */
import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { api } from '../api';
import { useAsync } from '../useAsync';
import { Switch } from './ui/switch';
import { Badge } from './ui/card';
import { featureSurface, registerFeatureSurface, revealFeatureSurface } from './featureSurfaces';

export const OFFICE_HOURS_SURFACE = registerFeatureSurface({
  key: 'office_hours',
  tab: 'settings',
  where: 'Settings › Office hours',
  anchorId: 'office-hours',
});

/** 0 = Sunday .. 6 = Saturday, the daemon's `dow` (OfficeHourCreate). */
const DOW = [
  { value: 0, short: 'Sun', long: 'Sunday' },
  { value: 1, short: 'Mon', long: 'Monday' },
  { value: 2, short: 'Tue', long: 'Tuesday' },
  { value: 3, short: 'Wed', long: 'Wednesday' },
  { value: 4, short: 'Thu', long: 'Thursday' },
  { value: 5, short: 'Fri', long: 'Friday' },
  { value: 6, short: 'Sat', long: 'Saturday' },
];

/** A profile row as `GET /profiles` sends it — `SELECT *`, so snake_case. */
interface ProfileFlagRow {
  id: string;
  slug: string;
  name: string;
  may_require_approval?: number | null;
}

/** '09:30' → 570. Returns null for an empty or unparseable field. */
export function timeToMin(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 570 → '09:30'. 1440 renders as '00:00' because `<input type="time">` has no 24:00. */
function minToTime(min: number): string {
  const h = Math.floor(min / 60) % 24;
  return `${String(h).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** Display form, where 1440 IS 24:00 — the end of the day, which the input cannot spell. */
function fmtMin(min: number): string {
  return min === 1440 ? '24:00' : minToTime(min);
}

/**
 * `endMin` is 1..1440 and must be after `startMin`, so an end of midnight is
 * the END of this day (1440), never the start of the next one — a window that
 * crosses midnight is two rows, and the daemon refuses it as one.
 */
export function endFieldToMin(v: string): number | null {
  const raw = timeToMin(v);
  return raw === 0 ? 1440 : raw;
}

/** IANA names for the datalist. Not every engine has `supportedValuesOf`. */
function knownZones(): string[] {
  const supported = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  try {
    return typeof supported === 'function' ? supported('timeZone') : [];
  } catch {
    return [];
  }
}

export function OfficeHoursCard({ version }: { version: number }): JSX.Element {
  const hours = useAsync(() => api.officeHours(), [version]);
  const profiles = useAsync<ProfileFlagRow[]>(() => api.profiles(), [version]);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [dow, setDow] = useState(1);
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('17:00');
  const [tz, setTz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [label, setLabel] = useState('');

  const enabled = hours.data?.enabled ?? false;
  const windows = [...(hours.data?.windows ?? [])].sort((a, b) => a.dow - b.dow || a.startMin - b.startMin);

  const startMin = timeToMin(start);
  const endMin = endFieldToMin(end);
  const problem =
    startMin === null || endMin === null
      ? 'Enter a start and an end time.'
      : endMin <= startMin
        ? 'End must be after start — a window cannot cross midnight. Split it into two windows (22:00–24:00 and 00:00–02:00).'
        : !tz.trim()
          ? 'Enter an IANA time zone, e.g. America/New_York.'
          : null;

  const toggle = async (next: boolean): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await api.officeHoursSetEnabled(next);
      hours.reload();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const add = async (): Promise<void> => {
    if (problem || startMin === null || endMin === null) return;
    setBusy(true);
    setErr(null);
    try {
      await api.officeHoursCreate({
        dow,
        startMin,
        endMin,
        tz: tz.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      setLabel('');
      hours.reload();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    setRemoving(id);
    setErr(null);
    try {
      await api.officeHoursDelete(id);
      hours.reload();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setRemoving(null);
    }
  };

  if (hours.loading && !hours.data) return <p className="hint">Reading office hours…</p>;

  return (
    <div>
      {hours.error && (
        <div className="error-banner" role="alert">
          Couldn’t load office hours: {hours.error}
        </div>
      )}

      <div className="tasklist-row">
        <div className="grow">
          <strong>Defer approvals into office hours</strong>
          <div className="hint">
            While this is on, a run that might need you is moved to the next open window instead of
            firing outside one. Turning it off leaves your windows in place — they simply stop
            applying. Currently{' '}
            <strong>{hours.data ? (enabled ? 'ON' : 'off') : 'unknown — the daemon did not answer'}</strong>.
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted">
          <Switch
            checked={enabled}
            disabled={busy || hours.loading}
            onCheckedChange={(v) => void toggle(Boolean(v))}
            aria-label="Office hours enabled"
            data-testid="office-hours-enabled"
          />
          {enabled ? 'On' : 'Off'}
        </label>
      </div>

      <PrerequisiteNotice profiles={profiles.data} error={profiles.error} enabled={enabled} />

      {windows.length === 0 && !hours.loading && !hours.error && (
        <p className="hint" data-testid="office-hours-empty">
          No windows yet. A window is a block of one weekday you can answer approvals in — say
          Tuesday 09:00–17:00 in your own time zone. Add your first one below; until then there is
          nowhere for a deferred run to land, and nothing is deferred.
        </p>
      )}

      {windows.map((w) => (
        <div key={w.id} className="tasklist-row" data-testid="office-hours-window">
          <CalendarClock className="h-4 w-4 shrink-0 text-dim" aria-hidden />
          <div className="grow">
            <strong>
              {DOW.find((d) => d.value === w.dow)?.long ?? `day ${w.dow}`} {fmtMin(w.startMin)}–
              {fmtMin(w.endMin)}
            </strong>
            {w.label && <span className="hint"> · {w.label}</span>}
            <div className="hint mono" style={{ margin: 0 }}>
              {w.tz}
            </div>
          </div>
          {!w.enabled && (
            <Badge variant="outline">
              inactive — no route switches one window back on; remove it and add it again
            </Badge>
          )}
          <button
            className="btn danger small"
            disabled={removing === w.id}
            data-testid="office-hours-remove"
            onClick={() => void remove(w.id)}
          >
            {removing === w.id ? 'Removing…' : 'Remove'}
          </button>
        </div>
      ))}

      <div className="office-hours-form">
        <div className="oh-days">
          <label className="f">Day</label>
          <div className="flex gap-1">
            {DOW.map((d) => (
              <button
                key={d.value}
                type="button"
                aria-pressed={dow === d.value}
                onClick={() => setDow(d.value)}
                className={
                  'h-8 w-full rounded-md border text-xxs font-medium ' +
                  (dow === d.value
                    ? 'border-accent bg-accent text-[var(--accent-fg)]'
                    : 'border-border text-muted hover:bg-surface-hover hover:text-fg')
                }
              >
                {d.short}
              </button>
            ))}
          </div>
        </div>
        <div className="oh-time">
          <label className="f" htmlFor="oh-start">
            From
          </label>
          <input
            id="oh-start"
            type="time"
            className="mono"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </div>
        <div className="oh-time">
          <label className="f" htmlFor="oh-end">
            To
          </label>
          <input
            id="oh-end"
            type="time"
            className="mono"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </div>
        <div className="oh-text">
          <label className="f" htmlFor="oh-tz">
            Time zone
          </label>
          <input
            id="oh-tz"
            type="text"
            list="oh-tz-list"
            className="mono"
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            placeholder="America/New_York"
          />
          <datalist id="oh-tz-list">
            {knownZones().map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </div>
        <div className="oh-text">
          <label className="f" htmlFor="oh-label">
            Label (optional)
          </label>
          <input
            id="oh-label"
            type="text"
            maxLength={64}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Working hours"
          />
        </div>
        <button
          className="btn primary oh-action"
          disabled={busy || problem !== null}
          data-testid="office-hours-add"
          onClick={() => void add()}
        >
          {busy ? 'Saving…' : 'Add window'}
        </button>
      </div>
      {/* Out of the control row on purpose: a hint under one input pushed that
          input off the baseline its three neighbours sat on. */}
      <p className="hint">
        00:00 in “To” means midnight at the <em>end</em> of that day.
      </p>
      {problem && (
        <p className="hint" data-testid="office-hours-problem">
          {problem}
        </p>
      )}
      {err && (
        <div className="error-banner" role="alert" data-testid="office-hours-error">
          {err}
        </div>
      )}
    </div>
  );
}

/**
 * The third setup step, which is not in this feature's API at all.
 *
 * Counted from the live `may_require_approval` column rather than inferred
 * from a rung, because that column is literally what the scheduler reads.
 */
function PrerequisiteNotice({
  profiles,
  error,
  enabled,
}: {
  profiles: ProfileFlagRow[] | null;
  error: string | null;
  enabled: boolean;
}): JSX.Element {
  const autonomy = featureSurface('earned_autonomy');
  const flagged = (profiles ?? []).filter((p) => Boolean(p.may_require_approval));

  return (
    <div className="tasklist-row" data-testid="office-hours-prerequisite">
      <div className="grow">
        <strong>Deferral applies to flagged profiles only</strong>
        <div className="hint">
          A run is only ever moved into a window when its profile is flagged as one that may need
          your approval. Nothing else in Clockwork sets that flag: it comes from enrolling a profile
          in the autonomy ladder at rung <span className="mono">plan</span> or{' '}
          <span className="mono">acceptEdits</span>. Enrolling at{' '}
          <span className="mono">unattended</span> clears it again. Switch office hours on with no
          flagged profile and it will defer nothing — which looks exactly like windows that are
          always open.
        </div>
        {error && <div className="hint">Couldn’t read profiles, so the count below is unknown: {error}</div>}
        {!error && flagged.length === 0 && (
          <div className="hint" data-testid="office-hours-none-flagged">
            No profile is flagged right now, so {enabled ? 'office hours is on and defers nothing' : 'turning this on would defer nothing'}.
          </div>
        )}
        {!error && flagged.length > 0 && (
          <div className="hint" data-testid="office-hours-flagged">
            {flagged.length} flagged: {flagged.map((p) => p.name).join(', ')} — tasks that use{' '}
            {flagged.length === 1 ? 'it' : 'them'} defer into the next open window.
          </div>
        )}
      </div>
      <Badge variant={flagged.length > 0 ? 'success' : 'warning'}>
        {flagged.length > 0 ? `${flagged.length} flagged` : 'nothing to defer'}
      </Badge>
      {autonomy && (
        <button
          className="btn small"
          data-testid="office-hours-to-autonomy"
          onClick={() => revealFeatureSurface(autonomy)}
        >
          Earned autonomy
        </button>
      )}
    </div>
  );
}
