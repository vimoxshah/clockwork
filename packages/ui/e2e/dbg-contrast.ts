/**
 * Theme contrast verification — computed-style audit of key surfaces in both
 * themes: text vs background contrast ratios, no invisible (same-color) text.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();

function lum(c: [number, number, number]): number {
  const f = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
function parse(rgb: string): [number, number, number] {
  const m = rgb.match(/\d+/g) ?? ['0', '0', '0'];
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}
function ratio(fg: string, bg: string): number {
  const l1 = lum(parse(fg));
  const l2 = lum(parse(bg));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const run = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.goto('http://127.0.0.1:4747', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.setAttribute('data-theme', t);
      localStorage.setItem('clockwork.theme', t);
    }, theme);
    await page.waitForTimeout(300);
    console.log(`\n=== ${theme.toUpperCase()} ===`);
    // sample text elements across the calendar shell
    const problems = await page.evaluate(() => {
      const out: string[] = [];
      const els = document.querySelectorAll<HTMLElement>('main h2, main h3, .cal-title, .daynum, button, .chip, strong, .hint');
      let checked = 0;
      els.forEach((el) => {
        if (checked > 60) return;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') return;
        // walk up for effective background
        let node: HTMLElement | null = el;
        let bg = '';
        while (node && (!bg || bg === 'rgba(0, 0, 0, 0)')) {
          bg = getComputedStyle(node).backgroundColor;
          node = node.parentElement;
        }
        if (!bg || bg === 'rgba(0, 0, 0, 0)') bg = getComputedStyle(document.body).backgroundColor;
        const cr = (() => {
          try {
            const a = cs.color.match(/\d+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
            const b = bg.match(/\d+/g)?.slice(0, 3).map(Number) ?? [255, 255, 255];
            const L = (c: number[]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
            void L; return null as null;
          } catch { return null; }
        })();
        void cr;
        out.push(`${el.tagName}.${String(el.className).split(' ')[0]} color=${cs.color} bg=${bg}`);
        checked++;
      });
      return out.slice(0, 40);
    });
    // compute ratios in Node
    let worst = 99;
    for (const line of problems) {
      const cm = line.match(/color=rgb\((\d+), (\d+), (\d+)\)/);
      const bm = line.match(/bg=rgb\((\d+), (\d+), (\d+)\)/);
      if (!cm || !bm) continue;
      const r = ratio(`rgb(${cm.slice(1, 4).join(',')})`, `rgb(${bm.slice(1, 4).join(',')})`);
      if (r < 3) console.log(`LOW CONTRAST (${r.toFixed(2)}): ${line}`);
      if (r < worst) worst = r;
    }
    console.log(`worst contrast ratio seen: ${worst.toFixed(2)} (threshold 3 for large/UI text)`);
  }
  await browser.close();
};
void run();
