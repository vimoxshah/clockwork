/* 500+ task scalability benchmark: seed synthetic tasks, measure real UI render + filter latency. */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();
const BASE = 'http://127.0.0.1:4747';
const api = async (m: string, p: string, b?: unknown): Promise<any> => {
  const r = await fetch(`${BASE}${p}`, { method: m, headers: { authorization: `Bearer ${TOKEN}`, ...(b ? { 'content-type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined });
  return r.json();
};
const NAMES = ['dep-surgeon nightly', 'flaky-test sweep', 'docs drift check', 'security audit', 'release notes', 'ci triage', 'refactor pass', 'backup verify'];
const run = async (): Promise<void> => {
  // seed
  const t0 = Date.now();
  const created: string[] = [];
  for (let i = 0; i < 1000; i++) {
    const name = `${NAMES[i % NAMES.length]} #${i}`;
    const res = await api('POST', '/tasks', {
      name,
      prompt: `Synthetic scalability task ${i}. ${i % 7 === 0 ? 'SPECIAL-MARKER-XYZ' : 'Do the routine check.'}`,
      repoPath: '',
      permissionMode: 'default',
      budget: { maxUsd: 0.5, maxTurns: 4, timeoutSec: 300 },
      schedule: { kind: 'rrule', rrule: 'FREQ=WEEKLY;BYDAY=MO', tz: 'Asia/Kolkata' },
    });
    if (res.id) created.push(res.id);
    else if (i < 3) console.log('seed fail:', JSON.stringify(res).slice(0, 150));
  }
  console.log(`SEEDED ${created.length} tasks in ${Date.now() - t0}ms`);

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 120)));
  await page.addInitScript((t) => localStorage.setItem('clockwork.token', t), TOKEN);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const tNav = Date.now();
  await page.getByRole('button', { name: 'Tasks', exact: true }).first().click();
  await page.waitForSelector('.tasklist-row');
  console.log(`RENDER first paint of rows: ${Date.now() - tNav}ms`);
  await page.waitForTimeout(600);
  const rowCount = await page.locator('.tasklist-row').count();
  console.log('MOUNTED ROWS:', rowCount, '(windowed — not all 1000)');
  // filter latency (5 samples)
  for (const term of ['SPECIAL-MARKER-XYZ', '#999', 'security', 'zzz-nothing']) {
    const tf = Date.now();
    await page.fill('[data-testid=task-filter]', term);
    await page.waitForTimeout(120); // let react settle
    const count = await page.locator('.tasklist-row').count();
    console.log(`FILTER "${term}": ${Date.now() - tf}ms → ${count} rows`);
    await page.fill('[data-testid=task-filter]', '');
  }
  // status filter
  await page.getByRole('tab', { name: 'paused' }).click();
  await page.waitForTimeout(200);
  console.log('STATUS paused rows:', await page.locator('.tasklist-row').count());
  await page.getByRole('tab', { name: 'all' }).click();
  // memory rough
  const mem = await page.evaluate(() => (performance as any).memory?.usedJSHeapSize ?? null);
  if (mem) console.log('JS heap MB:', Math.round(mem / 1048576));
  // cleanup
  const tDel = Date.now();
  let del = 0;
  for (const id of created) { await api('DELETE', `/tasks/${id}`).catch(() => {}); del++; }
  console.log(`CLEANED ${del}/${created.length} in ${((Date.now() - tDel) / 1000).toFixed(0)}s`);
  await browser.close();
};
void run();
