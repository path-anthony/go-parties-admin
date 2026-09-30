// Everything the scheduler does with time is America/New_York. A "day" is an
// Eastern calendar date, YYYY-MM-DD; event dates are already stored that way.

const TZ = "America/New_York";

const fmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

function parts(d: Date) {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, hour: p.hour, minute: p.minute, second: p.second };
}

// The Eastern calendar day an instant falls on.
export function easternDay(d: Date): string {
  const p = parts(d);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export function addDays(day: string, n: number): string {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

// 0 = Sunday.
export function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

// The instant at hh:mm Eastern on a given day. Daylight saving is handled by
// asking the zone what its wall clock reads and correcting the difference.
export function atEastern(day: string, hh: number, mm = 0): Date {
  const [y, m, d] = day.split("-").map(Number);
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = parts(new Date(guess));
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute, p.second);
    const diff = shown - wanted;
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess);
}

// A nurture message never goes on a Sunday: a Sunday day moves to Monday.
export function skipSunday(day: string): string {
  return weekdayOf(day) === 0 ? addDays(day, 1) : day;
}

const dateFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });

// "Tue, Oct 7 at 10:00 AM"
export function humanWhen(d: Date): string {
  return `${dateFmt.format(d)} at ${timeFmt.format(d)}`;
}

// "Tue, Oct 7"
export function humanDay(d: Date): string {
  return dateFmt.format(d);
}
