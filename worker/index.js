/**
 * Clockwork site Worker — static assets plus one endpoint: POST /subscribe.
 *
 * Why this exists: the app ships with zero telemetry and the site had no form,
 * so a launch could send thousands of visitors and leave no way to reach any of
 * them again. This is the smallest thing that fixes that without breaking the
 * privacy promise: one opt-in field, one stored value, nothing observed.
 *
 * What it stores: the email address, and when it was submitted. Nothing else —
 * no IP, no user agent, no referrer, no cookie, no analytics beacon. The app's
 * "we collect nothing" claim is unchanged; this is the website, and it only
 * gets an address if someone types one in and presses a button.
 *
 * Degrades safely. If the SUBSCRIBERS KV binding is missing (namespace not
 * created yet), /subscribe returns 503 with a JSON reason and the page falls
 * back to a mailto link. Static assets keep serving either way, so a
 * half-configured deploy can never take the site down.
 */

const MAX_EMAIL = 254;
// Deliberately loose. Address syntax is famously hard to validate; the goal is
// to reject obvious junk, not to adjudicate RFC 5322.
const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/;

const ALLOWED_ORIGINS = new Set([
  'https://clockwork.vmoksh-shah179.workers.dev',
  'https://vimoxshah.github.io',
]);

function cors(origin) {
  const h = {
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
  // The site is served from two hosts, so echo only origins we recognise
  // rather than using a wildcard.
  if (origin && ALLOWED_ORIGINS.has(origin)) h['access-control-allow-origin'] = origin;
  return h;
}

const json = (obj, status, origin) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors(origin) },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');

    if (url.pathname !== '/subscribe') {
      // Everything else is the static site.
      return env.ASSETS.fetch(request);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if (request.method !== 'POST') {
      return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
    }

    let email = '';
    try {
      const body = await request.json();
      email = String(body?.email ?? '').trim().toLowerCase();
    } catch {
      return json({ ok: false, error: 'bad_json' }, 400, origin);
    }

    if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
      return json({ ok: false, error: 'invalid_email' }, 400, origin);
    }

    // No namespace bound yet — say so honestly instead of pretending to store it.
    if (!env.SUBSCRIBERS) {
      return json({ ok: false, error: 'storage_unconfigured' }, 503, origin);
    }

    try {
      // Key on the address so a double submit overwrites rather than duplicates.
      const existing = await env.SUBSCRIBERS.get(`sub:${email}`);
      if (!existing) {
        await env.SUBSCRIBERS.put(
          `sub:${email}`,
          JSON.stringify({ email, at: new Date().toISOString() }),
        );
      }
      return json({ ok: true, already: Boolean(existing) }, 200, origin);
    } catch {
      return json({ ok: false, error: 'store_failed' }, 500, origin);
    }
  },
};
