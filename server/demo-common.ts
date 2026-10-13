// Shared helpers for the fictional demo world: time arithmetic, the simulated polling schedule and
// the demo "books" that price games from a noisy view of the simulated truth.

import { DateTime } from "luxon";
import type { QuoteRecord, Dataset } from "./repo";
import { americanToDecimal, decimalToAmerican, sigmoid } from "../shared/odds";
import { contractId, type ContractKey, type OutcomeKey } from "../shared/contracts";
import { normal } from "../shared/rng";

export const DS: Dataset = "demo";

/**
 * Demo books. `style` is how a book adds its margin: "proportional" scales every probability equally;
 * "longshot" adds more margin to unlikely outcomes (favourite–longshot bias), as many real books do.
 */
export type MarginStyle = "proportional" | "longshot";

export const DEMO_BOOKS = [
  { key: "demo_northgate", title: "Northgate (demo book)", margin: 0.038, noise: 0.05, skip: 0.03, lag: 0, style: "proportional" as MarginStyle },
  { key: "demo_lakeshore", title: "Lakeshore (demo book)", margin: 0.045, noise: 0.06, skip: 0.05, lag: 0, style: "longshot" as MarginStyle },
  { key: "demo_summit", title: "Summit (demo book)", margin: 0.052, noise: 0.07, skip: 0.06, lag: 0, style: "longshot" as MarginStyle },
  { key: "demo_bayview", title: "Bayview (demo book)", margin: 0.065, noise: 0.08, skip: 0.08, lag: 0.35, style: "longshot" as MarginStyle },
];

export type Rand = () => number;

export function toUtc(localDate: string, time: string, zone: string): string {
  return DateTime.fromISO(`${localDate}T${time}`, { zone }).toUTC().toISO({ suppressMilliseconds: true })!;
}
export const plusMin = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
export const days = (from: string, to: string) => {
  const out: string[] = [];
  let d = DateTime.fromISO(from, { zone: "UTC" });
  const end = DateTime.fromISO(to, { zone: "UTC" });
  while (d <= end) {
    out.push(d.toISODate()!);
    d = d.plus({ days: 1 });
  }
  return out;
};
export const weekday = (date: string) => DateTime.fromISO(date, { zone: "UTC" }).weekday; // 1 = Monday
export const addDays = (date: string, n: number) => DateTime.fromISO(date, { zone: "UTC" }).plus({ days: n }).toISODate()!;

export function toAmericanRounded(p: number): number {
  // Price p (already including margin) as American odds rounded to the nearest 5.
  const d = 1 / Math.min(0.97, Math.max(0.03, p));
  let a = decimalToAmerican(d);
  a = Math.round(a / 5) * 5;
  if (a > -100 && a < 100) a = a >= 0 ? 100 : -100;
  return a;
}

/**
 * Add a book's margin to fair probabilities. Proportional: q = p (1 + m). Longshot: q = p^k with k < 1
 * chosen so the set sums to 1 + m, which puts relatively more margin on unlikely outcomes.
 */
export function withMargin(probs: number[], margin: number, style: MarginStyle): number[] {
  if (style === "proportional") return probs.map((p) => p * (1 + margin));
  let lo = 0.3;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const k = (lo + hi) / 2;
    const s = probs.reduce((a, p) => a + p ** k, 0);
    if (s > 1 + margin) lo = k;
    else hi = k;
  }
  const k = (lo + hi) / 2;
  return probs.map((p) => p ** k);
}

/** Simulated retrieval schedule: fixed daily polls (UTC) plus two pre-game polls, from the opening line to the start. */
const POLL_TIMES_UTC = ["00:30", "02:30", "04:30", "10:30", "12:30", "14:30", "16:30", "18:30", "20:30", "22:30"];
/** Dense polling (every ~2 hours while people are awake) for the current season; three snapshots for past seasons. */
export function demoSnapshotTimes(start: string, openMinutesBefore: number, cutoff: string | null, dense = true): string[] {
  const open = plusMin(start, -openMinutesBefore);
  const out = new Set<string>([open, plusMin(start, -75), plusMin(start, -20)]);
  if (!dense) return [...out].filter((t) => (!cutoff || t < cutoff) && t >= open).sort();
  let day = DateTime.fromISO(open, { zone: "utc" }).startOf("day");
  const end = DateTime.fromISO(start, { zone: "utc" });
  while (day <= end) {
    for (const hm of POLL_TIMES_UTC) {
      const t = DateTime.fromISO(`${day.toISODate()}T${hm}:00`, { zone: "utc" }).toISO({ suppressMilliseconds: true })!;
      if (t > open && t < plusMin(start, -20)) out.add(t);
    }
    day = day.plus({ days: 1 });
  }
  return [...out].filter((t) => (!cutoff || t < cutoff) && t >= open).sort();
}

interface BookSnapshotInput {
  rand: Rand;
  eventId: string;
  contract: "moneyline_2way_full_game" | "moneyline_3way_regulation";
  outcomes: ("home" | "away" | "draw")[];
  fairAt: (t: string) => number[]; // market's fair view at time t
  snapshots: string[];
}

const quote = (eventId: string, book: (typeof DEMO_BOOKS)[number], contract: ContractKey, line: number | null, outcome: OutcomeKey, american: number, sourceTime: string, t: string, market: string): QuoteRecord => ({
  dataset: DS,
  event_id: eventId,
  provider: "demo",
  book_key: book.key,
  book_title: book.title,
  contract,
  contract_id: contractId(contract, line),
  provider_market: market,
  line,
  outcome,
  price_decimal: americanToDecimal(american),
  source_time: sourceTime,
  retrieved_at: t,
  known_at: t,
});

export function bookQuotes(inp: BookSnapshotInput): QuoteRecord[] {
  const out: QuoteRecord[] = [];
  for (const book of DEMO_BOOKS) {
    if (inp.rand() < book.skip) continue; // this book does not offer the market for this game
    const bookBias = normal(inp.rand, 0, book.noise);
    let lastSource: string | null = null;
    let lastFair: number[] | null = null;
    let dropped = false;
    inp.snapshots.forEach((t, idx) => {
      // A lagging book sometimes drops out of the feed: its last quote is never re-confirmed and goes stale.
      if (!dropped && idx >= 2 && idx < inp.snapshots.length - 1 && inp.rand() < book.lag / 3) dropped = true;
      if (dropped) return;
      const fair = inp.fairAt(t);
      // Books often leave a price unchanged between polls: keep the source time when nothing moved.
      const unchanged = lastFair !== null && Math.abs(fair[0] - lastFair[0]) < 0.004;
      lastFair = fair;
      let probs: number[];
      if (fair.length === 2) {
        const pH = sigmoid(Math.log(fair[0] / fair[1]) + bookBias + normal(inp.rand, 0, 0.02));
        probs = [pH, 1 - pH];
      } else {
        const tilt = Math.exp(bookBias);
        const raw = [fair[0] * tilt, fair[1], fair[2] / tilt];
        const s = raw.reduce((a, b) => a + b, 0);
        probs = raw.map((x) => x / s);
      }
      const sourceTime = unchanged && lastSource ? lastSource : plusMin(t, -Math.floor(inp.rand() * 4));
      lastSource = sourceTime;
      const priced = withMargin(probs, book.margin, book.style);
      inp.outcomes.forEach((o, i) => {
        out.push(quote(inp.eventId, book, inp.contract, null, o, toAmericanRounded(priced[i]), sourceTime, t, inp.contract === "moneyline_3way_regulation" ? "h2h (3-way)" : "h2h"));
      });
    });
  }
  return out;
}

export interface LineQuoteInput {
  rand: Rand;
  eventId: string;
  contract: "spread_full_game" | "total_full_game";
  snapshots: string[];
  /** Market's expected home margin (spreads) or total (totals) at time t. */
  viewAt: (t: string) => number;
  /** Per-book disagreement in points (standard deviation). */
  noisePoints: number;
  /** Win / push / loss probabilities for the first outcome (home covers, or over) given a view and a line. */
  probs: (view: number, line: number) => { win: number; push: number; loss: number };
  /** Line a book hangs for its view (spreads: home line, e.g. −3.5; totals: points). */
  lineFor: (view: number) => number;
}

/** Spread or total quotes: each book hangs its own line (sticky until its view moves) and prices both sides. */
export function lineQuotes(inp: LineQuoteInput): QuoteRecord[] {
  const out: QuoteRecord[] = [];
  const outcomes: OutcomeKey[] = inp.contract === "spread_full_game" ? ["home", "away"] : ["over", "under"];
  const market = inp.contract === "spread_full_game" ? "spreads" : "totals";
  for (const book of DEMO_BOOKS) {
    if (inp.rand() < book.skip) continue;
    const bias = normal(inp.rand, 0, inp.noisePoints * (book.noise / 0.05));
    const u = inp.rand();
    const shade = u < 0.1 ? -0.5 : u < 0.2 ? 0.5 : 0;
    let line: number | null = null;
    let lastKey = "";
    let lastSource: string | null = null;
    let dropped = false;
    inp.snapshots.forEach((t, idx) => {
      if (!dropped && idx >= 2 && idx < inp.snapshots.length - 1 && inp.rand() < book.lag / 3) dropped = true;
      if (dropped) return;
      // Books mostly hang the market's line and express their own view through the price; now and then
      // a book shades its line by half a point.
      const view = inp.viewAt(t) + bias;
      const wanted = inp.lineFor(inp.viewAt(t)) + shade;
      if (line === null || Math.abs(wanted - line) >= 1) line = wanted; // books move lines in steps, not every tick
      const p = inp.probs(view, line);
      const cond = p.win / Math.max(1e-9, p.win + p.loss);
      const pp = Math.min(0.97, Math.max(0.03, cond + normal(inp.rand, 0, 0.004)));
      const priced = withMargin([pp, 1 - pp], book.margin, book.style);
      const am = priced.map(toAmericanRounded);
      const key = `${line}|${am.join(",")}`;
      const sourceTime = key === lastKey && lastSource ? lastSource : plusMin(t, -Math.floor(inp.rand() * 4));
      lastKey = key;
      lastSource = sourceTime;
      outcomes.forEach((o, i) => out.push(quote(inp.eventId, book, inp.contract, line, o, am[i], sourceTime, t, market)));
    });
  }
  return out;
}

/** Discrete Normal distribution over integers in [lo, hi] (optionally excluding 0, e.g. a margin that cannot tie). */
export function discreteNormal(mu: number, sigma: number, lo: number, hi: number, excludeZero = false): Map<number, number> {
  const m = new Map<number, number>();
  let s = 0;
  for (let x = lo; x <= hi; x++) {
    if (excludeZero && x === 0) continue;
    const v = Math.exp(-0.5 * ((x - mu) / sigma) ** 2);
    m.set(x, v);
    s += v;
  }
  for (const [k, v] of m) m.set(k, v / s);
  return m;
}

/** P(value + line > 0), P(= 0), P(< 0) under a discrete distribution. */
export function lineSplit(dist: Map<number, number>, line: number): { win: number; push: number; loss: number } {
  let win = 0;
  let push = 0;
  let loss = 0;
  for (const [v, p] of dist) {
    const x = v + line;
    if (Math.abs(x) < 1e-9) push += p;
    else if (x > 0) win += p;
    else loss += p;
  }
  return { win, push, loss };
}

export const roundHalf = (x: number) => Math.round(x * 2) / 2;
