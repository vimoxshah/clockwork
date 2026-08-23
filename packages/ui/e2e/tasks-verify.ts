/* Verify Tasks page: full-width grid layout, search works across fields, filters, sort. */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();
const issues: string[] = [];
const note = (m: string): void => { issues.push(m); console.log('ISSUE:', m); };
const run = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  page.on('pageerror', (e) => note(`PAGEERROR: ${e.message.slice(0, 150)}`));
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.goto('http://127.0.0.1:4747', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Tasks', exact: true }).first().click();
  await page.waitForTimeout(1000);

  // 1. full-width utilization
  const widths = await page.evaluate(() => {
    const page_ = document.querySelector('.tasks-page') as HTMLElement | null;
    const grid = document.querySelector('.tasklist') as HTMLElement | null;
    return {
      pageW: page_?.getBoundingClientRect().width ?? 0,
      windowW: document.documentElement.clientWidth,
      gridCols: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
    };
  });
  console.log('LAYOUT:', JSON.stringify(widths));
  if (widths.pageW < widths.windowW * 0.9) note(`tasks page only ${Math.round(100*widths.pageW/widths.windowW)}% of window width`);
  if (widths.gridCols < 2) note(`grid has ${widths.gridCols} column(s) at 1600px — expected ≥2`);

  // 2. search works — by name substring
  await page.fill('[data-testid=task-filter]', 'hermes');
  await page.waitForTimeout(300);
  const n1 = await page.locator('.tasklist .tasklist-row').count();
  console.log('search "hermes":', n1, 'rows');
  if (n1 < 1) note('search "hermes" found nothing');
  // by provider engine field
  await page.fill('[data-testid=task-filter]', 'opencode');
  await page.waitForTimeout(300);
  const n2 = await page.locator('.tasklist .tasklist-row').count();
  console.log('search "opencode":', n2, 'rows');
  // no-match state + clear button
  await page.fill('[data-testid=task-filter]', 'zzz-nothing');
  await page.waitForTimeout(300);
  const emptyShown = await page.locator('.empty').count() > 0;
  console.log('no-match empty state:', emptyShown);
  if (!emptyShown) note('no-match state missing');
  await page.fill('[data-testid=task-filter]', '');
  await page.waitForTimeout(300);

  // 3. status filter
  await page.getByRole('tab', { name: 'paused' }).click();
  await page.waitForTimeout(250);
  console.log('paused tab rows:', await page.locator('.tasklist .tasklist-row').count());
  await page.getByRole('tab', { name: 'all' }).click();

  // 4. sort select exists and changes order
  const firstBefore = await page.locator('.tasklist .tasklist-row strong').first().innerText();
  await page.selectOption('select[aria-label="Sort tasks"]', 'name');
  await page.waitForTimeout(300);
  const firstAfter = await page.locator('.tasklist .tasklist-row strong').first().innerText();
  console.log('sort change:', JSON.stringify({ firstBefore, firstAfter }));
  if (firstBefore === firstAfter) note('sort did not change first row');

  // count chip present
  console.log('COUNT CHIP:', await page.locator('[data-testid=task-count]').count() > 0);
  await page.screenshot({ path: '/tmp/tasks-redesign.png' });
  await browser.close();
  console.log('\n=== RESULT:', issues.length === 0 ? 'NO ISSUES' : `${issues.length} ISSUES`);
};
void run();
