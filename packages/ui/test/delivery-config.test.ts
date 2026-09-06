/**
 * Telegram / webhook delivery configuration (Settings → Notifications &
 * delivery, Composer → per-task Telegram chat):
 *  - api.ts hits the right verb/path/body for the three delivery-config
 *    routes and never invents extra fields.
 *  - ComposerView.buildTaskDelivery assembles the per-task `delivery` object
 *    correctly, in particular the two safety-relevant rules: leaving the chat
 *    id blank must send exactly what shipped before per-task Telegram existed,
 *    and marking a chat as a group must send an honest allow-list — including
 *    an *empty* one, which is "refuse every press" (ADR-036), not "no rule".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildTaskDelivery } from '../src/components/ComposerView';

// ---------- api.ts delivery-config client ----------
describe('api.ts delivery-config client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // vitest-environment-jsdom's window.localStorage comes back `undefined`
    // under this repo's Node version (a pre-existing test-infra gap, not
    // touched by this change) — stub a minimal in-memory Storage so api.ts's
    // getToken()/setToken() (bare `localStorage` reads) have something real
    // to talk to, same as they would in an actual browser/webview.
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => void store.clear(),
    });
    localStorage.setItem('clockwork.token', 't0k3n');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const okJson = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

  // Regression: DELETE /triggers/:id and DELETE /byok/:id answer 204 No
  // Content. api.ts used to call res.json() unconditionally, which throws
  // SyntaxError on an empty body — so SettingsView's .then(reload) never ran
  // and a deleted trigger stayed on screen while the row was already gone.
  it('resolves without parsing on 204, so a DELETE does not throw', async () => {
    const json = vi.fn(async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      headers: new Headers(),
      json,
    } as unknown as Response);
    const { api } = await import('../src/api');
    await expect(api.deleteTrigger('trg_1')).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });

  it('still parses a normal JSON response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ telegram: { configured: false, botTokenMasked: null }, webhook: { configured: false } }),
    } as unknown as Response);
    const { api } = await import('../src/api');
    await expect(api.deliveryConfig()).resolves.toEqual({
      telegram: { configured: false, botTokenMasked: null },
      webhook: { configured: false },
    });
  });

  it('deliveryConfig() issues GET /delivery-config', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ telegram: { configured: false, botTokenMasked: null }, webhook: { configured: false } }),
    );
    const { api } = await import('../src/api');
    const r = await api.deliveryConfig();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/delivery-config');
    expect(init.method).toBe('GET');
    expect(r).toEqual({ telegram: { configured: false, botTokenMasked: null }, webhook: { configured: false } });
  });

  it('saveDeliveryConfig() PUTs a string token as-is (set/replace)', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ telegram: { configured: true, botTokenMasked: '12345678:AAE…xQ7' }, webhook: { configured: false } }),
    );
    const { api } = await import('../src/api');
    await api.saveDeliveryConfig({ telegramBotToken: '123456789:AAEsecretvalue' });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/delivery-config');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ telegramBotToken: '123456789:AAEsecretvalue' });
  });

  it('saveDeliveryConfig() PUTs null to clear a credential, omitted keys stay out of the body', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ telegram: { configured: false, botTokenMasked: null }, webhook: { configured: false } }),
    );
    const { api } = await import('../src/api');
    await api.saveDeliveryConfig({ telegramBotToken: null });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({ telegramBotToken: null });
    expect('webhookSecret' in body).toBe(false);
  });

  it('testTelegram() POSTs the chat id and surfaces the daemon result verbatim', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ ok: false, error: 'chat not found' }));
    const { api } = await import('../src/api');
    const r = await api.testTelegram('987654321');
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/delivery-config/test-telegram');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ chatId: '987654321' });
    expect(r).toEqual({ ok: false, error: 'chat not found' });
  });

  it('never sends a bot token on the test-telegram call', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ ok: true }));
    const { api } = await import('../src/api');
    await api.testTelegram('42');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).not.toMatch(/token/i);
  });
});

// ---------- ComposerView.buildTaskDelivery ----------
describe('ComposerView.buildTaskDelivery', () => {
  it('sends exactly the pre-existing shape when no chat id is entered', () => {
    expect(buildTaskDelivery('', false, '')).toEqual({ osNotify: true });
    expect(buildTaskDelivery('   ', true, '1,2')).toEqual({ osNotify: true });
  });

  it('a private (non-group) chat id carries no allow-list', () => {
    expect(buildTaskDelivery('123456789', false, '')).toEqual({
      osNotify: true,
      telegram: { chatId: '123456789' },
    });
    // stray allow-list input is ignored when the chat isn't marked as a group
    expect(buildTaskDelivery('123456789', false, '111, 222')).toEqual({
      osNotify: true,
      telegram: { chatId: '123456789' },
    });
  });

  it('a group chat parses a comma-separated allow-list, trimming entries', () => {
    expect(buildTaskDelivery(' -1009876 ', true, ' 111 , 222,333 ')).toEqual({
      osNotify: true,
      telegram: { chatId: '-1009876', allowedUserIds: ['111', '222', '333'] },
    });
  });

  it('a group chat with a blank allow-list sends an EMPTY array — refuse every press, not "no rule"', () => {
    expect(buildTaskDelivery('-1009876', true, '')).toEqual({
      osNotify: true,
      telegram: { chatId: '-1009876', allowedUserIds: [] },
    });
    // whitespace/commas-only input collapses to the same honest empty list
    expect(buildTaskDelivery('-1009876', true, ' , , ')).toEqual({
      osNotify: true,
      telegram: { chatId: '-1009876', allowedUserIds: [] },
    });
  });
});
