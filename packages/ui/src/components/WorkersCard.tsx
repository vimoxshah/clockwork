/**
 * Workers card (P4): the fleet on one screen. Pairing is a human-driven
 * ceremony, every step a control on this card: the worker shows its public
 * key, the primary starts pairing with it and shows a nonce, the worker
 * claims (it signs the nonce with its own key, here in the app), the primary
 * approves AFTER the claim, and the worker joins with the bearer token —
 * which appears exactly once for copying, never again.
 *
 * Task pins live here too (not in the composer): pick a task, pick a
 * worker (or local), required waits while preferred falls back. The current
 * pin shows beside each choice because a pin you cannot see is a pin you
 * cannot reason about on a sleeping-laptop night.
 *
 * Exported for the same reason DeliveryCard and GithubCard are — the UI
 * test drives this card alone.
 */
import { useEffect, useState } from 'react';
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

/**
 * The claim route relays the primary's refusal code; the shared client
 * surfaces only that code, so each one gets its next step here.
 */
const CLAIM_HINTS: Record<string, string> = {
  validation: 'Check the URL (http or https) and the nonce (32 hex characters).',
  no_identity: 'This machine has no worker key yet — press Create identity first.',
  unreachable: 'Could not reach the primary. Check the URL and your tunnel.',
  not_found: 'The primary has no pairing for this machine’s key. Start pairing there with the key shown above.',
  unknown_nonce: 'Unknown or used nonce. Nonces are single use — press Start pairing on the primary again.',
  expired: 'The nonce expired (10 minutes). Press Start pairing on the primary again.',
  bad_signature: 'The primary could not verify the signature. Make sure the key it has is this machine’s current key.',
  pubkey_mismatch: 'The primary expects a different key. Start pairing there with the key shown above.',
  bad_key: 'The primary could not read this machine’s key.',
  bad_state: 'This machine is already paired with that primary.',
  revoked: 'The primary revoked this machine. Remove it there and pair again.',
};

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
  const joinQ = useAsync(() => api.workerStatus(), [version]);
  const [joinUrl, setJoinUrl] = useState('');
  const [joinToken, setJoinToken] = useState('');
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinMsg, setJoinMsg] = useState<string | null>(null);
  const [joinErr, setJoinErr] = useState<string | null>(null);
  const identityQ = useAsync(() => api.workerIdentity(), [version]);
  const [claimUrl, setClaimUrl] = useState('');
  const [claimNonce, setClaimNonce] = useState('');
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimMsg, setClaimMsg] = useState<string | null>(null);
  const [claimErr, setClaimErr] = useState<string | null>(null);

  const reload = (): void => ws.reload();
  const [nonceNote, setNonceNote] = useState<string | null>(null);
  const [keyNote, setKeyNote] = useState<string | null>(null);

  // Coming online arrives over SSE (the heartbeat route broadcasts it), but
  // going silent is only the absence of heartbeats — nothing to broadcast.
  // Re-poll while this card is on screen so "silent" and the heartbeat age
  // stay true. The card mounts only on the Workers tab.
  const reloadWorkers = ws.reload;
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') reloadWorkers();
    }, 10_000);
    return () => clearInterval(t);
  }, [reloadWorkers]);

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
    setNonceNote(null);
    try {
      const workerName = name.trim();
      const r = await api.pairInit({ name: workerName, pubkeyHex: pubkey.trim() });
      setNonce({ ...r, workerName });
      setName('');
      setPubkey('');
      setMsg('Pairing started. On the worker, paste this daemon’s URL and the nonce under Claim a pairing, then approve here once it claims.');
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
      setMsg('Approved. Copy the token below into the worker’s Join another daemon form — it shows exactly once.');
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

  const join = async (): Promise<void> => {
    setJoinBusy(true);
    setJoinMsg(null);
    setJoinErr(null);
    try {
      const r = await api.joinWorker({ primaryUrl: joinUrl.trim(), token: joinToken.trim() });
      setJoinUrl('');
      setJoinToken('');
      setJoinMsg(`Joined ${r.primaryHost} — this daemon now pulls jobs. No restart needed.`);
      joinQ.reload();
    } catch (e) {
      setJoinErr(e instanceof Error ? e.message : String(e));
    } finally {
      setJoinBusy(false);
    }
  };

  const leave = async (): Promise<void> => {
    if (!confirm('Leave the primary? This daemon stops pulling jobs. Jobs it already pulled finish and report first.')) return;
    setJoinBusy(true);
    setJoinMsg(null);
    setJoinErr(null);
    try {
      await api.leaveWorker();
      setJoinMsg('Left — this daemon pulls nothing now.');
      joinQ.reload();
    } catch (e) {
      setJoinErr(e instanceof Error ? e.message : String(e));
    } finally {
      setJoinBusy(false);
    }
  };

  const publicKeyHex = identityQ.data?.publicKeyHex ?? null;
  // Only a successful "no key" answer counts as no identity. A failed load
  // says nothing about the disk, and minting then could replace a real key.
  const noIdentity = identityQ.data !== null && identityQ.data.publicKeyHex === null;

  const keygen = async (): Promise<void> => {
    // Only a REPLACEMENT asks: minting the first identity loses nothing.
    if (!noIdentity && !confirm('Mint a new worker identity? The old key dies — the primary must re-pair this machine.')) return;
    setJoinBusy(true);
    setJoinMsg(null);
    setJoinErr(null);
    try {
      await api.workerKeygen();
      setJoinMsg(publicKeyHex ? 'New identity minted. Pair this machine again on the primary with the new key.' : 'Identity created. Copy the key into the primary’s Pair new worker.');
      identityQ.reload();
    } catch (e) {
      setJoinErr(e instanceof Error ? e.message : String(e));
    } finally {
      setJoinBusy(false);
    }
  };

  // Confirmation lands beside the thing copied: `say` is that spot's setter.
  const copy = async (text: string, what: string, say: (m: string) => void, sayErr: (m: string) => void = say): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      say(`${what} copied.`);
    } catch {
      sayErr(`Couldn’t reach the clipboard — select the ${what.toLowerCase()} and copy it by hand.`);
    }
  };

  const claim = async (): Promise<void> => {
    setClaimBusy(true);
    setClaimMsg(null);
    setClaimErr(null);
    try {
      const primaryUrl = claimUrl.trim();
      const r = await api.claimPairing({ primaryUrl, nonce: claimNonce.trim() });
      setClaimNonce('');
      // The token exists only on the primary, at Approve — pre-fill the
      // rest of Join so only the token is left to paste.
      if (!joinUrl.trim()) setJoinUrl(primaryUrl);
      setClaimMsg(`Claimed on ${r.primaryHost}. Now press Approve on the primary, then paste the token it shows under Join another daemon.`);
    } catch (e) {
      const code = e instanceof Error ? e.message : String(e);
      setClaimErr(`${CLAIM_HINTS[code] ?? 'The claim failed.'} (${code})`);
    } finally {
      setClaimBusy(false);
    }
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
      <ol className="hint" style={{ margin: '0 0 8px 18px', padding: 0 }} data-testid="worker-steps">
        <li>1. On the worker: copy its key from This machine’s worker key.</li>
        <li>2. Here: Pair new worker — name it, paste the key, Start pairing. Copy the nonce.</li>
        <li>3. On the worker: Claim a pairing — this daemon’s URL and the nonce, then Claim.</li>
        <li>4. Here: Approve on the worker’s row. Copy the token — it shows once.</li>
        <li>5. On the worker: Join another daemon — this daemon’s URL and the token, then Join.</li>
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
          <div className="flex gap-2" style={{ marginTop: 6 }}>
            <button className="btn small" onClick={() => void copy(nonce.nonce, 'Nonce', setNonceNote)} data-testid="worker-nonce-copy">
              Copy nonce
            </button>
            <button className="btn small" onClick={() => setNonce(null)}>
              Dismiss
            </button>
            {nonceNote && (
              <span className="hint" role="status" style={{ alignSelf: 'center' }} data-testid="worker-nonce-note">
                {nonceNote}
              </span>
            )}
          </div>
        </div>
      )}
      <div className="cred-row">
        <label className="f cred-label" htmlFor="worker-name">
          Pair new worker
        </label>
        <div className="cred-field cred-stack">
          <input
            id="worker-name"
            className="cred-input"
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
            className="cred-input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={pubkey}
            onChange={(e) => setPubkey(e.target.value)}
            placeholder="Worker public key (from the worker’s Settings › Workers)"
            data-testid="worker-pubkey-input"
          />
        </div>
        <div className="hint cred-hint">Start pairing shows a nonce (10 minutes, single use). The worker claims with it; approve only after that.</div>
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
        <div className="cred-field cred-stack">
          <select
            id="worker-pin-task"
            className="cred-input"
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
          <div className="flex gap-2 items-start">
            <select
              aria-label="Worker"
              className="cred-input"
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
            <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
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
      <h3 className="hint" style={{ margin: '14px 0 6px', fontWeight: 600 }}>
        On the worker machine
      </h3>
      <div className="cred-row">
        <label className="f cred-label" htmlFor="worker-identity-key">
          This machine’s worker key
        </label>
        <div className="cred-field cred-stack">
          {publicKeyHex ? (
            <input
              id="worker-identity-key"
              className="cred-input mono"
              type="text"
              readOnly
              value={publicKeyHex}
              onFocus={(e) => e.currentTarget.select()}
              data-testid="worker-identity-key"
            />
          ) : identityQ.error ? (
            <p className="hint" style={{ margin: 0 }} role="alert" data-testid="worker-identity-error">
              Couldn’t read this machine’s worker key: {identityQ.error}
            </p>
          ) : (
            <p className="hint" style={{ margin: 0 }} data-testid="worker-identity-none">
              {noIdentity ? 'No worker identity yet. Create one to pair this machine with a primary.' : 'Loading…'}
            </p>
          )}
        </div>
        <div className="hint cred-hint">
          {keyNote ? (
            <span role="status" data-testid="worker-identity-note">
              {keyNote}{' '}
            </span>
          ) : null}
          The public half only. The private key stays on this machine (0600) and never leaves.
        </div>
        <div className="cred-actions">
          {publicKeyHex ? (
            <>
              <button className="btn small primary" disabled={joinBusy} onClick={() => void copy(publicKeyHex, 'Key', setKeyNote)} data-testid="worker-identity-copy">
                Copy key
              </button>
              <button className="btn small" disabled={joinBusy} onClick={() => void keygen()} data-testid="worker-keygen-button" title="Replace this machine’s identity — the primary must re-pair it">
                New key
              </button>
            </>
          ) : noIdentity ? (
            <button className="btn small primary" disabled={joinBusy} onClick={() => void keygen()} data-testid="worker-identity-create">
              Create identity
            </button>
          ) : null}
        </div>
      </div>
      <div className="cred-row">
        <label className="f cred-label" htmlFor="worker-claim-url">
          Claim a pairing
        </label>
        <div className="cred-field cred-stack">
          <input
            id="worker-claim-url"
            className="cred-input"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={claimUrl}
            onChange={(e) => setClaimUrl(e.target.value)}
            placeholder="Primary URL, e.g. http://laptop.tailnet:4747"
            data-testid="worker-claim-url"
          />
          <input
            id="worker-claim-nonce"
            aria-label="Pairing nonce from the primary"
            className="cred-input mono"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={claimNonce}
            onChange={(e) => setClaimNonce(e.target.value)}
            placeholder="Nonce the primary showed after Start pairing"
            data-testid="worker-claim-nonce"
          />
        </div>
        <div className="hint cred-hint">This machine signs the nonce with its own key. A claim earns no token — the primary still approves.</div>
        <div className="cred-actions">
          <button
            className="btn small primary"
            disabled={claimBusy || !publicKeyHex || !claimUrl.trim() || !claimNonce.trim()}
            onClick={() => void claim()}
            data-testid="worker-claim-button"
          >
            {claimBusy ? 'Claiming…' : 'Claim'}
          </button>
        </div>
        <div className="cred-extra">
          {claimMsg && (
            <div className="ok-banner" role="status" data-testid="worker-claim-ok">
              {claimMsg}
            </div>
          )}
          {claimErr && (
            <div className="error-banner" role="alert" data-testid="worker-claim-error">
              {claimErr}
            </div>
          )}
        </div>
      </div>
      <div className="cred-row">
        <label className="f cred-label" htmlFor="worker-join-url">
          Join another daemon
        </label>
        <div className="cred-field cred-stack">
          {joinQ.data?.joined ? (
            <p className="hint" style={{ margin: 0 }} data-testid="worker-join-status">
              Joined to <strong className="mono">{joinQ.data.primaryHost ?? 'unknown host'}</strong>
              {joinQ.data.via === 'env' ? ' via environment (Join below would be shadowed — unset the env to switch)' : ' via this app'}.
              This daemon pulls jobs from there; its own tasks still run here.
            </p>
          ) : (
            <p className="hint" style={{ margin: 0 }} data-testid="worker-join-status">
              This daemon pulls from nobody. After the primary approves, paste its URL and the bearer token
              its Approve step showed once. No terminal needed.
            </p>
          )}
          <input
            id="worker-join-url"
            className="cred-input"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={joinUrl}
            onChange={(e) => setJoinUrl(e.target.value)}
            placeholder="https://mini-lan:8787 or http://100.x.y.z:8787"
            data-testid="worker-join-url"
          />
          <input
            id="worker-join-token"
            aria-label="Primary bearer token"
            className="cred-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={joinToken}
            onChange={(e) => setJoinToken(e.target.value)}
            placeholder="Bearer token from the primary’s Approve step"
            data-testid="worker-join-token"
          />
        </div>
        <div className="hint cred-hint">Saved to worker.json (0600) — never shown again, never logged. Takes effect without a restart.</div>
        <div className="cred-actions">
          <button className="btn small primary" disabled={joinBusy || !joinUrl.trim() || joinToken.trim().length < 16} onClick={() => void join()} data-testid="worker-join-button">
            {joinBusy ? 'Joining…' : joinQ.data?.joined ? 'Re-join' : 'Join'}
          </button>
          {joinQ.data?.joined && joinQ.data?.via === 'file' && (
            <button className="btn small danger" disabled={joinBusy} onClick={() => void leave()} data-testid="worker-leave-button">
              Leave
            </button>
          )}
        </div>
        <div className="cred-extra">
          {joinMsg && <div className="ok-banner">{joinMsg}</div>}
          {joinErr && (
            <div className="error-banner" role="alert">
              {joinErr}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
