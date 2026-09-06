/**
 * F7 earned autonomy — the ladder `plan → acceptEdits → unattended`.
 *
 * A rung is OFFERED, never granted: the daemon writes an `autonomy_offers` row
 * when a profile's accepted-outcome streak is long enough, and only a human
 * answering that offer moves the profile. Enrolment is opt-in, and until this
 * card there was no way to opt in from the app at all.
 *
 * Enrolling is destructive and one-way, and the card says so before it
 * happens, not after:
 *   - Enrolling and accepting an offer both update the profile row in one
 *     statement — rung, permission mode and approval flag together
 *     (`AutonomyPolicy.enroll`, packages/daemon/src/autonomy-policy.ts). The
 *     rung's permission mode REPLACES whatever the profile had; there is no
 *     "track the rung, keep my mode" option.
 *   - Nothing takes a profile back off the ladder. `ProfilePatch` is
 *     `ProfileCreate.omit({slug}).partial().strict()` and has no
 *     `autonomy_rung` field, so no route can write NULL back into that column.
 *     A rung can be changed; enrolment cannot be undone.
 */
import { useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { api, type AutonomyEnrolledProfileT, type AutonomyOfferT, type AutonomyRungT, type AutonomyStateT } from '../api';
import { useAsync } from '../useAsync';
import { Badge } from './ui/card';
import { featureSurface, registerFeatureSurface, revealFeatureSurface } from './featureSurfaces';

export const AUTONOMY_SURFACE = registerFeatureSurface({
  key: 'earned_autonomy',
  tab: 'settings',
  where: 'Settings › Earned autonomy',
  anchorId: 'earned-autonomy',
});

/**
 * What a rung concretely does to a profile row.
 *
 * Mirrors `AUTONOMY_RUNG_SETTINGS` in `packages/shared/src/workforce.ts` BY
 * HAND — nothing under `packages/ui/src` imports `@clockwork/shared` (api.ts
 * says why) — so this is the same kind of hand-copied contract as every `T`
 * shape in api.ts. The enrolled table below reads each profile's REAL
 * `permission_mode` back off `GET /profiles`, so a drift between this map and
 * the daemon shows up on screen instead of hiding.
 */
const RUNG_EFFECT: Record<AutonomyRungT, { mode: string; flag: boolean; what: string }> = {
  plan: {
    mode: 'plan',
    flag: true,
    what: 'Refuses any task on this profile that asks for a permission mode other than plan (403).',
  },
  acceptEdits: {
    mode: 'acceptEdits',
    flag: true,
    what: 'Refuses nothing. The profile stays flagged, so office hours can defer its tasks.',
  },
  unattended: {
    mode: 'acceptEdits',
    flag: false,
    what:
      'Same permission mode as acceptEdits — it blocks nothing extra. Its one real effect is clearing the approval flag, so office hours stops deferring this profile’s tasks.',
  },
};

const RUNGS: AutonomyRungT[] = ['plan', 'acceptEdits', 'unattended'];

/** A profile row as `GET /profiles` sends it — `SELECT *`, so snake_case. */
interface ProfileRow {
  id: string;
  slug: string;
  name: string;
  permission_mode?: string | null;
  autonomy_rung?: string | null;
  may_require_approval?: number | null;
}

interface EnrolledRow extends AutonomyEnrolledProfileT {
  /** null when the per-profile state call failed — the row still renders */
  state: AutonomyStateT | null;
}

/** What the confirm panel is about to do. */
interface PendingEnrol {
  profile: ProfileRow;
  rung: AutonomyRungT;
  /** true when the profile is already on the ladder — a rung change, not a first enrolment */
  enrolled: boolean;
}

function fmtWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function AutonomyCard({ version }: { version: number }): JSX.Element {
  const offers = useAsync(() => api.autonomyOffers('offered'), [version]);
  const profiles = useAsync<ProfileRow[]>(() => api.profiles(), [version]);
  const enrolled = useAsync<EnrolledRow[]>(async () => {
    const rows = await api.autonomyEnrolledProfiles();
    // allSettled, not all: a profile deleted between the two calls must not
    // blank the whole table.
    const states = await Promise.allSettled(rows.map((r) => api.autonomyProfile(r.id)));
    return rows.map((r, i) => {
      const s = states[i];
      return { ...r, state: s && s.status === 'fulfilled' ? s.value : null };
    });
  }, [version]);

  const [pending, setPending] = useState<PendingEnrol | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const byId = new Map((profiles.data ?? []).map((p) => [p.id, p]));
  const unenrolled = (profiles.data ?? []).filter((p) => p.autonomy_rung == null);
  const officeHours = featureSurface('office_hours');

  const reloadAll = (): void => {
    offers.reload();
    profiles.reload();
    enrolled.reload();
  };

  const respond = async (id: string, decision: 'accepted' | 'declined'): Promise<void> => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await api.autonomyRespond(id, decision);
      setMsg(
        decision === 'accepted'
          ? `Promoted to rung ${res.toRung} — permission mode is now ${RUNG_EFFECT[res.toRung].mode}.`
          : `Offer declined. The streak has to grow past ${res.streak} before this profile is asked again.`,
      );
      reloadAll();
    } catch (e) {
      const status = (e as { status?: number }).status;
      setErr(
        status === 409
          ? 'That offer was already answered — the list has been refreshed.'
          : String((e as Error).message ?? e),
      );
      if (status === 409) reloadAll();
    } finally {
      setBusy(false);
    }
  };

  const commitEnrol = async (): Promise<void> => {
    if (!pending) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const state = await api.autonomyEnroll(pending.profile.id, pending.rung);
      setMsg(`${pending.profile.name} is on the ladder at rung ${state.rung ?? pending.rung}.`);
      setPending(null);
      setPicking(false);
      reloadAll();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        A profile earns rungs by accumulating accepted outcomes: <span className="mono">plan</span> →{' '}
        <span className="mono">acceptEdits</span> → <span className="mono">unattended</span>. Clockwork
        only ever <em>offers</em> the next rung — nothing is promoted without you answering. Profiles
        are enrolled one at a time, on purpose: a profile that is not enrolled has no ceiling at all.
      </p>

      {(offers.error || profiles.error || enrolled.error) && (
        <div className="error-banner" role="alert">
          Couldn’t load autonomy state: {offers.error ?? profiles.error ?? enrolled.error}
        </div>
      )}

      <p className="mb-1 mt-2 text-xxs font-semibold uppercase tracking-wide text-dim">Offers waiting for you</p>
      {(offers.data?.offers ?? []).length === 0 && !offers.loading && !offers.error && (
        <p className="hint" data-testid="autonomy-no-offers">
          No offers right now. When an enrolled profile reaches its streak of accepted outcomes with
          no rejection in between, the next outcome you accept in the Inbox writes an offer here.
          Only enrolled profiles are ever offered anything.
        </p>
      )}
      {(offers.data?.offers ?? []).map((o) => (
        <OfferRow
          key={o.id}
          offer={o}
          profileName={byId.get(o.profileId)?.name ?? o.profileId}
          busy={busy}
          onRespond={(d) => void respond(o.id, d)}
        />
      ))}

      <p className="mb-1 mt-4 text-xxs font-semibold uppercase tracking-wide text-dim">Enrolled profiles</p>
      {(enrolled.data ?? []).length === 0 && !enrolled.loading && !enrolled.error && (
        <p className="hint" data-testid="autonomy-none-enrolled">
          No profile is on the ladder. Enrolment is opt-in and changes the profile’s permission mode
          immediately — start a profile at rung <span className="mono">plan</span> below if you want
          its work reviewed before it edits anything.
        </p>
      )}
      {(enrolled.data ?? []).map((row) => {
        const profile = byId.get(row.id);
        return (
          <div key={row.id} className="tasklist-row" data-testid="autonomy-enrolled-row">
            <TrendingUp className="h-4 w-4 shrink-0 text-dim" aria-hidden />
            <div className="grow">
              <strong>{row.name}</strong> <span className="hint mono">{row.slug}</span>
              <div className="hint" style={{ margin: 0 }}>
                {row.state
                  ? `streak ${row.state.streak} of ${row.state.streakRequired} accepted outcomes`
                  : 'streak unavailable — this profile’s autonomy state could not be read'}
                {profile?.permission_mode ? ` · permission mode ${profile.permission_mode}` : ''}
                {profile ? ` · ${profile.may_require_approval ? 'flagged for office hours' : 'not flagged for office hours'}` : ''}
              </div>
            </div>
            <Badge variant="info">rung {row.autonomy_rung}</Badge>
            {row.state?.eligible && (
              <Badge variant="warning">next accepted outcome raises an offer</Badge>
            )}
            <button
              className="btn small"
              // No profile row means no current permission mode to show, and the
              // confirm panel's whole job is naming what the write replaces.
              disabled={busy || !profile}
              data-testid="autonomy-change-rung"
              onClick={() =>
                profile && setPending({ profile, rung: nextRungFor(row.autonomy_rung), enrolled: true })
              }
            >
              Change rung
            </button>
          </div>
        );
      })}

      <p className="mb-1 mt-4 text-xxs font-semibold uppercase tracking-wide text-dim">Enrol a profile</p>
      {!picking && (
        <button
          className="btn small"
          data-testid="autonomy-enrol-open"
          disabled={profiles.loading || unenrolled.length === 0}
          onClick={() => setPicking(true)}
        >
          {unenrolled.length === 0 ? 'Every profile is already enrolled' : 'Choose a profile to enrol'}
        </button>
      )}
      {picking && (
        <div data-testid="autonomy-enrol-list">
          <p className="hint" style={{ marginTop: 0 }}>
            Pick the profile to put on the ladder. You choose its starting rung next, and see exactly
            what changes before anything is written.
          </p>
          {unenrolled.map((p) => (
            <div key={p.id} className="tasklist-row">
              <div className="grow">
                <strong>{p.name}</strong> <span className="hint mono">{p.slug}</span>
                <div className="hint" style={{ margin: 0 }}>
                  permission mode {p.permission_mode ?? 'unknown'} · not enrolled, so no rung ceiling
                  applies to it today
                </div>
              </div>
              <button
                className="btn small"
                data-testid="autonomy-enrol-pick"
                onClick={() => setPending({ profile: p, rung: 'plan', enrolled: false })}
              >
                Enrol…
              </button>
            </div>
          ))}
          <button className="btn small" onClick={() => { setPicking(false); setPending(null); }}>
            Cancel
          </button>
        </div>
      )}

      {pending && (
        <EnrolConfirm
          pending={pending}
          busy={busy}
          officeHoursReachable={Boolean(officeHours)}
          onRung={(rung) => setPending({ ...pending, rung })}
          onCancel={() => setPending(null)}
          onConfirm={() => void commitEnrol()}
          onOfficeHours={() => officeHours && revealFeatureSurface(officeHours)}
        />
      )}

      {msg && (
        <div className="ok-banner" role="status" data-testid="autonomy-msg">
          {msg}
        </div>
      )}
      {err && (
        <div className="error-banner" role="alert" data-testid="autonomy-error">
          {err}
        </div>
      )}
    </div>
  );
}

/**
 * Which rung the "Change rung" panel opens on: the one above, or the current
 * one at the top of the ladder — never a rung that does not exist.
 */
function nextRungFor(current: AutonomyRungT): AutonomyRungT {
  const i = RUNGS.indexOf(current);
  return RUNGS[Math.min(i + 1, RUNGS.length - 1)] ?? 'plan';
}

function OfferRow({
  offer,
  profileName,
  busy,
  onRespond,
}: {
  offer: AutonomyOfferT;
  profileName: string;
  busy: boolean;
  onRespond: (decision: 'accepted' | 'declined') => void;
}): JSX.Element {
  const effect = RUNG_EFFECT[offer.toRung];
  return (
    <div className="tasklist-row" data-testid="autonomy-offer">
      <div className="grow">
        <strong>{profileName}</strong>{' '}
        <span className="mono">
          {offer.fromRung} → {offer.toRung}
        </span>
        <div className="hint" style={{ margin: 0 }}>
          Earned on a streak of {offer.streak} accepted outcomes · offered {fmtWhen(offer.offeredAt)}
        </div>
        <div className="hint" style={{ margin: 0 }}>
          Accepting sets this profile’s permission mode to <span className="mono">{effect.mode}</span>{' '}
          and {effect.flag ? 'keeps' : 'clears'} its approval flag. {effect.what}
        </div>
      </div>
      <button className="btn primary small" disabled={busy} data-testid="autonomy-accept" onClick={() => onRespond('accepted')}>
        Accept
      </button>
      <button className="btn small" disabled={busy} data-testid="autonomy-decline" onClick={() => onRespond('declined')}>
        Decline
      </button>
    </div>
  );
}

/** The one screen between a user and an irreversible write to a profile row. */
function EnrolConfirm({
  pending,
  busy,
  officeHoursReachable,
  onRung,
  onCancel,
  onConfirm,
  onOfficeHours,
}: {
  pending: PendingEnrol;
  busy: boolean;
  officeHoursReachable: boolean;
  onRung: (rung: AutonomyRungT) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onOfficeHours: () => void;
}): JSX.Element {
  const effect = RUNG_EFFECT[pending.rung];
  const current = pending.profile.permission_mode ?? 'unknown';
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-strong p-3" data-testid="autonomy-confirm">
      <strong>
        {pending.enrolled ? 'Change' : 'Enrol'} {pending.profile.name} at rung {pending.rung}
      </strong>
      <div className="flex gap-1">
        {RUNGS.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={pending.rung === r}
            data-testid={`autonomy-rung-${r}`}
            onClick={() => onRung(r)}
            className={
              'h-8 w-full rounded-md border text-xxs font-medium ' +
              (pending.rung === r
                ? 'border-accent bg-accent text-[var(--accent-fg)]'
                : 'border-border text-muted hover:bg-surface-hover hover:text-fg')
            }
          >
            {r}
          </button>
        ))}
      </div>
      <ul className="m-0 flex flex-col gap-1 pl-4 text-caption text-muted">
        <li data-testid="autonomy-confirm-mode">
          Permission mode {current === effect.mode ? <>stays <span className="mono">{effect.mode}</span></> : (
            <>
              changes from <span className="mono">{current}</span> to <span className="mono">{effect.mode}</span>
            </>
          )}
          , for every task that uses this profile, immediately.
        </li>
        <li>{effect.what}</li>
        <li>
          Office-hours deferral {effect.flag ? 'applies to' : 'stops applying to'} this profile’s tasks
          {effect.flag ? ' once office hours is switched on' : ''}.
          {officeHoursReachable && (
            <>
              {' '}
              <button className="underline underline-offset-2 hover:text-fg" onClick={onOfficeHours}>
                Office hours
              </button>
            </>
          )}
        </li>
        <li data-testid="autonomy-confirm-oneway">
          This cannot be undone from Clockwork: no route takes a profile back off the ladder. You can
          change the rung later, but the profile stays enrolled.
        </li>
      </ul>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn danger small" disabled={busy} data-testid="autonomy-confirm-btn" onClick={onConfirm}>
          {busy ? 'Writing…' : `${pending.enrolled ? 'Change rung' : 'Enrol'} and rewrite permission mode`}
        </button>
        <button className="btn small" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
