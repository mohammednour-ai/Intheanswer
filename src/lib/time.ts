/**
 * Toronto-time helpers for send windows, warm-up and business days.
 * Uses Intl so it is DST-correct without extra dependencies.
 */
export const TZ = "America/Toronto";

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

export function localParts(d: Date, tz = TZ): LocalParts {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour % 24,
    minute: +p.minute,
    weekday: wd,
  };
}

/** YYYY-MM-DD in Toronto. */
export function localDate(d: Date, tz = TZ): string {
  const p = localParts(d, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function isBusinessDay(d: Date, tz = TZ): boolean {
  const wd = localParts(d, tz).weekday;
  return wd >= 1 && wd <= 5;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

export function inSendWindow(d: Date, start: string, end: string, tz = TZ): boolean {
  if (!isBusinessDay(d, tz)) return false;
  const p = localParts(d, tz);
  const now = p.hour * 60 + p.minute;
  return now >= minutesOf(start) && now < minutesOf(end);
}

/** Convert a Toronto wall-clock time on a given local date to a UTC Date. */
export function torontoToUtc(dateYmd: string, hhmm: string, tz = TZ): Date {
  const [y, mo, da] = dateYmd.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  // first guess assuming UTC, then correct by the observed offset (twice for DST edges)
  let guess = new Date(Date.UTC(y, mo - 1, da, h, mi));
  for (let i = 0; i < 2; i++) {
    const p = localParts(guess, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const target = Date.UTC(y, mo - 1, da, h, mi);
    guess = new Date(guess.getTime() + (target - asUtc));
  }
  return guess;
}

/** Add N business days (Mon-Fri, Toronto) to a date, keeping the time of day. */
export function addBusinessDays(d: Date, n: number, tz = TZ): Date {
  let cur = new Date(d.getTime());
  let added = 0;
  while (added < n) {
    cur = new Date(cur.getTime() + 24 * 3600 * 1000);
    if (isBusinessDay(cur, tz)) added++;
  }
  return cur;
}

/** Whole days between two YYYY-MM-DD dates. */
export function daysBetween(a: string, b: string): number {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

export function formatLongDate(d: Date, tz = TZ): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "long", day: "numeric" }).format(d);
}
