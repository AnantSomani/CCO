import { describe, expect, it } from 'vitest';
import { anniversaryThisYear, birthdayThisYear, daysUntil, todayInWorkspaceTz } from '@/lib/dates';

const utc = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m - 1, d));
// Noon UTC lands on the same calendar day in any tz between UTC-12 and UTC+12.
// Use this for daysUntil tests where the target's tz-evaluated date matters.
const utcNoon = (y: number, m: number, d: number): Date =>
  new Date(Date.UTC(y, m - 1, d, 12, 0, 0));

describe('todayInWorkspaceTz', () => {
  it('returns the local calendar date in the given tz', () => {
    // 2025-03-09T03:00:00Z = 2025-03-08 22:00 in America/New_York (still the 8th)
    const now = new Date('2025-03-09T03:00:00Z');
    expect(todayInWorkspaceTz('America/New_York', now)).toEqual({
      year: 2025,
      month: 3,
      day: 8,
    });
    expect(todayInWorkspaceTz('UTC', now)).toEqual({ year: 2025, month: 3, day: 9 });
  });

  it('handles late-night LA (next-day UTC, same calendar day in tz)', () => {
    // 2026-05-13T05:30:00Z = 2026-05-12 22:30 in America/Los_Angeles
    const now = new Date('2026-05-13T05:30:00Z');
    expect(todayInWorkspaceTz('America/Los_Angeles', now)).toEqual({
      year: 2026,
      month: 5,
      day: 12,
    });
  });
});

describe('birthdayThisYear', () => {
  it('returns this year for a regular birthday (March 15)', () => {
    expect(birthdayThisYear(3, 15, { year: 2025, month: 1, day: 1 })).toEqual(utc(2025, 3, 15));
  });

  it('returns this year for October 1', () => {
    expect(birthdayThisYear(10, 1, { year: 2024, month: 7, day: 4 })).toEqual(utc(2024, 10, 1));
  });

  it('returns Feb 29 in a leap year (2024)', () => {
    expect(birthdayThisYear(2, 29, { year: 2024, month: 1, day: 1 })).toEqual(utc(2024, 2, 29));
  });

  it('observes Feb 29 birthdays on Feb 28 in non-leap years (2025)', () => {
    expect(birthdayThisYear(2, 29, { year: 2025, month: 1, day: 1 })).toEqual(utc(2025, 2, 28));
  });

  it('returns null for invalid month/day combinations', () => {
    expect(birthdayThisYear(13, 1, { year: 2025, month: 1, day: 1 })).toBeNull();
    expect(birthdayThisYear(2, 30, { year: 2024, month: 1, day: 1 })).toBeNull();
    expect(birthdayThisYear(4, 31, { year: 2025, month: 1, day: 1 })).toBeNull();
    expect(birthdayThisYear(0, 1, { year: 2025, month: 1, day: 1 })).toBeNull();
    expect(birthdayThisYear(1, 0, { year: 2025, month: 1, day: 1 })).toBeNull();
  });
});

describe('daysUntil', () => {
  it('returns 7 across March DST in America/New_York (Mar 8 → Mar 15)', () => {
    // DST forward: 2025-03-09 02:00 → 03:00 in US/Eastern.
    const today = { year: 2025, month: 3, day: 8 };
    const target = utcNoon(2025, 3, 15);
    expect(daysUntil(target, today, 'America/New_York')).toBe(7);
  });

  it('returns 7 across November DST in America/New_York (Nov 1 → Nov 8)', () => {
    // DST back: 2025-11-02 02:00 → 01:00 in US/Eastern.
    const today = { year: 2025, month: 11, day: 1 };
    const target = utcNoon(2025, 11, 8);
    expect(daysUntil(target, today, 'America/New_York')).toBe(7);
  });

  it('returns 7 across March DST in America/Los_Angeles', () => {
    const today = { year: 2025, month: 3, day: 8 };
    const target = utcNoon(2025, 3, 15);
    expect(daysUntil(target, today, 'America/Los_Angeles')).toBe(7);
  });

  it('returns 0 for same-day target', () => {
    const today = { year: 2026, month: 5, day: 12 };
    expect(daysUntil(utcNoon(2026, 5, 12), today, 'America/New_York')).toBe(0);
  });

  it('returns negative for past targets', () => {
    const today = { year: 2026, month: 5, day: 12 };
    expect(daysUntil(utcNoon(2026, 5, 5), today, 'UTC')).toBe(-7);
  });

  it('respects tz when computing target calendar date', () => {
    // 2026-05-13T05:00:00Z is 2026-05-12 22:00 in LA. Today in LA is 2026-05-12.
    // So days-until is 0 even though the UTC instant is "tomorrow".
    const today = { year: 2026, month: 5, day: 12 };
    const target = new Date('2026-05-13T05:00:00Z');
    expect(daysUntil(target, today, 'America/Los_Angeles')).toBe(0);
  });
});

describe('anniversaryThisYear', () => {
  it('mid-year start: returns this-year date and correct year count', () => {
    const start = utc(2020, 6, 15);
    const today = { year: 2026, month: 5, day: 12 };
    expect(anniversaryThisYear(start, today)).toEqual({ date: utc(2026, 6, 15), years: 6 });
  });

  it('end-of-year start: returns Dec date and correct year count', () => {
    const start = utc(2019, 12, 20);
    const today = { year: 2026, month: 1, day: 5 };
    expect(anniversaryThisYear(start, today)).toEqual({ date: utc(2026, 12, 20), years: 7 });
  });

  it('returns null if startDate is in the future', () => {
    const start = utc(2027, 1, 1);
    const today = { year: 2026, month: 5, day: 12 };
    expect(anniversaryThisYear(start, today)).toBeNull();
  });

  it('returns null if startDate is today (no anniversary yet)', () => {
    const start = utc(2026, 5, 12);
    const today = { year: 2026, month: 5, day: 12 };
    expect(anniversaryThisYear(start, today)).toBeNull();
  });

  it('observes Feb 29 anniversaries on Feb 28 in non-leap years', () => {
    const start = utc(2020, 2, 29);
    const today = { year: 2025, month: 1, day: 1 };
    expect(anniversaryThisYear(start, today)).toEqual({ date: utc(2025, 2, 28), years: 5 });
  });

  it('keeps Feb 29 anniversary on Feb 29 in a leap year', () => {
    const start = utc(2020, 2, 29);
    const today = { year: 2024, month: 1, day: 1 };
    expect(anniversaryThisYear(start, today)).toEqual({ date: utc(2024, 2, 29), years: 4 });
  });
});
