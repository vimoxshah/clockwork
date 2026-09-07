/**
 * Calendar view (T-122): MONTH grid by default, week and YEAR toggles, real
 * data from GET /calendar (runs + expanded recurring bookings), day selection
 * with a detail panel, event click → detail dialog, overflow handling.
 *
 * TWO WAYS OF ASKING, AND WHY (S-64)
 *   Month and week draw NAMED CHIPS, so they need events: `api.calendar()`.
 *   Year draws 365 cells that only have to carry a count and a colour, and a
 *   year over 5,000 runs is 5,000 events — so it asks for the per-day fold
 *   instead: `api.calendarDays()`, ~300 rows. Clicking a day in year mode then
 *   fetches THAT DAY's events, one local day wide. Aggregate to see the shape
 *   of the year, detail to read a day: the summary never replaces the runs.
 *
 * WHAT THE YEAR VIEW DOES NOT FIX. It is a payload and row-count win, not a
 * latency win. The daemon's `/calendar` cost is dominated by RRULE expansion
 * (see the route's own note in packages/daemon/src/api.ts), which both modes
 * pay in full. A year view is not faster to arrive; it is smaller when it does.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { api } from '../api';
import { useAsync } from '../useAsync';
import {
  buildMonthGrid,
  buildWeekDays,
  shiftMonth,
  todayMidnight,
  type GridCell,
} from '../calendar';
import type { CalendarDayT, CalendarDetailT, CalendarEvent, CalendarLimitsT } from '../api';
import { chipFor, stateLabel } from '../lib/runState';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MAX_PER_CELL = 4;
const MONTHS_IN_YEAR = 12;
/** Widest month; short ones render the tail as spacers. */
const DAYS_IN_WIDEST_MONTH = 31;

type CalMode = 'month' | 'week' | 'year';

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** The `YYYY-MM-DD` key the daemon's per-day fold uses — a LOCAL calendar day. */
function dayKey(year: number, month: number, day: number): string {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

/**
 * The last millisecond of the local day containing `ts`.
 *
 * Built from calendar fields, not by adding 86_400_000: across a DST change a
 * day is 23 or 25 hours long, and a fixed-millisecond day would ask for the
 * wrong window twice a year.
 */
function endOfLocalDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1;
}

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

/**
 * Flatten one detail response into the events a grid cell or a day panel
 * draws. Shared by the month/week window fetch and by the year view's
 * single-day fetch, so a run reads the same however it was asked for.
 */
function toEvents(data: CalendarDetailT | null): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const r of data?.runs ?? []) {
    const at = r.scheduled_for ?? r.started_at ?? r.ended_at;
    if (at == null) continue;
    out.push({
      kind: 'run',
      id: r.id,
      taskId: String(r.task_id),
      name: r.task_name ?? '(task)',
      at,
      state: String(r.state),
      costUsd: Number(r.cost_usd ?? 0),
      outcomeReason: r.outcome_reason ?? null,
    });
  }
  for (const b of data?.bookings ?? []) {
    out.push({ kind: 'booking', id: `b-${b.taskId}-${b.at}`, taskId: b.taskId, name: b.name, at: b.at });
  }
  // human events from subscribed ICS calendars (read-only overlay)
  for (const h of data?.humans ?? []) {
    out.push({ kind: 'human', id: `h-${h.uid}`, taskId: '', name: h.name, at: h.at, allDay: h.allDay });
  }
  return out.sort((a, b) => a.at - b.at);
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
  const [mode, setMode] = useState<CalMode>(() => {
    const saved = localStorage.getItem('clockwork.calview');
    return saved === 'week' || saved === 'year' ? saved : 'month';
  });
  const now = new Date();
  const [view, setView] = useState(() => ({ year: now.getFullYear(), month: now.getMonth() }));
  const [weekAnchorTs, setWeekAnchorTs] = useState(() => todayMidnight());
  // Year mode opens with NOTHING selected, on purpose: the year is one
  // aggregate request, and pre-selecting today would fire a second,
  // event-level request for a day the reader never asked about.
  const [selectedTs, setSelectedTs] = useState<number | null>(() =>
    localStorage.getItem('clockwork.calview') === 'year' ? null : todayMidnight(),
  );
  const [detailEvent, setDetailEvent] = useState<CalendarEvent | null>(null);
  /**
   * Whether the selected day's full list is open. A boolean rather than a
   * second timestamp on purpose: the list always describes `selectedTs`, and
   * two sources of truth for "which day" is a desync waiting to happen.
   */
  const [dayDialogOpen, setDayDialogOpen] = useState(false);

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
    if (mode === 'year') {
      // The whole calendar year, edge to edge. Built from calendar fields so
      // the window is exactly the year the header names in every zone.
      return {
        from: new Date(view.year, 0, 1).getTime(),
        to: new Date(view.year + 1, 0, 1).getTime() - 1,
      };
    }
    if (mode === 'month') {
      const first = new Date(view.year, view.month, 1);
      const start = new Date(first);
      start.setDate(1 - ((first.getDay() + 6) % 7));
      return { from: start.getTime(), to: start.getTime() + 42 * 86_400_000 };
    }
    return { from: weekStartTs - 86_400_000, to: weekStartTs + 8 * 86_400_000 };
  }, [mode, view, weekStartTs]);

  // Exactly one of these two ever hits the network; the other resolves null.
  // Month and week need events for their named chips; a year needs counts.
  const cal = useAsync(
    () => (mode === 'year' ? Promise.resolve(null) : api.calendar(range.from, range.to)),
    [mode, range.from, range.to, version],
  );
  const yearDays = useAsync(
    () => (mode === 'year' ? api.calendarDays(range.from, range.to) : Promise.resolve(null)),
    [mode, range.from, range.to, version],
  );
  // The year view's detail half: one local day, fetched only once a reader
  // picks a day. This is what keeps "click a day and see its runs" true when
  // the grid itself only ever received counts.
  const dayDetail = useAsync(
    () =>
      mode === 'year' && selectedTs != null
        ? api.calendar(selectedTs, endOfLocalDay(selectedTs))
        : Promise.resolve(null),
    [mode, selectedTs, version],
  );

  /** Whichever request draws the grid in the current mode. */
  const source = mode === 'year' ? yearDays : cal;
  const limits: CalendarLimitsT | undefined =
    (mode === 'year' ? yearDays.data?.limits : cal.data?.limits) ?? undefined;

  const eventsByDay = useMemo(() => {
    const map = new Map<number, CalendarEvent[]>();
    for (const e of toEvents(cal.data)) {
      const dayTs = todayMidnight(new Date(e.at));
      const arr = map.get(dayTs) ?? [];
      arr.push(e);
      map.set(dayTs, arr);
    }
    for (const [, arr] of map) arr.sort((a, b) => a.at - b.at);
    return map;
  }, [cal.data]);

  const setModePersist = (m: CalMode): void => {
    localStorage.setItem('clockwork.calview', m);
    setMode(m);
    // Only the YEAR transitions touch the selection. Year opens with nothing
    // picked so it does not fetch a day nobody clicked, and leaving year needs
    // a day again because month and week always show a panel. A month<->week
    // switch keeps whatever the reader had selected, exactly as it did before
    // year mode existed — `mode` here is still the mode being left.
    if (m === 'year') setSelectedTs(null);
    else if (mode === 'year') setSelectedTs(todayMidnight());
  };

  const goPrev = (): void => {
    if (mode === 'year') setView((v) => ({ ...v, year: v.year - 1 }));
    else if (mode === 'month') setView((v) => shiftMonth(v.year, v.month, -1));
    else setWeekAnchorTs((t) => t - 7 * 86_400_000);
  };
  const goNext = (): void => {
    if (mode === 'year') setView((v) => ({ ...v, year: v.year + 1 }));
    else if (mode === 'month') setView((v) => shiftMonth(v.year, v.month, 1));
    else setWeekAnchorTs((t) => t + 7 * 86_400_000);
  };
  const goToday = (): void => {
    const n = new Date();
    setView({ year: n.getFullYear(), month: n.getMonth() });
    setWeekAnchorTs(todayMidnight(n));
    setSelectedTs(todayMidnight(n));
  };

  const title =
    mode === 'year'
      ? String(view.year)
      : mode === 'month'
        ? buildMonthGrid(now, view.year, view.month).title
        : `${dayLabel(weekStartTs)} – ${dayLabel(weekEndTs)}`;

  const cells: GridCell[] =
    mode === 'month' ? buildMonthGrid(new Date(), view.year, view.month).cells : weekDays;

  // In year mode the panel reads its own single-day fetch; the grid never had
  // the events to give it.
  //
  // The filter is not redundant. `/calendar` admits a run when ANY of
  // `scheduled_for`/`started_at`/`ended_at` lands in the window, so a
  // one-day-wide request legitimately returns a run that STRADDLED midnight —
  // scheduled 23:55 yesterday, ended 00:05 today. The aggregate files that run
  // under `COALESCE(scheduled_for, ...)`, i.e. yesterday, and counts it in
  // yesterday's cell. Without this filter the cell would say four items and
  // the panel would then list five, one of them stamped the previous night.
  // Same rule as `eventsByDay` above, so both panels agree with their cells.
  const selectedEvents =
    mode === 'year'
      ? toEvents(dayDetail.data).filter(
          (e) => selectedTs != null && todayMidnight(new Date(e.at)) === selectedTs,
        )
      : selectedTs != null
        ? eventsByDay.get(selectedTs) ?? []
        : [];

  const bookOn = (ts: number): void => {
    const d = new Date(ts);
    d.setHours(d.getHours() + 1, 0, 0, 0);
    onBookOnDate({
      runAtLocal: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:00`,
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
          <button role="tab" aria-selected={mode === 'year'} className={mode === 'year' ? 'on' : ''} onClick={() => setModePersist('year')}>
            Year
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

      {source.loading && (
        <div className="state-line">
          <span className="spinner" /> Loading calendar…
        </div>
      )}
      {source.error && (
        <div className="error-banner" role="alert">
          Couldn’t load the calendar: {source.error}
          <div>
            <button className="btn small" style={{ marginTop: 8 }} onClick={source.reload}>
              Retry
            </button>
          </div>
        </div>
      )}

      <TruncationNotice limits={limits} />

      {!source.loading && !source.error && (
        <div className={`cal-wrap ${selectedTs == null ? 'no-side' : ''}`}>
          <div>
            <div className="cal-grid" style={mode !== 'month' ? { display: 'none' } : undefined} aria-hidden={mode !== 'month'}>
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
                  // "+N more" now actually shows the rest. It used to do
                  // exactly what a plain cell click does, which left the
                  // hidden items hidden.
                  onMore={() => {
                    setSelectedTs(c.ts);
                    setDayDialogOpen(true);
                  }}
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

            {mode === 'year' && (
              <YearGrid
                year={view.year}
                days={yearDays.data?.days ?? []}
                selectedTs={selectedTs}
                onSelect={setSelectedTs}
              />
            )}
          </div>

          {selectedTs != null && (
            <aside className="day-panel">
              <h3>{new Date(selectedTs).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</h3>
              <div className="sub">
                {mode === 'year' && dayDetail.loading
                  ? 'Loading that day…'
                  : selectedEvents.length === 0
                    ? 'Nothing scheduled.'
                    : `${selectedEvents.length} item${selectedEvents.length > 1 ? 's' : ''}`}
              </div>
              {mode === 'year' && dayDetail.error && (
                <div className="error-banner" role="alert">
                  Couldn’t load that day: {dayDetail.error}
                  <div>
                    <button className="btn small" style={{ marginTop: 8 }} onClick={dayDetail.reload}>
                      Retry
                    </button>
                  </div>
                </div>
              )}
              {selectedEvents.map((ev) => (
                <div key={ev.id} className="ev-row" onClick={() => setDetailEvent(ev)} role="button" tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setDetailEvent(ev)}>
                  <span className={`chip ${ev.kind === 'run' ? chipFor(ev.state!) : ''}`}>{ev.name}</span>
                  <span className="mono" style={{ color: 'var(--dim)' }}>
                    {ev.kind === 'run' ? stateLabel(ev.state) : 'Booked'}
                  </span>
                </div>
              ))}
              {selectedEvents.length > 0 && (
                <button
                  className="btn small"
                  style={{ marginTop: 12 }}
                  data-testid="view-all-day"
                  onClick={() => setDayDialogOpen(true)}
                >
                  View all {selectedEvents.length} item{selectedEvents.length === 1 ? '' : 's'}
                </button>
              )}
              <button className="btn small" style={{ marginTop: 12 }} onClick={() => bookOn(selectedTs)}>
                ＋ Book a run this day
              </button>
              <p className="honest-note">Runs execute when the machine is awake.</p>
            </aside>
          )}
        </div>
      )}

      {/* Rendered before EventDialog so that opening an event from the day
          list stacks the event dialog on top rather than under it. */}
      {dayDialogOpen && selectedTs != null && (
        <DayDialog
          ts={selectedTs}
          events={selectedEvents}
          onClose={() => setDayDialogOpen(false)}
          onEvent={(ev) => setDetailEvent(ev)}
          onBook={() => {
            setDayDialogOpen(false);
            bookOn(selectedTs);
          }}
        />
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

/**
 * The bound, made visible (S-64).
 *
 * `/calendar` caps every collection it returns, so a wide window can come back
 * partial. Saying nothing here would be the worst of both worlds: a reader
 * would see a complete-looking calendar that is missing runs. The notice names
 * what arrived, what exists, and what to do about it.
 *
 * `limits` and each of its members are optional: a daemon older than the field
 * answers without it, and then there is nothing honest to say.
 */
function TruncationNotice({ limits }: { limits?: CalendarLimitsT }): JSX.Element | null {
  if (!limits?.truncated) return null;
  const parts: string[] = [];
  const say = (c: { returned: number; total: number; truncated: boolean } | undefined, noun: string): void => {
    if (c?.truncated) parts.push(`${c.returned} of ${c.total} ${noun}`);
  };
  say(limits.days, 'days');
  say(limits.runs, 'runs');
  say(limits.bookings, 'booked occurrences');
  say(limits.humans, 'calendar events');
  return (
    <p className="hint" role="status" data-testid="calendar-truncated">
      This window is capped at {limits.rowLimit} rows, so you are seeing {parts.join(', ')}. Narrow
      the range to see the rest.
    </p>
  );
}

/** Fixed geometry for a year cell — 372 of them have to fit on one screen. */
const YEAR_CELL: CSSProperties = {
  padding: 0,
  width: '100%',
  height: 17,
  lineHeight: '17px',
  fontSize: 10,
  textAlign: 'center',
};

/**
 * Which colour a whole day gets, from its outcome counts.
 *
 * WORST-FIRST, deliberately. A day with nine completions and one failure is
 * drawn as a failure: a summary that averaged the news would hide exactly the
 * thing a reader opened the year view to find. The class names are the ones
 * `stateClass()` above puts on a single event, so a year cell and a month chip
 * mean the same colour.
 */
function dayClass(d: CalendarDayT | undefined): string {
  if (d === undefined) return '';
  if (d.outcomes.needsYou > 0) return 'st-needsyou';
  if (d.outcomes.failed > 0) return 'st-failed';
  if (d.outcomes.running > 0) return 'st-running';
  if (d.outcomes.completed > 0) return 'st-completed';
  // `other` is whatever the daemon could not group (today: `scheduled`), and
  // `stateClass` draws that with the same fallback.
  if (d.outcomes.cancelled > 0 || d.outcomes.other > 0) return 'st-cancelled';
  if (d.bookings > 0) return 'booking';
  if (d.humans > 0) return 'human';
  return '';
}

/** What a year cell says out loud — a count is not self-explanatory. */
function describeDay(d: CalendarDayT | undefined): string {
  if (d === undefined) return 'nothing scheduled';
  const parts: string[] = [];
  if (d.runs > 0) parts.push(`${d.runs} run${d.runs > 1 ? 's' : ''}`);
  if (d.bookings > 0) parts.push(`${d.bookings} booked`);
  if (d.humans > 0) parts.push(`${d.humans} calendar event${d.humans > 1 ? 's' : ''}`);
  if (d.outcomes.failed > 0) parts.push(`${d.outcomes.failed} failed`);
  if (d.outcomes.needsYou > 0) parts.push(`${d.outcomes.needsYou} waiting on you`);
  return parts.length > 0 ? parts.join(', ') : 'nothing scheduled';
}

/**
 * Twelve rows of day cells, fed by the per-day aggregate (S-64).
 *
 * Every cell carries a count and a colour and nothing else — that is the whole
 * bargain that makes a year view cheap. Clicking one selects the day, and the
 * panel fetches that day's real events.
 *
 * Layout is inline because this component ships no new stylesheet rules; the
 * COLOURS come from the existing `.cal-event` state classes, so the year grid
 * cannot drift away from the palette the rest of the calendar uses.
 */
function YearGrid({
  year,
  days,
  selectedTs,
  onSelect,
}: {
  year: number;
  days: CalendarDayT[];
  selectedTs: number | null;
  onSelect: (ts: number) => void;
}): JSX.Element {
  const byDay = new Map(days.map((d) => [d.day, d]));
  return (
    <div className="year-grid" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {Array.from({ length: MONTHS_IN_YEAR }, (_, m) => {
        const label = new Date(year, m, 1).toLocaleDateString(undefined, { month: 'short' });
        const lastDay = new Date(year, m + 1, 0).getDate();
        return (
          <div key={m} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="cal-dow" style={{ width: 46, padding: 0 }}>
              {label}
            </span>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${DAYS_IN_WIDEST_MONTH}, minmax(0, 1fr))`,
                gap: 3,
                flex: 1,
              }}
            >
              {Array.from({ length: DAYS_IN_WIDEST_MONTH }, (_, i) => {
                const dayNum = i + 1;
                // February's tail: a spacer, not a clickable day that does not exist.
                if (dayNum > lastDay) return <span key={dayNum} aria-hidden="true" />;
                const key = dayKey(year, m, dayNum);
                const row = byDay.get(key);
                const ts = new Date(year, m, dayNum).getTime();
                const total = row === undefined ? 0 : row.runs + row.bookings + row.humans;
                const label = `${new Date(ts).toLocaleDateString()}, ${describeDay(row)}`;
                return (
                  <button
                    key={dayNum}
                    className={`cal-event ${dayClass(row)}`}
                    style={{
                      ...YEAR_CELL,
                      border: row === undefined ? '1px solid var(--border)' : undefined,
                      outline: selectedTs === ts ? '2px solid var(--accent)' : undefined,
                    }}
                    data-testid={`year-day-${key}`}
                    title={label}
                    aria-label={label}
                    onClick={() => onSelect(ts)}
                  >
                    {total > 0 ? total : ''}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
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

/**
 * Everything booked on one day, in full.
 *
 * A month cell fits `MAX_PER_CELL` names and then said "+N more" — but the
 * button only selected the day, and the side panel it filled is a narrow
 * column that clips a name like "ASAP verify (temp)" to "ASAP verify (te…" and
 * never showed a time at all. So on a busy day there was no way to read what
 * was actually scheduled, or in what order. This is the full view: one row per
 * item, sorted by time, with the time, the state and the cost the panel had no
 * room for. Rows open the same per-event dialog they always did.
 */
function DayDialog({
  ts,
  events,
  onClose,
  onEvent,
  onBook,
}: {
  ts: number;
  events: CalendarEvent[];
  onClose: () => void;
  onEvent: (e: CalendarEvent) => void;
  onBook: () => void;
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const dayLabel = new Date(ts).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  // Sorted rather than left in whatever order the two halves of /calendar
  // arrived in: the point of this view is reading the day in sequence.
  const ordered = [...events].sort((a, b) => a.at - b.at);
  const runs = ordered.filter((e) => e.kind === 'run').length;
  const booked = ordered.filter((e) => e.kind === 'booking').length;
  const humans = ordered.filter((e) => e.kind === 'human').length;
  const spend = ordered.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);

  return (
    <div
      className="dialog-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${dayLabel}, ${ordered.length} items`}
      data-testid="day-dialog"
    >
      <div className="dialog wide" onClick={(e) => e.stopPropagation()}>
        <h3>{dayLabel}</h3>
        <div className="statrow mono">
          <span>
            {ordered.length} item{ordered.length === 1 ? '' : 's'}
          </span>
          {runs > 0 && <span>{runs} run{runs === 1 ? '' : 's'}</span>}
          {booked > 0 && <span>{booked} booked</span>}
          {humans > 0 && <span>{humans} from your calendar</span>}
          {spend > 0 && <span>${spend.toFixed(4)}</span>}
        </div>

        {ordered.length === 0 ? (
          <p className="hint">Nothing scheduled on this day.</p>
        ) : (
          <ul className="day-list">
            {ordered.map((ev) => (
              <li key={ev.id}>
                <button className="day-list-row" onClick={() => onEvent(ev)}>
                  <span className="mono day-list-time">{ev.allDay ? 'all day' : timeLabel(ev.at)}</span>
                  <span className="day-list-name" title={ev.name}>
                    {ev.name}
                  </span>
                  {ev.kind === 'run' ? (
                    <span className={`chip ${chipFor(ev.state!)}`}>{stateLabel(ev.state)}</span>
                  ) : (
                    <span className="chip">{ev.kind === 'human' ? 'Personal' : 'Booked'}</span>
                  )}
                  <span className="mono day-list-cost">
                    {ev.kind === 'run' ? `$${(ev.costUsd ?? 0).toFixed(4)}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="actions" style={{ marginTop: 16 }}>
          <button className="btn primary" onClick={onBook}>
            ＋ Book a run this day
          </button>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="honest-note">Runs execute when the machine is awake.</p>
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
              <span className={`chip ${chipFor(event.state!)}`}>{stateLabel(event.state)}</span>
              {event.outcomeReason && <span>reason: {event.outcomeReason}</span>}
              <span>${(event.costUsd ?? 0).toFixed(4)}</span>
            </>
          ) : (
            <span className="chip">Booked — future occurrence</span>
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

