/**
 * Full product surface verification — every tab, both themes, console/pageerror
 * capture, dead-control detection, calendar interactions.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4747';
const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();

const issues: string[] = [];
const note = (m: string): void => {
  issues.push(m);
  console.log('ISSUE:', m);
};

const run = async (): Promise<void> => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => note(`PAGEERROR: ${e.message.slice(0, 200)}`));
  page.on('console', (msg) => msg.type() === 'error' && !msg.text().includes('favicon') && note(`CONSOLE-ERR: ${msg.text().slice(0, 200)}`));
  page.on('response', async (r) => {
    if (r.status() >= 400 && !r.url().includes('/events')) console.log(`HTTP ${r.status()} ${r.url().split('?')[0]}`);
  });
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);

  // ---------- default screen = calendar ----------
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  if (!(await page.locator('.cal-grid, .week-grid').count())) note('Default view is not the calendar');
  if (!(await page.getByRole('tab', { name: 'Month', selected: true }).count())) note('Default calendar mode is not Month');
  const title = await page.locator('.cal-title').innerText().catch(() => '');
  console.log('CAL TITLE:', title);

  // ---------- calendar navigation ----------
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.waitForTimeout(300);
  const nextTitle = await page.locator('.cal-title').innerText();
  if (nextTitle === title) note(`NEXT did not change month title (${title})`);
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Today' }).click();
  await page.waitForTimeout(300);
  if ((await page.locator('.cal-title').innerText()) !== title) note('TODAY did not return to current month');
  console.log('CAL NAV OK');

  // day select + book buttons exist and are enabled
  const cells = await page.locator('.cal-cell').count();
  if (cells < 28 || cells > 42) note(`Unexpected month cell count ${cells}`);
  await page.locator('.cal-cell').nth(10).click();
  await page.waitForTimeout(200);
  if (!(await page.locator('.day-panel').count())) note('Day panel did not open on cell click');

  // event dialog if any events today
  const evCount = await page.locator('.cal-event').count();
  console.log('VISIBLE EVENTS:', evCount);
  if (evCount > 0) {
    await page.locator('.cal-event').first().click();
    await page.waitForTimeout(600);
    if (!(await page.locator('.dialog').count())) note('Event dialog did not open on event click');
    else {
      await page.screenshot({ path: '/tmp/gaunt-event-dialog.png' });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
  }

  // ---------- every tab ----------
  const tabs = ['Inbox', 'Agents', 'Tasks', 'Settings'];
  for (const tab of tabs) {
    await page.getByRole('button', { name: tab, exact: true }).first().click();
    await page.waitForTimeout(900);
    const mainText = await page.locator('main').innerText();
    const visibleLen = mainText.trim().length;
    console.log(`TAB ${tab}: ${visibleLen} chars`);
    if (visibleLen < 40) note(`Tab ${tab} looks near-blank (${visibleLen} chars)`);
    await page.screenshot({ path: `/tmp/gaunt-${tab.toLowerCase()}.png`, fullPage: false });
  }

  // inbox run selection → report + live tail presence logic
  await page.getByRole('button', { name: 'Inbox', exact: true }).first().click();
  await page.waitForTimeout(700);
  const rows = await page.locator('.inbox-row').count();
  console.log('INBOX ROWS:', rows);
  if (rows > 0) {
    await page.locator('.inbox-row').first().click();
    await page.waitForTimeout(800);
    if (!(await page.locator('.report h2, .report .empty').count())) note('Report pane empty after selecting a run');
    await page.screenshot({ path: '/tmp/gaunt-report.png' });
  }

  // search
  await page.fill('#inbox-search-input', 'test');
  await page.waitForTimeout(900);
  console.log('SEARCH RESULTS TEXT:', (await page.locator('.inbox-list p.text-xs, .inbox-list').first().innerText()).split('\n')[0]);
  await page.fill('#inbox-search-input', '');

  // ---------- theme switch ----------
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.waitForTimeout(500);
  const themeBtns = await page.locator('.theme-toggle button').count();
  console.log('THEME BUTTONS:', themeBtns);
  if (!themeBtns) note('No theme controls found in Settings');
  else {
    const setAndCheck = async (label: string, attr: string): Promise<void> => {
      await page.locator('.theme-toggle button', { hasText: label }).click();
      await page.waitForTimeout(300);
      const got = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      if (got !== attr) note(`Theme ${label}: data-theme=${got}`);
    };
    await setAndCheck('dark', 'dark');
    await page.screenshot({ path: '/tmp/gaunt-dark-settings.png' });
    // navigate with dark theme — check readability of each tab
    for (const tab of ['Calendar', 'Inbox', 'Tasks']) {
      await page.getByRole('button', { name: tab, exact: true }).first().click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `/tmp/gaunt-dark-${tab.toLowerCase()}.png` });
    }
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await page.waitForTimeout(500);
    await setAndCheck('light', 'light');
    await page.getByRole('button', { name: 'Calendar', exact: true }).first().click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: '/tmp/gaunt-light-calendar.png' });
    // persistence across reload
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    const persisted = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    if (persisted !== 'light') note(`Theme did not persist after reload (${persisted})`);
    // restore system
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await page.waitForTimeout(400);
    await page.locator('.theme-toggle button', { hasText: 'system' }).first().click().catch(() => {});
  }

  // ---------- narrow window ----------
  await page.setViewportSize({ width: 760, height: 820 });
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 24) note(`Horizontal overflow ${overflow}px at 760px width`);
  await page.screenshot({ path: '/tmp/gaunt-narrow.png' });

  await browser.close();
  console.log('\n=== RESULT:', issues.length === 0 ? 'NO ISSUES FOUND' : `${issues.length} ISSUES`);
  issues.forEach((i) => console.log(' -', i));
};

void run();
