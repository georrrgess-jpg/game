// Contract tests for the NFL, NBA and tennis data paths (recorded-format responses, no network).

import { describe, expect, it } from "vitest";
import { fakeTransport, fixture, makeDeps, ok } from "./helpers";
import { BalldontlieProvider, NflverseProvider, csvRecords, importResultsCsv, parseCsv, tennisShortAlias } from "../../server/providers/results";
import { OddsApiProvider } from "../../server/providers/oddsapi";
import { ProviderError } from "../../server/providers/common";

const QUOTA = { "x-requests-remaining": "480", "x-requests-used": "20", "x-requests-last": "1" };

describe("CSV parsing", () => {
  it("handles quotes, escaped quotes, CRLF and a byte-order mark", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n\r\n1,2')).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"'],
      ["1", "2"],
    ]);
    expect(csvRecords("date,home\n2024-01-01, A ")).toEqual([{ date: "2024-01-01", home: "A" }]);
  });

  it("builds the 'Last F.' alias used by tennis result files", () => {
    expect(tennisShortAlias("Novak Djokovic")).toBe("Djokovic N.");
    expect(tennisShortAlias("Felix Auger-Aliassime")).toBe("Auger-Aliassime F.");
    expect(tennisShortAlias("Madonna")).toBeNull();
    expect(tennisShortAlias("Djokovic N.")).toBeNull(); // already in that form: no "N. D." alias
  });
});

describe("nflverse adapter", () => {
  const setup = () => {
    const calls: string[] = [];
    const t = fakeTransport(
      [
        { match: /raw\.githubusercontent\.com\/nflverse\/nfldata\/master\/data\/games\.csv/, respond: () => ok(fixture("nflverse-games.csv")) },
        { match: /the-odds-api\.com\/v4\/sports\/americanfootball_nfl\/odds/, respond: () => ok(fixture("oddsapi-odds-nfl.json"), QUOTA) },
      ],
      calls,
    );
    const env = makeDeps({
      transport: t,
      now: new Date("2026-09-10T15:05:00Z"),
      settings: { providers: { nflverse: { enabled: true }, oddsapi: { enabled: true, sports: ["americanfootball_nfl"], markets: ["h2h", "spreads", "totals"] } } },
    });
    return { ...env, calls };
  };

  it("imports schedules, results and closing lines with correct orientation", async () => {
    const a = setup();
    const r = await new NflverseProvider(a.deps).importSeasons([2019, 2023, 2026]);
    expect(r.games).toBe(6);
    const kcDet = a.repo.event("nflverse:2023_01_DET_KC")!;
    expect(kcDet.sport_key).toBe("americanfootball_nfl");
    expect(kcDet.season).toBe("2023");
    expect(kcDet.start_time).toBe("2023-09-08T00:20:00Z"); // 20:20 Eastern
    expect([kcDet.home_score, kcDet.away_score]).toEqual([20, 21]);
    expect(a.repo.participant(kcDet.home_id)!.name).toBe("Kansas City Chiefs");
    // spread_line 4.5 means the home team was favoured by 4.5: stored as home line -4.5.
    const q = a.repo.latestQuotes(kcDet.id, kcDet.start_time);
    const spread = q.filter((x) => x.contract === "spread_full_game");
    expect(spread.map((x) => x.line)).toEqual([-4.5, -4.5]);
    expect(q.every((x) => x.known_at === "2023-09-07T23:20:00Z")).toBe(true); // 60 minutes before kick-off
    expect(q.find((x) => x.contract === "moneyline_2way_full_game" && x.outcome === "home")!.price_decimal).toBeCloseTo(1 + 100 / 205, 10);
    // Relocated franchise and neutral site.
    const oak = a.repo.event("nflverse:2019_01_DEN_OAK")!;
    expect(a.repo.participant(oak.home_id)!.name).toBe("Las Vegas Raiders");
    expect(a.repo.event("nflverse:2023_09_MIA_KC")!.neutral_site).toBe(1);
    // Upcoming game: scheduled, no score, no closing quotes, known from the import time.
    const next = a.repo.event("nflverse:2026_01_KC_DET")!;
    expect(next.status).toBe("scheduled");
    expect(next.home_score).toBeNull();
    expect(a.repo.latestQuotes(next.id, "2026-09-11T00:00:00Z")).toHaveLength(0);
    expect(next.known_at).toBe("2026-09-10T15:05:00Z");
  });

  it("re-importing is idempotent", async () => {
    const a = setup();
    const p = new NflverseProvider(a.deps);
    await p.importSeasons([2023]);
    const n = a.db.get<{ n: number }>("SELECT COUNT(*) n FROM events")!.n;
    const q = a.db.get<{ n: number }>("SELECT COUNT(*) n FROM quotes")!.n;
    const r = await p.importSeasons([2023]);
    expect(r.created).toBe(0);
    expect(a.db.get<{ n: number }>("SELECT COUNT(*) n FROM events")!.n).toBe(n);
    expect(a.db.get<{ n: number }>("SELECT COUNT(*) n FROM quotes")!.n).toBe(q);
  });

  it("Odds API quotes attach to the nflverse schedule event instead of creating a duplicate", async () => {
    const a = setup();
    await new NflverseProvider(a.deps).importSeasons([2026]);
    const r = await new OddsApiProvider(a.deps).refreshOdds("americanfootball_nfl");
    expect(r.events).toBe(1);
    expect(a.repo.linkedEvent("oddsapi", "nfl1")).toBe("nflverse:2026_01_KC_DET");
    expect(a.db.get<{ n: number }>("SELECT COUNT(*) n FROM events WHERE id LIKE 'oddsapi:%'")!.n).toBe(0);
    const q = a.repo.latestQuotes("nflverse:2026_01_KC_DET", "2026-09-10T16:00:00Z");
    // Two different spread lines are two different contracts.
    expect([...new Set(q.filter((x) => x.contract === "spread_full_game").map((x) => x.contract_id))].sort()).toEqual(["spread_full_game@1.0", "spread_full_game@1.5"]);
    expect(q.filter((x) => x.contract === "total_full_game").map((x) => x.line)).toEqual([51.5, 51.5]);
  });

  it("is off until enabled and reports bad files clearly", async () => {
    const a = makeDeps({ transport: fakeTransport([{ match: /games\.csv/, respond: () => ok("x,y\n1,2") }]), settings: { providers: { nflverse: { enabled: false } } } });
    await expect(new NflverseProvider(a.deps).importSeasons([2023])).rejects.toMatchObject({ code: "disabled" });
    a.settings.update({ providers: { nflverse: { enabled: true } } });
    await expect(new NflverseProvider(a.deps).importSeasons([2023])).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("balldontlie adapter", () => {
  it("pages with the cursor, sends the key as a header, and stores finals and the schedule", async () => {
    const seen: { url: string; auth?: string }[] = [];
    const t = async (req: { url: string; headers?: Record<string, string> }) => {
      seen.push({ url: req.url, auth: req.headers?.Authorization });
      return ok(fixture(req.url.includes("cursor=1002") ? "balldontlie-games-p2.json" : "balldontlie-games-p1.json"));
    };
    const a = makeDeps({ transport: t as never, settings: { providers: { balldontlie: { enabled: true, requestsPerMinute: 600 } } } });
    (a.config as { balldontlieApiKey: string | null }).balldontlieApiKey = "bdl-secret-key";
    const sleeps: number[] = [];
    const p = new BalldontlieProvider(a.deps, async (ms) => void sleeps.push(ms));
    const r = await p.importSeasons([2024], 2025);
    expect(r.games).toBe(4); // the malformed row is skipped
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.auth === "bdl-secret-key" && !s.url.includes("bdl-secret-key"))).toBe(true);
    expect(seen[0].url).toContain("seasons%5B%5D=2024");
    expect(sleeps).toEqual([100]); // spaced by the configured rate limit
    const bos = a.repo.db.get<{ id: string; status: string; home_score: number; season: string }>("SELECT * FROM events WHERE id = 'balldontlie:1001'")!;
    expect(bos).toMatchObject({ status: "final", home_score: 132, season: "2024" });
    expect(a.repo.event("balldontlie:1004")!.status).toBe("scheduled"); // 0-0 before tip-off is not a result
    // "LA Clippers" and "Los Angeles Clippers" resolve to the same team.
    expect(a.repo.resolveParticipant("live", "basketball_nba", "Los Angeles Clippers")).toBe(a.repo.event("balldontlie:1003")!.home_id);
    expect(a.repo.resolveParticipant("live", "basketball_nba", "LA Clippers")).toBe(a.repo.event("balldontlie:1003")!.home_id);
    expect(a.repo.resolveParticipant("live", "basketball_nba", "LAC")).toBe(a.repo.event("balldontlie:1003")!.home_id);
  });

  it("needs a key and reports rejected keys", async () => {
    const a = makeDeps({ transport: fakeTransport([{ match: /balldontlie/, respond: () => ({ status: 401, headers: {}, body: "{}" }) }]), settings: { providers: { balldontlie: { enabled: true } } } });
    await expect(new BalldontlieProvider(a.deps).refreshRange("2024-10-22", "2024-10-23")).rejects.toMatchObject({ code: "not_configured" });
    (a.config as { balldontlieApiKey: string | null }).balldontlieApiKey = "k-123456";
    await expect(new BalldontlieProvider(a.deps).refreshRange("2024-10-22", "2024-10-23")).rejects.toMatchObject({ code: "auth" });
  });
});

describe("tennis results import and odds matching", () => {
  it("imports tennis-data.co.uk rows: alphabetical orientation, sets, surfaces, closing odds; skips retirements", () => {
    const a = makeDeps();
    const r = importResultsCsv(a.repo, "tennis_atp", fixture("tennis-data.csv"), "tennis-data", "2026-01-01T00:00:00Z");
    expect(r).toMatchObject({ rows: 5, imported: 3, created: 3 });
    expect(r.skipped.map((s) => s.reason)).toEqual(["not completed (Retired)", 'unreadable date "bad-date"']);
    const evs = a.repo.db.all<{ id: string; home_id: string; away_id: string; home_score: number; away_score: number; extra: string; neutral_site: number; season: string }>("SELECT * FROM events ORDER BY start_time");
    // De Minaur beat Bergs; Bergs sorts first alphabetically, so Bergs is listed first ("home") with 0 sets.
    const madrid = evs.find((e) => e.id.includes("2024-04-25"))!;
    expect(a.repo.participant(madrid.home_id)!.name).toBe("Bergs Z.");
    expect([madrid.home_score, madrid.away_score]).toEqual([0, 2]);
    expect(JSON.parse(madrid.extra)).toMatchObject({ surface: "clay", bestOf: 3 });
    expect(madrid.neutral_site).toBe(1);
    const wimby = evs.find((e) => e.id.includes("djokovic"))!;
    expect(JSON.parse(wimby.extra)).toMatchObject({ surface: "grass", bestOf: 5 });
    expect(wimby.season).toBe("2024");
    // Closing odds follow the orientation: Bergs (home) was the 4.9 underdog at Pinnacle.
    const q = a.repo.latestQuotes(madrid.id, "2024-04-25T12:00:00Z").filter((x) => x.book_key === "td_pinnacle_close");
    expect(Object.fromEntries(q.map((x) => [x.outcome, x.price_decimal]))).toEqual({ home: 4.9, away: 1.21 });
  });

  it("rejects files without the expected columns", () => {
    const a = makeDeps();
    expect(() => importResultsCsv(a.repo, "tennis_atp", "a,b\n1,2", "tennis-data", "2026-01-01T00:00:00Z")).toThrow(/missing column/);
    expect(() => importResultsCsv(a.repo, "basketball_nba", "date,home\n1,2", "generic", "2026-01-01T00:00:00Z")).toThrow(/away/);
  });

  it("generic CSV: times, scheduled rows and bad numbers", () => {
    const a = makeDeps();
    const csv = "date,time,home,away,home_score,away_score\n2025-01-05,19:30,Alpha,Beta,101,99\n2025-01-06,,Gamma,Delta,,\n2025-01-07,20:00,Alpha,Gamma,ten,90\n";
    const r = importResultsCsv(a.repo, "basketball_nba", csv, "generic", "2025-01-06T00:00:00Z");
    expect(r.imported).toBe(2);
    expect(r.skipped).toEqual([{ row: 4, reason: "home_score is not a number" }]);
    const ev = a.repo.db.get<{ start_time: string; status: string; season: string }>("SELECT * FROM events WHERE home_score = 101")!;
    expect(ev).toMatchObject({ start_time: "2025-01-05T19:30:00Z", status: "final", season: "2024" }); // NBA seasons span New Year
  });

  it("Odds API tennis: tournament keys share one ATP player list and match imported players", async () => {
    const t = fakeTransport([{ match: /the-odds-api\.com\/v4\/sports\/tennis_atp_wimbledon\/odds/, respond: () => ok(fixture("oddsapi-odds-tennis.json"), QUOTA) }]);
    const a = makeDeps({ transport: t, now: new Date("2024-07-01T10:05:00Z"), settings: { providers: { oddsapi: { enabled: true, sports: ["tennis_atp_wimbledon"] } } } });
    importResultsCsv(a.repo, "tennis_atp", fixture("tennis-data.csv"), "tennis-data", "2024-07-03T00:00:00Z");
    const before = a.db.get<{ n: number }>("SELECT COUNT(*) n FROM participants")!.n;
    await new OddsApiProvider(a.deps).refreshOdds("tennis_atp_wimbledon");
    const ev = a.repo.event(a.repo.linkedEvent("oddsapi", "ten1")!)!;
    expect(ev.sport_key).toBe("tennis_atp");
    // "Novak Djokovic" resolves to the imported "Djokovic N." through the short alias: no new players.
    expect(a.db.get<{ n: number }>("SELECT COUNT(*) n FROM participants")!.n).toBe(before);
    expect(ev.id.startsWith("import:")).toBe(true);
    expect(a.repo.latestQuotes(ev.id, "2024-07-01T11:00:00Z").filter((q) => q.book_key === "pinnacle")).toHaveLength(2);
  });

  it("Odds API tennis events without a schedule get surface, best-of and neutral site from the tournament", async () => {
    const t = fakeTransport([{ match: /tennis_atp_wimbledon\/odds/, respond: () => ok(fixture("oddsapi-odds-tennis.json"), QUOTA) }]);
    const a = makeDeps({ transport: t, now: new Date("2024-07-01T10:05:00Z"), settings: { providers: { oddsapi: { enabled: true, sports: ["tennis_atp_wimbledon"] } } } });
    await new OddsApiProvider(a.deps).refreshOdds("tennis_atp_wimbledon");
    const ev = a.repo.event("oddsapi:ten1")!;
    expect(ev).toMatchObject({ sport_key: "tennis_atp", neutral_site: 1, season: "2024", league: "ATP Wimbledon" });
    expect(JSON.parse(ev.extra)).toMatchObject({ surface: "grass", bestOf: 5 });
    expect(a.repo.resolveParticipant("live", "tennis_atp", "Djokovic N.")).toBe(ev.home_id);
  });
});

describe("review regressions", () => {
  const TD_HEADER = "ATP,Location,Tournament,Date,Series,Court,Surface,Round,Best of,Winner,Loser,WRank,LRank,Wsets,Lsets,Comment,PSW,PSL\n";

  it("a later knockout round is unknown until the earlier rounds have finished (no early reveal of winners)", async () => {
    const { analyzeEvent, ModelService } = await import("../../server/analysis");
    const a = makeDeps();
    // Rows deliberately out of date order: the importer sorts them.
    const csv = TD_HEADER + "2,London,Wimbledon,03/07/2024,Grand Slam,Outdoor,Grass,2nd Round,5,Djokovic N.,Fearnley J.,2,277,3,0,Completed,1.01,20\n1,London,Wimbledon,01/07/2024,Grand Slam,Outdoor,Grass,1st Round,5,Djokovic N.,Kopriva V.,2,123,3,0,Completed,1.02,22.5\n";
    importResultsCsv(a.repo, "tennis_atp", csv, "tennis-data", "2026-01-01T00:00:00Z");
    const r1 = a.repo.db.get<{ final_at: string }>("SELECT final_at FROM events WHERE id LIKE '%2024-07-01%'")!;
    const r2 = a.repo.db.get<{ id: string; known_at: string }>("SELECT id, known_at FROM events WHERE id LIKE '%2024-07-03%'")!;
    expect(r2.known_at).toBe(r1.final_at);
    const ctx = (asOf: string) => ({ dataset: "live" as const, asOf, zone: "UTC", staleMinutes: 150, discrepancyMinPoints: 0.03, mode: "replay" as const });
    const models = new ModelService(a.repo, () => 150);
    expect(analyzeEvent({ repo: a.repo, models }, ctx("2024-06-30T12:00:00Z"), r2.id)).toBeNull();
    expect(analyzeEvent({ repo: a.repo, models }, ctx(r1.final_at), r2.id)).not.toBeNull();
    // Regular-season team games keep the "schedule public a week ahead" rule.
    const g = importResultsCsv(a.repo, "basketball_nba", "date,time,home,away,home_score,away_score\n2025-01-05,19:30,Alpha,Beta,101,99\n", "generic", "2026-01-01T00:00:00Z");
    expect(g.imported).toBe(1);
    expect(a.repo.db.get<{ known_at: string }>("SELECT known_at FROM events WHERE home_score = 101")!.known_at).toBe("2024-12-29T19:30:00Z");
  });

  it("nflverse playoff games are unknown until both teams' previous games are final", async () => {
    const csv = fixture("nflverse-games.csv").trim() + "\n2023_19_MIA_KC,2023,WC,19,2024-01-13,Saturday,20:00,MIA,7,KC,26,Home,19,33,0,,,,,,,,7,7,,,,,,,,,0,outdoors,grass,,,,,,,,,,,\n";
    const a = makeDeps({ transport: fakeTransport([{ match: /games\.csv/, respond: () => ok(csv) }]), settings: { providers: { nflverse: { enabled: true } } } });
    await new NflverseProvider(a.deps).importSeasons([2023]);
    const wc = a.repo.event("nflverse:2023_19_MIA_KC")!;
    const lastKc = a.repo.event("nflverse:2023_09_MIA_KC")!; // both teams' latest earlier game in the fixture, but more than a week before
    expect(Date.parse(wc.known_at)).toBe(Date.parse(wc.start_time) - 7 * 86400000);
    expect(lastKc.final_at! < wc.known_at).toBe(true);
  });

  it("tennis odds listed in the other order attach to the imported match with outcomes re-oriented", async () => {
    const swapped = JSON.stringify([{ id: "ten2", sport_key: "tennis_atp_wimbledon", sport_title: "ATP Wimbledon", commence_time: "2024-07-01T12:30:00Z", home_team: "Vit Kopriva", away_team: "Novak Djokovic", bookmakers: [{ key: "pinnacle", title: "Pinnacle", last_update: "2024-07-01T10:00:00Z", markets: [{ key: "h2h", last_update: "2024-07-01T10:00:00Z", outcomes: [{ name: "Vit Kopriva", price: 21.0 }, { name: "Novak Djokovic", price: 1.02 }] }, { key: "totals", outcomes: [{ name: "Over", price: 1.9, point: 30.5 }, { name: "Under", price: 1.9, point: 30.5 }] }] }] }]);
    const t = fakeTransport([{ match: /tennis_atp_wimbledon\/odds/, respond: () => ok(swapped, QUOTA) }]);
    const a = makeDeps({ transport: t, now: new Date("2024-07-01T10:05:00Z"), settings: { providers: { oddsapi: { enabled: true, sports: ["tennis_atp_wimbledon"], markets: ["h2h", "totals"] } } } });
    importResultsCsv(a.repo, "tennis_atp", fixture("tennis-data.csv"), "tennis-data", "2024-07-03T00:00:00Z");
    await new OddsApiProvider(a.deps).refreshOdds("tennis_atp_wimbledon");
    const id = a.repo.linkedEvent("oddsapi", "ten2")!;
    expect(id.startsWith("import:")).toBe(true);
    expect(a.db.get<{ n: number }>("SELECT COUNT(*) n FROM events WHERE id LIKE 'oddsapi:%'")!.n).toBe(0);
    const ev = a.repo.event(id)!;
    expect(a.repo.participant(ev.home_id)!.name).toBe("Djokovic N.");
    const q = a.repo.latestQuotes(id, "2024-07-01T11:00:00Z").filter((x) => x.book_key === "pinnacle");
    // Djokovic is "home" in the stored event, so his 1.02 is stored on the home outcome; game totals are not stored.
    expect(Object.fromEntries(q.map((x) => [x.outcome, x.price_decimal]))).toEqual({ home: 1.02, away: 21 });
  });

  it("generic CSV rejects ambiguous day/month dates", () => {
    const a = makeDeps();
    const r = importResultsCsv(a.repo, "basketball_nba", "date,home,away,home_score,away_score\n01/07/2024,A,B,1,2\n2024-07-01T19:00:00-04:00,A,B,3,4\n", "generic", "2026-01-01T00:00:00Z");
    expect(r.imported).toBe(1);
    expect(r.skipped[0].reason).toMatch(/YYYY-MM-DD/);
    expect(a.repo.db.get<{ start_time: string }>("SELECT start_time FROM events")!.start_time).toBe("2024-07-01T23:00:00Z");
  });

  it("market caches pick up imported quotes without a restart", async () => {
    const { MarketService } = await import("../../server/market");
    const a = makeDeps();
    const csv = TD_HEADER + "1,London,Wimbledon,01/07/2024,Grand Slam,Outdoor,Grass,1st Round,5,Djokovic N.,Kopriva V.,2,123,3,0,Completed,,\n";
    importResultsCsv(a.repo, "tennis_atp", csv, "tennis-data", "2026-01-01T00:00:00Z");
    const id = a.repo.db.get<{ id: string }>("SELECT id FROM events")!.id;
    const m = new MarketService(a.repo, () => 150);
    expect(m.homeProbAt(id)).toBeNull();
    importResultsCsv(a.repo, "tennis_atp", csv.replace(",Completed,,", ",Completed,1.02,22.5"), "tennis-data", "2026-01-02T00:00:00Z");
    expect(m.homeProbAt(id)).toBeGreaterThan(0.9);
  });
});

describe("cache invalidation is targeted", () => {
  it("live prices for upcoming games keep fitted models; quotes for finished games refresh them", async () => {
    const { MarketService } = await import("../../server/market");
    const a = makeDeps();
    const m = new MarketService(a.repo, () => 150);
    importResultsCsv(a.repo, "basketball_nba", "date,time,home,away,home_score,away_score\n2025-01-05,19:30,Alpha,Beta,101,99\n2025-01-09,19:30,Alpha,Beta,,\n", "generic", "2025-01-06T00:00:00Z");
    const v0 = m.pastVersion();
    const quote = (eventId: string, outcome: "home" | "away", price: number, t: string) => ({
      dataset: "live" as const, event_id: eventId, provider: "t", book_key: "b", book_title: "B", contract: "moneyline_2way_full_game" as const,
      contract_id: "moneyline_2way_full_game", provider_market: "h2h", line: null, outcome, price_decimal: price, source_time: t, retrieved_at: t, known_at: t,
    });
    const upcoming = a.repo.db.get<{ id: string }>("SELECT id FROM events WHERE status = 'scheduled'")!.id;
    const final = a.repo.db.get<{ id: string }>("SELECT id FROM events WHERE status = 'final'")!.id;
    a.repo.insertQuotes([quote(upcoming, "home", 1.9, "2025-01-08T12:00:00Z"), quote(upcoming, "away", 1.9, "2025-01-08T12:00:00Z")]);
    expect(m.pastVersion()).toBe(v0);
    a.repo.insertQuotes([quote(final, "home", 1.5, "2025-01-05T18:30:00Z"), quote(final, "away", 2.6, "2025-01-05T18:30:00Z")]);
    expect(m.pastVersion()).toBe(v0 + 1);
  });
});
