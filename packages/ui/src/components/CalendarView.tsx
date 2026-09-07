/**
 * Calendar view (T-122): MONTH grid by default, week toggle, real data from
 * GET /calendar (runs + expanded recurring bookings), day selection with a
 * detail panel, event click → detail dialog, overflow handling.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useAsync } from '../useAsync';
import {
  buildMonthGrid,
  buildWeekDays,
  shiftMonth,
  todayMidnight,
  type GridCell,
} from '../calendar';
import type { CalendarEvent } from '../api';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MAX_PER_CELL = 4;

export interface ComposerPrefill {
  runAtLocal: string;
}

function stateClass(state?: string): string {
  if (!state) return 'booking';
  if (state === 'completed') return 'st-completed';
  if (['failed', 'timed_out', 'budget_exceeded'].includes(state)) return 'st-failed';
  if (['missed', 'cancelled'].includes(state)) return 'st-cancelled';
  if (['running', 'queued', 'preparing', 'finalizing'].includes(state)) return 'st-running';
  if (['waiting_approval', 'awaiting_user'].includes(state)) return 'st-needsyou';
  return 'st-cancelled';
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** "Aug 31" — the week title's two ends, in the reader's locale. */
function dayLabel(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function CalendarView({
  version,
  onBookOnDate,
  onOpenTask,
}: {
  version: number;
  onBookOnDate: (prefill: { runAtLocal: string }) => void;
  onOpenTask: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<'month' | 'week'>(() =>
    localStorage.getItem('clockwork.calview') === 'week' ? 'week' : 'month',
  );
  const now = new Date();
  const [view, setView] = useState(() => ({ year: now.getFullYear(), month: now.getMonth() }));
  const [weekAnchorTs, setWeekAnchorTs] = useState(() => todayMidnight());
  const [selectedTs, setSelectedTs] = useState<number | null>(() => todayMidnight());
  const [detailEvent, setDetailEvent] = useState<CalendarEvent | null>(null);

  /**
   * The seven days Week mode draws. The title, the fetch window and the columns
   * are ALL derived from this one array, so the header can no longer name a
   * different week from the one underneath it.
   *
   * `weekAnchorTs` is any day inside the week, not its start: `buildWeekDays`
   * snaps it back to the containing Monday (calendar.ts — weeks start Monday
   * here, as they do in the month grid and the `DOW` row). Treating the anchor
   * as the start agreed with the grid only when it happened to BE a Monday, one
   * day in seven; on every other day the header was a whole week ahead of its
   * own columns, and the fetch window skipped the days before the anchor, so
   * those columns were guaranteed empty whatever the data said.
   */
  const weekDays = buildWeekDays(new Date(weekAnchorTs), now);
  const weekStartTs = weekDays[0].ts;
  const weekEndTs = weekDays[6].ts;

  // visible window: generous padding around the current view
  const range = useMemo(() => {
    if (mode === 'month') {
      const first = new Date(view.year, view.month, 1);
      const start = new Date(first);
      start.setDate(1 - ((first.getDay() + 6) % 7));
      return { from: start.getTime(), to: start.getTime() + 42 * 86_400_000 };
    }
    return { from: weekStartTs - 86_400_000, to: weekStartTs + 8 * 86_400_000 };
  }, [mode, view, weekStartTs]);

  const cal = useAsync(
    () => api.calendar(range.from, range.to),
    [range.from, range.to, version],
  );

  const eventsByDay = useMemo(() => {
    const map = new Map<number, CalendarEvent[]>();
    const push = (e: CalendarEvent): void => {
      const dayTs = todayMidnight(new Date(e.at));
      const arr = map.get(dayTs) ?? [];
      arr.push(e);
      map.set(dayTs, arr);
    };
    for (const r of cal.data?.runs ?? []) {
      const at = (r.scheduled_for ?? r.started_at ?? r.ended_at) as number | null;
      if (at == null) continue;
      push({
        kind: 'run',
        id: r.id as string,
        taskId: String(r.task_id),
        name: r.task_name ?? '(task)',
        at: at as number,
        state: String(r.state),
        costUsd: Number(r.cost_usd ?? 0),
        outcomeReason: (r.outcome_reason as string) ?? null,
      });
    }
    for (const b of cal.data?.bookings ?? []) {
      push({ kind: 'booking', id: `b-${b.taskId}-${b.at}`, taskId: b.taskId, name: b.name, at: b.at });
    }
    // human events from subscribed ICS calendars (read-only overlay)
    for (const h of (cal.data as any)?.humans ?? []) {
      push({ kind: 'human', id: `h-${h.uid}`, taskId: '', name: h.name, at: h.at, allDay: h.allDay });
    }
    for (const [, arr] of map) arr.sort((a, b) => a.at - b.at);
    return map;
  }, [cal.data]);

  const setModePersist = (m: 'month' | 'week'): void => {
    localStorage.setItem('clockwork.calview', m);
    setMode(m);
  };

  const goPrev = (): void => {
    if (mode === 'month') setView((v) => shiftMonth(v.year, v.month, -1));
    else setWeekAnchorTs((t) => t - 7 * 86_400_000);
  };
  const goNext = (): void => {
    if (mode === 'month') setView((v) => shiftMonth(v.year, v.month, 1));
    else setWeekAnchorTs((t) => t + 7 * 86_400_000);
  };
  const goToday = (): void => {
    const n = new Date();
    setView({ year: n.getFullYear(), month: n.getMonth() });
    setWeekAnchorTs(todayMidnight(n));
    setSelectedTs(todayMidnight(n));
  };

  const title =
    mode === 'month'
      ? buildMonthGrid(now, view.year, view.month).title
      : `${dayLabel(weekStartTs)} – ${dayLabel(weekEndTs)}`;

  const cells: GridCell[] =
    mode === 'month' ? buildMonthGrid(new Date(), view.year, view.month).cells : weekDays;

  const selectedEvents = selectedTs != null ? eventsByDay.get(selectedTs) ?? [] : [];

  const bookOn = (ts: number): void => {
    const d = new Date(ts);
    d.setHours(d.getHours() + 1, 0, 0, 0);
    const p2 = (n: number): string => String(n).padStart(2, '0');
    onBookOnDate({
      runAtLocal: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:00`,
    });
  };

  return (
    <div>
      <div className="cal-toolbar">
        <div className="seg" role="tablist" aria-label="Calendar view">
          <button role="tab" aria-selected={mode === 'month'} className={mode === 'month' ? 'on' : ''} onClick={() => setModePersist('month')}>
            Month
          </button>
          <button role="tab" aria-selected={mode === 'week'} className={mode === 'week' ? 'on' : ''} onClick={() => setModePersist('week')}>
            Week
          </button>
        </div>
        <button className="btn small" onClick={goPrev} aria-label="Previous">
          ←
        </button>
        <button className="btn small" onClick={goToday}>
          Today
        </button>
        <button className="btn small" onClick={goNext} aria-label="Next">
          →
        </button>
        <span className="cal-title">{title}</span>
        <span style={{ flex: 1 }} />
        <button className="btn primary small" onClick={() => bookOn(selectedTs ?? todayMidnight())}>
          ＋ Book run
        </button>
      </div>

      {cal.loading && (
        <div className="state-line">
          <span className="spinner" /> Loading calendar…
        </div>
      )}
      {cal.error && (
        <div className="error-banner" role="alert">
          Couldn’t load the calendar: {cal.error}
          <div>
            <button className="btn small" style={{ marginTop: 8 }} onClick={cal.reload}>
              Retry
            </button>
          </div>
        </div>
      )}

      {!cal.loading && !cal.error && (
        <div className={`cal-wrap ${selectedTs == null ? 'no-side' : ''}`}>
          <div>
            <div className="cal-grid" style={mode === 'week' ? { display: 'none' } : undefined} aria-hidden={mode !== 'month'}>
              {DOW.map((d) => (
                <div key={d} className="cal-dow">
                  {d}
                </div>
              ))}
              {cells.map((c) => (
                <MonthCell
                  key={c.ts}
                  cell={c}
                  events={eventsByDay.get(c.ts) ?? []}
                  selected={selectedTs === c.ts}
                  onSelect={() => setSelectedTs(c.ts)}
                  onMore={() => setSelectedTs(c.ts)}
                  onEvent={(e) => setDetailEvent(e)}
                />
              ))}
            </div>

            {mode === 'week' && (
              <div className="week-grid">
                {cells.map((c) => {
                  const evs = eventsByDay.get(c.ts) ?? [];
                  return (
                    <div
                      key={c.ts}
                      className={`week-col ${c.isToday ? 'today' : ''}`}
                      onClick={() => setSelectedTs(c.ts)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === 'Enter' && setSelectedTs(c.ts)}
                    >
                      <div className="daynum" style={{ fontWeight: c.isToday ? 700 : 400 }}>
                        {new Date(c.ts).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}
                      </div>
                      <div className="events">
                        {evs.map((ev) => (
                          <button
                            key={ev.id}
                            className={`cal-event ${ev.kind === 'run' ? stateClass(ev.state) : ev.kind === 'human' ? 'human' : 'booking'}`}
                            title={`${timeLabel(ev.at)} · ${ev.name}`}
                            onClick={(e) => { e.stopPropagation(); setDetailEvent(ev); }}
                          >
                            {timeLabel(ev.at)} {ev.name}
                          </button>
                        ))}
                        {evs.length === 0 && <span className="hint">—</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {selectedTs != null && (
            <aside className="day-panel">
              <h3>{new Date(selectedTs).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</h3>
              <div className="sub">
                {selectedEvents.length === 0
                  ? 'Nothing scheduled.'
                  : `${selectedEvents.length} item${selectedEvents.length > 1 ? 's' : ''}`}
              </div>
              {selectedEvents.map((ev) => (
                <div key={ev.id} className="ev-row" onClick={() => setDetailEvent(ev)} role="button" tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setDetailEvent(ev)}>
                  <span className={`chip ${ev.kind === 'run' ? chipFor(ev.state!) : ''}`}>{ev.name}</span>
                  <span className="mono" style={{ color: 'var(--dim)' }}>
                    {ev.kind === 'run' ? ev.state?.replace('_', ' ') : 'booked'}
                  </span>
                </div>
              ))}
              <button className="btn small" style={{ marginTop: 12 }} onClick={() => bookOn(selectedTs)}>
                ＋ Book a run this day
              </button>
              <p className="honest-note">Runs execute when the machine is awake.</p>
            </aside>
          )}
        </div>
      )}

      {detailEvent && (
        <EventDialog
          event={detailEvent}
          onClose={() => setDetailEvent(null)}
          onOpenTask={() => {
            setDetailEvent(null);
            onOpenTask();
          }}
        />
      )}
    </div>
  );
}

function MonthCell({
  cell,
  events,
  selected,
  onSelect,
  onMore,
  onEvent,
}: {
  cell: GridCell;
  events: CalendarEvent[];
  selected: boolean;
  onSelect: () => void;
  onMore: () => void;
  onEvent: (e: CalendarEvent) => void;
}): JSX.Element {
  const shown = events.slice(0, MAX_PER_CELL);
  const hidden = events.length - shown.length;
  return (
    <div
      className={[
        'cal-cell',
        cell.isToday ? 'today' : '',
        !cell.inMonth ? 'other' : '',
        selected ? 'selected' : '',
        events.length === 0 ? 'cal-empty-day' : '',
      ].join(' ')}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onSelect()}
      aria-label={`${cell.year}-${cell.month + 1}-${cell.day}, ${events.length} items`}
    >
      <div className="daynum">{cell.day}</div>
      <div className="events">
        {shown.map((ev) => (
          <button
            key={ev.id}
            className={`cal-event ${ev.kind === 'run' ? stateClass(ev.state) : ev.kind === 'human' ? 'human' : 'booking'}`}
            title={`${timeLabel(ev.at)} · ${ev.name}${ev.state ? ` — ${ev.state}` : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onEvent(ev);
            }}
          >
            {ev.name}
          </button>
        ))}
        {hidden > 0 && (
          <button className="cal-more" onClick={(e) => { e.stopPropagation(); onMore(); }}>
            +{hidden} more
          </button>
        )}
      </div>
    </div>
  );
}

function EventDialog({
  event,
  onClose,
  onOpenTask,
}: {
  event: CalendarEvent;
  onClose: () => void;
  onOpenTask: () => void;
}): JSX.Element {
  const report = useAsync(
    () => (event.kind === 'run' ? api.report(event.id) : Promise.resolve(null)),
    [event.id],
  );
  const tr = useAsync(
    () => (event.kind === 'run' ? api.transcript(event.id) : Promise.resolve({ available: false, lines: [] })),
    [event.id],
  );
  const [showTranscript, setShowTranscript] = useState(false);

  // Escape closes the dialog (a11y: never trap the keyboard user)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={event.name}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{event.name}</h3>
        <div className="statrow mono">
          <span>{new Date(event.at).toLocaleString()}</span>
          {event.kind === 'run' ? (
            <>
              <span className={`chip ${chipFor(event.state!)}`}>{event.state?.replace('_', ' ')}</span>
              {event.outcomeReason && <span>reason: {event.outcomeReason}</span>}
              <span>${(event.costUsd ?? 0).toFixed(4)}</span>
            </>
          ) : (
            <span className="chip">booked (future occurrence)</span>
          )}
        </div>

        {event.kind === 'human' && (
          <>
            <p className="hint">👤 Human event from your subscribed calendar (read-only). Clockwork never modifies your personal calendar.</p>
            <div className="actions">
              <button className="btn primary" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}

        {event.kind === 'booking' && (
          <>
            <p className="hint">This is a scheduled future occurrence of a task. Nothing has run yet.</p>
            <div className="actions">
              <button className="btn" onClick={onOpenTask}>
                Manage in Tasks →
              </button>
              <button className="btn primary" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}

        {event.kind === 'run' && (
          <>
            {report.loading && <div className="state-line"><span className="spinner" /> Loading report…</div>}
            {report.error && <div className="error-banner">Couldn’t load report: {report.error}</div>}
            {report.data?.report?.summary && <div className="summary-block">{report.data.report.summary}</div>}
            {report.data?.report?.diffStat?.length > 0 && (
              <table className="diffstat-table mono">
                <tbody>
                  {report.data?.report?.diffStat?.map((s: any) => (
                    <tr key={s.path}>
                      <td>{s.path}</td>
                      <td className="add">+{s.additions}</td>
                      <td className="del">−{s.deletions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {tr.data?.available && (
              <div className="transcript">
                <button className="btn small" onClick={() => setShowTranscript((s) => !s)}>
                  {showTranscript ? 'Hide transcript' : `Show transcript (${tr.data.totalLines ?? '?'} lines)`}
                </button>
                {showTranscript && <pre>{tr.data.lines.join('\n')}</pre>}
              </div>
            )}
            <div className="actions">
              <button className="btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function chipFor(state: string): string {
  if (state === 'completed') return 'completed';
  if (['failed', 'timed_out', 'budget_exceeded', 'missed'].includes(state)) return 'failed';
  if (['running', 'queued', 'preparing', 'finalizing'].includes(state)) return 'running';
  if (['waiting_approval', 'awaiting_user'].includes(state)) return 'needs-you';
  return '';
}
