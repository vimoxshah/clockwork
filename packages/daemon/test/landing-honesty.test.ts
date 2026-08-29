/**
 * The landing page may not promise what the product does not enforce
 * (gauntlet §49/§54).
 *
 * Four real contradictions existed before this guard: Pro advertised
 * "unlimited run history" while retention caps at 365 days; Pro sold
 * "priority engine & model updates", which is not a feature at all; Teams
 * sold approvals and budget guards, which every free user already has; and
 * Teams sold "self-hosted runners, VPC execution", which does not exist.
 *
 * Each pricing <li> carries data-feature="<key>". These tests read the page
 * and hold that markup to the enforced matrix.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURES, type Tier } from '../src/features.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(HERE, '../../../landing-page/index.html');

/** Pricing cards in document order: [tier, cardHtml]. */
function cards(): Array<{ tier: Tier; html: string }> {
  const html = readFileSync(PAGE, 'utf8');
  const section = html.slice(html.indexOf('<section id="pricing"'), html.indexOf('</section>', html.indexOf('<section id="pricing"')));
  const chunks = section.split('<div class="card">').slice(1);
  const tiers: Tier[] = ['free', 'pro', 'team'];
  return chunks.map((html, i) => ({ tier: tiers[i] ?? 'enterprise', html }));
}

const claimsIn = (html: string): string[] =>
  [...html.matchAll(/data-feature="([a-z_]+)"/g)].map((m) => m[1]!);

describe('landing page honesty', () => {
  const parsed = cards();

  it('parses the pricing cards at all', () => {
    expect(parsed.length).toBeGreaterThanOrEqual(3);
    expect(parsed.flatMap((c) => claimsIn(c.html)).length).toBeGreaterThan(5);
  });

  it('only advertises features that exist', () => {
    const real = new Set(FEATURES.map((f) => f.key));
    const unknown = parsed.flatMap((c) => claimsIn(c.html)).filter((k) => !real.has(k));
    expect(unknown, `landing page sells features absent from FEATURES: ${unknown.join(', ')}`).toEqual([]);
  });

  it('never sells a paid tier something the free tier already includes', () => {
    const offenders: string[] = [];
    for (const card of parsed) {
      if (card.tier === 'free') continue;
      for (const key of claimsIn(card.html)) {
        const f = FEATURES.find((x) => x.key === key);
        if (!f) continue;
        const freeHas = f.tiers.free?.available === true;
        const freeIsLimited = Boolean(f.tiers.free?.limit);
        // Selling a capped free feature as a paid upgrade is honest (more of
        // it). Selling an uncapped free feature as paid is not.
        if (freeHas && !freeIsLimited) offenders.push(`${card.tier}: ${key}`);
      }
    }
    expect(offenders, `paid tiers sell what free already gives away: ${offenders.join(', ')}`).toEqual([]);
  });

  it('says so when a feature is only planned', () => {
    const bad: string[] = [];
    for (const card of parsed) {
      for (const key of claimsIn(card.html)) {
        const f = FEATURES.find((x) => x.key === key);
        if (f?.status !== 'planned') continue;
        const li = card.html.match(new RegExp(`data-feature="${key}"[^>]*>([^<]*)<`));
        if (!li || !/planned/i.test(li[1] ?? '')) bad.push(key);
      }
    }
    expect(bad, `planned features advertised without saying so: ${bad.join(', ')}`).toEqual([]);
  });
});
