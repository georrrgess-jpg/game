// Scoring rules and calibration. Lower Brier score and log loss are better.

import { mulberry32 } from "./rng";

const EPS = 1e-12;

/** Binary Brier score for one forecast: (p - y)^2. */
export function brier(p: number, y: 0 | 1): number {
  return (p - y) ** 2;
}

/** Binary log loss with clipping so a 0% / 100% miss is large but finite. */
export function logLoss(p: number, y: 0 | 1): number {
  const c = Math.min(1 - EPS, Math.max(EPS, p));
  return -(y * Math.log(c) + (1 - y) * Math.log(1 - c));
}

/** Multi-outcome Brier score: sum over outcomes of (p_i - y_i)^2 (range 0..2). */
export function brierMulti(probs: number[], actualIndex: number): number {
  return probs.reduce((s, p, i) => s + (p - (i === actualIndex ? 1 : 0)) ** 2, 0);
}

export function logLossMulti(probs: number[], actualIndex: number): number {
  return -Math.log(Math.min(1 - EPS, Math.max(EPS, probs[actualIndex])));
}

export interface CalibrationBin {
  lower: number;
  upper: number;
  count: number;
  meanPredicted: number | null;
  observedRate: number | null;
  /** 95% Wilson interval for the observed rate. */
  ciLow: number | null;
  ciHigh: number | null;
}

export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export function calibrationBins(preds: number[], outcomes: (0 | 1)[], nBins = 10): CalibrationBin[] {
  const bins: CalibrationBin[] = [];
  for (let b = 0; b < nBins; b++) {
    const lower = b / nBins;
    const upper = (b + 1) / nBins;
    let count = 0;
    let sumP = 0;
    let hits = 0;
    preds.forEach((p, i) => {
      const inBin = b === nBins - 1 ? p >= lower && p <= upper : p >= lower && p < upper;
      if (inBin) {
        count++;
        sumP += p;
        hits += outcomes[i];
      }
    });
    const [lo, hi] = count ? wilson(hits, count) : [null, null];
    bins.push({
      lower,
      upper,
      count,
      meanPredicted: count ? sumP / count : null,
      observedRate: count ? hits / count : null,
      ciLow: lo,
      ciHigh: hi,
    });
  }
  return bins;
}

/** Expected calibration error: count-weighted mean |predicted - observed| across bins. */
export function expectedCalibrationError(bins: CalibrationBin[]): number | null {
  const n = bins.reduce((s, b) => s + b.count, 0);
  if (!n) return null;
  return bins.reduce((s, b) => s + (b.count ? (b.count / n) * Math.abs((b.meanPredicted ?? 0) - (b.observedRate ?? 0)) : 0), 0);
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/**
 * Paired bootstrap confidence interval for mean(a_i - b_i). Seeded, so reports are reproducible.
 * Returns null when there are too few pairs for a meaningful interval.
 */
export function pairedBootstrapCI(
  a: number[],
  b: number[],
  iterations = 2000,
  seed = 12345,
  level = 0.95,
): { mean: number; low: number; high: number } | null {
  const n = a.length;
  if (n !== b.length) throw new RangeError("paired samples must be the same length");
  if (n < 20) return null;
  const d = a.map((x, i) => x - b[i]);
  const rand = mulberry32(seed);
  const stats: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[Math.floor(rand() * n)];
    stats.push(s / n);
  }
  stats.sort((x, y) => x - y);
  const alpha = (1 - level) / 2;
  return {
    mean: mean(d),
    low: stats[Math.floor(alpha * iterations)],
    high: stats[Math.min(iterations - 1, Math.ceil((1 - alpha) * iterations) - 1)],
  };
}
