/**
 * Drag/drop schedule moves (P2) as a hook, so CalendarView stays a reader.
 *
 * Sources are booking chips (booked occurrences carry the taskId; runs and
 * human events are never draggable). Targets are month cells and week
 * columns — never year cells (counts, not days) and never the day dialog.
 * Tabs unmount inactive views (App.tsx), so cross-tab drags cannot exist;
 * everything here happens inside one mounted calendar.
 *
 * Network discipline (P2.4): exactly one GET per dragstart (the schedule),
 * zero per dragover (computeMove is pure), one PATCH per drop. Preview text
 * updates only when it changes, so dragover does not rerender per event.
 */
import { useCallback, useRef, useState } from 'react';
import { api } from '../api';
import { computeMove, type MoveSource } from '../lib/drag-schedule';

export interface DragInfo {
  taskId: string;
  name: string;
  schedule: MoveSource | null;
  loadError: string | null;
}

export interface DropPreview {
  ts: number;
  text: string;
  /** ok/bad for decided previews, neutral while the schedule is still loading. */
  tone: 'ok' | 'bad' | 'neutral';
}

export interface MoveNotice {
  ok: boolean;
  text: string;
}

interface UndoEntry {
  taskId: string;
  name: string;
  prev: { kind: 'once' | 'rrule'; runAt?: number | null; rrule?: string | null; tz: string };
  /** The schedule as left by the move. Undo refuses when the live schedule
   *  no longer matches this — otherwise it would silently discard an edit
   *  made in Tasks after the move. */
  moved: { kind: string; runAt?: number | null; rrule?: string | null; tz: string };
}

export function useTaskDrag(opts: { onMoved: () => void; countOthers: (dayTs: number, taskId: string) => number }): {
  drag: DragInfo | null;
  preview: DropPreview | null;
  notice: MoveNotice | null;
  undo: UndoEntry | null;
  dismissNotice: () => void;
  clearUndo: () => void;
  doUndo: () => void;
  chipDrag: (taskId: string, name: string) => {
    draggable: true;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnd: () => void;
  };
  cellDrop: (dayTs: number) => {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: React.DragEvent) => void;
  };
} {
  const [drag, setDrag] = useState<DragInfo | null>(null);
  const [preview, setPreview] = useState<DropPreview | null>(null);
  const [notice, setNotice] = useState<MoveNotice | null>(null);
  const [undo, setUndo] = useState<UndoEntry | null>(null);
  const previewText = useRef<string | null>(null);
  const busy = useRef(false);
  // Last hovered day: dragover may run before the dragstart schedule fetch
  // lands (or vice versa) — whichever finishes second paints the preview, so
  // no fixed sleep is needed anywhere to order them.
  const hoverTs = useRef<number | null>(null);

  const dismissNotice = useCallback(() => {
    // Dismissing accepts the move: the notice and its Undo go together, so a
    // dismissed-then-forgotten Undo can never fire later out of context.
    setNotice(null);
    setUndo(null);
  }, []);
  const clearUndo = useCallback(() => setUndo(null), []);

  const paintPreview = useCallback(
    (schedule: MoveSource, taskId: string, dayTs: number): void => {
      const r = computeMove(schedule, dayTs, Date.now());
      const others = opts.countOthers(dayTs, taskId);
      const clash = others > 0 ? ` · ${others} other booking${others === 1 ? '' : 's'} that day` : '';
      // The ✓/! prefix carries the verdict as text, not just cell colour.
      const text = (r.ok ? '✓ ' : '! ') + (r.ok ? r.interpretation : r.message) + clash;
      if (text === previewText.current) return;
      previewText.current = text;
      setPreview({ ts: dayTs, text, tone: r.ok ? 'ok' : 'bad' });
    },
    [opts],
  );

  const chipDrag = useCallback(
    (taskId: string, name: string) => ({
      draggable: true as const,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.setData('text/clockwork-task', taskId);
        e.dataTransfer.effectAllowed = 'move';
        setNotice(null);
        // A pending Undo survives new drags: it names its task, and a
        // successful drop replaces it. Clearing it here would destroy a
        // still-valid recovery before any expiry.
        setDrag({ taskId, name, schedule: null, loadError: null });
        void api
          .taskSchedule(taskId)
          .then((s) => {
            const schedule: MoveSource = { kind: s.kind, rrule: s.rrule, runAt: s.runAt, tz: s.tz, version: s.version };
            setDrag((d) => (d && d.taskId === taskId ? { ...d, schedule } : d));
            // Whichever finishes second paints: if the pointer already waits
            // over a cell, the preview lands now instead of needing another
            // dragover event that may never come.
            if (hoverTs.current != null) paintPreview(schedule, taskId, hoverTs.current);
          })
          .catch((e: unknown) =>
            setDrag((d) =>
              d && d.taskId === taskId ? { ...d, loadError: e instanceof Error ? e.message : String(e) } : d,
            ),
          );
      },
      onDragEnd: () => {
        hoverTs.current = null;
        setDrag(null);
        setPreview(null);
        previewText.current = null;
      },
    }),
    [paintPreview],
  );

  const previewFor = useCallback(
    (dayTs: number): void => {
      if (!drag || !drag.schedule) return;
      paintPreview(drag.schedule, drag.taskId, dayTs);
    },
    [drag, paintPreview],
  );

  const cellDrop = useCallback(
    (dayTs: number) => ({
      onDragOver: (e: React.DragEvent) => {
        if (!drag) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        hoverTs.current = dayTs;
        if (!drag.schedule) {
          if (previewText.current !== 'reading') {
            previewText.current = 'reading';
            setPreview({ ts: dayTs, text: drag.loadError ? `Could not read this job's schedule: ${drag.loadError}` : 'Reading schedule…', tone: 'neutral' });
          }
          return;
        }
        previewFor(dayTs);
      },
      onDragLeave: () => {
        hoverTs.current = null;
        previewText.current = null;
        setPreview((p) => (p && p.ts === dayTs ? null : p));
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        hoverTs.current = null;
        if (!drag?.schedule || busy.current) return;
        const taskId = drag.taskId;
        const name = drag.name;
        const prevSource = drag.schedule;
        busy.current = true;
        const r = computeMove(prevSource, dayTs, Date.now());
        if (!r.ok) {
          busy.current = false;
          setPreview(null);
          previewText.current = null;
          setNotice({ ok: false, text: `Couldn't move this job — ${r.message}` });
          return;
        }
        void api
          .patchTask(taskId, { schedule: r.patch.schedule, version: r.patch.version })
          .then(() => {
            // Undo restores a previous once/rrule. A queue landing has no
            // previous schedule to restore (queue rows carry no rule), so
            // those moves offer no Undo — the notice says what happened.
            if (prevSource.kind === 'once' || prevSource.kind === 'rrule') {
              const moved = r.patch.schedule;
              setUndo({
                taskId,
                name,
                prev: {
                  kind: prevSource.kind,
                  runAt: prevSource.runAt,
                  rrule: prevSource.rrule,
                  tz: prevSource.tz,
                },
                moved: {
                  kind: moved.kind,
                  runAt: moved.kind === 'once' ? moved.runAt : null,
                  rrule: moved.kind === 'rrule' ? moved.rrule : null,
                  tz: moved.tz,
                },
              });
            } else {
              setUndo(null);
            }
            setNotice({ ok: true, text: `${r.interpretation}${r.warnings.length ? ` — ${r.warnings.join(' ')}` : ''}` });
            opts.onMoved();
          })
          .catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            setNotice({
              ok: false,
              text: /409/.test(msg) ? 'That job changed elsewhere — reloaded; try the move again.' : `Move failed: ${msg}`,
            });
            opts.onMoved();
          })
          .finally(() => {
            busy.current = false;
            setDrag(null);
            setPreview(null);
            previewText.current = null;
          });
      },
    }),
    [drag, previewFor, opts],
  );

  const doUndo = useCallback(() => {
    const u = undo;
    if (!u || busy.current) return;
    busy.current = true;
    void api
      .taskSchedule(u.taskId)
      .then((fresh) => {
        // Refuse to undo over an intervening edit: the fresh schedule must
        // still read as the move left it, or restoring the snapshot would
        // silently discard someone's (or something's) newer change.
        const same =
          fresh.kind === u.moved.kind &&
          (fresh.runAt ?? null) === (u.moved.runAt ?? null) &&
          (fresh.rrule ?? null) === (u.moved.rrule ?? null) &&
          fresh.tz === u.moved.tz;
        if (!same) {
          setNotice({ ok: false, text: `“${u.name}” changed since the move — not undoing over your edit. Move it again from the calendar if needed.` });
          setUndo(null);
          return;
        }
        return api
          .patchTask(u.taskId, { schedule: { kind: u.prev.kind, runAt: u.prev.runAt ?? null, rrule: u.prev.rrule ?? null, tz: u.prev.tz }, version: fresh.version })
          .then(() => {
            setNotice({ ok: true, text: `Move undone — “${u.name}” is back on its previous schedule.` });
            setUndo(null);
            opts.onMoved();
          });
      })
      .catch((e: unknown) => setNotice({ ok: false, text: `Undo failed: ${e instanceof Error ? e.message : String(e)}` }))
      .finally(() => {
        busy.current = false;
      });
  }, [undo, opts]);

  return { drag, preview, notice, undo, dismissNotice, clearUndo, doUndo, chipDrag, cellDrop };
}
