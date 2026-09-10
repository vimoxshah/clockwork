/**
 * T1-20. The defect this exists to prevent recurring:
 * `NUMERIC_LIMITS.retention.free` was 30 while `retention-audit.ts` seeds
 * `run_days = 90`. Free is the only tier any install runs at, so every fresh
 * install booted holding a value its own `PUT /retention` refused with a 402.
 * The setter could shorten the window and never put it back.
 *
 * The cap is read from `features.ts` and the seed is read out of a REAL
 * migrated database rather than from a literal here. Hardcoding 90 in this
 * file would make it agree with itself while the product drifted — which is
 * the whole failure mode. If either side moves, this goes red.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { NUMERIC_LIMITS } from '../src/features.js';
import { RetentionAudit } from '../src/retention-audit.js';

/** The seed, as a fresh install actually receives it. */
function seededRunDays(): number | null {
  const db = new Database(':memory:');
  new RetentionAudit(db as never); // its constructor is what seeds the row
  const prefs = new RetentionAudit(db as never).getPrefs();
  db.close();
  return prefs.runDays;
}

describe('the free retention cap can never sit below the window a fresh install ships with', () => {
  it('reads a real seeded default rather than trusting a literal', () => {
    const seed = seededRunDays();
    expect(seed, 'retention_prefs seeds no run_days at all — the invariant below is vacuous').toBeTypeOf('number');
    expect(seed!).toBeGreaterThan(0);
  });

  it('lets a fresh install save the very window it booted with', () => {
    const seed = seededRunDays()!;
    const free = NUMERIC_LIMITS.retention?.free;
    expect(free, 'retention has no free-tier limit; the gate would then reject nothing or everything').toBeTypeOf('number');
    expect(
      free!,
      `free cap ${free} is below the seeded default ${seed}: a fresh install cannot save its own retention window, `
        + 'and PUT /retention will 402 the value it just handed the user. Raise the cap or lower the seed — '
        + 'but never only one of them (T1-20).',
    ).toBeGreaterThanOrEqual(seed);
  });

  it('keeps the paid tiers at or above free, so upgrading never shortens retention', () => {
    const { free, pro, team } = NUMERIC_LIMITS.retention as Record<string, number>;
    expect(pro, `pro ${pro} is below free ${free}: paying would shorten your history`).toBeGreaterThanOrEqual(free);
    expect(team, `team ${team} is below pro ${pro}`).toBeGreaterThanOrEqual(pro);
  });
});
