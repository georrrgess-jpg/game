// Deterministic odds and probability math. Everything numeric in the app
// flows through these functions; nothing here is estimated by a language model.

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const AMERICAN_RE = /^[+-]?\d+(\.\d+)?$/;

/**
 * Parse an American odds quote. Valid quotes have |A| >= 100 (e.g. -110, +150, -100, +100).
 * Zero, values strictly between -100 and +100, non-numeric text and non-finite numbers are rejected.
 */
export function parseAmerican(input: unknown): Result<number> {
  let n: number;
  if (typeof input === "number") {
    n = input;
  } else if (typeof input === "string") {
    const s = input.trim();
    if (!AMERICAN_RE.test(s)) return { ok: false, error: `"${input}" is not a valid American odds quote` };
    n = Number(s);
  } else {
    return { ok: false, error: "American odds must be a number or numeric string" };
  }
  if (!Number.isFinite(n)) return { ok: false, error: "American odds must be finite" };
  if (n === 0) return { ok: false, error: "American odds of 0 are undefined" };
  if (Math.abs(n) < 100) return { ok: false, error: "American odds must be at least +100 or at most -100" };
  return { ok: true, value: n };
}

/** American odds A -> decimal odds d. A > 0: d = 1 + A/100. A < 0: d = 1 + 100/|A|. */
export function americanToDecimal(a: number): number {
  const parsed = parseAmerican(a);
  if (!parsed.ok) throw new RangeError(parsed.error);
  return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
}

export function parseDecimal(input: unknown): Result<number> {
  const n = typeof input === "string" && input.trim() !== "" ? Number(input.trim()) : input;
  if (typeof n !== "number" || !Number.isFinite(n)) return { ok: false, error: "Decimal odds must be a finite number" };
  if (n <= 1) return { ok: false, error: "Decimal odds must be greater than 1.00" };
  if (n > 10000) return { ok: false, error: "Decimal odds above 10000 are rejected as malformed" };
  return { ok: true, value: n };
}

/** Decimal odds d -> American odds. d >= 2: +(d-1)*100. 1 < d < 2: -100/(d-1). */
export function decimalToAmerican(d: number): number {
  const parsed = parseDecimal(d);
  if (!parsed.ok) throw new RangeError(parsed.error);
  return d >= 2 ? (d - 1) * 100 : -100 / (d - 1);
}

/** Raw implied probability q = 1/d. Includes the bookmaker margin. */
export function impliedProbability(d: number): number {
  const parsed = parseDecimal(d);
  if (!parsed.ok) throw new RangeError(parsed.error);
  return 1 / d;
}

/** Break-even probability for a one-point stake at decimal odds d. Same value as the raw implied probability. */
export function breakEvenProbability(d: number): number {
  return impliedProbability(d);
}

/** Bookmaker margin (overround): sum of raw implied probabilities minus 1. */
export function overround(decimals: number[]): number {
  return decimals.reduce((s, d) => s + impliedProbability(d), 0) - 1;
}

/**
 * Proportional margin adjustment for ONE book's complete, mutually exclusive outcome set:
 * p_i = q_i / sum(q). This is an approximation of the book's view with its margin removed,
 * not a measurement of the true probability.
 */
export function proportionalNoVig(decimals: number[]): number[] {
  if (decimals.length < 2) throw new RangeError("A complete outcome set needs at least two outcomes");
  const q = decimals.map(impliedProbability);
  const total = q.reduce((a, b) => a + b, 0);
  return q.map((x) => x / total);
}

export function assertProbability(p: number, label = "probability"): void {
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
    throw new RangeError(`${label} must be between 0 and 1`);
  }
}

/**
 * Expected net points for a one-point classroom stake with no push possibility:
 * p*(d-1) - (1-p), which equals p*d - 1.
 */
export function expectedNetPoints(p: number, d: number): number {
  assertProbability(p);
  const parsed = parseDecimal(d);
  if (!parsed.ok) throw new RangeError(parsed.error);
  return p * d - 1;
}

/**
 * Expected net points when pushes (or voids/refunds) are possible:
 * p_win*(d-1) - p_loss. A push returns the stake, so it contributes 0.
 */
export function expectedNetPointsWithPush(pWin: number, pLoss: number, pPush: number, d: number): number {
  assertProbability(pWin, "win probability");
  assertProbability(pLoss, "loss probability");
  assertProbability(pPush, "push probability");
  const sum = pWin + pLoss + pPush;
  if (Math.abs(sum - 1) > 1e-9) throw new RangeError("Win, loss and push probabilities must sum to 1");
  const parsed = parseDecimal(d);
  if (!parsed.ok) throw new RangeError(parsed.error);
  return pWin * (d - 1) - pLoss;
}

/** Net points for a settled paper stake. */
export function settledNetPoints(outcome: "win" | "loss" | "push" | "void", stake: number, d: number): number {
  if (!(stake >= 0)) throw new RangeError("stake must be non-negative");
  switch (outcome) {
    case "win":
      return stake * (d - 1);
    case "loss":
      return -stake;
    case "push":
    case "void":
      return 0;
  }
}

export function median(values: number[]): number {
  if (values.length === 0) throw new RangeError("median of empty list");
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Consensus market reference: for each outcome take the median of the per-book
 * margin-adjusted probabilities, then renormalise so the set sums to 1.
 * Each input row must already be one book's complete same-timestamp set — this never
 * mixes the best prices of different books into a single "market".
 */
export function consensusFromBooks(perBook: number[][]): number[] {
  if (perBook.length === 0) throw new RangeError("No complete book sets supplied");
  const n = perBook[0].length;
  if (perBook.some((row) => row.length !== n)) throw new RangeError("All books must cover the same outcomes");
  const med = Array.from({ length: n }, (_, i) => median(perBook.map((row) => row[i])));
  const total = med.reduce((a, b) => a + b, 0);
  return med.map((x) => x / total);
}

export const logit = (p: number) => Math.log(p / (1 - p));
export const sigmoid = (x: number) => (x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x)));

/**
 * Round half away from zero, robust to binary floating-point artefacts
 * (0.575 * 100 is 57.49999... in IEEE-754 but should display as 58).
 */
export function roundHalfUp(x: number, digits = 0): number {
  const m = 10 ** digits;
  const scaled = Number((Math.abs(x) * m).toPrecision(12));
  const r = (Math.sign(x) * Math.round(scaled)) / m;
  return r === 0 ? 0 : r; // never -0
}

/** Display helpers: deliberately coarse to avoid unjustified decimal precision. */
export function formatPct(p: number | null | undefined, digits = 0): string {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${roundHalfUp(p * 100, digits).toFixed(digits)}%`;
}

export function formatPctPoints(diff: number | null | undefined, digits = 0): string {
  if (diff == null || !Number.isFinite(diff)) return "—";
  const v = roundHalfUp(diff * 100, digits);
  if (v === 0) return `${(0).toFixed(digits)} pts`;
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)} pts`;
}

export function formatAmerican(a: number | null | undefined): string {
  if (a == null || !Number.isFinite(a)) return "—";
  const r = roundHalfUp(a, 0);
  return r > 0 ? `+${r}` : `${r}`;
}

export function formatDecimal(d: number | null | undefined): string {
  if (d == null || !Number.isFinite(d)) return "—";
  return roundHalfUp(d, 2).toFixed(2);
}

export function formatPoints(x: number | null | undefined, digits = 2): string {
  if (x == null || !Number.isFinite(x)) return "—";
  const v = roundHalfUp(x, digits);
  if (v === 0) return (0).toFixed(digits);
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;
}
