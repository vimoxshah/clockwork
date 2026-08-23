import { describe, expect, it } from 'vitest';
import { parseIcs } from '../src/ics.js';

const SAMPLE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:abc-123@example.com',
  'DTSTAMP:20260823T120000Z',
  'DTSTART:20260824T140000Z',
  'DTEND:20260824T150000Z',
  'SUMMARY:Team standup',
  'LOCATION:Zoom',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:all-day-1@example.com',
  'DTSTAMP:20260823T120000Z',
  'DTSTART;VALUE=DATE:20260825',
  'SUMMARY:Conference day',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:recurring-1@example.com',
  'DTSTAMP:20260823T120000Z',
  'DTSTART:20260826T090000Z',
  'RRULE:FREQ=WEEKLY;BYDAY=WE',
  'SUMMARY:Weekly 1:1',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('ICS parser', () => {
  it('parses timed events to epoch ms', () => {
    const evs = parseIcs(SAMPLE);
    const standup = evs.find((e) => e.summary === 'Team standup')!;
    expect(standup).toBeDefined();
    expect(standup.startMs).toBe(Date.UTC(2026, 7, 24, 14, 0));
    expect(standup.endMs).toBe(Date.UTC(2026, 7, 24, 15, 0));
    expect(standup.allDay).toBe(false);
    expect(standup.location).toBe('Zoom');
  });

  it('flags all-day DATE events', () => {
    const evs = parseIcs(SAMPLE);
    const conf = evs.find((e) => e.summary === 'Conference day')!;
    expect(conf.allDay).toBe(true);
    expect(conf.startMs).toBe(Date.UTC(2026, 7, 25));
  });

  it('marks recurring events without blind expansion', () => {
    const evs = parseIcs(SAMPLE);
    const rec = evs.find((e) => e.summary.includes('Weekly 1:1'))!;
    expect(rec).toBeDefined();
    expect(rec.summary.startsWith('(recurring)')).toBe(true);
  });

  it('unfolds continuation lines', () => {
    const folded = SAMPLE.replace(
      'SUMMARY:Team standup',
      'SUMMARY:Team standup —\r\n weekly sync',
    );
    const evs = parseIcs(folded);
    expect(evs.some((e) => e.summary.includes('weekly sync'))).toBe(true);
  });
});
