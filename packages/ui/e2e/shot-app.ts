// shot-app: verify the APP is full-bleed at 1600px and capture screenshots.
import { chromium } from 'playwright';
import { readFileSync, realpathSync } from 'node:fs';

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto('http://127.0.0.1:4747/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const tok = readFileSync(realpathSync(process.env.HOME + '/.clockwork/api-token'), 'utf8').trim();
  await page.evaluate((t) => localStorage.setItem('clockwork.token', t), tok);
  await page.reload({ waitUntil: 'networkidle' });

  for (const tab of ['settings', 'agents', 'tasks']) {
    await page.goto(`http://127.0.0.1:4747/#${tab}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const mainBox = (await page.locator('main.main').boundingBox()) ?? { width: 0 };
    const inner = await page.evaluate(() => {
      const m = document.querySelector('main.main');
      if (!m) return 0;
      let w = 0;
      for (const el of Array.from(m.children)) {
        const r = el.getBoundingClientRect();
        if (r.width > w) w = r.width;
      }
      return Math.round(w);
    });
    console.log(`${tab}: main=${Math.round(mainBox.width)} content=${inner}`);
  }

  await page.goto('http://127.0.0.1:4747/#settings', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/app-settings.png' });
  await page.goto('http://127.0.0.1:4747/#agents', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/app-agents.png' });
  await browser.close();
}
void main();
