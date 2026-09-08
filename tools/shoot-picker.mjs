/**
 * The date-time picker, in WEBKIT — which is the point of this file.
 *
 * The Tauri window is a WKWebView. A native <select> there is a macOS popup
 * menu drawn by the OS: it ignores the theme, ignores dark mode, and is the
 * one part of the picker that was never ours. Chromium draws its own styled
 * dropdown instead, so the earlier pixel check passed while the reported fault
 * was still on screen. Any check of "does this look right" has to run in the
 * engine the app actually ships.
 *
 *   pnpm build
 *   ./node_modules/.bin/playwright install webkit     # once
 *   CLOCKWORK_HOME=/tmp/cw-probe-home CLOCKWORK_PORT=4790 node packages/daemon/dist/main.js &
 *   node tools/shoot-picker.mjs
 *
 * What it reports:
 *   nativeSelects  — must be empty.
 *   before/after   — the trigger label around picking 9 AM.
 *   popover still open after picking an hour — must be true. A Select renders
 *     its list in a portal outside the popover, so this is the interaction
 *     that would break first if the layer stacking ever changed.
 */
import { webkit } from 'playwright';
import { readFileSync } from 'node:fs';
const HOME = process.env.CLOCKWORK_HOME ?? '/tmp/cw-probe-home';
const PORT = process.env.CLOCKWORK_PORT ?? '4790';
const token = readFileSync(`${HOME}/api-token`, 'utf8').trim();
const b = await webkit.launch();
const c = await b.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:2});
const p = await c.newPage();
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'domcontentloaded'});
await p.evaluate(t=>localStorage.setItem('clockwork.token',t), token);
await p.reload({waitUntil:'domcontentloaded'});
await p.getByRole('button',{name:/new task/i}).first().click({timeout:10000});
await p.waitForSelector('#c-prompt',{timeout:12000});
await p.getByRole('button',{name:/got it/i}).click({timeout:1500}).catch(()=>{});
await p.waitForTimeout(800);
console.log('before:', (await p.locator('#c-when').textContent()).trim());
await p.locator('#c-when').click();
await p.waitForTimeout(700);
await p.screenshot({path:'/tmp/picker-open.png'});
// THE test: choosing an hour must not dismiss the popover.
await p.locator('[data-testid="dtp-hour"]').click();
await p.waitForTimeout(600);
await p.screenshot({path:'/tmp/picker-hourlist.png'});
console.log('native selects in the picker:', await p.locator('select').count());
await p.getByRole('option', { name: '9 AM', exact: true }).click();
await p.waitForTimeout(700);
const stillOpen = await p.locator('[data-testid="dtp-minute"]').isVisible().catch(()=>false);
console.log('popover still open after picking an hour:', stillOpen);
console.log('after:', (await p.locator('#c-when').textContent()).trim());
await p.screenshot({path:'/tmp/picker-after.png'});
await b.close();
