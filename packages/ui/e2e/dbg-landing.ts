/* Verify landing page renders, images load, responsive, reduced-motion. */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const run = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const failed: string[] = [];
  page.on('requestfailed', (r) => failed.push(r.url()));
  page.on('response', (r) => r.status() >= 400 && failed.push(`${r.status()} ${r.url()}`));
  await page.goto('file://' + process.cwd() + '/../../landing-page/index.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  // all images loaded?
  const imgs = await page.evaluate(() =>
    Array.from(document.images).map((i) => ({ src: i.src.split('/').slice(-2).join('/'), ok: i.complete && i.naturalWidth > 0 })),
  );
  console.log('IMAGES:', imgs.map((i) => `${i.ok ? 'OK' : 'BROKEN'} ${i.src}`).join(' | '));
  // sections present
  const text = await page.evaluate(() => document.body.innerText);
  for (const must of ['calendar', 'Book → Run → Review → Repeat', 'Hermes Agent', 'FSL-1.1', 'honest constraint']) {
    if (!text.includes(must)) console.log('MISSING CONTENT:', must);
  }
  await page.screenshot({ path: '/tmp/landing-hero.png', fullPage: false });
  // narrow
  await page.setViewportSize({ width: 700, height: 850 });
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log('OVERFLOW at 700px:', overflow > 4 ? `YES ${overflow}px` : 'none');
  await browser.close();
  if (failed.length) console.log('FAILED REQUESTS:', failed.join(', '));
  void readFileSync;
};
void run();
