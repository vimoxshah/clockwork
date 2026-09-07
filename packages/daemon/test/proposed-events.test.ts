/**
 * F9 proposed-events (plan/AGENT-WORKFORCE-SPEC.md §F9).
 *
 * Defends: reports read with bare JSON.parse and never re-validated end to
 * end, so `proposedEventsFor` must survive a missing run, a null report, a
 * report predating the field, and individually-malformed entries without
 * throwing. `toIcs` must produce RFC 5545 text a real parser can round-trip,
 * with byte-safe folding, RFC-correct escaping, and no ambient-clock
 * flakiness. The module has no write path — every SQL statement it issues
 * is a SELECT.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createMigrator, loadMigrationsFrom, type DB } from '../src/db.js';
import { proposedEventsFor, toIcs, icsFilenameFor } from '../src/proposed-events.js';
import { parseIcs } from '../src/ics.js';
import path from 'node:path';

const MIGRATIONS = loadMigrationsFrom(path.resolve(import.meta.dirname, '../migrations'));

let db: DB;

function seedTask(id: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (id, name, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, 'task', 'do work', now, now);
}

function seedRun(id: string, taskId: string, reportJson: string | null): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO runs (id, task_id, jobspec_json, state, state_changed_at, report_json) VALUES (?, ?, ?, 'completed', ?, ?)`,
  ).run(id, taskId, '{}', now, reportJson);
}

beforeAll(() => {
  db = new Database(':memory:') as unknown as DB;
  db.pragma('foreign_keys = ON'); // matches openDatabase (db.ts:19)
  createMigrator(db, MIGRATIONS).migrate();
  seedTask('t1');
});

afterAll(() => db.close());

describe('proposedEventsFor', () => {
  it('returns the parsed events for a run whose report carries valid proposals', () => {
    seedRun(
      'r-happy',
      't1',
      JSON.stringify({ proposedEvents: [{ key: 'a', title: 'Review PR 42', durationMin: 10, suggestedAt: null }] }),
    );
    const events = proposedEventsFor(db, 'r-happy');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ key: 'a', title: 'Review PR 42', durationMin: 10, suggestedAt: null, notes: null });
  });

  it('returns [] for a run id that does not exist', () => {
    expect(proposedEventsFor(db, 'no-such-run')).toEqual([]);
  });

  it('returns [] when the run has no report at all (report_json IS NULL)', () => {
    seedRun('r-noreport', 't1', null);
    expect(proposedEventsFor(db, 'r-noreport')).toEqual([]);
  });

  it('returns [] for a report predating the field (no proposedEvents key)', () => {
    seedRun('r-old', 't1', JSON.stringify({ summary: 'did stuff' }));
    expect(proposedEventsFor(db, 'r-old')).toEqual([]);
  });

  it('returns [] when report_json is not valid JSON, rather than throwing', () => {
    seedRun('r-corrupt', 't1', '{not json');
    expect(() => proposedEventsFor(db, 'r-corrupt')).not.toThrow();
    expect(proposedEventsFor(db, 'r-corrupt')).toEqual([]);
  });

  it('returns [] when proposedEvents is present but not an array', () => {
    seedRun('r-wrongshape', 't1', JSON.stringify({ proposedEvents: 'not-an-array' }));
    expect(proposedEventsFor(db, 'r-wrongshape')).toEqual([]);
  });

  it('drops a malformed entry (missing required key) but keeps the valid ones beside it', () => {
    seedRun(
      'r-mixed',
      't1',
      JSON.stringify({
        proposedEvents: [
          { key: 'good', title: 'Valid one' },
          { title: 'Missing key field' }, // key is required, no default — must be dropped
          { key: 'also-good', title: 'Another valid one' },
        ],
      }),
    );
    const events = proposedEventsFor(db, 'r-mixed');
    expect(events.map((e) => e.key)).toEqual(['good', 'also-good']);
  });

  it('applies schema defaults for optional fields left off a hand-shaped entry', () => {
    seedRun('r-defaults', 't1', JSON.stringify({ proposedEvents: [{ key: 'k', title: 'T' }] }));
    const [ev] = proposedEventsFor(db, 'r-defaults');
    expect(ev).toMatchObject({ durationMin: 15, suggestedAt: null, notes: null });
  });

  it('issues only SELECTs — no write path exists for this feature', () => {
    seedRun('r-spy', 't1', JSON.stringify({ proposedEvents: [{ key: 'k', title: 'T' }] }));
    const spy = vi.spyOn(db, 'prepare');
    proposedEventsFor(db, 'r-spy');
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    for (const call of spy.mock.calls) {
      expect(String(call[0]).trim().toUpperCase().startsWith('SELECT')).toBe(true);
    }
    spy.mockRestore();
  });
});

describe('toIcs', () => {
  afterAll(() => vi.useRealTimers());

  it('produces a VCALENDAR round-trippable by the codebase\'s own ICS parser', () => {
    const ics = toIcs(
      [{ key: 'a', title: 'Review PR 42', notes: null, durationMin: 10, suggestedAt: Date.UTC(2026, 0, 5, 14, 0, 0) }],
      { runId: 'run123' },
    );
    const [parsed] = parseIcs(ics);
    expect(parsed).toBeDefined();
    expect(parsed!.uid).toBe('run123-a@clockwork.local');
    expect(parsed!.summary).toBe('Review PR 42');
    expect(parsed!.startMs).toBe(Date.UTC(2026, 0, 5, 14, 0, 0));
    expect(parsed!.endMs).toBe(Date.UTC(2026, 0, 5, 14, 10, 0));
  });

  it('uses CRLF line endings throughout, not bare LF', () => {
    const ics = toIcs([{ key: 'a', title: 'T', notes: null, durationMin: 5, suggestedAt: 0 }]);
    expect(ics.includes('\r\n')).toBe(true);
    // every LF must be preceded by CR — a bare LF is a folding/line-ending bug
    const bareLf = ics.replace(/\r\n/g, '').includes('\n');
    expect(bareLf).toBe(false);
  });

  it('falls back to UID without a run prefix when opts.runId is omitted', () => {
    const ics = toIcs([{ key: 'solo', title: 'T', notes: null, durationMin: 5, suggestedAt: 0 }]);
    expect(ics).toContain('UID:solo@clockwork.local');
  });

  it('DTEND is DTSTART + durationMin', () => {
    const start = Date.UTC(2026, 2, 1, 9, 0, 0);
    const ics = toIcs([{ key: 'a', title: 'T', notes: null, durationMin: 45, suggestedAt: start }]);
    const [parsed] = parseIcs(ics);
    expect(parsed!.endMs! - parsed!.startMs).toBe(45 * 60_000);
  });

  it('falls back to opts.defaultAtMs when suggestedAt is null', () => {
    const fallback = Date.UTC(2026, 5, 1, 8, 0, 0);
    const ics = toIcs([{ key: 'a', title: 'T', notes: null, durationMin: 10, suggestedAt: null }], {
      defaultAtMs: fallback,
    });
    const [parsed] = parseIcs(ics);
    expect(parsed!.startMs).toBe(fallback);
  });

  it('falls back to the next whole hour when suggestedAt is null and no defaultAtMs is given', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 3, 10, 11, 30, 0)); // 11:30 -> next whole hour is 12:00
    const ics = toIcs([{ key: 'a', title: 'T', notes: null, durationMin: 10, suggestedAt: null }]);
    const [parsed] = parseIcs(ics);
    expect(parsed!.startMs).toBe(Date.UTC(2026, 3, 10, 12, 0, 0));
    vi.useRealTimers();
  });

  it('advances to the NEXT hour even when "now" lands exactly on an hour boundary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 3, 10, 12, 0, 0)); // exactly on the hour
    const ics = toIcs([{ key: 'a', title: 'T', notes: null, durationMin: 10, suggestedAt: null }]);
    const [parsed] = parseIcs(ics);
    expect(parsed!.startMs).toBe(Date.UTC(2026, 3, 10, 13, 0, 0)); // not 12:00 — must strictly advance
    vi.useRealTimers();
  });

  it('includes a mandatory DTSTAMP on every VEVENT', () => {
    const ics = toIcs([{ key: 'a', title: 'T', notes: null, durationMin: 10, suggestedAt: 0 }]);
    expect(ics).toMatch(/DTSTAMP:\d{8}T\d{6}Z/);
  });

  it('escapes backslash, semicolon, comma and newline in SUMMARY/DESCRIPTION per RFC 5545', () => {
    const ics = toIcs([
      {
        key: 'a',
        title: 'Fix a;b,c\\d\ne',
        notes: 'note; with, chars\\and\nlines',
        durationMin: 10,
        suggestedAt: 0,
      },
    ]);
    // parseProp does not unescape, so assert the escaped raw wire text directly
    // (unfolded first, since a long line would otherwise fold mid-escape-sequence).
    const unfolded = ics.replace(/\r\n[ \t]/g, '');
    expect(unfolded).toContain('SUMMARY:Fix a\\;b\\,c\\\\d\\ne');
    expect(unfolded).toContain('DESCRIPTION:note\\; with\\, chars\\\\and\\nlines');
  });

  it('folds a long, multi-byte SUMMARY at a byte-safe boundary and round-trips through parseIcs', () => {
    // non-ASCII (3-byte UTF-8 code points) repeated well past 75 octets, with no
    // characters requiring escaping so the parser's non-unescaping round trip is exact.
    const longTitle = '事'.repeat(60); // 60 * 3 = 180 octets, forces multiple folds
    const ics = toIcs([{ key: 'k', title: longTitle, notes: null, durationMin: 5, suggestedAt: 0 }]);
    // every physical (CRLF-delimited) line must be <= 75 octets
    for (const line of ics.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
    const [parsed] = parseIcs(ics);
    expect(parsed!.summary).toBe(longTitle);
  });

  it('omits DESCRIPTION entirely when notes is null', () => {
    const ics = toIcs([{ key: 'a', title: 'T', notes: null, durationMin: 5, suggestedAt: 0 }]);
    expect(ics).not.toContain('DESCRIPTION');
  });

  it('produces a well-formed empty calendar for an empty events array', () => {
    const ics = toIcs([]);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).not.toContain('BEGIN:VEVENT');
    expect(parseIcs(ics)).toEqual([]);
  });
});

describe('icsFilenameFor', () => {
  it('names the file clockwork-<runId>.ics', () => {
    expect(icsFilenameFor('run123')).toBe('clockwork-run123.ics');
  });
});
