// Rocket Money's GraphQL variables use plain YYYY-MM-DD dates and a consistent
// grammar: half-open month intervals [firstOfMonth, firstOfNextMonth), a `now`
// same-day marker, and history that reaches back to a first-of-month N months
// prior. All the date-driven operations share this vocabulary, so we build the
// windows once here rather than hand-rolling dates in every tool.

/** Format a Date as YYYY-MM-DD in UTC (RM dates are date-only, no tz games). */
export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** First day of the month that contains `d`, `delta` months offset. */
export function monthStart(d: Date, delta = 0): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1));
}

/** `n` days after `d`. */
export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

export interface MonthWindows {
  now: string; // today
  currentMonthStart: string; // first of this month
  nextMonthStart: string; // first of next month
  previousMonthStart: string; // first of last month
  sixMonthsAgo: string; // first of the month 6 months back
  lastMonthEnd: string; // last day of last month
}

/** Compute the standard set of month boundaries around a reference day. */
export function monthWindows(ref = new Date()): MonthWindows {
  const cur = monthStart(ref, 0);
  const next = monthStart(ref, 1);
  return {
    now: ymd(ref),
    currentMonthStart: ymd(cur),
    nextMonthStart: ymd(next),
    previousMonthStart: ymd(monthStart(ref, -1)),
    sixMonthsAgo: ymd(monthStart(ref, -6)),
    lastMonthEnd: ymd(addDays(cur, -1)),
  };
}
