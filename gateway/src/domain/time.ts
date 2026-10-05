// Nigeria is UTC+1 all year (WAT, no daylight saving).
const WAT_OFFSET_MS = 60 * 60 * 1000;

/** YYYY-MM-DD in WAT; passed to N-ATLaS so "today"/"yesterday" make sense. */
export function todayWAT(now: Date): string {
  return new Date(now.getTime() + WAT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Start of the current day / week (Monday) / month in WAT, as a UTC instant. */
export function periodStart(period: "today" | "week" | "month", now: Date): Date {
  const wat = new Date(now.getTime() + WAT_OFFSET_MS);
  let y = wat.getUTCFullYear();
  let m = wat.getUTCMonth();
  let d = wat.getUTCDate();
  if (period === "week") d -= (wat.getUTCDay() + 6) % 7;
  if (period === "month") d = 1;
  return new Date(Date.UTC(y, m, d) - WAT_OFFSET_MS);
}
