/**
 * The ICS scheme check must survive a redirect.
 *
 * fetchIcs validates `https://` once, BEFORE the request. Node's fetch follows
 * redirects by default (verified separately), so an https feed that 302s to
 * http:// was still fetched — the classic SSRF shape, and how a plain-HTTP
 * internal endpoint becomes reachable from the daemon.
 *
 * Threat model, stated honestly: on this product the ICS URL is typed by the
 * human into Settings and the daemon binds loopback only, so there is no
 * remote attacker today. The one semi-trusted party — an agent inside a run —
 * lost API access when the control-plane escape was closed. This is therefore
 * a latent issue rather than a live one, fixed because the fix costs nothing:
 * a real calendar feed never needs to downgrade to http.
 */
import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import { fetchIcs } from '../src/ics.js';

const servers: http.Server[] = [];
const listen = async (h: http.RequestListener): Promise<number> => {
  const s = http.createServer(h);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as { port: number }).port;
};
afterAll(() => servers.forEach((s) => s.close()));

describe('ICS feed fetching', () => {
  it('refuses a plain http URL outright', async () => {
    const r = await fetchIcs('http://127.0.0.1:1/whatever.ics');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/only https/i);
  });

  it('refuses file:// and other schemes', async () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com/a.ics', 'gopher://x/1']) {
      const r = await fetchIcs(u);
      expect(r.ok, `${u} was accepted`).toBe(false);
    }
  });

  // These reach the POST-REDIRECT branch by injecting a fetch whose Response
  // reports a different final URL — exactly what a 302 produces. The earlier
  // version of these tests used http entry points, so the outer guard fired
  // first and the redirect check was never executed; deleting that check left
  // them green. Caught by planting.
  const ICS = 'BEGIN:VCALENDAR\nEND:VCALENDAR\n';
  const respFrom = (finalUrl: string): typeof fetch =>
    (async () => Object.defineProperty(new Response(ICS, { status: 200 }), 'url', { value: finalUrl })) as unknown as typeof fetch;

  it('rejects an https feed that redirected down to http', async () => {
    const r = await fetchIcs('https://calendar.example.com/f.ics', 5000, respFrom('http://169.254.169.254/latest/meta-data/'));
    expect(r.ok, 'a downgraded redirect was accepted').toBe(false);
    expect(r.error).toMatch(/redirected away from https/i);
    expect(r.events).toBeUndefined();
  });

  it('still accepts an https feed that redirects to another https URL', async () => {
    const r = await fetchIcs('https://calendar.example.com/f.ics', 5000, respFrom('https://cdn.example.com/f.ics'));
    expect(r.ok, 'a legitimate https->https redirect was rejected').toBe(true);
  });
});
