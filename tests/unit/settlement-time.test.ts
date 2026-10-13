import { describe, expect, it } from "vitest";
import { contractFromOddsApiMarket, contractId, sameContract } from "../../shared/contracts";
import { realisedOutcome, settle } from "../../shared/settlement";
import { localDateOf, localDayBounds, parseTimestamp } from "../../shared/time";
import { brier, calibrationBins, expectedCalibrationError, logLoss, pairedBootstrapCI, wilson } from "../../shared/evaluation";

describe("equivalent-market matching", () => {
  it("never treats regulation 3-way and overtime-inclusive 2-way as the same contract", () => {
    expect(sameContract({ contract: "moneyline_2way_full_game" }, { contract: "moneyline_3way_regulation" })).toBe(false);
    expect(contractFromOddsApiMarket("icehockey_nhl", "h2h")).toBe("moneyline_2way_full_game");
    expect(contractFromOddsApiMarket("icehockey_nhl", "h2h_3_way")).toBe("moneyline_3way_regulation");
    expect(contractFromOddsApiMarket("soccer_epl", "h2h")).toBe("moneyline_3way_regulation");
    expect(contractFromOddsApiMarket("baseball_mlb", "h2h")).toBe("moneyline_2way_full_game");
  });

  it("different lines and totals are different contracts", () => {
    expect(sameContract({ contract: "spread_full_game", line: -1.5 }, { contract: "spread_full_game", line: -1.5 })).toBe(true);
    expect(sameContract({ contract: "spread_full_game", line: -1.5 }, { contract: "spread_full_game", line: -2.5 })).toBe(false);
    expect(sameContract({ contract: "total_full_game", line: 8.5 }, { contract: "total_full_game", line: 9 })).toBe(false);
    expect(contractId("total_full_game", 8.5)).toBe("total_full_game@8.5");
    expect(() => contractId("total_full_game", null)).toThrow();
  });

  it("ignores unsupported provider markets", () => {
    expect(contractFromOddsApiMarket("baseball_mlb", "h2h_lay")).toBeNull();
    expect(contractFromOddsApiMarket("baseball_mlb", "player_hits")).toBeNull();
    expect(contractFromOddsApiMarket("icehockey_nhl", "h2h_p1")).toBeNull();
  });
});

describe("settlement rules", () => {
  const final = (h: number, a: number, extra: object = {}) => ({ status: "final" as const, homeScore: h, awayScore: a, ...extra });

  it("2-way moneyline includes extra time and voids postponements/cancellations", () => {
    expect(settle("moneyline_2way_full_game", "home", null, final(5, 4)).settlement).toBe("win");
    expect(settle("moneyline_2way_full_game", "away", null, final(5, 4)).settlement).toBe("loss");
    expect(settle("moneyline_2way_full_game", "home", null, final(3, 3)).settlement).toBe("void");
    expect(settle("moneyline_2way_full_game", "home", null, { status: "postponed", homeScore: null, awayScore: null }).settlement).toBe("void");
    expect(settle("moneyline_2way_full_game", "home", null, { status: "cancelled", homeScore: null, awayScore: null }).settlement).toBe("void");
    expect(settle("moneyline_2way_full_game", "home", null, { status: "suspended", homeScore: 2, awayScore: 1 }).settlement).toBe("pending");
    expect(settle("moneyline_2way_full_game", "home", null, { status: "in_progress", homeScore: 2, awayScore: 1 }).settlement).toBe("pending");
    expect(settle("moneyline_2way_full_game", "home", null, { status: "final", homeScore: null, awayScore: null }).settlement).toBe("unsupported");
  });

  it("3-way settles on regulation only, draw is a real outcome", () => {
    // Regulation 2-2, extra time won by home: 3-way result is a draw.
    const r = final(3, 2, { regulationHome: 2, regulationAway: 2 });
    expect(settle("moneyline_3way_regulation", "draw", null, r).settlement).toBe("win");
    expect(settle("moneyline_3way_regulation", "home", null, r).settlement).toBe("loss");
    // ...while the 2-way overtime-inclusive contract goes to home.
    expect(settle("moneyline_2way_full_game", "home", null, r).settlement).toBe("win");
    // Without a known regulation score we refuse to settle.
    expect(settle("moneyline_3way_regulation", "home", null, final(3, 2)).settlement).toBe("unsupported");
    expect(settle("moneyline_3way_regulation", "home", null, final(3, 2, { finalIsRegulation: true })).settlement).toBe("win");
    expect(realisedOutcome("moneyline_3way_regulation", final(1, 1, { finalIsRegulation: true }))).toBe("draw");
  });

  it("spreads and totals push exactly on the line", () => {
    expect(settle("spread_full_game", "home", -1, final(4, 3)).settlement).toBe("push");
    expect(settle("spread_full_game", "home", -1.5, final(4, 3)).settlement).toBe("loss");
    expect(settle("spread_full_game", "away", -1.5, final(4, 3)).settlement).toBe("win");
    expect(settle("spread_full_game", "home", -1.5, final(5, 3)).settlement).toBe("win");
    expect(settle("total_full_game", "over", 7, final(4, 3)).settlement).toBe("push");
    expect(settle("total_full_game", "over", 6.5, final(4, 3)).settlement).toBe("win");
    expect(settle("total_full_game", "under", 6.5, final(4, 3)).settlement).toBe("loss");
  });
});

describe("timezones, DST and midnight crossings", () => {
  it("spring-forward day in New York has 23 hours", () => {
    const b = localDayBounds("2026-03-08", "America/New_York");
    expect(b.hours).toBe(23);
    expect(b.startUtc).toBe("2026-03-08T05:00:00Z");
    expect(b.endUtc).toBe("2026-03-09T04:00:00Z");
  });

  it("fall-back day in New York has 25 hours", () => {
    const b = localDayBounds("2026-11-01", "America/New_York");
    expect(b.hours).toBe(25);
    expect(b.startUtc).toBe("2026-11-01T04:00:00Z");
    expect(b.endUtc).toBe("2026-11-02T05:00:00Z");
  });

  it("a late west-coast game belongs to the next local day in the east", () => {
    const start = "2026-06-16T05:10:00Z"; // 22:10 PDT on the 15th, 01:10 EDT on the 16th
    expect(localDateOf(start, "America/Los_Angeles")).toBe("2026-06-15");
    expect(localDateOf(start, "America/New_York")).toBe("2026-06-16");
  });

  it("works in zones with non-hour offsets and in the southern hemisphere", () => {
    expect(localDayBounds("2026-04-05", "Australia/Sydney").hours).toBe(25); // DST ends
    expect(localDayBounds("2026-06-01", "Asia/Kolkata").startUtc).toBe("2026-05-31T18:30:00Z");
  });

  it("rejects invalid dates and zones", () => {
    expect(() => localDayBounds("2026-02-30", "UTC")).toThrow();
    expect(() => localDayBounds("2026-06-01", "Mars/Olympus")).toThrow();
  });

  it("parses ISO and RFC 2822 timestamps", () => {
    expect(parseTimestamp("Tue, 14 Apr 2026 15:04:05 GMT")).toBe("2026-04-14T15:04:05Z");
    expect(parseTimestamp("2026-04-14T11:04:05-04:00")).toBe("2026-04-14T15:04:05Z");
    expect(parseTimestamp("yesterday")).toBeNull();
  });
});

describe("scoring and calibration", () => {
  it("computes Brier and log loss", () => {
    expect(brier(0.7, 1)).toBeCloseTo(0.09, 12);
    expect(brier(0.7, 0)).toBeCloseTo(0.49, 12);
    expect(logLoss(0.5, 1)).toBeCloseTo(Math.log(2), 12);
    expect(Number.isFinite(logLoss(0, 1))).toBe(true);
  });

  it("bins predictions and reports calibration error", () => {
    const preds = [0.05, 0.15, 0.15, 0.95, 1.0];
    const ys: (0 | 1)[] = [0, 0, 1, 1, 1];
    const bins = calibrationBins(preds, ys, 10);
    expect(bins[1].count).toBe(2);
    expect(bins[1].observedRate).toBe(0.5);
    expect(bins[9].count).toBe(2); // 1.0 lands in the top bin
    expect(expectedCalibrationError(bins)).toBeGreaterThan(0);
    const [lo, hi] = wilson(5, 10);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
  });

  it("bootstrap is deterministic and refuses tiny samples", () => {
    const a = Array.from({ length: 50 }, (_, i) => (i % 3) / 10);
    const b = Array.from({ length: 50 }, (_, i) => (i % 5) / 10);
    expect(pairedBootstrapCI(a, b)).toEqual(pairedBootstrapCI(a, b));
    expect(pairedBootstrapCI(a.slice(0, 5), b.slice(0, 5))).toBeNull();
  });
});
