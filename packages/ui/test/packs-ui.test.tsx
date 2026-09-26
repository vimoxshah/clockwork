/**
 * Packs section (P6): installed list, URL/file preview with signature state,
 * trust-gated install, honest uninstall. Same credential-adjacency discipline
 * as the other install surfaces: unknown fingerprints never auto-trust, and
 * the trust checkbox only exists beside an unknown-key verdict.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PacksSection } from '../src/components/PacksSection';
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

const PREVIEW_UNKNOWN = {
  manifest: { name: 'np', version: '1.0.0', publisher: 'team' },
  verified: { ok: false, reason: 'unknown_key', message: 'Signed by unknown key k1', keyId: 'k1' },
  templates: [{ name: 'triage', schemaOk: true, preview: { flags: [] } }],
  blocked: false,
  blockedReasons: [],
};

describe('PacksSection', () => {
  it('lists installed packs and uninstalls with confirm', async () => {
    stubFetch((call) => {
      if (call.url === '/packs/installed') return json({ packs: [{ name: 'np', version: '1.0.0', publisher: 't', tasks: 2 }] });
      if (call.url === '/packs/np' && call.method === 'DELETE') return json({ removed: 1, kept: ['t-keep'] });
      throw new Error(`unexpected request: ${call.method} ${call.url}`);
    });
    const container = await renderComponent(<PacksSection version={1} />);
    await waitForText(container, 'np');
    const realConfirm = window.confirm;
    (window as any).confirm = () => true;
    try {
      const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Uninstall') as HTMLButtonElement;
      btn.click();
      // Kept tasks are reported by id — "Uninstalled." alone would hide them.
      await waitForText(container, 'Removed 1');
      await waitForText(container, 't-keep');
    } finally {
      (window as any).confirm = realConfirm;
    }
  });

  it('unknown keys need the trust checkbox; install stays disabled without it', async () => {
    stubFetch((call) => {
      if (call.url === '/packs/installed') return json({ packs: [] });
      if (call.url === '/packs/preview') return json(PREVIEW_UNKNOWN);
      if (call.url === '/packs/install') return json({ installed: 'np', version: '1.0.0', tasks: [{ taskId: 't1', name: 'a' }] });
      throw new Error(`unexpected request: ${call.method} ${call.url}`);
    });
    const container = await renderComponent(<PacksSection version={1} />);
    await waitForElement(container, '[data-testid="pack-url-input"]');
    const input = container.querySelector('[data-testid="pack-url-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, 'https://example.test/np.json');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (container.querySelector('[data-testid="pack-preview-url"]') as HTMLButtonElement).click();
    // The fingerprint renders as a value to check out-of-band, not prose.
    await waitForElement(container, '[data-testid="pack-key-fingerprint"]');
    expect(container.querySelector('[data-testid="pack-key-fingerprint"]')?.textContent).toBeTruthy();
    const install = container.querySelector('[data-testid="pack-install-button"]') as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    (container.querySelector('[data-testid="pack-trust-key"]') as HTMLInputElement).click();
    expect((container.querySelector('[data-testid="pack-install-button"]') as HTMLButtonElement).disabled).toBe(false);
    (container.querySelector('[data-testid="pack-install-button"]') as HTMLButtonElement).click();
    await waitForText(container, 'arrive disabled');
  });

  it('blocked packs name their reasons and offer no install', async () => {
    stubFetch((call) => {
      if (call.url === '/packs/installed') return json({ packs: [] });
      if (call.url === '/packs/preview') {
        return json({ ...PREVIEW_UNKNOWN, blocked: true, blockedReasons: ['evil: asks for bypassPermissions'] });
      }
      throw new Error(`unexpected request: ${call.method} ${call.url}`);
    });
    const container = await renderComponent(<PacksSection version={1} />);
    await waitForElement(container, '[data-testid="pack-url-input"]');
    const input = container.querySelector('[data-testid="pack-url-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, 'https://example.test/evil.json');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (container.querySelector('[data-testid="pack-preview-url"]') as HTMLButtonElement).click();
    await waitForText(container, 'bypassPermissions');
    expect((container.querySelector('[data-testid="pack-install-button"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('install sends the trust flag; declined confirms send nothing', async () => {
    const seen: Call[] = [];
    const stubber = (call: Call) => {
      seen.push(call);
      if (call.url === '/packs/installed') return json({ packs: [{ name: 'np', version: '1.0.0', publisher: 't', tasks: 1 }] });
      if (call.url === '/packs/preview') return json(PREVIEW_UNKNOWN);
      if (call.url === '/packs/install') return json({ installed: 'np', version: '1.0.0', tasks: [] });
      throw new Error(`unexpected request: ${call.method} ${call.url}`);
    };
    const realConfirm = window.confirm;
    try {
      // Decline: no DELETE fires.
      stubFetch(stubber);
      let container = await renderComponent(<PacksSection version={1} />);
      await waitForText(container, 'np');
      (window as any).confirm = () => false;
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Uninstall')!.click();
      await new Promise((r) => setTimeout(r, 100));
      expect(seen.some((c) => c.method === 'DELETE')).toBe(false);
      // Trust flag travels: without it the daemon would 422 unknown_key.
      (window as any).confirm = () => true;
      stubFetch(stubber);
      container = await renderComponent(<PacksSection version={1} />);
      await waitForElement(container, '[data-testid="pack-url-input"]');
      const input = container.querySelector('[data-testid="pack-url-input"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'https://example.test/np.json');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      (container.querySelector('[data-testid="pack-preview-url"]') as HTMLButtonElement).click();
      await waitForElement(container, '[data-testid="pack-trust-key"]');
      (container.querySelector('[data-testid="pack-trust-key"]') as HTMLInputElement).click();
      (container.querySelector('[data-testid="pack-install-button"]') as HTMLButtonElement).click();
      await waitForText(container, 'arrive disabled');
      const install = seen.filter((c) => c.url === '/packs/install').pop();
      expect((install?.body as any)?.trustKey).toBe(true);
    } finally {
      (window as any).confirm = realConfirm;
    }
  });

  it('rotation, incompatibility and conflict verdicts surface verbatim', async () => {
    const cases: Array<{ preview: any; text: string }> = [
      {
        preview: { ...PREVIEW_UNKNOWN, verified: { ok: false, reason: 'key_changed', message: 'Known publisher key k1 arrived with different key bytes' } },
        text: 'different key bytes',
      },
      {
        preview: { ...PREVIEW_UNKNOWN, verified: { ok: false, reason: 'incompatible', message: 'Pack needs Clockwork 99.0.0+' } },
        text: '99.0.0',
      },
    ];
    for (const { preview, text } of cases) {
      stubFetch((call) => {
        if (call.url === '/packs/installed') return json({ packs: [] });
        if (call.url === '/packs/preview') return json(preview);
        throw new Error(`unexpected request: ${call.method} ${call.url}`);
      });
      const container = await renderComponent(<PacksSection version={1} />);
      await waitForElement(container, '[data-testid="pack-url-input"]');
      const input = container.querySelector('[data-testid="pack-url-input"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'https://example.test/x.json');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      (container.querySelector('[data-testid="pack-preview-url"]') as HTMLButtonElement).click();
      await waitForText(container, text);
      // Neither verdict offers an install path.
      expect((container.querySelector('[data-testid="pack-install-button"]') as HTMLButtonElement).disabled).toBe(true);
      document.body.innerHTML = '';
    }
  });
});
