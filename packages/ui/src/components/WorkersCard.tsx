/**
 * Workers card (P4): the fleet on one screen. Pairing is a human-driven
 * ceremony in three visible steps — paste the worker's pubkey, hand the
 * nonce to the worker, approve AFTER it claims — and the bearer token
 * appears exactly once for copying, never again.
 *
 * Task pins live here too (not in the composer): pick a task, pick a
 * worker (or local), required waits while preferred falls back. The current
 * pin shows beside each choice because a pin you cannot see is a pin you
 * cannot reason about on a sleeping-laptop night.
 *
 * Exported for the same reason DeliveryCard and GithubCard are — the UI
 * test drives this card alone.
 */
import { useState } from 'react';
import { api, type TaskViewT } from '../api';
import { useAsync } from '../useAsync';
import { registerFeatureSurface } from './featureSurfaces';

registerFeatureSurface({ key: 'multi_machine', tab: 'settings', where: 'Settings › Workers', anchorId: 'workers' });

interface WorkerT {
  id: string;
  name: string;
  platform: string | null;
  status: string;
  online: number;
  last_heartbeat: number | null;
  created_at: number;
  onlineComputed: boolean;
}

export function WorkersCard({ version }: { version: number }): JSX.Element {
  const tasksQ = useAsync(() => api.tasks(), [version]);
  const tasks: TaskViewT[] = tasksQ.data ?? [];
  const ws = useAsync(() => api.workers(), [version]);
  const [name, setName] = useState('');
  const [pubkey, setPubkey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState<{ workerId: string; workerName: string; nonce: string; expiresAt: number } | null>(null);
  const [token, setToken] = useState<{ workerId: string; workerName: string; token: string } | null>(null);
  const [pinTask, setPinTask] = useState('');
  const [pinWorker, setPinWorker] = useState('');
  const [pinRequired, setPinRequired] = useState(true);

  const reload = (): void => ws.reload();

  const run = async (fn: () => Promise<unknown>, okMsg: string): Promise<void> => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      await fn();
      setMsg(okMsg);
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pair = async (): Promise<void> => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    setNonce(null);
    try {
      const workerName = name.trim();
      const r = await api.pairInit({ name: workerName, pubkeyHex: pubkey.trim() });
      setNonce({ ...r, workerName });
      setName('');
      setPubkey('');
      setMsg('Pairing started — hand the nonce to the worker, then approve once it claims.');
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const approve = async (id: string, workerName: string): Promise<void> => {
    if (!confirm(`Approve worker “${workerName}”? Its signature verified — this issues its bearer token.`)) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    setToken(null);
    try {
      const r = await api.approveWorker(id);
      setToken({ workerId: id, workerName, token: r.token });
      setMsg('Approved. Copy the token below into the worker configuration — it shows exactly once.');
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const savePin = async (): Promise<void> => {
    if (!pinTask) return;
    await run(
      () => api.patchTask(pinTask, { workerPin: pinWorker || null, workerRequired: pinRequired, version: tasks.find((t) => t.id === pinTask)?.version }),
      pinWorker ? 'Pinned.' : 'Unpinned — runs locally again.',
    );
  };

  const workers: WorkerT[] = ws.data?.workers ?? [];
  const ago = (ts: number | null): string => {
    if (!ts) return 'never';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
  };

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        Another Clockwork daemon — a Mini, a homelab box — that pulls jobs and runs them under its own
        sandbox. Pin overnight jobs to the always-on machine; keep afternoons local. Workers reach
        this daemon over your own tunnel (Tailscale, WireGuard); there is no Clockwork relay.
      </p>
      <ol className="hint" style={{ margin: '0 0 8px 18px', padding: 0 }}>
        <li>1. Paste the worker&apos;s pubkey below to start pairing.</li>
        <li>2. Hand the shown nonce to the worker so it can claim.</li>
        <li>3. Approve below — only after the worker claimed. A signature alone never earns a token.</li>
      </ol>
      {ws.error && (
        <div className="error-banner" role="alert">
          Couldn’t load workers: {ws.error}
        </div>
      )}
      {workers.length === 0 && !ws.loading ? (
        <p className="hint">No workers paired. Overnight jobs wait for a machine that never sleeps — this is where it joins.</p>
      ) : (
        <div>
          {workers.map((w) => (
            <div key={w.id} className="tasklist-row" data-testid={`worker-${w.id}`}>
              <div className="grow">
                <strong>{w.name}</strong>{' '}
                <span className={`chip ${w.status === 'paired' ? (w.onlineComputed ? '' : 'failed') : ''}`}>
                  {w.status === 'paired' ? (w.onlineComputed ? 'online' : 'silent') : w.status}
                </span>{' '}
                <span className="hint">
                  {w.platform ?? 'unknown platform'} · heartbeat {ago(w.last_heartbeat)}
                </span>
              </div>
              <div className="cred-actions">
                {w.status === 'pending' && (
                  <button className="btn small primary" disabled={busy} onClick={() => void approve(w.id, w.name)} data-testid={`worker-approve-${w.id}`}>
                    Approve
                  </button>
                )}
                {w.status === 'paired' && (
                  <button
                    className="btn small danger"
                    disabled={busy}
                    onClick={() => {
                      if (confirm(`Revoke worker “${w.name}”? Its token dies now. Queued jobs come home to this Mac; jobs it already pulled fail as worker_lost.`)) {
                        void run(() => api.revokeWorker(w.id), 'Revoked.');
                      }
                    }}
                  >
                    Revoke
                  </button>
                )}
                <button
                  className="btn small danger"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`Remove worker “${w.name}”? Required pins wait on nothing until you re-pin; preferred pins fall back local.`)) {
                      void run(() => api.removeWorker(w.id), 'Removed.');
                    }
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {token && (
        <div className="ok-banner" data-testid="worker-token-once" role="alert">
          Bearer token for {token.workerName} (copy now — never shown again):
          <div>
            <code className="mono" style={{ userSelect: 'all' }}>
              {token.token}
            </code>
          </div>
          <button className="btn small" style={{ marginTop: 6 }} onClick={() => setToken(null)}>
            I copied it — hide
          </button>
        </div>
      )}
      {nonce && (
        <div className="ok-banner" data-testid="worker-nonce" role="status">
          Nonce for {nonce.workerName} to claim with (10 minutes, single use):
          <div>
            <code className="mono" style={{ userSelect: 'all' }}>
              {nonce.nonce}
            </code>
          </div>
          <button className="btn small" style={{ marginTop: 6 }} onClick={() => setNonce(null)}>
            Dismiss
          </button>
        </div>
      )}
      <div className="cred-row">
        <label className="f cred-label" htmlFor="worker-name">
          Pair new worker
        </label>
        <input
          id="worker-name"
          className="cred-field"
          type="text"
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Mac Mini (always-on)"
          data-testid="worker-name-input"
        />
        <input
          id="worker-pubkey"
          aria-label="Worker public key (DER hex)"
          className="cred-field"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={pubkey}
          onChange={(e) => setPubkey(e.target.value)}
          placeholder="Worker ed25519 pubkey (DER hex — from clockworkd worker-key)"
          data-testid="worker-pubkey-input"
          style={{ marginTop: 6 }}
        />
        <div className="hint cred-hint">Three steps, all visible above: paste the key to start, hand over the nonce, approve after the worker claims.</div>
        <div className="cred-actions">
          <button className="btn small primary" disabled={busy || !name.trim() || !pubkey.trim()} onClick={() => void pair()} data-testid="worker-pair-button">
            {busy ? 'Starting…' : 'Start pairing'}
          </button>
        </div>
      </div>
      <div className="cred-row">
        <label className="f cred-label" htmlFor="worker-pin-task">
          Pin a task to a worker
        </label>
        <select
          id="worker-pin-task"
          className="cred-field"
          value={pinTask}
          onChange={(e) => setPinTask(e.target.value)}
          data-testid="worker-pin-task"
        >
          <option value="">Pick a task…</option>
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.workerPin ? ` (pinned: ${workers.find((w) => w.id === t.workerPin)?.name ?? t.workerPin})` : ''}
            </option>
          ))}
        </select>
        <div className="flex gap-2" style={{ marginTop: 6 }}>
          <select
            aria-label="Worker"
            className="cred-field"
            value={pinWorker}
            onChange={(e) => setPinWorker(e.target.value)}
            data-testid="worker-pin-worker"
            style={{ flex: 1 }}
          >
            <option value="">Local (unpin)</option>
            {workers
              .filter((w) => w.status === 'paired')
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} {w.onlineComputed ? '' : '(silent)'}
                </option>
              ))}
          </select>
          <fieldset style={{ marginTop: 6, border: 'none', padding: 0 }}>
            <legend className="hint" style={{ marginBottom: 4 }}>
              If the worker is silent when a run fires:
            </legend>
            <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="radio"
                name="worker-pin-mode"
                checked={pinRequired}
                onChange={() => setPinRequired(true)}
                data-testid="worker-pin-required"
              />
              Required — wait for the worker
            </label>
            <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
              <input
                type="radio"
                name="worker-pin-mode"
                checked={!pinRequired}
                onChange={() => setPinRequired(false)}
                data-testid="worker-pin-preferred"
              />
              Preferred — run here instead, noted on the run
            </label>
          </fieldset>
        </div>
        <div className="cred-actions">
          <button className="btn small primary" disabled={busy || !pinTask} onClick={() => void savePin()} data-testid="worker-pin-save">
            {busy ? 'Saving…' : 'Save pin'}
          </button>
        </div>
      </div>
      {msg && <div className="ok-banner">{msg}</div>}
      {err && (
        <div className="error-banner" role="alert">
          {err}
        </div>
      )}
    </div>
  );
}
