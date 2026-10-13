import { beforeAll, describe, expect, it } from "vitest";
import { Db } from "../../server/db";
import { Repo, type EventRecord, type QuoteRecord } from "../../server/repo";
import { fitLogistic, fitModel, predictWithInterval, runElo, ratingsAt, type GameRow } from "../../server/model";
import { analyzeEvent, buildMarket, ModelService, type AnalysisContext } from "../../server/analysis";
import { buildBoard } from "../../server/board";
import { generateDemoWorld, demoSnapshotTimes } from "../../server/demo";
import { mulberry32 } from "../../shared/rng";
import { sigmoid } from "../../shared/odds";

describe("logistic regression and Elo", () => {
  it("recovers known coefficients from simulated data", () => {
    const rand = mulberry32(7);
    const X: number[][] = [];
    const y: (0 | 1)[] = [];
    for (let i = 0; i < 6000; i++) {
      const x = [1, (rand() - 0.5) * 4];
      X.push(x);
      y.push(rand() < sigmoid(0.3 + 0.8 * x[1]) ? 1 : 0);
    }
    const { beta, cov } = fitLogistic(X, y);
    expect(beta[0]).toBeCloseTo(0.3, 1);
    expect(beta[1]).toBeCloseTo(0.8, 1);
    expect(cov[1][1]).toBeGreaterThan(0);
    const r = predictWithInterval(beta, cov, [1, 0]);
    expect(r.low).toBeLessThan(r.p);
    expect(r.high).toBeGreaterThan(r.p);
  });

  it("Elo is deterministic and order-dependent only through time", () => {
    const games: GameRow[] = Array.from({ length: 40 }, (_, i) => ({
      id: `g${i}`,
      start_time: new Date(Date.UTC(2025, 3, 1 + i)).toISOString(),
      home_id: i % 2 ? "A" : "B",
      away_id: i % 2 ? "B" : "A",
      home_score: i % 3 ? 3 : 1,
      away_score: 2,
      neutral_site: 0,
      season: "2025",
    }));
    const a = runElo(games, { k: 10, homeElo: 20, carry: 0.7 });
    const b = runElo(games, { k: 10, homeElo: 20, carry: 0.7 });
    expect(a.rows).toEqual(b.rows);
    // Each game's features use only earlier games: the first game starts level.
    expect(a.rows[0].x[1]).toBe(0);
  });

  it("refuses to fit without two completed seasons", () => {
    const games: GameRow[] = Array.from({ length: 500 }, (_, i) => ({
      id: `g${i}`,
      start_time: new Date(Date.UTC(2025, 3, 1) + i * 3600000 * 8).toISOString(),
      home_id: `T${i % 6}`,
      away_id: `T${(i + 1) % 6}`,
      home_score: i % 2,
      away_score: (i + 1) % 2,
      neutral_site: 0,
      season: "2025",
    }));
    const r = fitModel({ sportKey: "demo_baseball", games, forecastSeason: "2026" });
    expect(r.available).toBe(false);
  });
});

describe("market construction", () => {
  const base: Omit<QuoteRecord, "book_key" | "book_title" | "outcome" | "price_decimal" | "source_time" | "retrieved_at" | "known_at"> = {
    dataset: "demo",
    event_id: "e1",
    provider: "test",
    contract: "moneyline_2way_full_game",
    contract_id: "moneyline_2way_full_game",
    provider_market: "h2h",
    line: null,
  };
  const q = (book: string, outcome: "home" | "away", d: number, source: string, retrieved: string): QuoteRecord => ({
    ...base,
    book_key: book,
    book_title: book.toUpperCase(),
    outcome,
    price_decimal: d,
    source_time: source,
    retrieved_at: retrieved,
    known_at: retrieved,
  });
  const ev = { start_time: "2026-06-16T23:00:00Z" };
  const asOf = "2026-06-16T15:00:00Z";

  it("uses only fresh, complete, same-time sets and never mixes books", () => {
    const quotes = [
      q("a", "home", 1.8, "2026-06-16T14:50:00Z", "2026-06-16T14:55:00Z"),
      q("a", "away", 2.1, "2026-06-16T14:50:00Z", "2026-06-16T14:55:00Z"),
      q("b", "home", 1.9, "2026-06-16T08:00:00Z", "2026-06-16T14:55:00Z"), // unchanged since morning but re-confirmed: current
      q("b", "away", 2.0, "2026-06-16T08:00:00Z", "2026-06-16T14:55:00Z"),
      q("stale", "home", 2.5, "2026-06-16T09:00:00Z", "2026-06-16T09:00:00Z"), // not re-confirmed: stale
      q("stale", "away", 1.6, "2026-06-16T09:00:00Z", "2026-06-16T09:00:00Z"),
      q("half", "home", 3.0, "2026-06-16T14:50:00Z", "2026-06-16T14:55:00Z"), // incomplete set
      q("skew", "home", 1.85, "2026-06-16T14:00:00Z", "2026-06-16T14:55:00Z"), // outcomes changed at different times
      q("skew", "away", 2.05, "2026-06-16T14:40:00Z", "2026-06-16T14:55:00Z"),
    ];
    const m = buildMarket(quotes, "moneyline_2way_full_game", null, ev, asOf, 60);
    const status = Object.fromEntries(m.books.map((b) => [b.book_key, b.status]));
    expect(status).toEqual({ a: "current", b: "current", stale: "stale", half: "incomplete", skew: "mismatched_times" });
    expect(m.reference!.nBooks).toBe(2);
    const pa = (1 / 1.8) / (1 / 1.8 + 1 / 2.1);
    const pb = (1 / 1.9) / (1 / 1.9 + 1 / 2.0);
    expect(m.reference!.probs.home).toBeCloseTo((pa + pb) / 2, 10);
    expect(m.reference!.probs.home! + m.reference!.probs.away!).toBeCloseTo(1, 12);
    // Highest price: incomplete book's quote is still a real quote; stale one is excluded.
    expect(m.bestPrice.home!.book_key).toBe("half");
    expect(m.bestPrice.away!.book_key).toBe("a");
    expect(m.bestPrice.home!.label).toMatch(/^Highest quoted price among connected sources as of/);
  });

  it("explains why there is no reference when only stale or post-start quotes exist", () => {
    const stale = [q("s", "home", 1.9, "2026-06-16T09:00:00Z", "2026-06-16T09:00:00Z"), q("s", "away", 1.9, "2026-06-16T09:00:00Z", "2026-06-16T09:00:00Z")];
    const m1 = buildMarket(stale, "moneyline_2way_full_game", null, ev, asOf, 60);
    expect(m1.reference).toBeNull();
    expect(m1.referenceUnavailableReason).toMatch(/stale/);
    expect(m1.bestPrice.home).toBeUndefined();
    const late = [q("l", "home", 1.9, "2026-06-16T23:10:00Z", "2026-06-16T23:10:00Z"), q("l", "away", 1.9, "2026-06-16T23:10:00Z", "2026-06-16T23:10:00Z")];
    const m2 = buildMarket(late, "moneyline_2way_full_game", null, ev, "2026-06-16T23:20:00Z", 60);
    expect(m2.reference).toBeNull();
    expect(m2.books[0].status).toBe("after_start");
    expect(buildMarket([], "moneyline_2way_full_game", null, ev, asOf, 60).referenceUnavailableReason).toMatch(/No quotes/);
  });

  it("requires all three outcomes for a 3-way market", () => {
    const three = (o: "home" | "away" | "draw", d: number): QuoteRecord => ({
      ...q("x", "home", d, "2026-06-16T14:50:00Z", "2026-06-16T14:55:00Z"),
      outcome: o,
      contract: "moneyline_3way_regulation",
      contract_id: "moneyline_3way_regulation",
    });
    const m = buildMarket([three("home", 2.1), three("away", 3.6)], "moneyline_3way_regulation", null, ev, asOf, 60);
    expect(m.reference).toBeNull();
    const m2 = buildMarket([three("home", 2.1), three("away", 3.6), three("draw", 3.4)], "moneyline_3way_regulation", null, ev, asOf, 60);
    expect(Object.keys(m2.reference!.probs).sort()).toEqual(["away", "draw", "home"]);
  });
});

describe("demo world analysis (leakage, replay, determinism)", () => {
  let repo: Repo;
  let models: ModelService;
  const ctx = (asOf: string, extra: Partial<AnalysisContext> = {}): AnalysisContext => ({
    dataset: "demo",
    asOf,
    zone: "America/New_York",
    staleMinutes: 150,
    discrepancyMinPoints: 0.03,
    mode: "replay",
    ...extra,
  });

  beforeAll(() => {
    repo = new Repo(new Db(":memory:"));
    generateDemoWorld(repo);
    models = new ModelService(repo, () => 150);
  }, 60000);

  it("generates the same world every time (deterministic seed)", () => {
    const other = new Repo(new Db(":memory:"));
    generateDemoWorld(other);
    const sig = (r: Repo) => r.db.get<{ c: number; s: number }>("SELECT COUNT(*) c, SUM(price_decimal) s FROM quotes")!;
    expect(sig(other)).toEqual(sig(repo));
  }, 60000);

  it("snapshot schedule never includes polls at or after the start", () => {
    const t = demoSnapshotTimes("2026-06-16T23:05:00Z", 26 * 60, null);
    expect(t.every((x) => x < "2026-06-16T23:05:00Z")).toBe(true);
    expect(t.length).toBeGreaterThan(5);
    expect(demoSnapshotTimes("2026-06-16T23:05:00Z", 26 * 60, null, false)).toHaveLength(3);
  });

  it("produces a board with model and market for the demo day", () => {
    const b = buildBoard({ repo, models }, ctx("2026-06-16T15:00:00Z", { mode: "demo" }), "2026-06-16");
    expect(b.items.length).toBeGreaterThan(4);
    expect(b.items.every((i) => i.fictional)).toBe(true);
    expect(b.items.some((i) => i.voided)).toBe(true);
    expect(b.coverage.withModel).toBe(b.items.length);
    for (const i of b.items) {
      expect(i.asOf).toBe("2026-06-16T15:00:00Z");
      expect(i.uncertainty.length).toBeGreaterThan(20);
      expect(i.completeness.applicable).toBeGreaterThan(0);
    }
  });

  it("information after the as-of time cannot change an analysis (no leakage)", () => {
    const asOf = "2026-06-16T15:00:00Z";
    const b = buildBoard({ repo, models }, ctx(asOf), "2026-06-16");
    const target = b.items.find((i) => !i.voided)!;
    const before = JSON.stringify(analyzeEvent({ repo, models }, ctx(asOf), target.eventId));
    // Inject future information: a later quote, injury, news item and a result for another game.
    repo.insertQuotes([
      { dataset: "demo", event_id: target.eventId, provider: "demo", book_key: "demo_northgate", book_title: "Northgate (demo book)", contract: "moneyline_2way_full_game", contract_id: "moneyline_2way_full_game", provider_market: "h2h", line: null, outcome: "home", price_decimal: 9.99, source_time: "2026-06-16T16:00:00Z", retrieved_at: "2026-06-16T16:00:00Z", known_at: "2026-06-16T16:00:00Z" },
    ]);
    const ev = repo.event(target.eventId)!;
    repo.insertInjuries([{ dataset: "demo", sport_key: ev.sport_key, participant_id: ev.home_id, player_id: null, player_name: "Future Injury", status: "out", detail: null, source: "test", source_url: null, confirmation: "official", source_time: "2026-06-16T17:00:00Z", retrieved_at: "2026-06-16T17:00:00Z" }]);
    repo.insertNews([{ dataset: "demo", sport_key: ev.sport_key, participant_ids: JSON.stringify([ev.home_id]), title: "Future news", summary: null, url: "https://demo.overround.invalid/future", source_name: "t", source_tier: "official", claim_type: "official", published_at: "2026-06-16T18:00:00Z", retrieved_at: "2026-06-16T18:00:00Z", dedupe_key: "future news", duplicate_of: null }]);
    const after = JSON.stringify(analyzeEvent({ repo, models }, ctx(asOf), target.eventId));
    expect(after).toEqual(before);
    // ...but a later information time does see them.
    const later = analyzeEvent({ repo, models }, ctx("2026-06-16T18:30:00Z"), target.eventId)!;
    expect(later.evidence.injuries.some((i) => i.player_name === "Future Injury")).toBe(true);
  });

  it("replays are deterministic and masks results that were not yet known", () => {
    const asOf = "2026-05-12T15:00:00Z";
    const a1 = buildBoard({ repo, models }, ctx(asOf), "2026-05-12");
    const a2 = buildBoard({ repo, models }, ctx(asOf), "2026-05-12");
    expect(JSON.stringify(a1.items)).toEqual(JSON.stringify(a2.items));
    expect(a1.items.every((i) => !i.resultKnown && i.score === null)).toBe(true);
    const next = buildBoard({ repo, models }, ctx("2026-05-13T15:00:00Z"), "2026-05-12");
    expect(next.items.filter((i) => !i.voided).every((i) => i.resultKnown)).toBe(true);
  });

  it("a started or finished game is analysed with information frozen at its scheduled start", () => {
    const b = buildBoard({ repo, models }, ctx("2026-06-16T15:00:00Z"), "2026-06-16");
    const id = b.items.find((i) => !i.voided)!.eventId;
    const start = repo.event(id)!.start_time;
    const atStart = analyzeEvent({ repo, models }, ctx(start), id)!;
    const muchLater = analyzeEvent({ repo, models }, ctx("2026-06-20T15:00:00Z"), id)!;
    expect(muchLater.infoAsOf).toBe(start);
    expect(muchLater.status.resultKnown).toBe(true);
    expect(muchLater.model.probs).toEqual(atStart.model.probs); // its own result never feeds back into the forecast
    expect(muchLater.market.reference).toEqual(atStart.market.reference);
    expect(muchLater.evidence.news.map((n) => n.id)).toEqual(atStart.evidence.news.map((n) => n.id));
  });

  it("model parameters never use games from the forecast season or later", () => {
    const fitA = models.fit("demo", "demo_baseball", "2026", "2026-05-01T00:00:00Z");
    const fitB = models.fit("demo", "demo_baseball", "2026", "2026-09-30T00:00:00Z");
    expect(fitA.available && fitB.available).toBe(true);
    if (fitA.available && fitB.available) {
      expect(fitB.beta).toEqual(fitA.beta);
      expect(fitB.version).toBe(fitA.version);
      expect(fitA.validation.seasons).toEqual(["2025"]);
    }
    // In the first demo season there is no prior history: no forecast is shown.
    const early = models.fit("demo", "demo_baseball", "2024", "2024-06-01T00:00:00Z");
    expect(early.available).toBe(false);
  });

  it("ratings at a moment only use games completed before it", () => {
    const fit = models.fit("demo", "demo_baseball", "2026", "2026-06-16T15:00:00Z");
    if (!fit.available) throw new Error("expected a fit");
    const finals = repo.finalsBefore("demo", "demo_baseball", "2026-06-16T15:00:00Z");
    expect(finals.every((g) => g.final_at! <= "2026-06-16T15:00:00Z")).toBe(true);
    const s1 = ratingsAt(finals, fit.params, "2026");
    const s2 = models.state("demo", "demo_baseball", fit, "2026-06-16T15:00:00Z");
    expect([...s1.ratings.entries()].sort()).toEqual([...s2.ratings.entries()].sort());
  });

  it("soccer is market-only with the draw included", () => {
    const day = repo.db.get<{ start_time: string }>("SELECT start_time FROM events WHERE sport_key = 'demo_soccer' AND start_time > '2026-06-01' ORDER BY start_time LIMIT 1")!.start_time;
    const asOf = new Date(Date.parse(day) - 3 * 3600000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const ev = repo.db.get<EventRecord>("SELECT * FROM events WHERE sport_key = 'demo_soccer' AND start_time = ? LIMIT 1", [day])!;
    const a = analyzeEvent({ repo, models }, ctx(asOf), ev.id)!;
    expect(a.contract).toBe("moneyline_3way_regulation");
    expect(a.model.available).toBe(false);
    expect(a.model.reason).toMatch(/No independent 3-way/);
    expect(a.primary.source).toBe("market");
    expect(Object.keys(a.market.reference!.probs).sort()).toEqual(["away", "draw", "home"]);
    expect(a.overallVerdict.verdict).toBe("insufficient_evidence");
  });

  it("an empty day is a valid result and DST days are reported", () => {
    const b = buildBoard({ repo, models }, ctx("2026-01-10T15:00:00Z"), "2026-01-10");
    expect(b.items).toHaveLength(0);
    expect(b.notes[0]).toMatch(/valid result/);
    const dst = buildBoard({ repo, models }, ctx("2026-11-05T15:00:00Z"), "2026-11-01");
    expect(dst.window.hours).toBe(25);
  });

  it("what-if: neutral site changes only the home-advantage input", () => {
    const b = buildBoard({ repo, models }, ctx("2026-06-16T15:00:00Z"), "2026-06-16");
    const id = b.items.find((i) => !i.voided)!.eventId;
    const base = analyzeEvent({ repo, models }, ctx("2026-06-16T15:00:00Z"), id)!;
    const neutral = analyzeEvent({ repo, models }, ctx("2026-06-16T15:00:00Z"), id, { neutral: true })!;
    const hb = base.model.prediction!.features.find((f) => f.name === "home_advantage")!;
    expect(hb.value).toBe(1);
    expect(neutral.model.prediction!.features.find((f) => f.name === "home_advantage")!.value).toBe(0);
    expect(neutral.model.probs!.home!).toBeLessThan(base.model.probs!.home!);
    // The market reference is unaffected by a model what-if.
    expect(neutral.market.reference).toEqual(base.market.reference);
  });
});
