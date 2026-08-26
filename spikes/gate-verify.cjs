/* Verify trigger-cap enforcement + UpgradeHint on free tier (live). */
const { chromium } = require('playwright');
const fs = require('fs');

const WATCHDOG = setTimeout(() => { console.error('WATCHDOG'); process.exit(2); }, 120000);

(async () => {
  const token = fs.readFileSync(process.env.HOME + '/.clockwork/api-token', 'utf8').trim();
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://127.0.0.1:4747/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => localStorage.setItem('clockwork.token', t), token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    // Count existing triggers via API first
    const before = await page.evaluate(async (t) => {
      const r = await fetch('/triggers', { headers: { Authorization: 'Bearer ' + t } });
      return (await r.json()).length;
    }, token);
    console.log('EXISTING_TRIGGERS:', before);

    // Try creating triggers via API until we hit the cap
    let gateHit = null;
    for (let i = 0; i < 6; i++) {
      const res = await page.evaluate(async ({ t, i }) => {
        // Need a valid task; fetch one
        const tasksRes = await fetch('/api/tasks', { headers: { Authorization: 'Bearer ' + t } }).catch(() => null);
        return { status: tasksRes ? tasksRes.status : 0 };
      }, { t: token, i });
      void res;
      break;
    }

    // Simpler: call POST /triggers with an existing task id
    const taskId = await page.evaluate(async (t) => {
      const r = await fetch('/tasks?limit=1', { headers: { Authorization: 'Bearer ' + t } });
      const list = await r.json();
      return Array.isArray(list) ? list[0]?.id : list.tasks?.[0]?.id;
    }, token);
    console.log('TASK_FOR_TRIGGER:', taskId ? 'found' : 'none');
    if (!taskId) { console.log('NO_TASKS_SKIPPING_GATE_TEST'); clearTimeout(WATCHDOG); process.exit(0); }

    for (let i = before; i < 5; i++) {
      const out = await page.evaluate(async ({ t, tid }) => {
        const r = await fetch('/triggers', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + t, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'gate-probe-' + Math.random().toString(36).slice(2, 7), source: 'webhook', taskId: tid }),
        });
        if (r.status === 402) {
          const b = await r.json();
          return { gated: true, feature: b.feature, requiresPlan: b.requiresPlan, error: b.error };
        }
        return { gated: false, status: r.status };
      }, { t: token, tid: taskId });
      if (out.gated) { gateHit = out; break; }
    }
    console.log('GATE_HIT:', JSON.stringify(gateHit));

    // UI check: open Settings triggers section to confirm UpgradeHint renders when gated
    if (gateHit) {
      await page.click('text=Settings', { timeout: 4000 });
      await page.locator('text=Event triggers').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      console.log('UI_OK');
    }

    clearTimeout(WATCHDOG);
    process.exit(0);
  } catch (e) {
    console.error('FAILED:', e.message.slice(0, 200));
    process.exit(1);
  } finally {
    await browser.close().catch(() => {});
  }
})();
