/**
 * F7 earned-autonomy (plan/AGENT-WORKFORCE-SPEC.md, §F7).
 *
 * A profile climbs `plan -> acceptEdits -> unattended` by accumulating accepted
 * run outcomes (F6's `run_outcomes`, THE acceptance signal). The climb is never
 * automatic: `maybeOffer` writes an `autonomy_offers` row and NOTHING else, and
 * `respond('accepted')` is the only promotion path that touches the profile. A
 * rung is offered; a human grants it.
 *
 * Enrolment is opt-in. `profiles.autonomy_rung IS NULL` means "not enrolled",
 * and this module never writes a default into it — 0008 deliberately left the
 * column NULL because every profile that exists today runs `acceptEdits`, and
 * stamping them 'plan' would both misreport a rung nobody chose and start
 * refusing their tasks. An unenrolled profile is never offered anything and
 * `evaluate` returns null for it.
 *
 * This module COMPOSES `PolicyEngine` rather than editing it — `policy-engine.ts`
 * is not one of this feature's two files. The integrator folds `evaluate` into
 * the fail-closed policy chain with a wiring snippet; that is what "inside the
 * policy engine" means in practice.
 *
 * The rung -> settings mapping is NOT restated here: `AUTONOMY_RUNG_SETTINGS`
 * in `@clockwork/shared` is the single definition, and `unattended` is
 * `acceptEdits` with the approval flag cleared because `bypassPermissions` is
 * banned in H1 (S-74) — there is no third permission mode to promote into.
 */
import {
  AUTONOMY_RUNG_SETTINGS,
  autonomyRungs,
  newId,
  nextRung,
  type AutonomyOffer,
  type AutonomyOfferStatus,
  type AutonomyRung,
  type PermissionMode,
} from '@clockwork/shared';
import type { DB } from './db.js';
import type { Acceptance } from './acceptance.js';
import type { PolicyEngine, PolicyViolation } from './policy-engine.js';

/**
 * Fallback when the `workforce_prefs` singleton is missing — same value as the
 * column default in 0008 and `WorkforcePrefs.autonomyStreakRequired`'s zod
 * default, so a deleted prefs row cannot silently make promotion cheaper.
 * (Precedent: self-healing.ts keeps the same kind of constant.)
 */
const DEFAULT_STREAK_REQUIRED = 5;

/** The bottom of the ladder, read from the shared definition rather than restated. */
const BOTTOM_RUNG = autonomyRungs[0] as AutonomyRung;

/**
 * Permission modes ordered by how much autonomy they hand the agent, low to
 * high. This is NOT `permissionModes`' declaration order
 * (`plan, acceptEdits, default`), which is a list, not a ladder: `default` is
 * `acceptEdits` plus a human prompt per action, so it sits BELOW it — the same
 * reasoning `evaluate` states below for why it refuses on 'plan' alone.
 * Used only to tell a patch that RAISES autonomy from one that does not.
 */
const MODE_RANK: Record<PermissionMode, number> = { plan: 0, default: 1, acceptEdits: 2 };

/**
 * Fail closed. A stored rung that is not one of the known rungs is a CORRUPT
 * enrolment (a hand-edited row, or one written by a newer build), not an absent
 * one — reading it as "unenrolled" would let every permission mode through, so
 * it drops to the bottom rung instead.
 */
function parseRung(raw: string): AutonomyRung {
  return (autonomyRungs as readonly string[]).includes(raw) ? (raw as AutonomyRung) : BOTTOM_RUNG;
}

interface OfferRow {
  id: string;
  profile_id: string;
  from_rung: string;
  to_rung: string;
  streak: number;
  status: string;
  offered_at: number;
  decided_at: number | null;
}

function rowToOffer(row: OfferRow): AutonomyOffer {
  return {
    id: row.id,
    profileId: row.profile_id,
    fromRung: parseRung(row.from_rung),
    toRung: parseRung(row.to_rung),
    streak: row.streak,
    status: row.status as AutonomyOfferStatus,
    offeredAt: row.offered_at,
    decidedAt: row.decided_at,
  };
}

export interface AutonomyState {
  profileId: string;
  rung: AutonomyRung | null; // null = not enrolled
  streakRequired: number; // profile override, else workforce_prefs
  streak: number; // current accepted streak
  eligible: boolean; // streak >= streakRequired && nextRung(rung) !== null
}

export class AutonomyPolicy {
  constructor(
    private readonly db: DB,
    /**
     * Held so the integrator can construct this from the same engine it folds
     * `evaluate` into (§F7 wiring). No method here consults it: `evaluate`
     * carries a profile and a permission mode, never the engine id or budget
     * `PolicyEngine.evaluate` needs, so there is nothing honest to delegate.
     */
    private readonly policy: PolicyEngine,
    private readonly acceptance: Acceptance,
  ) {}

  state(profileId: string): AutonomyState | undefined {
    const row = this.db
      .prepare('SELECT autonomy_rung, autonomy_streak_required FROM profiles WHERE id=?')
      .get(profileId) as { autonomy_rung: string | null; autonomy_streak_required: number | null } | undefined;
    if (!row) return undefined;

    const rung = row.autonomy_rung == null ? null : parseRung(row.autonomy_rung);
    const streakRequired = this.streakRequiredFor(row.autonomy_streak_required);
    const streak = this.acceptance.acceptedStreak(profileId);
    return {
      profileId,
      rung,
      streakRequired,
      streak,
      // A profile at the top of the ladder is never "eligible" — there is
      // nothing above `unattended` to be offered.
      eligible: rung !== null && streak >= streakRequired && nextRung(rung) !== null,
    };
  }

  /**
   * Opt in a profile at an explicit rung, applying that rung's CONCRETE profile
   * settings (`AUTONOMY_RUNG_SETTINGS`). Enrolling is a human act, not a
   * promotion: nothing here reads the streak and nothing climbs the ladder.
   */
  enroll(profileId: string, rung: AutonomyRung, now: number = Date.now()): AutonomyState | 'not_found' {
    const settings = AUTONOMY_RUNG_SETTINGS[rung];
    const r = this.db
      .prepare('UPDATE profiles SET autonomy_rung=?, permission_mode=?, may_require_approval=?, updated_at=? WHERE id=?')
      .run(rung, settings.permissionMode, settings.mayRequireApproval ? 1 : 0, now, profileId);
    if (r.changes === 0) return 'not_found';
    return this.state(profileId) ?? 'not_found';
  }

  /**
   * Fail-closed gate: a task that asks for more autonomy than its profile has
   * earned is a policy violation.
   *
   * WHERE IT ACTUALLY RUNS. Three call sites, all in `api.ts`, all on the task
   * ROW rather than on a run: `POST /tasks` and the webhook fire path call this
   * method, and `PATCH /tasks/:id` calls `evaluateEdit` below. That is the
   * whole set — nothing else in the daemon imports it.
   *
   * IT IS NOT AN ENQUEUE-TIME CHECK, whatever the surrounding policy engine
   * does. `POST /tasks/:id/run-now`, the scheduler tick and F1/F4/F8's
   * auto-bookers all reach `enqueueRunNow` without consulting it, so a row that
   * exceeds its rung — one stored before the profile was enrolled — still runs
   * on those paths. The ceiling is on what you can SAVE, not on what can fire.
   *
   * Only ONE mode is restrictive on this ladder. `acceptEdits` and `unattended`
   * both map to permission mode `acceptEdits` (they differ only in the approval
   * flag), so every mode sits within them — including `default`, which is
   * `acceptEdits` plus a human prompt per action and therefore never MORE
   * autonomous. Ranking by `permissionModes`' index would reject `default` on
   * the `acceptEdits` rung, which is backwards.
   */
  evaluate(input: { profileId: string | null; permissionMode: PermissionMode }): PolicyViolation | null {
    if (!input.profileId) return null; // a task with no profile has no rung to exceed
    const row = this.db.prepare('SELECT slug, autonomy_rung FROM profiles WHERE id=?').get(input.profileId) as
      | { slug: string; autonomy_rung: string | null }
      | undefined;
    // An id naming no profile is not an enrolment. Task create does not verify
    // profile_id either (api.ts:238), so inventing a violation here would
    // reject tasks for a reason this feature has no standing to judge.
    if (!row) return null;
    if (row.autonomy_rung == null) return null; // opt-in: unenrolled is unconstrained

    const rung = parseRung(row.autonomy_rung);
    const allowed = AUTONOMY_RUNG_SETTINGS[rung].permissionMode;
    if (allowed === 'plan' && input.permissionMode !== 'plan') {
      return {
        code: 'autonomy_rung_exceeded',
        message:
          `Policy: profile "${row.slug}" is on the "${rung}" autonomy rung, which runs in permission mode "plan"; ` +
          `this task asks for "${input.permissionMode}". Accept an autonomy offer for this profile, or set the task's permission mode to "plan".`,
      };
    }
    return null;
  }

  /**
   * The same ceiling, applied to an EDIT of a row that already exists
   * (PATCH /tasks/:id).
   *
   * `evaluate` judges a prospective row on its own merits, which is right for a
   * create and a trap for an edit. A GRANDFATHERED row — stored `acceptEdits`
   * before its profile was enrolled at rung 'plan' — fails it on its own stored
   * values, so EVERY patch of that task was refused, `{enabled:false}`
   * included: the one edit that makes it safe. A fail-closed gate nobody can
   * comply with is not fail-closed, it is stuck, and it holds the escalation in
   * place rather than removing it.
   *
   * So an edit is refused when it RAISES autonomy — a higher `MODE_RANK`, or a
   * different profile, since a different profile is a different ceiling and
   * this module has no honest way to rank one against another. An edit that
   * leaves both alone, or lowers the mode, lands even though the row it lands
   * on still exceeds its rung: it was already there, and refusing is what kept
   * it there. An edit that INTRODUCES a violation on a compliant row is refused
   * exactly as before — that is F7's whole point, and the first branch below.
   */
  evaluateEdit(
    current: { profileId: string | null; permissionMode: PermissionMode },
    next: { profileId: string | null; permissionMode: PermissionMode },
  ): PolicyViolation | null {
    const violation = this.evaluate(next);
    if (!violation) return null;
    if (!this.evaluate(current)) return violation; // the patch is what breaks the ceiling
    // A mode outside the enum can only come from a hand-edited row. Ranking it
    // at the bottom means every named mode above 'plan' reads as a RAISE and is
    // refused — same fail-closed reading `parseRung` gives a corrupt rung.
    const rank = (m: PermissionMode): number => MODE_RANK[m] ?? 0;
    const raisesMode = rank(next.permissionMode) > rank(current.permissionMode);
    const movesProfile = next.profileId !== current.profileId;
    return raisesMode || movesProfile ? violation : null;
  }

  /**
   * Offer — never grant — the next rung once the streak is earned. This writes
   * an `autonomy_offers` row and nothing else; the profile is untouched until a
   * human calls `respond('accepted')`.
   *
   * Returns null when the profile is unknown, unenrolled, already at the top,
   * short of its required streak, already holding an open offer, or has not
   * grown its streak past the last offer. That last rule is the spec's
   * "a declined offer is not re-offered at the same streak", applied to every
   * status: a promotion accepted at streak 5 with a requirement of 5 would
   * otherwise be immediately eligible for the rung above it, chaining two
   * promotions off one earned streak.
   */
  maybeOffer(profileId: string, now: number = Date.now()): AutonomyOffer | null {
    const s = this.state(profileId);
    if (!s || s.rung === null || !s.eligible) return null;
    const toRung = nextRung(s.rung);
    if (!toRung) return null; // unreachable while `eligible` checks it; kept so the contract is local

    const last = this.db
      .prepare('SELECT * FROM autonomy_offers WHERE profile_id=? ORDER BY offered_at DESC, rowid DESC LIMIT 1')
      .get(profileId) as OfferRow | undefined;
    if (last) {
      if (last.status === 'offered') return null; // one open offer at a time — the human still owes an answer
      if (s.streak <= last.streak) return null; // the streak must GROW past the offer it already produced
    }

    const offer: AutonomyOffer = {
      id: newId(),
      profileId,
      fromRung: s.rung,
      toRung,
      streak: s.streak,
      status: 'offered',
      offeredAt: now,
      decidedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO autonomy_offers (id, profile_id, from_rung, to_rung, streak, status, offered_at, decided_at)
         VALUES (?, ?, ?, ?, ?, 'offered', ?, NULL)`,
      )
      .run(offer.id, offer.profileId, offer.fromRung, offer.toRung, offer.streak, offer.offeredAt);
    return offer;
  }

  /** Newest first. `rowid DESC` breaks ties on identical `offered_at`. */
  listOffers(status?: AutonomyOfferStatus): AutonomyOffer[] {
    const rows = (
      status
        ? this.db
            .prepare('SELECT * FROM autonomy_offers WHERE status=? ORDER BY offered_at DESC, rowid DESC')
            .all(status)
        : this.db.prepare('SELECT * FROM autonomy_offers ORDER BY offered_at DESC, rowid DESC').all()
    ) as OfferRow[];
    return rows.map(rowToOffer);
  }

  /**
   * The human's answer, and the ONLY promotion path. CAS on `decided_at IS NULL`
   * in SQL (§2.2) so a second answer gets 'already_resolved' instead of writing
   * the profile twice; a read-then-write would race.
   *
   * Accepting applies `offer.to_rung` even if the profile has since been
   * enrolled elsewhere by hand. A stale offer can then only move the profile to
   * the rung a human already agreed to, which is at worst a DEMOTION — safe by
   * construction.
   */
  respond(
    offerId: string,
    decision: 'accepted' | 'declined',
    now: number = Date.now(),
  ): AutonomyOffer | 'not_found' | 'already_resolved' {
    let result: AutonomyOffer | 'not_found' | 'already_resolved' = 'not_found';
    this.db.transaction(() => {
      const r = this.db
        .prepare('UPDATE autonomy_offers SET status=?, decided_at=? WHERE id=? AND decided_at IS NULL')
        .run(decision, now, offerId);
      if (r.changes === 0) {
        const exists = this.db.prepare('SELECT 1 AS x FROM autonomy_offers WHERE id=?').get(offerId);
        result = exists ? 'already_resolved' : 'not_found';
        return;
      }
      const row = this.db.prepare('SELECT * FROM autonomy_offers WHERE id=?').get(offerId) as OfferRow;
      if (decision === 'accepted') {
        const toRung = parseRung(row.to_rung);
        const settings = AUTONOMY_RUNG_SETTINGS[toRung];
        this.db
          .prepare(
            'UPDATE profiles SET autonomy_rung=?, permission_mode=?, may_require_approval=?, updated_at=? WHERE id=?',
          )
          .run(toRung, settings.permissionMode, settings.mayRequireApproval ? 1 : 0, now, row.profile_id);
      }
      result = rowToOffer(row);
    })();
    return result;
  }

  /**
   * Profile override wins; otherwise the `workforce_prefs` singleton; otherwise
   * the shared default. A non-integer or non-positive override is ignored
   * rather than honoured — a stored `0` would make every enrolled profile
   * instantly eligible, which is the opposite of "earned".
   */
  private streakRequiredFor(override: number | null): number {
    if (typeof override === 'number' && Number.isInteger(override) && override >= 1) return override;
    const row = this.db.prepare('SELECT autonomy_streak_required AS v FROM workforce_prefs WHERE id=1').get() as
      | { v: number }
      | undefined;
    const v = row?.v;
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : DEFAULT_STREAK_REQUIRED;
  }
}
