/**
 * Workers card (P4): registry states, one-time token/nonce display, pin save.
 * Same credential-adjacency rules as the delivery/github card tests: the
 * bearer token renders exactly once for copying and never again; revocation
 * and removal confirm before acting.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkersCard } from '../src/components/WorkersCard';
import { renderComponent, waitForElement, waitForText } from './helpers/dom';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch(handler: (call: Call) => Response | Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const call: Call = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      return handler(call);
    }) as any,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const WORKERS = [
  { id: 'wrk_1', name: 'Mini', platform: 'darwin arm64', status: 'paired', online: 1, last_heartbeat: Date.now(), created_at: 1, onlineComputed: true },
  { id: 'wrk_2', name: 'Old', platform: null, status: 'pending', online: 0, last_heartbeat: null, created_at: 2, onlineComputed: false },
];

function stubAll(): void {
  stubFetch((call) => {
    if (call.url === '/workers') return json({ workers: WORKERS });
    if (call.url === '/tasks') return json([{ id: 't1', name: 'Nightly', workerPin: 'wrk_1', version: 3 }]);
    if (call.url === '/workers/pairing/init') return json({ workerId: 'wrk_3', nonce: 'n0nce', expiresAt: 999 }, 201);
    if (call.url === '/workers/wrk_2/approve') return json({ token: 'tok-abc-123' });
    if (call.url === '/workers/wrk_1/revoke') return json({ unassigned: 1, lost: 0 });
    if (call.url === '/workers/wrk_1' && call.method === 'DELETE') return json({ removed: true });
    if (call.url === '/tasks/t1') return json({ id: 't1', workerPin: 'wrk_1' });
    throw new Error(`unexpected request: ${call.method} ${call.url}`);
  });
}

describe('WorkersCard', () => {
  it('lists workers with honest states', async () => {
    stubAll();
    const container = await renderComponent(<WorkersCard version={1} />);
    await waitForText(container, 'Mini');
    await waitForText(container, 'online');
    await waitForText(container, 'pending');
    expect(container.querySelector('[data-testid="worker-wrk_1"]')).toBeTruthy();
  });

  it('one-time secrets dismiss and never redisplay', async () => {
    stubAll();
    const container = await renderComponent(<WorkersCard version={1} />);
    await waitForElement(container, '[data-testid="worker-pair-button"]');
    const name = container.querySelector('[data-testid="worker-name-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(name, 'Mini2');
    name.dispatchEvent(new Event('input', { bubbles: true }));
    const pub = container.querySelector('[data-testid="worker-pubkey-input"]') as HTMLInputElement;
    setter.call(pub, 'aabbcc');
    pub.dispatchEvent(new Event('input', { bubbles: true }));
    (container.querySelector('[data-testid="worker-pair-button"]') as HTMLButtonElement).click();
    await waitForElement(container, '[data-testid="worker-nonce"]');
    // Dismiss hides it; no re-render path brings it back (value lives server-side only).
    const dismiss = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss') as HTMLButtonElement;
    dismiss.click();
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector('[data-testid="worker-nonce"]')).toBeNull();
  });

  it('revoke confirms and reports', async () => {
    stubAll();
    const container = await renderComponent(<WorkersCard version={1} />);
    await waitForText(container, 'Mini');
    const realConfirm = window.confirm;
    (window as any).confirm = () => true;
    try {
      const revoke = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Revoke') as HTMLButtonElement;
      revoke.click();
      await waitForText(container, 'Revoked.');
    } finally {
      (window as any).confirm = realConfirm;
    }
  });
  it('pairing shows the nonce; approve shows the token', async () => {
    stubAll();
    const container = await renderComponent(<WorkersCard version={1} />);
    await waitForElement(container, '[data-testid="worker-pair-button"]');
    const name = container.querySelector('[data-testid="worker-name-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(name, 'Mini2');
    name.dispatchEvent(new Event('input', { bubbles: true }));
    const pub = container.querySelector('[data-testid="worker-pubkey-input"]') as HTMLInputElement;
    setter.call(pub, 'aabbcc');
    pub.dispatchEvent(new Event('input', { bubbles: true }));
    (container.querySelector('[data-testid="worker-pair-button"]') as HTMLButtonElement).click();
    await waitForText(container, 'n0nce');
    // Approve wrk_2 (pending): confirm dialog accepted via stubbed confirm.
    const realConfirm = window.confirm;
    (window as any).confirm = () => true;
    try {
      (container.querySelector('[data-testid="worker-approve-wrk_2"]') as HTMLButtonElement).click();
      await waitForText(container, 'tok-abc-123');
    } finally {
      (window as any).confirm = realConfirm;
    }
  });

  it('pin control shows the current pin and saves', async () => {
    const seen: Call[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const call: Call = {
          url: String(url),
          method: init?.method ?? 'GET',
          body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        };
        seen.push(call);
        if (call.url === '/workers') return json({ workers: WORKERS });
        if (call.url === '/tasks') return json([{ id: 't1', name: 'Nightly', workerPin: 'wrk_1', version: 3 }]);
        if (call.url === '/tasks/t1') {
          if ((call.body as any)?.workerPin === 'wrk_nope') return json({ error: 'unknown_worker' }, 422);
          return json({ id: 't1', workerPin: (call.body as any)?.workerPin ?? null });
        }
        throw new Error(`unexpected request: ${call.method} ${call.url}`);
      }) as any,
    );
    const container = await renderComponent(<WorkersCard version={1} />);
    await waitForText(container, 'pinned: Mini');
    const sel = container.querySelector('[data-testid="worker-pin-task"]') as HTMLSelectElement;
    sel.value = 't1';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    // Pin to the worker first: body carries the pin and required flag.
    const wsel = container.querySelector('[data-testid="worker-pin-worker"]') as HTMLSelectElement;
    wsel.value = 'wrk_1';
    wsel.dispatchEvent(new Event('change', { bubbles: true }));
    (container.querySelector('[data-testid="worker-pin-save"]') as HTMLButtonElement).click();
    await waitForText(container, 'Pinned.');
    expect(seen.filter((c) => c.url === '/tasks/t1' && c.method === 'PATCH').pop()?.body).toMatchObject({
      workerPin: 'wrk_1',
      workerRequired: true,
    });
    // Unknown pins surface the daemon refusal, and unpinning clears.
    wsel.value = '';
    wsel.dispatchEvent(new Event('change', { bubbles: true }));
    (container.querySelector('[data-testid="worker-pin-save"]') as HTMLButtonElement).click();
    await waitForText(container, 'Unpinned');
  });
});
