/**
 * Workers card (P4): registry states, one-time token/nonce display, pin save.
 * Same credential-adjacency rules as the delivery/github card tests: the
 * bearer token renders exactly once for copying and never again; revocation
 * and removal confirm before acting.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkersCard } from '../src/components/WorkersCard';
import { renderComponent, waitFor, waitForElement, waitForText } from './helpers/dom';

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
    if (call.url === '/worker/status') return json({ joined: false, primaryHost: null, via: null });
    if (call.url === '/worker/identity') return json({ publicKeyHex: 'aa'.repeat(22) });
    throw new Error(`unexpected request: ${call.method} ${call.url}`);
  });
}

/**
 * .cred-row is a grid with ONE cell per named area (styles.css). Two direct
 * children that claim the same area stack in one cell and cover each other;
 * a child with no area falls into an implicit cell. That is how the name,
 * pubkey and join-URL inputs ended up unclickable (VERIFY-REPORT Bug 2).
 */
const AREAS = ['cred-label', 'cred-field', 'cred-hint', 'cred-extra', 'cred-actions'];
function layoutFaults(container: HTMLElement): string[] {
  const faults: string[] = [];
  container.querySelectorAll('.cred-row').forEach((row, i) => {
    const taken = new Set<string>();
    for (const child of [...row.children]) {
      const what = `<${child.tagName.toLowerCase()} ${child.getAttribute('data-testid') ?? child.className}>`;
      const areas = AREAS.filter((a) => child.classList.contains(a));
      if (areas.length !== 1) {
        faults.push(`row ${i}: ${what} claims ${areas.length} grid areas`);
        continue;
      }
      if (taken.has(areas[0]!)) faults.push(`row ${i}: ${what} shares the ${areas[0]} cell`);
      taken.add(areas[0]!);
    }
  });
  return faults;
}

describe('WorkersCard', () => {
  it('every cred-row child owns its own grid cell, so no input covers another', async () => {
    stubAll();
    const container = await renderComponent(<WorkersCard version={1} />);
    await waitForText(container, 'Mini');
    await waitForElement(container, '[data-testid="worker-join-status"]');
    expect(container.querySelectorAll('.cred-row').length).toBeGreaterThan(0);
    expect(layoutFaults(container)).toEqual([]);
    // Every text input and select still renders, inside a row's field cell.
    await waitForElement(container, '[data-testid="worker-identity-key"]');
    expect(layoutFaults(container)).toEqual([]);
    for (const id of [
      'worker-name-input',
      'worker-pubkey-input',
      'worker-pin-task',
      'worker-pin-worker',
      'worker-identity-key',
      'worker-claim-url',
      'worker-claim-nonce',
      'worker-join-url',
      'worker-join-token',
    ]) {
      const el = container.querySelector(`[data-testid="${id}"]`);
      expect(el, id).toBeTruthy();
      expect(el!.closest('.cred-row > .cred-field'), `${id} is outside a field cell`).toBeTruthy();
    }
  });

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
  it('shows this machine\'s public key for copying, and offers to create one when absent', async () => {
    stubAll();
    const container = await renderComponent(<WorkersCard version={1} />);
    const key = (await waitForElement(container, '[data-testid="worker-identity-key"]')) as HTMLInputElement;
    await waitForText(container, 'Copy key');
    expect(key.value).toBe('aa'.repeat(22));
    expect(key.readOnly).toBe(true);

    const calls: Call[] = [];
    let minted: string | null = null;
    stubFetch((call) => {
      calls.push(call);
      if (call.url === '/worker/identity') return json({ publicKeyHex: minted });
      if (call.url === '/worker/keygen') {
        minted = 'cc'.repeat(22);
        return json({ publicKeyHex: minted });
      }
      if (call.url === '/worker/status') return json({ joined: false, primaryHost: null, via: null });
      if (call.url === '/workers') return json({ workers: [] });
      if (call.url === '/tasks') return json([]);
      throw new Error(`unexpected request: ${call.method} ${call.url}`);
    });
    const fresh = await renderComponent(<WorkersCard version={2} />);
    const create = (await waitForElement(fresh, '[data-testid="worker-identity-create"]')) as HTMLButtonElement;
    // No confirm: there is no old key to lose.
    const realConfirm = window.confirm;
    (window as any).confirm = () => {
      throw new Error('first identity must not ask to replace a key');
    };
    try {
      create.click();
      await waitFor(
        () => (fresh.querySelector('[data-testid="worker-identity-key"]') as HTMLInputElement | null)?.value === 'cc'.repeat(22),
        'the new public key in the identity field',
      );
    } finally {
      (window as any).confirm = realConfirm;
    }
    expect(calls.some((c) => c.url === '/worker/keygen' && c.method === 'POST')).toBe(true);
  });

  it('claim signs on this daemon, then pre-fills Join with the same primary', async () => {
    const calls: Call[] = [];
    stubFetch((call) => {
      calls.push(call);
      if (call.url === '/worker/claim') return json({ ok: true, workerId: 'wrk_9', primaryHost: 'laptop:4882' });
      if (call.url === '/worker/identity') return json({ publicKeyHex: 'aa'.repeat(22) });
      if (call.url === '/worker/status') return json({ joined: false, primaryHost: null, via: null });
      if (call.url === '/workers') return json({ workers: [] });
      if (call.url === '/tasks') return json([]);
      throw new Error(`unexpected request: ${call.method} ${call.url}`);
    });
    const container = await renderComponent(<WorkersCard version={1} />);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    const url = (await waitForElement(container, '[data-testid="worker-claim-url"]')) as HTMLInputElement;
    const nonce = container.querySelector('[data-testid="worker-claim-nonce"]') as HTMLInputElement;
    const button = container.querySelector('[data-testid="worker-claim-button"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    setter.call(url, 'http://laptop:4882');
    url.dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(nonce, 'ab'.repeat(16));
    nonce.dispatchEvent(new Event('input', { bubbles: true }));
    expect(button.disabled).toBe(false);
    button.click();
    await waitForText(container, 'Claimed');
    expect(calls.find((c) => c.url === '/worker/claim')?.body).toEqual({ primaryUrl: 'http://laptop:4882', nonce: 'ab'.repeat(16) });
    expect((container.querySelector('[data-testid="worker-join-url"]') as HTMLInputElement).value).toBe('http://laptop:4882');
    // Nothing here pretends a token arrived: the primary still has to approve.
    expect(container.textContent).toMatch(/Approve/);
  });

  it('claim refusals from the primary read as what to do next', async () => {
    stubFetch((call) => {
      if (call.url === '/worker/claim') return json({ error: 'unknown_nonce', message: 'Unknown or already-used nonce' }, 422);
      if (call.url === '/worker/identity') return json({ publicKeyHex: 'aa'.repeat(22) });
      if (call.url === '/worker/status') return json({ joined: false, primaryHost: null, via: null });
      if (call.url === '/workers') return json({ workers: [] });
      if (call.url === '/tasks') return json([]);
      throw new Error(`unexpected request: ${call.method} ${call.url}`);
    });
    const container = await renderComponent(<WorkersCard version={1} />);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    const url = (await waitForElement(container, '[data-testid="worker-claim-url"]')) as HTMLInputElement;
    setter.call(url, 'http://laptop:4882');
    url.dispatchEvent(new Event('input', { bubbles: true }));
    const nonce = container.querySelector('[data-testid="worker-claim-nonce"]') as HTMLInputElement;
    setter.call(nonce, 'ab'.repeat(16));
    nonce.dispatchEvent(new Event('input', { bubbles: true }));
    (container.querySelector('[data-testid="worker-claim-button"]') as HTMLButtonElement).click();
    const err = await waitForElement(container, '[data-testid="worker-claim-error"]');
    expect(err.textContent).toContain('Nonces are single use');
    expect(err.textContent).toContain('unknown_nonce');
  });
  it('a failed identity load never offers to mint — that could replace a real key', async () => {
    stubFetch((call) => {
      if (call.url === '/worker/identity') return json({ error: 'boom' }, 500);
      if (call.url === '/worker/status') return json({ joined: false, primaryHost: null, via: null });
      if (call.url === '/workers') return json({ workers: [] });
      if (call.url === '/tasks') return json([]);
      throw new Error(`unexpected request: ${call.method} ${call.url}`);
    });
    const container = await renderComponent(<WorkersCard version={1} />);
    await waitForElement(container, '[data-testid="worker-identity-error"]');
    expect(container.querySelector('[data-testid="worker-identity-create"]')).toBeNull();
    expect((container.querySelector('[data-testid="worker-claim-button"]') as HTMLButtonElement).disabled).toBe(true);
  });
  it('re-polls the worker list every 10 s while the page is visible, so silence shows', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let hidden = false;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    let listCalls = 0;
    stubFetch((call) => {
      if (call.url === '/workers') {
        listCalls++;
        return json({ workers: WORKERS });
      }
      if (call.url === '/tasks') return json([]);
      if (call.url === '/worker/status') return json({ joined: false, primaryHost: null, via: null });
      if (call.url === '/worker/identity') return json({ publicKeyHex: null });
      throw new Error(`unexpected request: ${call.method} ${call.url}`);
    });
    try {
      const container = await renderComponent(<WorkersCard version={1} />);
      await waitForText(container, 'Mini');
      const base = listCalls;
      vi.advanceTimersByTime(10_000);
      await waitFor(() => listCalls === base + 1, 'one re-poll after 10 s');
      hidden = true;
      vi.advanceTimersByTime(30_000);
      await new Promise((r) => setTimeout(r, 20));
      expect(listCalls, 'a hidden page must not poll').toBe(base + 1);
    } finally {
      vi.useRealTimers();
      delete (document as any).visibilityState; // back to jsdom's prototype getter
    }
  });

  it('the nonce copy confirmation appears beside the nonce', async () => {
    stubAll();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      const container = await renderComponent(<WorkersCard version={1} />);
      await waitForElement(container, '[data-testid="worker-pair-button"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      const name = container.querySelector('[data-testid="worker-name-input"]') as HTMLInputElement;
      setter.call(name, 'Mini2');
      name.dispatchEvent(new Event('input', { bubbles: true }));
      const pub = container.querySelector('[data-testid="worker-pubkey-input"]') as HTMLInputElement;
      setter.call(pub, 'aabbcc');
      pub.dispatchEvent(new Event('input', { bubbles: true }));
      (container.querySelector('[data-testid="worker-pair-button"]') as HTMLButtonElement).click();
      await waitForElement(container, '[data-testid="worker-nonce-copy"]');
      (container.querySelector('[data-testid="worker-nonce-copy"]') as HTMLButtonElement).click();
      await waitFor(() => container.querySelector('[data-testid="worker-nonce"]')?.textContent?.includes('Nonce copied'), 'the confirmation inside the nonce banner');
      expect(writeText).toHaveBeenCalledWith('n0nce');
      // Not in the Join row at the bottom of the page any more.
      const joinRow = container.querySelector('[data-testid="worker-join-status"]')!.closest('.cred-row')!;
      expect(joinRow.textContent).not.toContain('Nonce copied');
    } finally {
      delete (navigator as any).clipboard;
    }
  });
  it('the key copy confirmation appears in the key row', async () => {
    stubAll();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      const container = await renderComponent(<WorkersCard version={1} />);
      await waitForText(container, 'Copy key');
      (container.querySelector('[data-testid="worker-identity-copy"]') as HTMLButtonElement).click();
      const note = await waitForElement(container, '[data-testid="worker-identity-note"]');
      expect(note.textContent).toContain('Key copied');
      expect(note.closest('.cred-row')?.querySelector('[data-testid="worker-identity-key"]')).toBeTruthy();
      expect(writeText).toHaveBeenCalledWith('aa'.repeat(22));
    } finally {
      delete (navigator as any).clipboard;
    }
  });
});
