import { describe, expect, it } from "vitest";
import { arbitrage, averagePrice, closingLineValue, decimalToFractional, devig, hedgeStake, kellyFraction, parlay, parseFractional, shinZ, type DevigMethod } from "../../shared/betting";
import { americanToDecimal, proportionalNoVig } from "../../shared/odds";

const METHODS: DevigMethod[] = ["proportional", "power", "shin", "odds_ratio"];

describe("margin removal methods", () => {
  it("every method returns a probability set summing to 1", () => {
    for (const m of METHODS) {
      for (const set of [[1.91, 1.91], [1.4, 3.1], [1.15, 6.5], [2.1, 3.4, 3.6], [1.05, 15, 30]]) {
        const p = devig(set, m);
        expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
        expect(p.every((x) => x > 0 && x < 1)).toBe(true);
      }
    }
  });

  it("symmetric prices give 50/50 under every method", () => {
    for (const m of METHODS) expect(devig([1.91, 1.91], m)[0]).toBeCloseTo(0.5, 10);
  });

  it("proportional matches the original implementation", () => {
    expect(devig([1.4, 3.1], "proportional")).toEqual(proportionalNoVig([1.4, 3.1]));
  });

  it("power, Shin and odds-ratio shift margin onto the longshot (favourite gets a higher probability)", () => {
    const d = [1.25, 4.2];
    const prop = devig(d, "proportional")[0];
    for (const m of ["power", "shin", "odds_ratio"] as const) expect(devig(d, m)[0]).toBeGreaterThan(prop);
  });

  it("with no margin every method returns the implied probabilities", () => {
    for (const m of METHODS) {
      const p = devig([2, 2], m);
      expect(p[0]).toBeCloseTo(0.5, 12);
    }
  });

  it("Shin's z is zero without a margin and grows with it", () => {
    expect(shinZ([2, 2])).toBe(0);
    expect(shinZ([1.91, 1.91])).toBeGreaterThan(0);
    expect(shinZ([1.8, 1.8])).toBeGreaterThan(shinZ([1.91, 1.91]));
  });
});

describe("odds formats", () => {
  it("converts decimal to simple fractions and back", () => {
    expect(decimalToFractional(2.5)).toBe("3/2");
    expect(decimalToFractional(americanToDecimal(-110))).toBe("10/11");
    expect(decimalToFractional(1.5)).toBe("1/2");
    expect(decimalToFractional(11)).toBe("10/1");
    expect(parseFractional("5/2")).toEqual({ ok: true, value: 3.5 });
    expect(parseFractional("0/2").ok).toBe(false);
    expect(parseFractional("evens").ok).toBe(false);
  });
});

describe("staking, arbitrage, parlays, hedging", () => {
  it("Kelly fraction", () => {
    expect(kellyFraction(0.55, 2)).toBeCloseTo(0.1, 12);
    expect(kellyFraction(0.5, 1.91)).toBeLessThan(0);
    expect(() => kellyFraction(1.2, 2)).toThrow();
  });

  it("detects arbitrage and equalises payouts", () => {
    const a = arbitrage([2.1, 2.05]);
    expect(a.isArbitrage).toBe(true);
    expect(a.margin).toBeGreaterThan(0);
    const payouts = a.stakeShares.map((s, i) => s * [2.1, 2.05][i]);
    expect(payouts[0]).toBeCloseTo(payouts[1], 12);
    expect(payouts[0]).toBeCloseTo(1 + a.margin, 12);
    expect(arbitrage([1.91, 1.91]).isArbitrage).toBe(false);
    expect(arbitrage([2.9, 3.6, 3.9]).isArbitrage).toBe(true);
  });

  it("parlay multiplies prices and only gives a probability for independent legs", () => {
    const p = parlay([{ decimal: 2, probability: 0.5 }, { decimal: 1.5, probability: 0.7 }]);
    expect(p.decimal).toBeCloseTo(3, 12);
    expect(p.probabilityIfIndependent).toBeCloseTo(0.35, 12);
    expect(p.ev).toBeCloseTo(0.35 * 3 - 1, 12);
    expect(parlay([{ decimal: 2 }, { decimal: 2, probability: 0.5 }]).probabilityIfIndependent).toBeNull();
  });

  it("hedge stake equalises the outcome", () => {
    const h = hedgeStake(10, 3, 1.5);
    expect(h.stake).toBeCloseTo(20, 12);
    expect(h.lockedProfit).toBeCloseTo(0, 12);
  });

  it("closing line value and averaging on the probability scale", () => {
    expect(closingLineValue(2.1, 0.5)).toBeCloseTo(0.05, 12);
    expect(averagePrice([2, 4])).toBeCloseTo(1 / ((0.5 + 0.25) / 2), 12);
    expect(() => averagePrice([])).toThrow();
  });
});
