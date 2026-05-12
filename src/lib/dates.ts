import { formatInTimeZone } from 'date-fns-tz';

// All functions are pure and deterministic given inputs. Date math goes through
// date-fns-tz; no raw Date arithmetic, no implicit `process.env.TZ` reads.
//
// Feb 29 rule: a Feb 29 birthday in a non-leap year is observed on Feb 28.
// A Feb 29 start date produces anniversaries on Feb 28 in non-leap years.
// Same rule for both — we don't want to silently skip Feb-29 people 3 years
// out of 4, and Feb 28 sits inside February (March 1 would feel wrong).

export type CalendarDate = { year: number; month: number; day: number };

const utcMidnight = (year: number, month: number, day: number): Date =>
  new Date(Date.UTC(year, month - 1, day));

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const daysInMonth = (month: number, year: number): number => {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
};

const isValidMonthDay = (month: number, day: number): boolean => {
  if (!Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  // Allow Feb 29 by validating against a leap year; observed-day adjustment
  // happens at the call site that knows the actual year.
  return day <= daysInMonth(month, 2000);
};

export const nowInWorkspaceTz = (_tz: string): Date => new Date();

export const todayInWorkspaceTz = (tz: string, now: Date = new Date()): CalendarDate => {
  const ymd = formatInTimeZone(now, tz, 'yyyy-MM-dd');
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return { year: y, month: m, day: d };
};

export const birthdayThisYear = (month: number, day: number, today: CalendarDate): Date | null => {
  if (!isValidMonthDay(month, day)) return null;
  const observedDay = month === 2 && day === 29 && !isLeapYear(today.year) ? 28 : day;
  return utcMidnight(today.year, month, observedDay);
};

// Whole calendar days from `today` (in tz) to `target` (also evaluated in tz).
// Subtracts UTC midnights of the two calendar dates, so DST transitions never
// produce 23h/25h-induced off-by-one errors.
export const daysUntil = (target: Date, today: CalendarDate, tz: string): number => {
  const targetYmd = formatInTimeZone(target, tz, 'yyyy-MM-dd');
  const [ty, tm, td] = targetYmd.split('-').map(Number) as [number, number, number];
  const todayMs = utcMidnight(today.year, today.month, today.day).getTime();
  const targetMs = utcMidnight(ty, tm, td).getTime();
  return Math.round((targetMs - todayMs) / 86_400_000);
};

export const anniversaryThisYear = (
  startDate: Date,
  today: CalendarDate,
): { date: Date; years: number } | null => {
  const sy = startDate.getUTCFullYear();
  const sm = startDate.getUTCMonth() + 1;
  const sd = startDate.getUTCDate();
  const startGteToday =
    sy > today.year ||
    (sy === today.year && sm > today.month) ||
    (sy === today.year && sm === today.month && sd >= today.day);
  if (startGteToday) return null;
  const years = today.year - sy;
  const observedDay = sm === 2 && sd === 29 && !isLeapYear(today.year) ? 28 : sd;
  return { date: utcMidnight(today.year, sm, observedDay), years };
};
