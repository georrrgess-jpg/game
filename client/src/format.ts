import { formatPct, formatPctPoints, formatAmerican, formatDecimal, formatPoints } from "../../shared/odds";

export { formatPct, formatPctPoints, formatAmerican, formatDecimal, formatPoints };

export function fmtTime(iso: string | null | undefined, zone: string, opts: Intl.DateTimeFormatOptions = {}): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: zone, ...opts }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

export function fmtDateTime(iso: string | null | undefined, zone: string): string {
  return fmtTime(iso, zone, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

export function fmtDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y) return isoDate;
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function ago(iso: string | null | undefined, nowIso: string): string {
  if (!iso) return "—";
  const mins = (Date.parse(nowIso) - Date.parse(iso)) / 60000;
  if (!Number.isFinite(mins)) return "—";
  if (mins < -1) return `in ${dur(-mins)}`;
  if (mins < 1) return "just now";
  return `${dur(mins)} ago`;
}

function dur(m: number): string {
  if (m < 60) return `${Math.round(m)} min`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h`;
  return `${Math.round(m / 1440)} d`;
}

/** YYYY-MM-DD of an instant in a zone. */
export function localDate(iso: string, zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${g("year")}-${g("month")}-${g("day")}`;
  } catch {
    return iso.slice(0, 10);
  }
}

export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** Convert a datetime-local value interpreted in `zone` to a UTC ISO string. */
export function zonedLocalToUtc(local: string, zone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as unknown as number[];
  // Iterate: guess UTC, measure the zone offset at that instant, correct.
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const offset = zoneOffsetMinutes(new Date(guess), zone);
    guess = Date.UTC(y, mo - 1, d, h, mi) - offset * 60000;
  }
  return new Date(guess).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function utcToZonedLocal(iso: string, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

function zoneOffsetMinutes(date: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return Math.round((asUtc - date.getTime()) / 60000);
}

export const outcomeLabel = (o: string, names: Partial<Record<string, string>>) => names[o] ?? (o === "draw" ? "Draw" : o);

export const statusLabel: Record<string, string> = {
  scheduled: "Scheduled",
  in_progress: "Started",
  final: "Final",
  postponed: "Postponed",
  cancelled: "Cancelled",
  suspended: "Suspended",
  unknown: "Status unknown",
};

export function sportLabel(key: string): string {
  const map: Record<string, string> = {
    demo_baseball: "Baseball (fictional)",
    demo_soccer: "Soccer (fictional)",
    baseball_mlb: "MLB",
    basketball_nba: "NBA",
    americanfootball_nfl: "NFL",
    icehockey_nhl: "NHL",
  };
  return map[key] ?? key.replace(/_/g, " ");
}
