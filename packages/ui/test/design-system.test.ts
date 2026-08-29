/**
 * Design-system guards (gauntlet §38). S-review (Hermes): "0 arbitrary
 * values" only stays true if something enforces it — otherwise the next
 * component reintroduces text-[13px] and the scale rots.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx') || p.endsWith('.ts')) out.push(p);
  }
  return out;
};

describe('type scale', () => {
  const files = walk(SRC);

  it('has no arbitrary font sizes — every size comes from the scale', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      src.split('\n').forEach((line, i) => {
        const m = line.match(/text-\[\d+(\.\d+)?px\]/g);
        if (m) offenders.push(`${f.replace(SRC, 'src')}:${i + 1} ${m.join(' ')}`);
      });
    }
    expect(offenders, `Use a scale token (text-micro/xxs/caption/compact/sm/base) instead:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('does not reintroduce a second spelling for a scale size', () => {
    // 11px is text-xxs and 13px is text-compact. A raw arbitrary value for either
    // is the exact duplication this sweep removed.
    const dupes: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (/text-\[(11|13)px\]/.test(src)) dupes.push(f.replace(SRC, 'src'));
    }
    expect(dupes).toEqual([]);
  });
});
