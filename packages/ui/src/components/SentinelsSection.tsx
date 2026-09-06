/**
 * F4 sentinel-worker, inside Tasks.
 *
 * A sentinel is a cheap run on a tight cadence that watches for one thing. Its
 * report summary is matched — case-insensitively, as a substring — against the
 * trip expression; on a match it books the expensive worker run through an
 * existing event trigger, then holds off for the cooldown.
 *
 * TWO REFUSALS THE FORM PRE-EMPTS RATHER THAN DISCOVERS
 *   1. `Sentinels.create` 422s when the chosen trigger fires the watch task
 *      itself ("a sentinel cannot book its own run", sentinel.ts:122), so
 *      those triggers are not offered.
 *   2. There is no trigger at all → nothing to book through. The form says so
 *      and points at where triggers are made instead of failing on submit.
 *
 * NO EDIT CONTROL, ON PURPOSE. The daemon exposes create/list/delete/trips and
 * nothing else (api.ts:944-975), so an "edit" button could only ever fail.
 * Changing a sentinel means deleting it and creating it again, and the list
 * says that where a user would look for the missing button.
 */
import { useState } from 'react';
import { api, type SentinelT, type TaskViewT } from '../api';
import { useAsync } from '../useAsync';
import { Select, SelectValue, SelectTrigger, SelectContent, SelectItem } from './ui/select';
import { ConfirmDialog } from './ConfirmDialog';
import { fmtDuration, fmtWhen, openRunInInbox, openSettings } from './workforce-common';

interface TriggerT {
  id: string;
  name: string;
  source: string;
  taskId: string;
  enabled: boolean;
}

/** The daemon's own `sentinel_trips.reason` vocabulary (sentinel.ts:22-33). */
const TRIP_REASON: Record<string, string> = {
  disabled: 'the sentinel is switched off — nothing was booked',
  no_match: 'no match — the report summary did not contain the trip text',
  cooldown: 'matched, but inside the cooldown — nothing was booked',
  trigger_disabled: 'the trigger is switched off — nothing was booked',
  trigger_missing: 'the trigger no longer exists — nothing was booked',
  policy_violation: 'a policy rule refused the worker run — nothing was booked',
};

export function explainTrip(reason: string | null, tripped: boolean): string {
  if (tripped) return 'tripped — the worker run was booked';
  if (reason && TRIP_REASON[reason]) return TRIP_REASON[reason];
  return reason ? `did not book: ${reason}` : 'did not book';
}

/**
 * The triggers a sentinel watching `sentinelTaskId` may book through.
 *
 * A trigger that fires the watch task itself makes the sentinel book its own
 * run — an infinite loop the daemon refuses with a 422 (sentinel.ts:122). It
 * is left out of the picker rather than offered and then rejected.
 */
export function usableTriggersFor<T extends { taskId: string }>(triggers: T[], sentinelTaskId: string): T[] {
  return triggers.filter((t) => t.taskId !== sentinelTaskId);
}

const MAX_COOLDOWN_SEC = 86_400;

export default function SentinelsSection({ version, tasks }: { version: number; tasks: TaskViewT[] }): JSX.Element {
  const sentinels = useAsync(() => api.sentinels(), [version]);
  const triggers = useAsync(() => api.triggers(), [version]);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SentinelT | null>(null);

  const rows = sentinels.data?.sentinels ?? [];
  const trgs: TriggerT[] = (triggers.data ?? []) as TriggerT[];
  const taskName = (id: string): string | null => tasks.find((t) => t.id === id)?.name ?? null;

  const announce = (msg: string): void => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 5000);
  };

  return (
    <div>
      <div className="tasks-toolbar">
        <div className="grow">
          <h3 className="section-title" style={{ margin: 0 }}>Sentinels</h3>
          <p className="hint" style={{ marginTop: 2 }}>
            A cheap check on a tight cadence that books an expensive run when it finds something. Clockwork
            matches the trip text against the watch run’s report summary, and books the worker through one of
            your event triggers.
          </p>
        </div>
        <button className="btn small" onClick={() => { sentinels.reload(); triggers.reload(); }} aria-label="Refresh sentinels">⟳</button>
      </div>

      {notice && <div className="ok-banner">{notice}</div>}
      {triggers.error && (
        <div className="error-banner" role="alert">
          Couldn’t load triggers: {triggers.error} — a sentinel cannot be created without one.
          <div><button className="btn small" style={{ marginTop: 8 }} onClick={triggers.reload}>Retry</button></div>
        </div>
      )}

      {!triggers.loading && !triggers.error && trgs.length === 0 ? (
        <div className="empty" data-testid="sentinel-no-triggers">
          A sentinel books its worker run through an event trigger, and you have none yet.
          <p className="hint">
            Create one in Settings → Event triggers, pointing at the task the sentinel should book. Then come
            back and the form appears here.
          </p>
          <button className="btn small" style={{ marginTop: 8 }} onClick={openSettings}>Open Settings</button>
        </div>
      ) : (
        <CreateSentinelForm
          tasks={tasks}
          triggers={trgs}
          disabled={triggers.loading}
          onCreated={(msg) => {
            announce(msg);
            sentinels.reload();
          }}
        />
      )}

      {sentinels.loading && <div className="state-line"><span className="spinner" /> Loading sentinels…</div>}
      {sentinels.error && (
        <div className="error-banner" role="alert">
          Couldn’t load sentinels: {sentinels.error}
          <div><button className="btn small" style={{ marginTop: 8 }} onClick={sentinels.reload}>Retry</button></div>
        </div>
      )}
      {!sentinels.loading && !sentinels.error && rows.length === 0 && (
        <div className="empty" data-testid="sentinel-empty">
          No sentinels yet.
          <p className="hint">
            Use one when a check is cheap and the work is not: a five-minute “is the build red?” run that books
            the hour-long investigation only when the answer is yes. The form above makes the first one.
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <p className="hint">
          A sentinel cannot be edited: the daemon offers create, list, delete and history only. Change one by
          deleting it and creating it again.
        </p>
      )}

      {rows.map((s) => {
        const trigger = trgs.find((t) => t.id === s.triggerId) ?? null;
        return (
          <SentinelRow
            key={s.id}
            sentinel={s}
            watchName={taskName(s.sentinelTaskId)}
            trigger={trigger}
            workerName={trigger ? taskName(trigger.taskId) : null}
            onDelete={() => setDeleting(s)}
          />
        );
      })}

      {deleting && (
        <ConfirmDialog
          title={`Delete sentinel “${deleting.name}”?`}
          body="Its trip history goes with it. The watch task, the trigger and the worker task are all left alone — only the link between them is removed."
          confirmLabel="Delete sentinel"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.sentinelDelete(deleting.id);
            setDeleting(null);
            announce(`Sentinel “${deleting.name}” deleted.`);
            sentinels.reload();
          }}
        />
      )}
    </div>
  );
}

function SentinelRow({
  sentinel,
  watchName,
  trigger,
  workerName,
  onDelete,
}: {
  sentinel: SentinelT;
  watchName: string | null;
  trigger: TriggerT | null;
  workerName: string | null;
  onDelete: () => void;
}): JSX.Element {
  const [showTrips, setShowTrips] = useState(false);
  return (
    <div className="tasklist-row" style={{ display: 'block' }} data-testid="sentinel-row">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <strong className="grow">{sentinel.name}</strong>
        {!sentinel.enabled && <span className="chip failed">off</span>}
        <button className="btn small" onClick={() => setShowTrips((s) => !s)} data-testid="sentinel-trips-toggle">
          {showTrips ? 'Hide checks' : 'Recent checks'}
        </button>
        <button className="btn danger small" onClick={onDelete} aria-label={`Delete ${sentinel.name}`}>Delete</button>
      </div>

      <div className="hint" style={{ marginTop: 4 }}>
        watches {watchName ?? <span className="mono">{sentinel.sentinelTaskId}</span>}
        {' · books '}
        {workerName ?? <span className="mono">{trigger?.taskId ?? 'an unknown task'}</span>}
        {' through '}
        {trigger ? trigger.name : <span className="mono">{sentinel.triggerId}</span>}
      </div>
      <div className="hint" style={{ marginTop: 2 }}>
        trips when the report summary contains <span className="mono">“{sentinel.tripExpr}”</span>
        {' · '}cooldown {fmtDuration(sentinel.cooldownSec)}
        {' · '}last trip {fmtWhen(sentinel.lastTrippedAt)}
      </div>

      {trigger && !trigger.enabled && (
        <div className="hint" data-testid="sentinel-trigger-off">
          The trigger “{trigger.name}” is switched off, so a match books nothing. Turn it back on in Settings →
          Event triggers.
        </div>
      )}
      {!sentinel.enabled && (
        <div className="hint">
          This sentinel still records every check, but it never books. There is no route to switch a sentinel
          back on — delete it and create it again.
        </div>
      )}
      {showTrips && <TripList sentinelId={sentinel.id} />}
    </div>
  );
}

function TripList({ sentinelId }: { sentinelId: string }): JSX.Element {
  const trips = useAsync(() => api.sentinelTrips(sentinelId, 50), [sentinelId]);
  const rows = trips.data?.trips ?? [];
  return (
    <div style={{ marginTop: 8 }}>
      {trips.loading && <div className="state-line"><span className="spinner" /> Loading checks…</div>}
      {trips.error && <div className="error-banner" role="alert">Couldn’t load checks: {trips.error}</div>}
      {!trips.loading && !trips.error && rows.length === 0 && (
        <p className="hint" data-testid="sentinel-no-trips">
          No checks recorded yet. One is written every time the watch task finishes a run — including the runs
          that found nothing, so you can tell “never tripped” from “never ran”.
        </p>
      )}
      {rows.map((t) => (
        <div key={t.id} className="hint" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
          <span className={`chip ${t.tripped ? 'completed' : ''}`}>{t.tripped ? 'tripped' : 'quiet'}</span>
          <span className="mono">{fmtWhen(t.at)}</span>
          <span className="grow">{explainTrip(t.reason, t.tripped)}</span>
          {t.runId && (
            <button className="btn small" onClick={() => openRunInInbox(t.runId!)}>Watch run</button>
          )}
          {t.workerRunId && (
            <button className="btn small" onClick={() => openRunInInbox(t.workerRunId!)}>Worker run</button>
          )}
        </div>
      ))}
    </div>
  );
}

function CreateSentinelForm({
  tasks,
  triggers,
  disabled,
  onCreated,
}: {
  tasks: TaskViewT[];
  triggers: TriggerT[];
  disabled: boolean;
  onCreated: (msg: string) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [sentinelTaskId, setSentinelTaskId] = useState('');
  const [triggerId, setTriggerId] = useState('');
  const [tripExpr, setTripExpr] = useState('');
  const [cooldown, setCooldown] = useState('3600');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // A trigger that fires the watch task itself would have the sentinel book its
  // own run; the daemon refuses that outright, so it is never offered.
  const usable = usableTriggersFor(triggers, sentinelTaskId);
  const selfBooking = triggers.length - usable.length;
  const cooldownSec = Number(cooldown);
  const cooldownOk = Number.isInteger(cooldownSec) && cooldownSec >= 0 && cooldownSec <= MAX_COOLDOWN_SEC;
  const ready = Boolean(name.trim() && sentinelTaskId && triggerId && tripExpr.trim() && cooldownOk);

  const create = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const s = await api.sentinelCreate({
        name: name.trim(),
        sentinelTaskId,
        triggerId,
        tripExpr: tripExpr.trim(),
        cooldownSec,
      });
      setName('');
      setTripExpr('');
      onCreated(`Sentinel “${s.name}” created — it checks every time “${tasks.find((t) => t.id === sentinelTaskId)?.name ?? 'the watch task'}” finishes a run.`);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tasklist-row" style={{ display: 'block' }}>
      <strong>New sentinel</strong>
      {tasks.length === 0 ? (
        <p className="hint" data-testid="sentinel-no-tasks">
          You have no tasks yet, so there is nothing to watch. Create the cheap check as a task first (the
          “+ New task” tab), then bind it here.
        </p>
      ) : (
        <>
          <div className="row3" style={{ alignItems: 'end', marginTop: 8 }}>
            <div>
              <label className="f" htmlFor="snt-name">Name</label>
              <input
                id="snt-name"
                type="text"
                value={name}
                maxLength={80}
                placeholder="Build went red"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label className="f">Watch task (the cheap check)</label>
              <Select
                value={sentinelTaskId || '__none__'}
                onValueChange={(v) => {
                  const next = v === '__none__' ? '' : v;
                  setSentinelTaskId(next);
                  // the chosen trigger may have just become a self-booking one
                  if (triggerId && triggers.find((t) => t.id === triggerId)?.taskId === next) setTriggerId('');
                }}
              >
                <SelectTrigger aria-label="Watch task" data-testid="sentinel-task-select">
                  <SelectValue placeholder="— pick a task —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— pick a task —</SelectItem>
                  {tasks.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="f">Book through trigger</label>
              <Select value={triggerId || '__none__'} onValueChange={(v) => setTriggerId(v === '__none__' ? '' : v)}>
                <SelectTrigger aria-label="Trigger" data-testid="sentinel-trigger-select">
                  <SelectValue placeholder="— pick a trigger —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— pick a trigger —</SelectItem>
                  {usable.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                      {t.enabled ? '' : ' — switched off'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="f" htmlFor="snt-expr">Trip when the summary contains</label>
              <input
                id="snt-expr"
                type="text"
                value={tripExpr}
                maxLength={200}
                placeholder="build failed"
                onChange={(e) => setTripExpr(e.target.value)}
              />
            </div>
            <div>
              <label className="f" htmlFor="snt-cool">Cooldown (seconds)</label>
              <input
                id="snt-cool"
                type="number"
                min={0}
                max={MAX_COOLDOWN_SEC}
                value={cooldown}
                onChange={(e) => setCooldown(e.target.value)}
              />
            </div>
            <button className="btn primary" disabled={busy || disabled || !ready} data-testid="sentinel-create" onClick={() => void create()}>
              Add sentinel
            </button>
          </div>

          <p className="hint">
            The match is a case-insensitive substring of the watch run’s report summary — no patterns, no regex.
            After a trip, the sentinel books nothing for {fmtDuration(cooldownOk ? cooldownSec : 3600)}.
          </p>
          {!cooldownOk && (
            <p className="hint" data-testid="sentinel-cooldown-bad">
              Cooldown must be a whole number of seconds between 0 and {MAX_COOLDOWN_SEC} (24h) — the daemon
              refuses anything else.
            </p>
          )}
          {selfBooking > 0 && (
            <p className="hint" data-testid="sentinel-self-booking">
              {selfBooking} trigger{selfBooking === 1 ? ' is' : 's are'} not listed: {selfBooking === 1 ? 'it fires' : 'they fire'} the
              watch task itself, and a sentinel that books its own run is a loop the daemon refuses.
            </p>
          )}
          {triggers.length > 0 && usable.length === 0 && (
            <p className="hint">
              No trigger can book for this watch task. Pick a different task, or add a trigger in Settings that
              fires the task you want booked.
            </p>
          )}
          <p className="hint">
            A sentinel arrives switched on. There is no route to change one afterwards, so check the trip text
            before you add it.
          </p>
        </>
      )}
      {err && <div className="error-banner" role="alert">{err}</div>}
    </div>
  );
}
