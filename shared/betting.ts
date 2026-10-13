// Advanced, deterministic betting math: several margin-removal ("de-vig") methods, fractional
// odds, Kelly sizing, arbitrage and parlay arithmetic. Every function is pure and unit-tested.

import { impliedProbability, parseDecimal, type Result } from "./odds";

export type DevigMethod = "proportional" | "power" | "shin" | "odds_ratio";

export const DEVIG_METHODS: { key: DevigMethod; label: string; summary: string }[] = [
  { key: "proportional", label: "Proportional (multiplicative)", summary: "Divides each implied probability by the total. Spreads the margin evenly in proportion to price." },
  { key: "power", label: "Power", summary: "Raises each implied probability to the power k that makes the set sum to 1. Takes more margin from longshots." },
  { key: "shin", label: "Shin", summary: "Models a share z of informed money; the solution removes more margin from longshots (favourite–longshot bias)." },
  { key: "odds_ratio", label: "Odds ratio", summary: "Scales the odds q/(1−q) of every outcome by the same factor so probabilities sum to 1." },
];

function bisect(f: (x: number) => number, lo: number, hi: number, iterations = 200): number {
  let flo = f(lo);
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (Math.abs(fm) < 1e-15) return mid;
    if (Math.sign(fm) === Math.sign(flo)) {
      lo = mid;
      flo = fm;
    } else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Remove the bookmaker margin from ONE book's complete outcome set with the chosen method.
 * Returns probabilities that sum to 1. With no margin (sum q = 1) every method returns q.
 */
export function devig(decimals: number[], method: DevigMethod = "proportional"): number[] {
  if (decimals.length < 2) throw new RangeError("A complete outcome set needs at least two outcomes");
  const q = decimals.map(impliedProbability);
  const total = q.reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) < 1e-12) return q;
  const normalise = (p: number[]) => {
    const s = p.reduce((a, b) => a + b, 0);
    return p.map((x) => x / s);
  };
  switch (method) {
    case "proportional":
      return q.map((x) => x / total);
    case "power": {
      // sum q_i^k = 1; k > 1 when there is a margin (total > 1), k < 1 for a negative margin.
      const f = (k: number) => q.reduce((s, x) => s + x ** k, 0) - 1;
      const k = total > 1 ? bisect(f, 1, 50) : bisect(f, 0.01, 1);
      return normalise(q.map((x) => x ** k));
    }
    case "shin": {
      if (total < 1) return q.map((x) => x / total); // Shin is undefined without a positive margin
      const pOf = (z: number) => q.map((x) => (Math.sqrt(z * z + (4 * (1 - z) * x * x) / total) - z) / (2 * (1 - z)));
      const f = (z: number) => pOf(z).reduce((a, b) => a + b, 0) - 1;
      const z = bisect(f, 0, 0.999);
      return normalise(pOf(z));
    }
    case "odds_ratio": {
      // p_i = q_i / (q_i + c (1 - q_i)); find c so the probabilities sum to 1.
      const pOf = (c: number) => q.map((x) => x / (x + c * (1 - x)));
      const f = (c: number) => pOf(c).reduce((a, b) => a + b, 0) - 1;
      const c = total > 1 ? bisect(f, 1, 1000) : bisect(f, 0.001, 1);
      return normalise(pOf(c));
    }
  }
}

/** Shin's z: the estimated share of informed ("insider") money implied by one book's prices. */
export function shinZ(decimals: number[]): number {
  const q = decimals.map(impliedProbability);
  const total = q.reduce((a, b) => a + b, 0);
  if (total <= 1) return 0;
  const f = (z: number) => q.reduce((s, x) => s + (Math.sqrt(z * z + (4 * (1 - z) * x * x) / total) - z) / (2 * (1 - z)), 0) - 1;
  return bisect(f, 0, 0.999);
}

// ---------------- other odds formats ----------------
function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

/** Decimal odds -> fractional odds string, e.g. 2.5 -> "3/2". Uses the simplest fraction within 0.5% of the price. */
export function decimalToFractional(d: number): string {
  const parsed = parseDecimal(d);
  if (!parsed.ok) throw new RangeError(parsed.error);
  const x = d - 1;
  for (let den = 1; den <= 200; den++) {
    const num = Math.round(x * den);
    if (num > 0 && Math.abs(num / den - x) / x < 0.005) {
      const g = gcd(num, den);
      return `${num / g}/${den / g}`;
    }
  }
  return `${Math.round(x * 100)}/100`;
}

export function parseFractional(input: unknown): Result<number> {
  if (typeof input !== "string") return { ok: false, error: "Fractional odds must look like 5/2" };
  const m = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(input);
  if (!m) return { ok: false, error: `"${input}" is not fractional odds like 5/2` };
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!(num > 0) || !(den > 0)) return { ok: false, error: "Both parts of fractional odds must be positive" };
  return { ok: true, value: 1 + num / den };
}

// ---------------- staking, arbitrage, parlays ----------------
/**
 * Kelly fraction of bankroll for one bet: f* = (p*d - 1)/(d - 1). Negative means "no bet".
 * Kelly assumes p is exactly right; with estimated probabilities it overbets, so fractional
 * Kelly (e.g. 1/4) is the usual educational reference. With pushes, use p_win/(1-p_push) on the
 * non-push outcomes.
 */
export function kellyFraction(p: number, d: number): number {
  const parsed = parseDecimal(d);
  if (!parsed.ok) throw new RangeError(parsed.error);
  if (!(p >= 0 && p <= 1)) throw new RangeError("probability must be between 0 and 1");
  return (p * d - 1) / (d - 1);
}

export interface Arbitrage {
  isArbitrage: boolean;
  /** Sum of 1/d over the best price for each outcome; below 1 means a guaranteed-return combination exists. */
  impliedTotal: number;
  /** Guaranteed return on the total stake if every leg is placed at these prices at the same time. */
  margin: number;
  /** Share of the total stake for each outcome so every result pays the same. */
  stakeShares: number[];
}

/** Arbitrage check across the best prices for every outcome of ONE contract (possibly from different books). */
export function arbitrage(bestDecimals: number[]): Arbitrage {
  if (bestDecimals.length < 2) throw new RangeError("Need a price for every outcome");
  const inv = bestDecimals.map(impliedProbability);
  const total = inv.reduce((a, b) => a + b, 0);
  return { isArbitrage: total < 1 - 1e-9, impliedTotal: total, margin: 1 / total - 1, stakeShares: inv.map((x) => x / total) };
}

/** Parlay (accumulator) price, and its probability ONLY IF the legs are independent. */
export function parlay(legs: { decimal: number; probability?: number }[]): { decimal: number; probabilityIfIndependent: number | null; ev: number | null } {
  if (!legs.length) throw new RangeError("A parlay needs at least one leg");
  let d = 1;
  let p: number | null = 1;
  for (const l of legs) {
    const parsed = parseDecimal(l.decimal);
    if (!parsed.ok) throw new RangeError(parsed.error);
    d *= l.decimal;
    p = l.probability == null || p == null ? null : p * l.probability;
  }
  return { decimal: d, probabilityIfIndependent: p, ev: p == null ? null : p * d - 1 };
}

/** Stake on the opposite side that equalises the payout of an existing bet (hedging). */
export function hedgeStake(originalStake: number, originalDecimal: number, hedgeDecimal: number): { stake: number; lockedProfit: number } {
  if (!(originalStake > 0)) throw new RangeError("stake must be positive");
  for (const d of [originalDecimal, hedgeDecimal]) {
    const parsed = parseDecimal(d);
    if (!parsed.ok) throw new RangeError(parsed.error);
  }
  const stake = (originalStake * originalDecimal) / hedgeDecimal;
  return { stake, lockedProfit: originalStake * originalDecimal - originalStake - stake };
}

/** Closing line value: how much better a taken price was than the closing fair price (positive is good). */
export function closingLineValue(takenDecimal: number, closingFairProbability: number): number {
  return takenDecimal * closingFairProbability - 1;
}

/** Average of several prices for the same outcome, done on the probability scale (the meaningful average). */
export function averagePrice(decimals: number[]): number {
  if (!decimals.length) throw new RangeError("No prices to average");
  const meanImplied = decimals.reduce((s, d) => s + impliedProbability(d), 0) / decimals.length;
  return 1 / meanImplied;
}
