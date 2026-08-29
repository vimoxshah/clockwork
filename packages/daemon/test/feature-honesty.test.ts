/**
 * Honesty guards for the capability registry (gauntlet §49/§54: never
 * advertise a feature as if it exists).
 *
 * The bug this prevents actually happened: hosted execution was dropped in
 * iteration 3, `cloud_agents` was removed from FEATURES, but the upgrade
 * modal kept selling it — "Run agents on always-on machines so schedules
 * survive your Mac sleeping" — for a feature that will never ship.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURES } from '../src/features.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const UPGRADE_HINT = resolve(HERE, '../../ui/src/components/UpgradeHint.tsx');

describe('capability registry honesty', () => {
  it('has no upgrade copy for a feature that no longer exists', () => {
    const src = readFileSync(UPGRADE_HINT, 'utf8');
    const block = src.slice(src.indexOf('FEATURE_COPY'), src.indexOf('export function upgradeCopy'));
    const advertised = [...block.matchAll(/^\s{2}([a-z_]+):\s*\{/gm)].map((m) => m[1]!);
    const real = new Set(FEATURES.map((f) => f.key));
    const orphaned = advertised.filter((k) => !real.has(k));
    expect(orphaned, `UpgradeHint sells features absent from FEATURES: ${orphaned.join(', ')}`).toEqual([]);
    expect(advertised.length).toBeGreaterThan(0); // guard against a parse that silently matches nothing
  });

  it('never actively upsells a feature that is only planned', () => {
    // Listing a `planned` capability in the plan matrix is honest — the UI
    // renders the status beside it. Putting it in the upgrade modal is not:
    // that copy argues for paying today for something that does not exist.
    const src = readFileSync(UPGRADE_HINT, 'utf8');
    const block = src.slice(src.indexOf('FEATURE_COPY'), src.indexOf('export function upgradeCopy'));
    const advertised = new Set([...block.matchAll(/^\s{2}([a-z_]+):\s*\{/gm)].map((m) => m[1]!));
    const planned = FEATURES.filter((f) => f.status === 'planned' && advertised.has(f.key)).map((f) => f.key);
    expect(planned, `upgrade modal sells unbuilt features: ${planned.join(', ')}`).toEqual([]);
  });
});
