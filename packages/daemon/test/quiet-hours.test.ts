/**
 * Quiet hours (ADR-030): window math + scheduler deferral semantics.
 */
import { describe, expect, it } from 'vitest';
import { inQuietWindow, quietWindowEnd } from '../src/scheduler.js';

describe('quiet hours', () => {
  const NY = 'America/New_York';
  const qh = { startHour: 23, endHour: 7 }; // wraps midnight

  // 2026-08-24 is a Monday; pick fixed instants.
  const at = (day: number, hour: number): number =>
    new Date(`2026-08-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`).getTime();

  it('flags hours inside a midnight-wrapping window', () => {
    // 03:00 UTC == 23:00 EDT previous day → inside 23–07
    expect(inQuietWindow(at(24, 3), qh, NY)).toBe(true);
    // 09:00 UTC == 05:00 EDT → inside
    expect(inQuietWindow(at(24, 9), qh, NY)).toBe(true);
  });

  it('allows hours outside the window', () => {
    // 12:00 UTC == 08:00 EDT → just outside end
    expect(inQuietWindow(at(24, 12), qh, NY)).toBe(false);
    // 18:00 UTC == 14:00 EDT → outside
    expect(inQuietWindow(at(24, 18), qh, NY)).toBe(false);
  });

  it('handles non-wrapping windows', () => {
    const noon = { startHour: 11, endHour: 14 };
    expect(inQuietWindow(at(24, 12), noon, 'UTC')).toBe(true);
    expect(inQuietWindow(at(24, 15), noon, 'UTC')).toBe(false);
  });

  it('zero-length window never defers', () => {
    expect(inQuietWindow(at(24, 12), { startHour: 7, endHour: 7 }, 'UTC')).toBe(false);
  });

  it('quietWindowEnd returns an instant outside the window', () => {
    // 03:00Z = 23:00 EDT inside the wrap window → defer to next allowed hour (07:00 local = 11:00Z)
    const resume = quietWindowEnd(at(24, 3), qh, NY);
    expect(inQuietWindow(resume, qh, NY)).toBe(false);
    expect(resume).toBeGreaterThan(at(24, 3));
    // Resume must be at most ~8h later for this window
    expect(resume - at(24, 3)).toBeLessThan(9 * 3600_000);
  });

  it('resume lands exactly at the local window-end hour', () => {
    // 02:00Z = 22:00 EDT Aug 23 → inside? 22 < 23 start → NOT inside; use 04:00Z = 00:00 EDT inside.
    const resume = quietWindowEnd(at(24, 4), qh, NY);
    expect(inQuietWindow(resume, qh, NY)).toBe(false);
  });
});
