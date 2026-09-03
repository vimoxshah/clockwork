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
 *
 * SCOPE — what this does NOT catch, so "we have a test" is never mistaken for
 * "the page is honest":
 *   - most prose and headline claims. ONE prose rule exists (permanence vs
 *     retention); the rest of the copy is unchecked.
 *   - whether FEATURES itself is truthful; the page is held to the registry,
 *     and the registry is held to nothing here
 *   - the PRICE. There is no machine-readable source of truth to check a price
 *     against, and setting one is a business decision, not a test. The page
 *     currently advertises no price at all: nothing is purchasable while
 *     ENTITLEMENT_PUBLIC_KEY_HEX is empty, so a figure here would be a claim
 *     the product cannot honour.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURES, type Tier } from '../src/features.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(HERE, '../../../landing-page/index.html');
const README = resolve(HERE, '../../../README.md');

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

  // S-review (Hermes): the first version of this suite PASSED with Pro
  // claiming "Unlimited run history" while retention caps Pro at 365 days —
  // the exact lie the suite was written to catch. Verified by re-planting it.
  // Rule 2 only compared against the FREE tier, so a capped paid tier could
  // still be described in absolute terms.
  it('never uses absolute language for a tier that has a limit', () => {
    const ABSOLUTE = /\b(unlimited|forever|always|no limit|never expires|infinite)\b/i;
    const offenders: string[] = [];
    for (const card of parsed) {
      for (const [, key, text] of card.html.matchAll(/data-feature="([a-z_]+)"[^>]*>([^<]*)</g)) {
        const f = FEATURES.find((x) => x.key === key);
        const limit = f?.tiers[card.tier]?.limit;
        if (limit && ABSOLUTE.test(text!)) {
          offenders.push(`${card.tier}/${key}: "${text!.trim()}" but the limit is "${limit}"`);
        }
      }
    }
    expect(offenders, `absolute claim over a limited tier:\n${offenders.join('\n')}`).toEqual([]);
  });

  // S-audit iteration 8: the rules above only inspect pricing <li> elements
  // carrying data-feature. The PROSE was unguarded, and it claimed "Search
  // every past run forever" — false on two counts, because retention-audit.ts
  // prunes terminal runs by BOTH a time window (default 90 days, free capped
  // at 30) and a count cap (default 1000 runs).
  //
  // `retention` carries a limit on every tier, so no permanence claim about
  // history is true anywhere on the page. "unlimited" is deliberately NOT
  // banned outright — "unlimited recurring schedules" is true, because
  // `scheduling` has no cap on any tier.
  it('makes no permanence claim about history that retention contradicts', () => {
    const retention = FEATURES.find((f) => f.key === 'retention');
    const everyTierCapped =
      retention !== undefined &&
      (['free', 'pro', 'team', 'enterprise'] as Tier[]).every((t) => Boolean(retention.tiers[t]?.limit));
    expect(everyTierCapped, 'retention is no longer capped on every tier — revisit this rule').toBe(true);

    const raw = readFileSync(PAGE, 'utf8')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    const text = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    const PERMANENCE = /\b(forever|never deleted|never expires?|permanently|kept for good|all time)\b/i;
    const hit = text.match(PERMANENCE);
    expect(hit?.[0] ?? null, `page claims permanence but retention prunes on every tier: "${hit?.[0] ?? ''}"`).toBeNull();

    // The README makes the same pitch to the same reader and carried the same
    // claim ("Search every past run forever"), so it is held to the same rule.
    const readme = readFileSync(README, 'utf8');
    const rHit = readme.match(PERMANENCE);
    expect(rHit?.[0] ?? null, `README claims permanence but retention prunes: "${rHit?.[0] ?? ''}"`).toBeNull();
  });

  // Caught a real defect the moment it was written: a new link used
  // var(--accent), which this palette does not define. An undefined custom
  // property fails SILENTLY — the browser drops the declaration and the
  // element inherits, so the page looks almost right and nothing errors.
  it('uses no CSS variable it does not define', () => {
    const html = readFileSync(PAGE, 'utf8');
    const defined = new Set([...html.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
    // Only bare var(--x). `var(--x, #fallback)` is deliberate and safe — the
    // first version of this test flagged one and was wrong.
    const used = new Set([...html.matchAll(/var\((--[a-z0-9-]+)\s*\)/g)].map((m) => m[1]!));
    expect(defined.size, 'no custom properties parsed — this guard is blind').toBeGreaterThan(5);
    const undefinedVars = [...used].filter((v) => !defined.has(v));
    expect(undefinedVars, `landing page uses undefined CSS variables: ${undefinedVars.join(', ')}`).toEqual([]);
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
