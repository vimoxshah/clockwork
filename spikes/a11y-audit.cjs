/* Accessibility audit (§30): labels, accessible names, dialog semantics,
   contrast — over the live app's redesigned surfaces. No new deps. */
const { chromium } = require('playwright');
const fs = require('fs');

const WATCHDOG = setTimeout(() => { console.error('WATCHDOG'); process.exit(2); }, 90000);

function luminance(r, g, b) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(c1, c2) {
  const [a, b] = [luminance(...c1), luminance(...c2)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

(async () => {
  const token = fs.readFileSync(process.env.HOME + '/.clockwork/api-token', 'utf8').trim();
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://127.0.0.1:4747/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => localStorage.setItem('clockwork.token', t), token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.click('text=Settings');
    await page.waitForTimeout(600);

    // 1. Accessible names on all buttons
    const unnamed = await page.evaluate(() =>
      [...document.querySelectorAll('button')].filter((b) =>
        !(b.textContent || '').trim() && !b.getAttribute('aria-label') && !b.getAttribute('title'),
      ).map((b) => b.className.slice(0, 40)),
    );
    console.log('BUTTONS_WITHOUT_NAME:', JSON.stringify(unnamed));

    // 2. Label association for inputs inside the settings view
    const orphanInputs = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('.settings-view input:not([type=checkbox]):not([type=radio]), .settings-view select').forEach((el) => {
        if (el.type === 'hidden') return;
        const id = el.id;
        const hasLabel = id && document.querySelector(`label[for="${id}"]`);
        const wrapped = el.closest('label');
        const aria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
        if (!hasLabel && !wrapped && !aria) out.push(el.tagName + '.' + String(el.className).slice(0, 25));
      });
      return out;
    });
    console.log('ORPHAN_FORM_FIELDS:', JSON.stringify(orphanInputs));

    // 3. Open the connect dialog: role/name semantics
    await page.click('[data-testid="connect-provider-btn"]');
    await page.waitForTimeout(400);
    const dlgSemantics = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="provider-connect-flow"]')?.closest('[role="dialog"], dialog');
      if (!d) return 'NO-DIALOG-ROLE';
      const named = d.getAttribute('aria-label') || (d.querySelector('h1,h2,[id]')
        ? document.getElementById(d.getAttribute('aria-labelledby') ?? '')?.textContent : null);
      return named ? `role=dialog name=${named.trim().slice(0, 40)}` : 'DIALOG_UNNAMED';
    });
    console.log('CONNECT_DIALOG_SEMANTICS:', dlgSemantics);

    // 4. Contrast of body text + dim text against effective backgrounds
    const contrasts = await page.evaluate(() => {
      const lum = (r, g, b) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (fg, bg) => {
        const [a, b] = [lum(...fg), lum(...bg)].sort((x, y) => y - x);
        return (a + 0.05) / (b + 0.05);
      };
      function effBg(el) {
        let n = el;
        while (n && n !== document.documentElement) {
          const bg = getComputedStyle(n).backgroundColor;
          if (bg && !bg.includes('0, 0, 0, 0') && bg !== 'transparent') return bg;
          n = n.parentElement;
        }
        return 'rgb(255, 255, 255)';
      }
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const fg = getComputedStyle(el).color.match(/\d+/g).slice(0, 3).map(Number);
        const bg = effBg(el).match(/\d+/g).slice(0, 3).map(Number);
        return { sel, ratio: +ratio(fg, bg).toFixed(2) };
      };
      return ['.settings-view', '.section-title', '.hint', '.text-dim', 'body']
        .map(pick).filter(Boolean);
    });
    console.log('CONTRAST:', JSON.stringify(contrasts));
    const lowContrast = contrasts.filter((c) => c.ratio < 4.5);
    console.log('WCAG_AA_FAILURES:', lowContrast.length === 0 ? 'none' : JSON.stringify(lowContrast));

    clearTimeout(WATCHDOG);
    process.exit(0);
  } catch (e) {
    console.error('FAILED:', e.message.slice(0, 200));
    process.exit(1);
  } finally {
    await browser.close().catch(() => {});
  }
})();
