import { describe, expect, it } from "vitest";
import {
  americanToDecimal,
  breakEvenProbability,
  consensusFromBooks,
  decimalToAmerican,
  expectedNetPoints,
  expectedNetPointsWithPush,
  formatAmerican,
  formatPct,
  formatPctPoints,
  impliedProbability,
  overround,
  parseAmerican,
  parseDecimal,
  proportionalNoVig,
  settledNetPoints,
} from "../../shared/odds";

describe("American odds conversion", () => {
  it("converts positive odds: d = 1 + A/100", () => {
    expect(americanToDecimal(150)).toBeCloseTo(2.5, 12);
    expect(americanToDecimal(100)).toBeCloseTo(2.0, 12);
    expect(americanToDecimal(250)).toBeCloseTo(3.5, 12);
  });

  it("converts negative odds: d = 1 + 100/|A|", () => {
    expect(americanToDecimal(-110)).toBeCloseTo(1 + 100 / 110, 12);
    expect(americanToDecimal(-200)).toBeCloseTo(1.5, 12);
    expect(americanToDecimal(-100)).toBeCloseTo(2.0, 12);
  });

  it("+100 and -100 are the same price", () => {
    expect(americanToDecimal(100)).toBe(americanToDecimal(-100));
  });

  it("round-trips decimal <-> American", () => {
    for (const a of [-1000, -250, -137, -110, -101, 100, 101, 120, 333, 900]) {
      const back = decimalToAmerican(americanToDecimal(a));
      expect(back).toBeCloseTo(a === -100 ? 100 : a, 9);
    }
  });

  it("rejects zero and malformed quotes", () => {
    for (const bad of [0, "0", 50, -99.5, "abc", "", "+", "1e3", NaN, Infinity, null, undefined, "--110", "+-110", {}]) {
      expect(parseAmerican(bad).ok).toBe(false);
    }
    expect(() => americanToDecimal(0)).toThrow();
    expect(() => americanToDecimal(75)).toThrow();
  });

  it("accepts signed numeric strings with whitespace", () => {
    expect(parseAmerican(" +150 ")).toEqual({ ok: true, value: 150 });
    expect(parseAmerican("-110")).toEqual({ ok: true, value: -110 });
  });

  it("rejects malformed decimal odds", () => {
    for (const bad of [1, 0.5, 0, -2, "x", NaN, 20000]) expect(parseDecimal(bad).ok).toBe(false);
    expect(parseDecimal("1.91")).toEqual({ ok: true, value: 1.91 });
  });
});

describe("implied probability and margin", () => {
  it("q = 1/d", () => {
    expect(impliedProbability(2.5)).toBeCloseTo(0.4, 12);
    expect(impliedProbability(americanToDecimal(-110))).toBeCloseTo(110 / 210, 12);
  });

  it("break-even equals raw implied probability", () => {
    expect(breakEvenProbability(1.8)).toBeCloseTo(1 / 1.8, 12);
  });

  it("standard -110/-110 market has ~4.76% overround and splits 50/50 after adjustment", () => {
    const d = americanToDecimal(-110);
    expect(overround([d, d])).toBeCloseTo(2 * (110 / 210) - 1, 12);
    const p = proportionalNoVig([d, d]);
    expect(p[0]).toBeCloseTo(0.5, 12);
    expect(p[0] + p[1]).toBeCloseTo(1, 12);
  });

  it("proportional adjustment divides by the sum", () => {
    const decimals = [1.5, 2.8];
    const q = decimals.map((d) => 1 / d);
    const s = q[0] + q[1];
    const p = proportionalNoVig(decimals);
    expect(p[0]).toBeCloseTo(q[0] / s, 12);
    expect(p[1]).toBeCloseTo(q[1] / s, 12);
  });

  it("handles three-way markets including the draw", () => {
    const decimals = [2.1, 3.4, 3.6]; // home, draw, away
    const p = proportionalNoVig(decimals);
    expect(p.length).toBe(3);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(overround(decimals)).toBeCloseTo(1 / 2.1 + 1 / 3.4 + 1 / 3.6 - 1, 12);
    // Dropping the draw would wrongly inflate both sides.
    const twoWayWrong = proportionalNoVig([2.1, 3.6]);
    expect(twoWayWrong[0]).toBeGreaterThan(p[0]);
  });

  it("requires a complete set", () => {
    expect(() => proportionalNoVig([1.9])).toThrow();
  });

  it("consensus takes per-book medians then renormalises", () => {
    const c = consensusFromBooks([
      [0.6, 0.4],
      [0.62, 0.38],
      [0.58, 0.42],
    ]);
    expect(c[0]).toBeCloseTo(0.6, 12);
    expect(c[0] + c[1]).toBeCloseTo(1, 12);
    const three = consensusFromBooks([
      [0.5, 0.25, 0.25],
      [0.4, 0.3, 0.3],
    ]);
    expect(three.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(() => consensusFromBooks([[0.5, 0.5], [0.3, 0.3, 0.4]])).toThrow();
    expect(() => consensusFromBooks([])).toThrow();
  });
});

describe("expected net points", () => {
  it("p*(d-1) - (1-p) equals p*d - 1", () => {
    for (const [p, d] of [
      [0.55, 1.91],
      [0.3, 3.5],
      [0.5, 2],
      [0.01, 101],
    ]) {
      expect(expectedNetPoints(p, d)).toBeCloseTo(p * (d - 1) - (1 - p), 12);
      expect(expectedNetPoints(p, d)).toBeCloseTo(p * d - 1, 12);
    }
  });

  it("is zero exactly at the break-even probability", () => {
    const d = americanToDecimal(+130);
    expect(expectedNetPoints(breakEvenProbability(d), d)).toBeCloseTo(0, 12);
  });

  it("with pushes: p_win*(d-1) - p_loss", () => {
    expect(expectedNetPointsWithPush(0.45, 0.45, 0.1, 2.0)).toBeCloseTo(0, 12);
    expect(expectedNetPointsWithPush(0.5, 0.4, 0.1, 1.91)).toBeCloseTo(0.5 * 0.91 - 0.4, 12);
    expect(() => expectedNetPointsWithPush(0.5, 0.5, 0.1, 2)).toThrow();
  });

  it("rejects invalid probabilities and prices", () => {
    expect(() => expectedNetPoints(1.2, 2)).toThrow();
    expect(() => expectedNetPoints(-0.1, 2)).toThrow();
    expect(() => expectedNetPoints(0.5, 1)).toThrow();
  });

  it("settles paper stakes consistently", () => {
    expect(settledNetPoints("win", 2, 2.5)).toBeCloseTo(3, 12);
    expect(settledNetPoints("loss", 2, 2.5)).toBe(-2);
    expect(settledNetPoints("push", 2, 2.5)).toBe(0);
    expect(settledNetPoints("void", 2, 2.5)).toBe(0);
  });
});

describe("display rounding", () => {
  it("avoids unjustified precision and negative zero", () => {
    expect(formatPct(0.5749)).toBe("57%");
    expect(formatPct(0.575)).toBe("58%");
    expect(formatPctPoints(-0.0001)).toBe("0 pts");
    expect(formatPctPoints(0.034)).toBe("+3 pts");
    expect(formatAmerican(-109.6)).toBe("-110");
    expect(formatAmerican(149.99)).toBe("+150");
    expect(formatPct(null)).toBe("—");
  });
});

describe("rounding edge cases", () => {
  it("rounds half away from zero despite float artefacts", async () => {
    const { roundHalfUp, formatDecimal, formatPoints } = await import("../../shared/odds");
    expect(roundHalfUp(1.005, 2)).toBe(1.01);
    expect(roundHalfUp(-2.5, 0)).toBe(-3);
    expect(Object.is(roundHalfUp(-0.0001, 2), -0)).toBe(false);
    expect(formatDecimal(1.905)).toBe("1.91");
    expect(formatPoints(-0.004)).toBe("0.00");
    expect(formatPoints(0.125)).toBe("+0.13");
  });
});
