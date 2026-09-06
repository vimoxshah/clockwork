/**
 * ICS file import (frozen snapshot) alongside the existing live-subscription
 * feed. Covers: import by content (upload), import-path (daemon reads the
 * file itself, $HOME-confined), re-import, delete, the legacy on-disk
 * migration, GET /calendar merging file-source events without ever
 * fetching, and the /fs/browse `files=` extension.
 *
 * process.env.HOME is overridden for the whole file (restored in afterAll)
 * so the $HOME-confinement guard has a real, writable directory to work
 * against. Everything under `home` is realpath'd up front — on macOS
 * os.tmpdir() resolves through a /private symlink, and comparing a raw vs.
 * resolved path would make every "inside $HOME" case look like "outside".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync, realpathSync, readFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { RunManager } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeClock } from '../src/clock.js';
import { buildServer } from '../src/api.js';
import { loadIcsSources, saveIcsSources } from '../src/ics.js';
import { SafetyJournal } from '@clockwork/runner';
import type { FastifyInstance } from 'fastify';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

let db: DB;
let homeDir: string;
let dataDir: string;
let outsideDir: string;
let app: FastifyInstance;
let token: string;
let originalHome: string | undefined;

beforeAll(async () => {
  originalHome = process.env.HOME;
  homeDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cw-ics-home-')));
  outsideDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cw-ics-outside-')));
  process.env.HOME = homeDir;
  dataDir = path.join(homeDir, '.clockwork-data');

  const opened = openDatabase(dataDir);
  db = opened.db;
  createMigrator(db, MIGRATIONS).migrate();
  const clock = new FakeClock(Date.now());

  const rm = new RunManager({
    db,
    clock,
    dataDir,
    runnerChildModule: '/nonexistent/runner-child.js',
    notify: () => {},
    broadcast: () => {},
    safetyJournal: new SafetyJournal(`${dataDir}/journal.jsonl`),
  });
  const scheduler = new Scheduler({ db, clock, enqueueRun: () => {}, notify: () => {} });
  const built = await buildServer({ db, dataDir, runManager: rm, scheduler, version: 'test' });
  app = built.app;
  token = built.token;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

function auth(json: any): { method: string; url: string; payload?: any; headers: Record<string, string> } {
  return { ...json, headers: { authorization: `Bearer ${token}` } };
}

// Two VEVENTs + a folded X-WR-CALNAME (Google wraps long lines per RFC 5545
// §3.1 — a continuation line starts with a single space/tab). The fold
// splits mid-word ("Na" / " me...") so a broken unfold would leave the label
// truncated or with a stray leading space instead of "...Folded Name...".
const FOLDED_SAMPLE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'X-WR-CALNAME:Personal Calendar - Folded Na',
  ' me For Unfold Test',
  'BEGIN:VEVENT',
  'UID:import-1@example.com',
  'DTSTAMP:20260901T000000Z',
  'DTSTART:20260901T090000Z',
  'DTEND:20260901T100000Z',
  'SUMMARY:Test Event One',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:import-2@example.com',
  'DTSTAMP:20260901T000000Z',
  'DTSTART:20260902T090000Z',
  'DTEND:20260902T100000Z',
  'SUMMARY:Test Event Two',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function icsWithEvents(count: number): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0'];
  for (let i = 0; i < count; i++) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:disk-${i}@example.com`,
      'DTSTAMP:20260905T000000Z',
      `DTSTART:2026090${i + 1}T090000Z`,
      `DTEND:2026090${i + 1}T100000Z`,
      `SUMMARY:Disk Event ${i}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

describe('POST /calendars/ics/import (upload by content)', () => {
  it('parses content, unfolds a wrapped X-WR-CALNAME for the label, stores the copy at 0600', async () => {
    const res = await app.inject(
      auth({ method: 'POST', url: '/calendars/ics/import', payload: { content: FOLDED_SAMPLE } }),
    );
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; kind: string; label: string; eventCount: number; importedAt: number };
    expect(body.kind).toBe('file');
    expect(body.eventCount).toBe(2);
    expect(body.label).toBe('Personal Calendar - Folded Name For Unfold Test');
    expect(typeof body.importedAt).toBe('number');

    const stat = statSync(`${dataDir}/ics-imports/${body.id}.ics`);
    expect(stat.mode & 0o777).toBe(0o600);

    const list = (await app.inject(auth({ method: 'GET', url: '/calendars/ics' }))).json() as any[];
    const entry = list.find((s) => s.id === body.id);
    expect(entry).toMatchObject({
      kind: 'file',
      url: null,
      sourcePath: null,
      eventCount: 2,
    });
  });

  it('rejects junk text with a specific message', async () => {
    const res = await app.inject(
      auth({ method: 'POST', url: '/calendars/ics/import', payload: { content: 'this is not a calendar\njust some notes\n' } }),
    );
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toMatch(/calendar data|BEGIN:VCALENDAR/i);
  });

  it('rejects a VCALENDAR with zero parseable events', async () => {
    const res = await app.inject(
      auth({ method: 'POST', url: '/calendars/ics/import', payload: { content: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n' } }),
    );
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toMatch(/no events/i);
  });

  it('rejects content over 5 MiB', async () => {
    // The ceiling is a real 5 MiB (5,242,880 bytes), not 5,000,000 — keep this
    // payload above the binary value or the test silently checks nothing.
    const big = 'BEGIN:VCALENDAR\n' + 'X'.repeat(5 * 1024 * 1024 + 1000) + '\nEND:VCALENDAR\n';
    const res = await app.inject(
      auth({ method: 'POST', url: '/calendars/ics/import', payload: { content: big } }),
    );
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toMatch(/5 ?MiB|larger than/i);
  });
});

describe('POST /calendars/ics/import-path', () => {
  const mycalPath = () => path.join(homeDir, 'mycal.ics');

  beforeAll(() => {
    writeFileSync(mycalPath(), icsWithEvents(2));
  });

  it('imports a file the daemon reads itself, defaulting the label to the filename', async () => {
    const res = await app.inject(
      auth({ method: 'POST', url: '/calendars/ics/import-path', payload: { path: mycalPath() } }),
    );
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; kind: string; label: string; eventCount: number };
    expect(body.kind).toBe('file');
    expect(body.eventCount).toBe(2);
    expect(body.label).toBe('mycal');

    const list = (await app.inject(auth({ method: 'GET', url: '/calendars/ics' }))).json() as any[];
    const entry = list.find((s) => s.id === body.id);
    expect(entry.sourcePath).toBe(realpathSync(mycalPath()));
    expect(entry.sourceName).toBe('mycal.ics');
  });

  it('refuses a path outside $HOME with 403', async () => {
    const outsidePath = path.join(outsideDir, 'outside.ics');
    writeFileSync(outsidePath, icsWithEvents(1));
    const res = await app.inject(
      auth({ method: 'POST', url: '/calendars/ics/import-path', payload: { path: outsidePath } }),
    );
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toMatch(/home/i);
  });

  it('refuses a .txt extension with 422', async () => {
    const txtPath = path.join(homeDir, 'notes.txt');
    writeFileSync(txtPath, 'not an ics file');
    const res = await app.inject(
      auth({ method: 'POST', url: '/calendars/ics/import-path', payload: { path: txtPath } }),
    );
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toMatch(/\.ics|\.ical/i);
  });

  it('refuses a path inside a credential directory with 403', async () => {
    const sshDir = path.join(homeDir, '.ssh');
    mkdirSync(sshDir, { recursive: true });
    const credPath = path.join(sshDir, 'cal.ics');
    writeFileSync(credPath, icsWithEvents(1));
    const res = await app.inject(
      auth({ method: 'POST', url: '/calendars/ics/import-path', payload: { path: credPath } }),
    );
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toMatch(/credential/i);
  });
});

describe('POST /calendars/ics/:id/reimport', () => {
  it('re-reads sourcePath and updates the event count when the file changed on disk', async () => {
    const filePath = path.join(homeDir, 'reimport-me.ics');
    writeFileSync(filePath, icsWithEvents(2));
    const imported = await app.inject(
      auth({ method: 'POST', url: '/calendars/ics/import-path', payload: { path: filePath } }),
    );
    expect(imported.statusCode).toBe(201);
    const { id } = imported.json() as { id: string };

    writeFileSync(filePath, icsWithEvents(3));
    const res = await app.inject(auth({ method: 'POST', url: `/calendars/ics/${id}/reimport` }));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; eventCount: number; importedAt: number };
    expect(body.eventCount).toBe(3);

    const list = (await app.inject(auth({ method: 'GET', url: '/calendars/ics' }))).json() as any[];
    expect(list.find((s) => s.id === id)?.eventCount).toBe(3);
  });

  it('refuses to reimport an uploaded (pathless) source with 409, telling the user to import again', async () => {
    const uploaded = await app.inject(
      auth({ method: 'POST', url: '/calendars/ics/import', payload: { content: icsWithEvents(1) } }),
    );
    expect(uploaded.statusCode).toBe(201);
    const { id } = uploaded.json() as { id: string };

    const res = await app.inject(auth({ method: 'POST', url: `/calendars/ics/${id}/reimport` }));
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/import.*again/i);
  });

  it('422s when the source path no longer exists', async () => {
    const filePath = path.join(homeDir, 'vanishing.ics');
    writeFileSync(filePath, icsWithEvents(1));
    const imported = await app.inject(
      auth({ method: 'POST', url: '/calendars/ics/import-path', payload: { path: filePath } }),
    );
    const { id } = imported.json() as { id: string };
    rmSync(filePath);

    const res = await app.inject(auth({ method: 'POST', url: `/calendars/ics/${id}/reimport` }));
    expect(res.statusCode).toBe(422);
  });
});

describe('DELETE /calendars/ics/:id', () => {
  it('removes the stored copy from ics-imports/', async () => {
    const uploaded = await app.inject(
      auth({ method: 'POST', url: '/calendars/ics/import', payload: { content: icsWithEvents(1) } }),
    );
    const { id } = uploaded.json() as { id: string };
    expect(existsSync(`${dataDir}/ics-imports/${id}.ics`)).toBe(true);

    const del = await app.inject(auth({ method: 'DELETE', url: `/calendars/ics/${id}` }));
    expect(del.statusCode).toBe(200);
    expect(existsSync(`${dataDir}/ics-imports/${id}.ics`)).toBe(false);

    const list = (await app.inject(auth({ method: 'GET', url: '/calendars/ics' }))).json() as any[];
    expect(list.some((s) => s.id === id)).toBe(false);
  });
});

describe('loadIcsSources legacy migration', () => {
  it('reads a legacy {id,url,label} entry as kind:url with null extras, without rewriting the file', () => {
    const legacyDir = mkdtempSync(path.join(os.tmpdir(), 'cw-ics-legacy-'));
    try {
      const legacyJson = JSON.stringify([{ id: 'ics_legacy1', url: 'https://example.com/old.ics', label: 'Old feed' }]);
      writeFileSync(`${legacyDir}/ics-sources.json`, legacyJson);

      const sources = loadIcsSources(legacyDir);
      expect(sources).toEqual([
        {
          id: 'ics_legacy1',
          kind: 'url',
          url: 'https://example.com/old.ics',
          label: 'Old feed',
          importedAt: null,
          eventCount: null,
          sourcePath: null,
          sourceName: null,
        },
      ]);

      const onDiskAfter = readFileSync(`${legacyDir}/ics-sources.json`, 'utf8');
      expect(onDiskAfter).toBe(legacyJson);
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});

describe('GET /calendar merges file-source events without ever fetching', () => {
  it('includes the file event in `humans` and calls fetch exactly once, for the url source only', async () => {
    const startMs = Date.UTC(2027, 0, 15, 9, 0);
    const fileContent = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:merge-file-1@example.com',
      'DTSTAMP:20270101T000000Z',
      'DTSTART:20270115T090000Z',
      'DTEND:20270115T100000Z',
      'SUMMARY:Merged File Event',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const uploaded = await app.inject(
      auth({ method: 'POST', url: '/calendars/ics/import', payload: { content: fileContent } }),
    );
    expect(uploaded.statusCode).toBe(201);

    // Seed a url (live subscription) source directly — POST /calendars/ics
    // probes the URL before saving, and this URL must never actually be
    // reachable, so we write the source list ourselves (as the contract
    // suggests: "point the source list at a url that would fail if fetched").
    const unreachableUrl = 'https://127.0.0.1:1/would-fail.ics';
    const sources = loadIcsSources(dataDir);
    sources.push({
      id: 'ics_url_probe',
      kind: 'url',
      url: unreachableUrl,
      label: 'Unreachable feed',
      importedAt: null,
      eventCount: null,
      sourcePath: null,
      sourceName: null,
    });
    saveIcsSources(dataDir, sources);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not actually be reached in tests'));
    try {
      const from = startMs - 3_600_000;
      const to = startMs + 3_600_000;
      const res = await app.inject(auth({ method: 'GET', url: `/calendar?from=${from}&to=${to}` }));
      expect(res.statusCode).toBe(200);
      const body = res.json() as { humans: Array<{ uid: string; name: string; at: number }> };
      expect(body.humans.some((h) => h.uid === 'merge-file-1@example.com')).toBe(true);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe(unreachableUrl);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('security guards added after review', () => {
  it('/fs/browse refuses an anonymous caller — it discloses file names under $HOME', async () => {
    const res = await app.inject({ method: 'GET', url: `/fs/browse?path=${encodeURIComponent(homeDir)}` });
    expect(res.statusCode).toBe(401);
  });

  it('import-path refuses a file over the 5 MiB ceiling without reading it into memory', async () => {
    const big = path.join(homeDir, 'huge.ics');
    // Sparse-ish write: one buffer past the ceiling, so the guard must reject
    // on stat alone rather than on the parsed contents.
    writeFileSync(big, 'BEGIN:VCALENDAR\n' + 'X'.repeat(6 * 1024 * 1024));
    const res = await app.inject(auth({ method: 'POST', url: '/calendars/ics/import-path', payload: { path: big } }));
    expect(res.statusCode).toBe(422);
    expect(String((res.json() as { error: string }).error)).toContain('5 MiB');
    rmSync(big, { force: true });
  });

  it('import-path re-checks the extension on the resolved path, so a .ics symlink to a .txt is refused', async () => {
    const real = path.join(homeDir, 'notes.txt');
    const link = path.join(homeDir, 'sneaky.ics');
    writeFileSync(real, 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:x\nDTSTART:20260101T000000Z\nEND:VEVENT\nEND:VCALENDAR\n');
    symlinkSync(real, link);
    const res = await app.inject(auth({ method: 'POST', url: '/calendars/ics/import-path', payload: { path: link } }));
    expect(res.statusCode).toBe(422);
    expect(String((res.json() as { error: string }).error)).toContain('.ics');
    rmSync(link, { force: true });
    rmSync(real, { force: true });
  });
});

describe('GET /fs/browse `files` query param', () => {
  // A real subdirectory alongside the .ics files: without it, homeDir's only
  // subdirectories are hidden (.clockwork-data, .ssh), so `entries` would be
  // `[]` in every assertion below and `.every(...)` would pass vacuously —
  // proving nothing about whether directories still come back.
  beforeAll(() => {
    mkdirSync(path.join(homeDir, 'Projects'));
  });

  it('without files= returns directories only (unchanged)', async () => {
    const res = await app.inject(auth({ method: 'GET', url: `/fs/browse?path=${encodeURIComponent(homeDir)}` }));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: Array<{ name: string; type: string }> };
    expect(body.entries.some((e) => e.name === 'Projects' && e.type === 'dir')).toBe(true);
    expect(body.entries.every((e) => e.type === 'dir')).toBe(true);
    expect(body.entries.some((e) => e.name === 'mycal.ics')).toBe(false);
  });

  it('with files=ics also lists a .ics file in the temp dir, alongside directories', async () => {
    const res = await app.inject(auth({ method: 'GET', url: `/fs/browse?path=${encodeURIComponent(homeDir)}&files=ics` }));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: Array<{ name: string; type: string }> };
    expect(body.entries.some((e) => e.name === 'Projects' && e.type === 'dir')).toBe(true);
    expect(body.entries.some((e) => e.name === 'mycal.ics' && e.type === 'file')).toBe(true);
    expect(body.entries.some((e) => e.name === 'notes.txt')).toBe(false);
  });
});
