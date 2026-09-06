/**
 * ICS file import (Settings → Calendars, "Or import a file"):
 *  - api.ts hits the right verb/path/body for the three new import routes
 *    (importIcsContent, importIcsPath, reimportIcs) and never invents fields.
 *  - browseFs passes the `files` extension filter through only when given,
 *    so the existing repo-folder picker (no `files`) is byte-for-byte
 *    unaffected.
 *  - fallbackIcsLabel mirrors the daemon's filename → label fallback used to
 *    preview an import's default label before it's sent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('api.ts ICS import client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Same localStorage stub as delivery-config.test.ts: this repo's Node
    // version doesn't give vitest-environment-jsdom a working
    // window.localStorage, so api.ts's getToken()/setToken() need a real
    // Storage-shaped stand-in.
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
    ({ ok: true, status: 201, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body }) as unknown as Response;

  it('importIcsContent() POSTs content/label/filename to /calendars/ics/import', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ id: 'ics_1', kind: 'file', label: 'Work', eventCount: 12, importedAt: 1_700_000_000_000 }),
    );
    const { api } = await import('../src/api');
    const r = await api.importIcsContent({ content: 'BEGIN:VCALENDAR\nEND:VCALENDAR', label: 'Work', filename: 'work.ics' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/calendars/ics/import');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      content: 'BEGIN:VCALENDAR\nEND:VCALENDAR',
      label: 'Work',
      filename: 'work.ics',
    });
    expect(r).toEqual({ id: 'ics_1', kind: 'file', label: 'Work', eventCount: 12, importedAt: 1_700_000_000_000 });
  });

  it('importIcsContent() omits label/filename from the body when not given', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ id: 'ics_2', kind: 'file', label: 'Imported calendar', eventCount: 0, importedAt: 1_700_000_000_000 }),
    );
    const { api } = await import('../src/api');
    await api.importIcsContent({ content: 'BEGIN:VCALENDAR\nEND:VCALENDAR' });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({ content: 'BEGIN:VCALENDAR\nEND:VCALENDAR' });
    expect('label' in body).toBe(false);
    expect('filename' in body).toBe(false);
  });

  it('importIcsPath() POSTs path/label to /calendars/ics/import-path', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ id: 'ics_3', kind: 'file', label: 'Personal', eventCount: 42, importedAt: 1_700_000_000_000 }),
    );
    const { api } = await import('../src/api');
    const r = await api.importIcsPath({ path: '/Users/me/Downloads/personal.ics', label: 'Personal' });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/calendars/ics/import-path');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ path: '/Users/me/Downloads/personal.ics', label: 'Personal' });
    expect(r).toEqual({ id: 'ics_3', kind: 'file', label: 'Personal', eventCount: 42, importedAt: 1_700_000_000_000 });
  });

  it('reimportIcs() POSTs to /calendars/ics/:id/reimport with no body', async () => {
    fetchMock.mockResolvedValueOnce(
      ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ id: 'ics_3', eventCount: 43, importedAt: 1_700_000_100_000 }) }) as unknown as Response,
    );
    const { api } = await import('../src/api');
    const r = await api.reimportIcs('ics_3');
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/calendars/ics/ics_3/reimport');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(r).toEqual({ id: 'ics_3', eventCount: 43, importedAt: 1_700_000_100_000 });
  });

  it('reimportIcs() surfaces the daemon 409 message verbatim (no sourcePath — re-import needs the file picked again)', async () => {
    const conflict = {
      ok: false,
      status: 409,
      json: async () => ({ error: 'this calendar was uploaded, not read from a file — import it again to enable re-import' }),
    } as unknown as Response;
    fetchMock.mockResolvedValueOnce(conflict).mockResolvedValueOnce(conflict);
    const { api, ApiError } = await import('../src/api');
    await expect(api.reimportIcs('ics_uploaded')).rejects.toMatchObject({
      status: 409,
      message: 'this calendar was uploaded, not read from a file — import it again to enable re-import',
    });
    await expect(api.reimportIcs('ics_uploaded')).rejects.toBeInstanceOf(ApiError);
  });

  it('icsSources() GETs the migrated shape (kind, importedAt, eventCount, sourcePath, sourceName)', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson([
        { id: 'ics_old', kind: 'url', url: 'https://example.com/basic.ics', label: 'Work', importedAt: null, eventCount: null, sourcePath: null, sourceName: null },
        { id: 'ics_new', kind: 'file', url: null, label: 'Personal', importedAt: 1_700_000_000_000, eventCount: 12, sourcePath: '/Users/me/personal.ics', sourceName: 'personal.ics' },
      ]),
    );
    const { api } = await import('../src/api');
    const r = await api.icsSources();
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/calendars/ics');
    expect(init.method).toBe('GET');
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ kind: 'url', importedAt: null, eventCount: null });
    expect(r[1]).toMatchObject({ kind: 'file', importedAt: 1_700_000_000_000, eventCount: 12, sourcePath: '/Users/me/personal.ics' });
  });

  it('browseFs() omits `files` from the query string when not given (byte-for-byte with today\'s repo picker)', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ path: '/Users/me', parent: null, entries: [] }));
    const { api } = await import('../src/api');
    await api.browseFs('/Users/me');
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/fs/browse?path=%2FUsers%2Fme');
    expect(init.method).toBe('GET');
  });

  it('browseFs() passes `files` through as a query param when given', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ path: '/Users/me/Downloads', parent: '/Users/me', entries: [] }));
    const { api } = await import('../src/api');
    await api.browseFs('/Users/me/Downloads', 'ics,ical');
    const [path] = fetchMock.mock.calls[0];
    expect(path).toBe('/fs/browse?path=%2FUsers%2Fme%2FDownloads&files=ics%2Cical');
  });
});

describe('fallbackIcsLabel', () => {
  it('strips a single trailing extension', async () => {
    const { fallbackIcsLabel } = await import('../src/api');
    expect(fallbackIcsLabel('personal.ics')).toBe('personal');
    expect(fallbackIcsLabel('Work Calendar.ical')).toBe('Work Calendar');
  });

  it('only strips the LAST extension, so a dotted name keeps its inner dots', async () => {
    const { fallbackIcsLabel } = await import('../src/api');
    expect(fallbackIcsLabel('2026.export.ics')).toBe('2026.export');
  });

  // Mirrors a real-world export filename shape (Google Calendar's own ICS
  // download is named after the account email, e.g.
  // "someone@example.com.ics" — the '@' and the extra dots in the domain
  // must survive, only the trailing ".ics" comes off).
  it('handles an email-shaped export filename (multiple dots, an "@")', async () => {
    const { fallbackIcsLabel } = await import('../src/api');
    expect(fallbackIcsLabel('someone@example.com.ics')).toBe('someone@example.com');
  });

  it('falls back to "Imported calendar" for a name with no usable stem', async () => {
    const { fallbackIcsLabel } = await import('../src/api');
    expect(fallbackIcsLabel('.ics')).toBe('Imported calendar');
    expect(fallbackIcsLabel('')).toBe('Imported calendar');
    expect(fallbackIcsLabel('   ')).toBe('Imported calendar');
  });

  it('leaves an extension-less filename as-is', async () => {
    const { fallbackIcsLabel } = await import('../src/api');
    expect(fallbackIcsLabel('mycalendar')).toBe('mycalendar');
  });
});
