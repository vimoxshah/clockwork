/**
 * Composer (T-123): booking with once / recurring (daily · weekly+day+time ·
 * monthly) / ASAP-queue modes, calendar date prefill, inline validation.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ComposerPrefill } from './CalendarView';

const p2 = (n: number): string => String(n).padStart(2, '0');

function defaultSlot(): string {
  const d = new Date(Date.now() + 60 * 60_000);
  d.setMinutes(0, 0, 0);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:00`;
}

export default function ComposerView({
  onDone,
  prefill,
}: {
  onDone: () => void;
  prefill: ComposerPrefill | null;
}): JSX.Element {
  const [profiles, setProfiles] = useState<Array<{ id: string; slug: string; name: string }>>([]);
  const [form, setForm] = useState(() => ({
    name: '',
    prompt: '',
    repoPath: '',
    profileId: '',
    permissionMode: 'acceptEdits',
    maxUsd: '2',
    maxTurns: '50',
    timeoutSec: '3600',
    kind: 'once' as 'once' | 'rrule' | 'queue',
    runAtLocal: prefill?.runAtLocal ?? defaultSlot(),
    rruleFreq: 'WEEKLY' as 'DAILY' | 'WEEKLY' | 'MONTHLY',
    rruleByDay: 'MO',
    rruleTime: '09:00',
    monthlyDay: String(new Date().getDate()),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Calendar prefill arrives after mount when user clicks "Book a run this day".
  useEffect(() => {
    if (prefill?.runAtLocal) {
      setForm((f) => ({ ...f, kind: 'once', runAtLocal: prefill.runAtLocal }));
    }
  }, [prefill]);

  useEffect(() => {
    void api.profiles().then(setProfiles).catch(() => {});
  }, []);

  const submit = async (): Promise<void> => {
    setError(null);
    const maxUsdN = Number(form.maxUsd);
    const maxTurnsN = Number(form.maxTurns);
    const timeoutSecN = Number(form.timeoutSec);
    if (!form.prompt.trim()) return setError('A prompt is required.');
    if (!Number.isFinite(maxUsdN) || maxUsdN <= 0) return setError('Budget must be a positive number.');
    if (!Number.isInteger(maxTurnsN) || maxTurnsN < 1) return setError('Max turns must be a positive integer.');
    if (!Number.isInteger(timeoutSecN) || timeoutSecN < 30) return setError('Timeout must be at least 30 seconds.');

    let schedule: Record<string, unknown>;
    if (form.kind === 'once') {
      const ts = new Date(form.runAtLocal).getTime();
      if (!Number.isFinite(ts)) return setError('Pick a valid date and time.');
      schedule = { kind: 'once', runAt: ts, tz: form.tz };
    } else if (form.kind === 'queue') {
      schedule = { kind: 'queue', tz: form.tz };
    } else {
      const [hh, mm] = form.rruleTime.split(':').map(Number);
      if (!Number.isInteger(hh) || !Number.isInteger(mm)) return setError('Pick a valid recurrence time.');
      let rrule: string;
      if (form.rruleFreq === 'DAILY') rrule = `FREQ=DAILY;BYHOUR=${hh};BYMINUTE=${mm}`;
      else if (form.rruleFreq === 'WEEKLY') rrule = `FREQ=WEEKLY;BYDAY=${form.rruleByDay};BYHOUR=${hh};BYMINUTE=${mm}`;
      else {
        const dom = Number(form.monthlyDay);
        if (!Number.isInteger(dom) || dom < 1 || dom > 28) return setError('Monthly day must be 1–28 (safe across months).');
        rrule = `FREQ=MONTHLY;BYMONTHDAY=${dom};BYHOUR=${hh};BYMINUTE=${mm}`;
      }
      schedule = { kind: 'rrule', rrule, tz: form.tz };
    }

    setBusy(true);
    try {
      await api.createTask({
        name: form.name.trim() || 'Untitled task',
        prompt: form.prompt,
        repoPath: form.repoPath.trim() || undefined,
        profileId: form.profileId || undefined,
        permissionMode: form.permissionMode,
        budget: { maxUsd: maxUsdN, maxTurns: maxTurnsN, timeoutSec: timeoutSecN },
        missedPolicy: 'run-late',
        overlapPolicy: 'skip',
        retryOnTransient: false,
        context: { files: [] },
        delivery: { osNotify: true },
        schedule,
      });
      onDone();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const days = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  const dayNames: Record<string, string> = { MO: 'Mondays', TU: 'Tuesdays', WE: 'Wednesdays', TH: 'Thursdays', FR: 'Fridays', SA: 'Saturdays', SU: 'Sundays' };

  return (
    <div className="form-card">
      <h2 style={{ marginTop: 0 }}>Book a run</h2>

      <label className="f" htmlFor="c-name">Task name</label>
      <input id="c-name" type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Nightly TODO digest" />

      <label className="f" htmlFor="c-prompt">Prompt — what should the agent do?</label>
      <textarea id="c-prompt" value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} data-testid="prompt" />

      <label className="f" htmlFor="c-repo">Repository path (empty = scratch task)</label>
      <input id="c-repo" type="text" value={form.repoPath} onChange={(e) => setForm({ ...form, repoPath: e.target.value })} placeholder="/Users/you/dev/my-repo" />

      <div className="row2">
        <div>
          <label className="f" htmlFor="c-profile">Agent profile</label>
          <select id="c-profile" value={form.profileId} onChange={(e) => setForm({ ...form, profileId: e.target.value })}>
            <option value="">Generalist (default)</option>
            {profiles.filter((p) => p.slug !== 'generalist').map((p) => (
              <option key={p.id} value={p.id}>@{p.slug}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="f" htmlFor="c-mode">Permission mode</label>
          <select id="c-mode" value={form.permissionMode} onChange={(e) => setForm({ ...form, permissionMode: e.target.value })}>
            <option value="plan">plan (dry-run)</option>
            <option value="acceptEdits">acceptEdits</option>
          </select>
        </div>
      </div>

      <div className="row3">
        <div>
          <label className="f" htmlFor="c-usd">Budget USD (soft cap)</label>
          <input id="c-usd" className="mono" type="number" min="0.5" step="0.5" value={form.maxUsd} onChange={(e) => setForm({ ...form, maxUsd: e.target.value })} />
        </div>
        <div>
          <label className="f" htmlFor="c-turns">Max turns (hard)</label>
          <input id="c-turns" className="mono" type="number" min="1" value={form.maxTurns} onChange={(e) => setForm({ ...form, maxTurns: e.target.value })} />
        </div>
        <div>
          <label className="f" htmlFor="c-timeout">Timeout s (hard)</label>
          <input id="c-timeout" className="mono" type="number" min="30" value={form.timeoutSec} onChange={(e) => setForm({ ...form, timeoutSec: e.target.value })} />
        </div>
      </div>

      <div className="row2">
        <div>
          <label className="f" htmlFor="c-kind">Schedule</label>
          <select id="c-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as typeof form.kind })}>
            <option value="once">One-off</option>
            <option value="rrule">Recurring</option>
            <option value="queue">ASAP — work the queue</option>
          </select>
        </div>
        {form.kind === 'once' && (
          <div>
            <label className="f" htmlFor="c-when">When</label>
            <input id="c-when" type="datetime-local" className="mono" value={form.runAtLocal} onChange={(e) => setForm({ ...form, runAtLocal: e.target.value })} />
          </div>
        )}
        {form.kind === 'queue' && (
          <div style={{ alignSelf: 'end' }}>
            <p className="hint" style={{ margin: 0 }}>Starts as soon as a slot and its repo are free.</p>
          </div>
        )}
      </div>

      {form.kind === 'rrule' && (
        <>
          <label className="f" htmlFor="c-freq">Repeats</label>
          <select id="c-freq" value={form.rruleFreq} onChange={(e) => setForm({ ...form, rruleFreq: e.target.value as typeof form.rruleFreq })}>
            <option value="DAILY">Daily</option>
            <option value="WEEKLY">Weekly</option>
            <option value="MONTHLY">Monthly</option>
          </select>
          {(form.rruleFreq === 'WEEKLY' || form.rruleFreq === 'MONTHLY') && (
            <div className="row2">
              {form.rruleFreq === 'WEEKLY' ? (
                <div>
                  <label className="f" htmlFor="c-day">On</label>
                  <select id="c-day" value={form.rruleByDay} onChange={(e) => setForm({ ...form, rruleByDay: e.target.value })}>
                    {days.map((d) => (
                      <option key={d} value={d}>{dayNames[d]}</option>
                    ))}
                  </select>
                </div>
              ) : (
                <div>
                  <label className="f" htmlFor="c-dom">On day of month (1–28)</label>
                  <input id="c-dom" className="mono" type="number" min="1" max="28" value={form.monthlyDay} onChange={(e) => setForm({ ...form, monthlyDay: e.target.value })} />
                </div>
              )}
              <div>
                <label className="f" htmlFor="c-rtime">At</label>
                <input id="c-rtime" type="time" className="mono" value={form.rruleTime} onChange={(e) => setForm({ ...form, rruleTime: e.target.value })} />
              </div>
            </div>
          )}
        </>
      )}

      <p className="hint">
        Runs fire when this Mac is awake. For overnight jobs, plug in — Clockwork arms keep-awake
        and reports sleep-caused misses honestly.
      </p>
      {error && <div className="error-banner" role="alert" data-testid="composer-error">{error}</div>}
      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <button className="btn primary" disabled={busy || !form.prompt.trim()} onClick={() => void submit()}>
          {busy ? 'Booking…' : 'Book it'}
        </button>
        <button className="btn" onClick={onDone} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
