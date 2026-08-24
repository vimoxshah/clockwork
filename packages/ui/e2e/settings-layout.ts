import { chromium } from 'playwright';
async function main(): Promise<void> {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  await page.goto('http://127.0.0.1:4747/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  const cal = page.locator('.live-cal');
  console.log('live-cal present:', (await cal.count()) === 1);
  console.log('today cell:', await page.locator('.live-cal td.today').textContent().catch(() => 'none'));
  console.log('chips:', await page.locator('.live-cal .chip').count());
  await page.screenshot({ path: '/tmp/landing-new.png', fullPage: false });
  await browser.close();
  console.log('screenshot saved');
}
void main();
