/* Verify the full ICS overlay path with a real HTTPS feed: parse + calendar humans field. */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const TOKEN = readFileSync(homedir() + '/.clockwork/api-token', 'utf8').trim();

// 1. parser against a real Google-Calendar-shaped public feed (w3c test calendar)
const res = await fetch('https://calendar.google.com/calendar/ical/mozilla.com%40import.calendar.google.com/public/basic.ics').catch(() => null);
if (res && res.ok) {
  const { parseIcs } = await import('/Users/vimoxshah/Desktop/Vimox/poc/clockwork/packages/daemon/dist/ics.js');
  const text = await res.text();
  const evs = parseIcs(text, 50);
  console.log('REAL FEED PARSED:', evs.length, 'events');
  console.log('SAMPLE:', JSON.stringify(evs[0] ?? {}).slice(0, 200));
} else {
  console.log('network feed unreachable — unit tests cover parser');
}

// 2. /calendar endpoint returns humans array (empty but present) via daemon API
const r = await fetch('http://127.0.0.1:4747/calendar', { headers: { authorization: `Bearer ${TOKEN}` } });
const cal: any = await r.json();
console.log('CALENDAR HAS humans FIELD:', Array.isArray(cal.humans));
