// Timezone-aware date handling. All instants are stored as UTC ISO strings; a
// "day" is always a local calendar day in an explicit IANA timezone, so DST days
// with 23 or 25 hours and games that cross local midnight are handled correctly.

import { DateTime, IANAZone } from "luxon";

export function isValidZone(zone: string): boolean {
  return typeof zone === "string" && IANAZone.isValidZone(zone);
}

export function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s, { zone: "UTC" }).isValid;
}

/** UTC bounds [start, end) of a local calendar day. */
export function localDayBounds(localDate: string, zone: string): { startUtc: string; endUtc: string; hours: number } {
  if (!isIsoDate(localDate)) throw new RangeError(`Invalid date: ${localDate}`);
  if (!isValidZone(zone)) throw new RangeError(`Invalid timezone: ${zone}`);
  const start = DateTime.fromISO(localDate, { zone }).startOf("day");
  const end = start.plus({ days: 1 }).startOf("day");
  return {
    startUtc: start.toUTC().toISO({ suppressMilliseconds: true })!,
    endUtc: end.toUTC().toISO({ suppressMilliseconds: true })!,
    hours: end.diff(start, "hours").hours,
  };
}

/** Local calendar date (YYYY-MM-DD) of a UTC instant in a timezone. */
export function localDateOf(isoUtc: string, zone: string): string {
  const dt = DateTime.fromISO(isoUtc, { zone: "utc" });
  if (!dt.isValid) throw new RangeError(`Invalid instant: ${isoUtc}`);
  return dt.setZone(zone).toISODate()!;
}

export function toUtcIso(input: string | Date | number): string {
  const dt =
    input instanceof Date
      ? DateTime.fromJSDate(input)
      : typeof input === "number"
        ? DateTime.fromMillis(input)
        : DateTime.fromISO(input, { setZone: true });
  if (!dt.isValid) throw new RangeError(`Invalid timestamp: ${String(input)}`);
  // Whole seconds only, so ISO strings always sort chronologically.
  return dt.toUTC().set({ millisecond: 0 }).toISO({ suppressMilliseconds: true })!;
}

/** Parse a timestamp leniently (ISO or RFC 2822 as used by RSS); null if unparseable. */
export function parseTimestamp(input: unknown): string | null {
  if (typeof input !== "string" || !input.trim()) return null;
  const s = input.trim();
  let dt = DateTime.fromISO(s, { setZone: true });
  if (!dt.isValid) dt = DateTime.fromRFC2822(s, { setZone: true });
  if (!dt.isValid) dt = DateTime.fromHTTP(s, { setZone: true });
  if (!dt.isValid) return null;
  return dt.toUTC().set({ millisecond: 0 }).toISO({ suppressMilliseconds: true });
}

export function minutesBetween(aIso: string, bIso: string): number {
  return (Date.parse(bIso) - Date.parse(aIso)) / 60000;
}

export function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function addDaysToDate(localDate: string, days: number): string {
  return DateTime.fromISO(localDate, { zone: "UTC" }).plus({ days }).toISODate()!;
}

/** Human-friendly age, e.g. "12 min ago". */
export function ageLabel(iso: string, nowIso: string): string {
  const m = Math.round(minutesBetween(iso, nowIso));
  if (m < 0) return `in ${formatDuration(-m)}`;
  if (m < 1) return "just now";
  return `${formatDuration(m)} ago`;
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = minutes / 60;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} d`;
}
