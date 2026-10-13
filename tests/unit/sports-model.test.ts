// Multi-sport model, market settings, Value Finder and the new fictional leagues.

import { beforeAll, describe, expect, it } from "vitest";
import { Db } from "../../server/db";
import { Repo } from "../../server/repo";
import { generateDemoWorld } from "../../server/demo";
import { ModelService, analyzeEvent, type AnalysisContext } from "../../server/analysis";
import { buildBoard } from "../../server/board";
import { Evaluator } from "../../server/evaluation";
import { Backtester, averageLines, valueFinder, MIN_CONSENSUS_BOOKS, MIN_EDGE } from "../../server/value";
import { DEFAULT_MARKET_CONFIG, weightedConsensus } from "../../server/market";
import {
  coverProbability,
  discreteDistribution,
  impliedMean,
  lineProbabilities,
  movMultiplier,
  scheduleFeatures,
  sportConfig,
  MARGIN_RANGE,
  type DiscreteModel,
} from "../../server/model";
import { contractFromOddsApiMarket, modelKeyFor, seasonOf, tennisBestOfFromKey, tennisSurfaceFromName } from "../../shared/contracts";

describe("sport configuration", () => {
  it("maps sports to model families, keys and seasons", () => {
    expect(sportConfig("basketball_nba")).toMatchObject({ family: "basketball", mov: true, homeFeature: true });
    expect(sportConfig("americanfootball_nfl")).toMatchObject({ family: "american_football", allowTies: true });
    expect(sportConfig("tennis_atp")).toMatchObject({ family: "tennis", homeFeature: false, tennis: true, margins: false });
    expect(sportConfig("demo_baseball").family).toBe("baseball");
    expect(modelKeyFor("tennis_atp_wimbledon")).toBe("tennis_atp");
    expect(modelKeyFor("tennis_wta_us_open")).toBe("tennis_wta");
    expect(modelKeyFor("basketball_nba")).toBe("basketball_nba");
    // Seasons that cross New Year belong to their starting year.
    expect(seasonOf("americanfootball_nfl", "2026-01-18T21:00:00Z")).toBe("2025");
    expect(seasonOf("americanfootball_nfl", "2025-09-07T17:00:00Z")).toBe("2025");
    expect(seasonOf("basketball_nba", "2025-04-10T23:00:00Z")).toBe("2024");
    expect(seasonOf("baseball_mlb", "2025-10-30T23:00:00Z")).toBe("2025");
    expect(seasonOf("tennis_atp", "2025-01-20T03:00:00Z")).toBe("2025");
    expect(seasonOf("demo_football", "2026-01-05T00:00:00Z")).toBe("2026");
    expect(seasonOf("basketball_ncaab", "2025-03-20T00:00:00Z")).toBe("2024");
    expect(seasonOf("basketball_wnba", "2025-08-20T00:00:00Z")).toBe("2025");
    expect(seasonOf("americanfootball_ncaaf", "2026-01-01T20:00:00Z")).toBe("2025");
    expect(seasonOf("americanfootball_cfl", "2025-10-20T00:00:00Z")).toBe("2025");
    expect(seasonOf("soccer_usa_mls", "2025-10-20T00:00:00Z")).toBe("2025");
    expect(seasonOf("soccer_epl", "2026-04-20T00:00:00Z")).toBe("2025");
    // Tennis handicaps and totals are counted in games while results are stored in sets: never mapped.
    expect(contractFromOddsApiMarket("tennis_atp_wimbledon", "spreads")).toBeNull();
    expect(contractFromOddsApiMarket("tennis_atp_wimbledon", "totals")).toBeNull();
    expect(contractFromOddsApiMarket("tennis_atp_wimbledon", "h2h")).toBe("moneyline_2way_full_game");
    expect(tennisSurfaceFromName("tennis_atp_french_open")).toBe("clay");
    expect(tennisSurfaceFromName("tennis_wta_wimbledon")).toBe("grass");
    expect(tennisSurfaceFromName("tennis_atp_us_open")).toBe("hard");
    expect(tennisSurfaceFromName("tennis_atp_something")).toBeNull();
    expect(tennisBestOfFromKey("tennis_atp_wimbledon")).toBe(5);
    expect(tennisBestOfFromKey("tennis_wta_wimbledon")).toBe(3);
  });

  it("margin-of-victory multiplier grows with the margin and is damped for favourites", () => {
    expect(movMultiplier(20, 0)).toBeGreaterThan(movMultiplier(3, 0));
    expect(movMultiplier(10, 300)).toBeLessThan(movMultiplier(10, 0));
    expect(movMultiplier(10, -300)).toBeGreaterThan(movMultiplier(10, 0));
  });

  it("back-to-back and rest differences come from the public schedule", () => {
    const schedule = [
      { id: "1", home_id: "A", away_id: "C", start_time: "2026-03-01T00:00:00Z", status: "final" },
      { id: "2", home_id: "B", away_id: "D", start_time: "2026-02-27T00:00:00Z", status: "final" },
    ];
    expect(scheduleFeatures(schedule, "A", "B", "2026-03-02T00:00:00Z")).toEqual({ restDiff: -2, b2bDiff: 1 });
    // A postponed game does not count as having played.
    const ppd = [{ ...schedule[0], status: "postponed" }, schedule[1]];
    expect(scheduleFeatures(ppd, "A", "B", "2026-03-02T00:00:00Z").b2bDiff).toBe(0);
  });
});

describe("discrete margin and total distributions", () => {
  const flat: DiscreteModel = { beta: [0, 0], sigma: 13, keyWeights: {}, n: 0, meanAbsError: 0 };
  const keyed: DiscreteModel = { ...flat, keyWeights: { 3: 2, [-3]: 2, 0: 0.25 } };

  it("probabilities sum to one and pushes only happen on whole-number lines", () => {
    const d = discreteDistribution(2.5, keyed, MARGIN_RANGE);
    expect([...d.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    const half = lineProbabilities(d, -3.5, "plus");
    expect(half.push).toBe(0);
    expect(half.win + half.loss).toBeCloseTo(1, 12);
    const whole = lineProbabilities(d, -3, "plus");
    expect(whole.push).toBeGreaterThan(0.05); // a key number (about twice the flat-curve mass)
    expect(whole.win + whole.push + whole.loss).toBeCloseTo(1, 12);
    // home and away sides of the same line mirror each other
    const away = lineProbabilities(d, -3, "minus");
    expect(away.win).toBeCloseTo(whole.loss, 12);
    expect(away.push).toBeCloseTo(whole.push, 12);
  });

  it("key-number weights move push probability exactly where they should", () => {
    const pFlat = lineProbabilities(discreteDistribution(3, flat, MARGIN_RANGE), -3, "plus").push;
    const pKey = lineProbabilities(discreteDistribution(3, keyed, MARGIN_RANGE), -3, "plus").push;
    expect(pKey).toBeGreaterThan(1.7 * pFlat);
  });

  it("the market-implied mean inverts the cover probability", () => {
    for (const p of [0.3, 0.5, 0.62]) {
      const mu = impliedMean(keyed, "spread_full_game", -3.5, p);
      expect(coverProbability(mu, keyed, "spread_full_game", -3.5)).toBeCloseTo(p, 4);
      const t = impliedMean({ ...flat, sigma: 17 }, "total_full_game", 220.5, p);
      expect(coverProbability(t, { ...flat, sigma: 17 }, "total_full_game", 220.5)).toBeCloseTo(p, 4);
    }
  });

  it("weighted consensus renormalises and validates its inputs", () => {
    expect(weightedConsensus([[0.6, 0.4], [0.5, 0.5]], [3, 1])).toEqual([0.575, 0.42500000000000004]);
    expect(() => weightedConsensus([[0.5, 0.5]], [0])).toThrow();
    expect(() => weightedConsensus([[0.5, 0.5]], [1, 1])).toThrow();
  });
});

describe("multi-sport demo world", () => {
  let repo: Repo;
  let models: ModelService;
  const ctx = (asOf: string): AnalysisContext => ({ dataset: "demo", asOf, zone: "America/New_York", staleMinutes: 150, discrepancyMinPoints: 0.03, mode: "demo" });

  beforeAll(() => {
    repo = new Repo(new Db(":memory:"));
    generateDemoWorld(repo);
    models = new ModelService(repo, () => 150);
  }, 120000);

  it("fits a model per sport with sport-specific inputs, never using the forecast season", () => {
    const asOf = "2026-06-16T15:00:00Z";
    for (const sport of ["demo_basketball", "demo_football", "demo_tennis"]) {
      const fit = models.fit("demo", sport, "2026", asOf);
      if (!fit.available) throw new Error(`${sport}: ${fit.reason}`);
      expect(fit.validation.seasons).toEqual(["2025"]);
      expect(fit.trainedSeasons.every((s) => s < "2026")).toBe(true);
      if (sport === "demo_tennis") {
        expect(fit.featuresUsed).not.toContain("home_advantage");
        expect(fit.margin).toBeNull();
      } else {
        expect(fit.margin).not.toBeNull();
        expect(fit.total).not.toBeNull();
      }
    }
    // Football margins cluster on 3 and 7: the learned key weights say so.
    const fb = models.fit("demo", "demo_football", "2026", asOf);
    if (!fb.available) throw new Error("expected football fit");
    const w = fb.margin!.keyWeights;
    // (A few hundred games are noisy, so compare with the least likely small margin, 1 point.)
    expect(w[3]).toBeGreaterThan(w[1]);
    expect(w[7]).toBeGreaterThan(w[1]);
    expect(w[7]).toBeGreaterThan(1);
    expect(w[3]).toBe(w[-3]); // pooled: a 3-point win and loss are the same key number
  }, 60000);

  it("analyses spreads and totals with push probabilities and labelled estimates", () => {
    const b = buildBoard({ repo, models }, ctx("2026-06-16T15:00:00Z"), "2026-06-16");
    const fb = b.analyses.find((a) => a.event.sport_key === "demo_football" && !a.status.started)!;
    expect(fb.lines.length).toBeGreaterThan(1);
    expect(fb.lines.filter((l) => l.isMainLine)).toHaveLength(fb.lines.some((l) => l.contract === "total_full_game") && fb.lines.some((l) => l.contract === "spread_full_game") ? 2 : 1);
    for (const l of fb.lines) {
      for (const sd of Object.values(l.sides)) {
        if (!sd?.model) continue;
        expect(sd.model.win + sd.model.push + sd.model.loss).toBeCloseTo(1, 9);
        if (Number.isInteger(l.line)) expect(sd.model.push).toBeGreaterThan(0);
        else expect(sd.model.push).toBe(0);
      }
    }
    expect(fb.marketConfig.source).toBe("fitted");
    // Tennis: neutral, no lineups, no spreads.
    const tn = b.analyses.find((a) => a.event.sport_key === "demo_tennis")!;
    expect(tn.model.prediction!.features.map((f) => f.name)).not.toContain("home_advantage");
    expect(tn.completeness.items.find((i) => i.key === "lineups")!.status).toBe("not_applicable");
    expect(tn.lines).toHaveLength(0);
  }, 60000);

  it("market settings are learned on the previous season only, and not before it is complete", () => {
    const cfg = models.markets.configFor("demo", "demo_basketball", "2026", "moneyline_2way_full_game");
    expect(cfg.source).toBe("fitted");
    expect(cfg.calibration!.season).toBe("2025");
    expect(cfg.calibration!.methods).toHaveLength(4);
    // In the middle of 2025, the 2025 season cannot inform 2026 settings yet.
    expect(models.markets.configFor("demo", "demo_basketball", "2026", "moneyline_2way_full_game", "2025-07-01T00:00:00Z")).toBe(DEFAULT_MARKET_CONFIG);
    // No earlier season at all: defaults.
    expect(models.markets.configFor("demo", "demo_basketball", "2024", "moneyline_2way_full_game")).toBe(DEFAULT_MARKET_CONFIG);
  }, 60000);

  it("tennis draws reveal later rounds only after earlier rounds finish", () => {
    const qf = repo.db.get<{ id: string; known_at: string; start_time: string; home_id: string; away_id: string }>(
      "SELECT * FROM events WHERE sport_key = 'demo_tennis' AND season = '2026' AND id LIKE '%-QF-1' ORDER BY start_time LIMIT 1",
    )!;
    const week = /-w(\d+)-QF-1$/.exec(qf.id)![1];
    const r16 = repo.db.all<{ final_at: string; home_id: string; away_id: string }>(
      "SELECT * FROM events WHERE sport_key = 'demo_tennis' AND season = '2026' AND id LIKE ?",
      [`%-w${week}-R16-%`],
    );
    expect(r16).toHaveLength(8);
    // Known exactly when the later of the two players' first-round matches ended.
    const feeders = r16.filter((m) => [m.home_id, m.away_id].some((p) => p === qf.home_id || p === qf.away_id));
    expect(feeders).toHaveLength(2);
    expect(qf.known_at).toBe(feeders.map((m) => m.final_at).sort()[1]);
    const before = new Date(Date.parse(qf.known_at) - 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
    expect(analyzeEvent({ repo, models }, ctx(before), qf.id)).toBeNull(); // the match does not exist yet
    expect(analyzeEvent({ repo, models }, ctx(qf.known_at), qf.id)).not.toBeNull();
  });

  it("value finder separates likelihood from value and never fills a quota", () => {
    const b = buildBoard({ repo, models }, ctx("2026-06-16T15:00:00Z"), "2026-06-16");
    const v = valueFinder(b.analyses);
    const started = new Set(b.analyses.filter((a) => a.status.started || a.status.voided).map((a) => a.event.id));
    const all = [...v.mostLikely, ...v.discrepancies, ...v.unproven];
    expect(all.every((c) => !started.has(c.eventId))).toBe(true);
    for (let i = 1; i < v.mostLikely.length; i++) expect(v.mostLikely[i - 1].probability).toBeGreaterThanOrEqual(v.mostLikely[i].probability);
    expect(v.mostLikely.every((c) => c.mainLine)).toBe(true);
    for (const c of v.discrepancies) {
      if (c.grade === "B") {
        expect(c.consensus!.books).toBeGreaterThanOrEqual(MIN_CONSENSUS_BOOKS);
        expect(c.consensus!.edge).toBeGreaterThanOrEqual(MIN_EDGE);
        expect(c.best.decimal * c.consensus!.probability - 1).toBeCloseTo(c.consensus!.edge, 12);
      }
    }
    expect(v.unproven.every((c) => c.grade === "D" && c.estimateSource !== "market")).toBe(true);
    for (const a of v.arbitrage) {
      expect(a.impliedTotal).toBeLessThan(1);
      expect(a.legs.reduce((s, l) => s + l.stakeShare, 0)).toBeCloseTo(1, 12);
      const payouts = a.legs.map((l) => l.stakeShare * l.decimal);
      for (const p of payouts) expect(p).toBeCloseTo(1 + a.guaranteedReturn, 10);
    }
    // An empty day is an honest empty answer.
    const empty = valueFinder([]);
    expect(empty.discrepancies).toHaveLength(0);
    expect(empty.notes[0]).toMatch(/valid result/);
  }, 60000);

  it("average lines average on the probability scale", () => {
    const b = buildBoard({ repo, models }, ctx("2026-06-16T15:00:00Z"), "2026-06-16");
    const al = averageLines(b.analyses);
    let checked = 0;
    for (const g of al.games)
      for (const m of g.markets)
        for (const o of m.outcomes) {
          if (!o.average || !o.best || !o.worst) continue;
          expect(o.average.decimal).toBeLessThanOrEqual(o.best.decimal + 1e-9);
          expect(o.average.decimal).toBeGreaterThanOrEqual(o.worst.decimal - 1e-9);
          checked++;
        }
    expect(checked).toBeGreaterThan(20);
    const spread = al.games.flatMap((g) => g.markets).find((m) => m.contract === "spread_full_game" && m.averageLine != null)!;
    expect(spread.lineRange![0]).toBeLessThanOrEqual(spread.averageLine!);
    expect(spread.lineRange![1]).toBeGreaterThanOrEqual(spread.averageLine!);
  }, 60000);

  it("backtest is deterministic and reports intervals and closing line value", () => {
    const bt = new Backtester({ repo, models });
    const sports = ["demo_baseball", "demo_basketball", "demo_football", "demo_soccer", "demo_tennis"];
    const r1 = bt.run("demo", "2026-06-16T15:00:00Z", sports);
    const r2 = new Backtester({ repo, models }).run("demo", "2026-06-16T15:00:00Z", sports);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    expect(r1.gamesWithPrices).toBeGreaterThan(500);
    for (const s of r1.strategies) {
      expect(s.bets).toBeGreaterThan(20);
      expect(s.roiCI!.low).toBeLessThanOrEqual(s.roiCI!.mean);
      expect(s.roiCI!.high).toBeGreaterThanOrEqual(s.roiCI!.mean);
      expect(s.meanClv).not.toBeNull();
    }
    // Only games finished before the information time are used.
    const early = bt.run("demo", "2026-04-20T15:00:00Z", sports);
    expect(early.games).toBeLessThan(r1.games);
  }, 60000);

  it("the model report covers spreads, totals and market settings", () => {
    const ev = new Evaluator(repo, models, () => 150);
    const r = ev.report("demo", "demo_basketball", "2026-06-16T15:00:00Z") as any;
    expect(r.lines.spread_full_game.n).toBeGreaterThan(50);
    expect(r.lines.total_full_game.n).toBeGreaterThan(50);
    expect(r.marketSettings.source).toBe("fitted");
    expect(Object.keys(r.model.weights)).toEqual(["home_advantage", "elo_diff_per_100", "rest_diff_days", "back_to_back_diff", "elo_diff_best_of_5"]);
    const t = ev.report("demo", "demo_tennis", "2026-06-16T15:00:00Z") as any;
    expect(t.lines.spread_full_game).toBeNull();
    expect(t.holdout.n).toBeGreaterThan(200);
  }, 60000);
});
