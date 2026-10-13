// Contract tests: adapters are exercised against recorded-format responses through a fake
// transport, so these run without network access or credentials.

import { describe, expect, it } from "vitest";
import { fakeTransport, fixture, makeDeps, ok } from "./helpers";
import { OddsApiProvider, oddsApiCost, soccerLeagueFinalIsRegulation } from "../../server/providers/oddsapi";
import { MlbProvider, mapMlbStatus } from "../../server/providers/mlb";
import { OpenMeteoProvider } from "../../server/providers/openmeteo";
import { RssProvider } from "../../server/providers/rss";
import { ProviderError, providerStatus } from "../../server/providers/common";
import { hostAllowed, HttpClient, isPublicAddress } from "../../server/http";
import { classifyClaim, dedupeKey, detectConflicts, jaccard, markDuplicates, parseFeed, tagTeams } from "../../server/news";
import { LiveIngest } from "../../server/ingest";
import { redact } from "../../server/config";

const QUOTA = { "x-requests-remaining": "480", "x-requests-used": "20", "x-requests-last": "1" };

function setupMlbAndOdds(extra: Parameters<typeof makeDeps>[0] = {}) {
  const calls: string[] = [];
  const t = fakeTransport(
    [
      { match: /statsapi\.mlb\.com\/api\/v1\/teams\?/, respond: () => ok(fixture("mlb-teams.json")) },
      { match: /statsapi\.mlb\.com\/api\/v1\/schedule/, respond: () => ok(fixture("mlb-schedule.json")) },
      { match: /statsapi\.mlb\.com\/api\/v1\/teams\/\d+\/roster/, respond: () => ok(fixture("mlb-roster.json")) },
      { match: /the-odds-api\.com\/v4\/sports\/baseball_mlb\/odds/, respond: () => ok(fixture("oddsapi-odds-mlb.json"), QUOTA) },
      { match: /the-odds-api\.com\/v4\/sports\/soccer_epl\/odds/, respond: () => ok(fixture("oddsapi-odds-epl.json"), { ...QUOTA, "x-requests-last": "1" }) },
      { match: /the-odds-api\.com\/v4\/sports\/soccer_epl\/scores/, respond: () => ok(fixture("oddsapi-scores-epl.json"), { ...QUOTA, "x-requests-last": "2" }) },
      { match: /the-odds-api\.com\/v4\/sports\?/, respond: () => ok(JSON.stringify([{ key: "baseball_mlb", group: "Baseball", title: "MLB", active: true }]), { ...QUOTA, "x-requests-last": "0" }) },
      { match: /api\.open-meteo\.com/, respond: () => ok(fixture("openmeteo.json")) },
      { match: /www\.example\.com\/feed/, respond: () => ok(fixture("feed.rss.xml")) },
    ],
    calls,
  );
  const env = makeDeps({
    transport: t,
    settings: {
      providers: {
        oddsapi: { enabled: true, sports: ["baseball_mlb"], dailyCreditCap: 30, minRemainingCredits: 25 },
        mlb: { enabled: true },
        openmeteo: { enabled: true },
        rss: { enabled: true, feeds: [{ url: "https://www.example.com/feed", name: "Example League", tier: "official", sportKey: "baseball_mlb" }] },
      },
    },
    ...extra,
  });
  return { ...env, calls };
}

describe("MLB Stats API adapter", () => {
  it("maps official statuses conservatively", () => {
    expect(mapMlbStatus({ abstractGameState: "Final", detailedState: "Final" })).toBe("final");
    expect(mapMlbStatus({ abstractGameState: "Final", detailedState: "Final: Tied" })).toBe("final");
    expect(mapMlbStatus({ abstractGameState: "Final", detailedState: "Completed Early: Rain" })).toBe("final");
    expect(mapMlbStatus({ abstractGameState: "Final", detailedState: "Game Over" })).toBe("in_progress"); // not yet official
    expect(mapMlbStatus({ abstractGameState: "Final", detailedState: "Postponed" })).toBe("postponed");
    expect(mapMlbStatus({ abstractGameState: "Final", detailedState: "Cancelled" })).toBe("cancelled");
    expect(mapMlbStatus({ abstractGameState: "Live", detailedState: "Suspended: Rain" })).toBe("suspended");
    expect(mapMlbStatus({ abstractGameState: "Preview", detailedState: "Scheduled" })).toBe("scheduled");
    expect(mapMlbStatus({ abstractGameState: "Other", detailedState: "Weird" })).toBe("unknown");
  });

  it("ingests teams with aliases, schedules with make-ups, doubleheaders, lineups and probable pitchers", async () => {
    const { deps, repo } = setupMlbAndOdds();
    const mlb = new MlbProvider(deps);
    expect(await mlb.refreshTeams("2026")).toBe(3);
    expect(repo.resolveParticipant("live", "baseball_mlb", "Yankees")).toBe("mlb-team:147");
    expect(repo.resolveParticipant("live", "baseball_mlb", "Oakland Athletics")).toBe("mlb-team:133");
    const r = await mlb.refreshSchedule("2026-06-15", "2026-06-17");
    expect(r.events).toBe(5); // one malformed entry rejected, the postponed + make-up pair collapse into one event
    const makeup = repo.event("mlb:800001")!;
    expect(makeup.status).toBe("scheduled");
    expect(makeup.start_time).toBe("2026-06-16T17:05:00Z");
    expect(makeup.rescheduled_from).toBe("2026-06-15T23:05:00Z");
    const dh2 = repo.event("mlb:800002")!;
    expect(dh2.game_number).toBe(2);
    expect(repo.event("mlb:800003")!.status).toBe("final");
    expect(repo.event("mlb:800003")!.home_score).toBe(5);
    expect(repo.event("mlb:800004")!.status).toBe("in_progress"); // "Game Over" is not an official final
    expect(repo.event("mlb:800004")!.home_score).toBeNull();
    expect(repo.event("mlb:800005")!.status).toBe("suspended");
    const lineups = repo.lineupsAsOf("mlb:800001", "2026-06-16T16:00:00Z");
    expect(lineups.find((l) => l.participant_id === "mlb-team:147")?.status).toBe("confirmed");
    expect(lineups.find((l) => l.participant_id === "mlb-team:111")?.status).toBe("probable");
    // Refreshing again does not duplicate unchanged lineup snapshots.
    await mlb.refreshSchedule("2026-06-15", "2026-06-17");
    expect(repo.db.get<{ c: number }>("SELECT COUNT(*) c FROM lineups")!.c).toBe(2);
  });

  it("reads injured-list status from rosters and marks recoveries active", async () => {
    const { deps, repo } = setupMlbAndOdds();
    const mlb = new MlbProvider(deps);
    await mlb.refreshTeams("2026");
    await mlb.refreshInjuries(["mlb-team:147"], "2026-06-16");
    const inj = repo.injuriesAsOf("live", ["mlb-team:147"], "2026-06-16T16:00:00Z");
    expect(inj.map((i) => i.player_name).sort()).toEqual(["Hurt Pitcher", "Long Term Outfielder"]);
    expect(inj.every((i) => i.confirmation === "official")).toBe(true);
    expect(repo.injuryFeedSeen("live", "baseball_mlb", "2026-06-16T16:00:00Z")).toBe(true);
    // A later roster without the injured players reports them active again.
    const later = mlb.ingestRoster("mlb-team:147", { roster: [{ person: { id: 501, fullName: "Healthy Player" }, status: { code: "A" } }] }, "2026-06-20T12:00:00Z");
    expect(later).toBe(2);
    expect(repo.injuriesAsOf("live", ["mlb-team:147"], "2026-06-20T13:00:00Z")).toHaveLength(0);
    // ...but a replay of the earlier moment still sees them injured.
    expect(repo.injuriesAsOf("live", ["mlb-team:147"], "2026-06-17T00:00:00Z")).toHaveLength(2);
  });

  it("refuses to run when disabled", async () => {
    const { deps } = setupMlbAndOdds({ settings: { providers: { mlb: { enabled: false } } } });
    await expect(new MlbProvider(deps).refreshTeams("2026")).rejects.toMatchObject({ code: "disabled" });
  });
});

describe("The Odds API adapter", () => {
  it("computes documented costs", () => {
    expect(oddsApiCost(1, 1, 0)).toBe(1);
    expect(oddsApiCost(3, 2, 0)).toBe(6);
    expect(oddsApiCost(2, 4, 12)).toBe(4); // bookmakers count in groups of 10
    expect(soccerLeagueFinalIsRegulation("soccer_epl")).toBe(true);
    expect(soccerLeagueFinalIsRegulation("soccer_fa_cup")).toBe(false);
    expect(soccerLeagueFinalIsRegulation("baseball_mlb")).toBe(false);
  });

  it("attaches quotes to the official MLB schedule event, keeps contracts separate and rejects malformed prices", async () => {
    const { deps, repo, db, calls } = setupMlbAndOdds();
    const mlb = new MlbProvider(deps);
    await mlb.refreshTeams("2026");
    await mlb.refreshSchedule("2026-06-15", "2026-06-17");
    const odds = new OddsApiProvider(deps);
    const r = await odds.refreshOdds("baseball_mlb");
    expect(r.events).toBe(1);
    expect(r.unmatched).toBe(1); // unknown team
    expect(odds.ingestOdds("baseball_mlb", JSON.parse(fixture("oddsapi-odds-mlb.json")), "2026-06-16T15:00:00Z", null).rejected).toBe(3); // malformed event + 2 invalid prices
    expect(calls.some((u) => u.includes("apiKey=test-key-123456"))).toBe(true);
    // Doubleheader: commence 23:05 matches game 2, not the 17:05 make-up.
    const quotes = repo.latestQuotes("mlb:800002", "2026-06-16T16:00:00Z");
    expect(quotes.length).toBeGreaterThan(0);
    expect(repo.latestQuotes("mlb:800001", "2026-06-16T16:00:00Z")).toHaveLength(0);
    const ml = quotes.filter((q) => q.contract === "moneyline_2way_full_game");
    expect(new Set(ml.map((q) => q.book_key))).toEqual(new Set(["draftkings", "fanduel"])); // malformed book rejected
    const spreads = quotes.filter((q) => q.contract === "spread_full_game");
    expect(new Set(spreads.map((q) => q.contract_id))).toEqual(new Set(["spread_full_game@-1.5", "spread_full_game@-2.5"]));
    expect(quotes.some((q) => q.provider_market === "h2h_lay")).toBe(false);
    const totals = quotes.filter((q) => q.contract === "total_full_game");
    expect(totals.map((q) => q.outcome).sort()).toEqual(["over", "under"]);
    // Source and retrieval timestamps are both stored.
    expect(ml[0].source_time).toMatch(/2026-06-16T14:5/);
    expect(ml[0].retrieved_at).toBe("2026-06-16T15:00:00Z");
    // Quota headers captured, usage counted.
    const st = providerStatus(db, "oddsapi")!;
    expect(st.quota_remaining).toBe(480);
    expect(st.credits_today).toBe(1);
  });

  it("creates canonical events for odds-only sports, includes the draw and settles from scores", async () => {
    const { deps, repo } = setupMlbAndOdds({ settings: { providers: { oddsapi: { enabled: true, sports: ["soccer_epl"] } } } });
    const odds = new OddsApiProvider(deps);
    await odds.refreshOdds("soccer_epl");
    const ev = repo.event("oddsapi:a1b2c3")!;
    expect(ev.final_is_regulation).toBe(1);
    const q = repo.latestQuotes(ev.id, "2026-08-22T00:00:00Z");
    expect(q.map((x) => x.outcome).sort()).toEqual(["away", "draw", "home"]);
    expect(q.every((x) => x.contract === "moneyline_3way_regulation")).toBe(true);
    await odds.refreshScores("soccer_epl");
    const done = repo.event(ev.id)!;
    expect(done.status).toBe("final");
    expect([done.home_score, done.away_score]).toEqual([1, 1]);
  });

  it("enforces the daily credit cap before making a request", async () => {
    const { deps, calls, db } = setupMlbAndOdds({ settings: { providers: { oddsapi: { enabled: true, markets: ["h2h", "spreads", "totals"], regions: ["us", "uk"], dailyCreditCap: 5 } } } });
    const odds = new OddsApiProvider(deps);
    await expect(odds.refreshOdds("baseball_mlb")).rejects.toMatchObject({ code: "cap" });
    expect(calls).toHaveLength(0);
    // Minimum remaining credits are respected too.
    db.run("INSERT OR IGNORE INTO provider_status(provider) VALUES ('oddsapi')");
    db.run("UPDATE provider_status SET quota_remaining = 26 WHERE provider = 'oddsapi'");
    expect(() => odds.checkBudget(2)).toThrow(/fewer than 25 credits/);
  });

  it("handles exhausted quotas, rejected keys and missing keys without crashing", async () => {
    const quotaT = fakeTransport([{ match: /odds/, respond: () => ({ status: 401, headers: { "x-requests-remaining": "0" }, body: '{"message":"Usage quota has been reached","error_code":"OUT_OF_USAGE_CREDITS"}' }) }]);
    const a = makeDeps({ transport: quotaT, settings: { providers: { oddsapi: { enabled: true } } } });
    await expect(new OddsApiProvider(a.deps).refreshOdds("baseball_mlb")).rejects.toMatchObject({ code: "quota" });
    expect(providerStatus(a.db, "oddsapi")!.quota_exhausted).toBe(1);
    // Subsequent paid calls are blocked locally.
    await expect(new OddsApiProvider(a.deps).refreshOdds("baseball_mlb")).rejects.toMatchObject({ code: "quota" });

    const authT = fakeTransport([{ match: /odds/, respond: () => ({ status: 401, headers: {}, body: '{"message":"API key is not valid"}' }) }]);
    const b = makeDeps({ transport: authT, settings: { providers: { oddsapi: { enabled: true } } } });
    await expect(new OddsApiProvider(b.deps).refreshOdds("baseball_mlb")).rejects.toMatchObject({ code: "auth" });

    const c = makeDeps({ config: { oddsApiKey: null }, settings: { providers: { oddsapi: { enabled: true } } } });
    await expect(new OddsApiProvider(c.deps).refreshOdds("baseball_mlb")).rejects.toMatchObject({ code: "not_configured" });
  });

  it("retries 429/5xx with backoff, then gives up and records provider health", async () => {
    let n = 0;
    const t = fakeTransport([{ match: /odds/, respond: () => (++n < 3 ? { status: 503, headers: {}, body: "busy" } : ok("[]", QUOTA)) }]);
    const a = makeDeps({ transport: t, settings: { providers: { oddsapi: { enabled: true } } } });
    const r = await new OddsApiProvider(a.deps).refreshOdds("baseball_mlb");
    expect(n).toBe(3);
    expect(r.events).toBe(0);
    let m = 0;
    const down = fakeTransport([{ match: /odds/, respond: () => (m++, { status: 500, headers: {}, body: "down" }) }]);
    const b = makeDeps({ transport: down, settings: { providers: { oddsapi: { enabled: true } } } });
    await expect(new OddsApiProvider(b.deps).refreshOdds("baseball_mlb")).rejects.toBeInstanceOf(ProviderError);
    expect(m).toBe(3);
    expect(providerStatus(b.db, "oddsapi")!.consecutive_failures).toBe(1);
    expect(providerStatus(b.db, "oddsapi")!.last_error).not.toContain("test-key-123456");
  });

  it("stores historical snapshots with the snapshot time as information time (only when allowed)", async () => {
    const hist = { timestamp: "2026-06-10T12:00:00Z", previous_timestamp: "2026-06-10T11:55:00Z", next_timestamp: "2026-06-10T12:05:00Z", data: JSON.parse(fixture("oddsapi-odds-epl.json")) };
    const t = fakeTransport([{ match: /historical/, respond: () => ok(JSON.stringify(hist), { ...QUOTA, "x-requests-last": "10" }) }]);
    const blocked = makeDeps({ transport: t, settings: { providers: { oddsapi: { enabled: true, dailyCreditCap: 100 } } } });
    await expect(new OddsApiProvider(blocked.deps).historicalSnapshot("soccer_epl", "2026-06-10T12:00:00Z")).rejects.toMatchObject({ code: "disabled" });
    const a = makeDeps({ transport: t, settings: { providers: { oddsapi: { enabled: true, allowHistorical: true, dailyCreditCap: 100 } } } });
    const r = await new OddsApiProvider(a.deps).historicalSnapshot("soccer_epl", "2026-06-10T12:00:00Z");
    expect(r.quotes).toBe(3);
    const q = a.repo.quoteHistory("oddsapi:a1b2c3", "moneyline_3way_regulation", "2026-06-10T12:00:00Z");
    expect(q).toHaveLength(3);
    expect(q[0].known_at).toBe("2026-06-10T12:00:00Z");
    expect(a.repo.quoteHistory("oddsapi:a1b2c3", "moneyline_3way_regulation", "2026-06-10T11:59:00Z")).toHaveLength(0);
  });

  it("de-duplicates concurrent identical requests and uses the cache", async () => {
    const calls: string[] = [];
    const t = fakeTransport([{ match: /sports\?/, respond: async () => ok(JSON.stringify([{ key: "baseball_mlb", group: "Baseball", title: "MLB", active: true }]), QUOTA) }], calls);
    const a = makeDeps({ transport: t, settings: { providers: { oddsapi: { enabled: true } } } });
    const p = new OddsApiProvider(a.deps);
    await Promise.all([p.listSports(), p.listSports(), p.listSports()]);
    expect(calls).toHaveLength(1);
    await p.listSports();
    expect(calls).toHaveLength(1); // cached for 6 hours
  });
});

describe("Open-Meteo adapter", () => {
  it("picks the forecast hour of the start time and skips indoor venues", async () => {
    const { deps, repo } = setupMlbAndOdds();
    const mlb = new MlbProvider(deps);
    await mlb.refreshTeams("2026");
    await mlb.refreshSchedule("2026-06-15", "2026-06-17");
    const ev = repo.event("mlb:800002")!;
    const n = await new OpenMeteoProvider(deps).refreshForEvents([ev, { ...ev, id: "x", indoor: 1 }]);
    expect(n).toBe(1);
    const w = repo.weatherAsOf("mlb:800002", "2026-06-16T16:00:00Z")!;
    expect(w.precip_probability).toBe(35);
    expect(w.forecast_for).toBe("2026-06-16T23:00:00Z");
  });
});

describe("news feeds", () => {
  it("parses RSS and Atom, strips markup and drops non-http links", () => {
    const items = parseFeed(fixture("feed.rss.xml"));
    expect(items.map((i) => i.url)).toEqual(["https://www.example.com/news/1", "https://www.example.com/news/2", "https://www.example.com/news/3"]);
    expect(items[0].summary).toBe("Official move.");
    expect(items[0].published_at).toBe("2026-06-16T14:00:00Z");
    const atom = parseFeed(fixture("feed.atom.xml"));
    expect(atom[0].url).toBe("https://atom.example.org/a/1");
    expect(parseFeed("plain text, not a feed")).toEqual([]);
  });

  it("classifies claims, tags teams and groups duplicate reports", async () => {
    expect(classifyClaim("Rumor: X could be traded", "media")).toBe("speculation");
    expect(classifyClaim("Team places X on injured list", "official")).toBe("official");
    expect(classifyClaim("X expected to start Friday", "media")).toBe("speculation");
    expect(classifyClaim("X hits two home runs", "media")).toBe("report");
    const { deps, repo } = setupMlbAndOdds();
    await new MlbProvider(deps).refreshTeams("2026");
    const teams = repo.participants("live", "baseball_mlb");
    expect(tagTeams("Yankees place Hurt Pitcher on IL", teams)).toEqual(["mlb-team:147"]);
    expect(tagTeams("Red Sox win again", teams)).toEqual(["mlb-team:111"]);
    const n = await new RssProvider(deps).refresh();
    expect(n.items).toBe(3);
    const marked = markDuplicates(repo.newsAsOf("live", "2026-06-16T16:00:00Z"));
    expect(marked.filter((m) => m.duplicateOfIndex != null)).toHaveLength(1);
    expect(jaccard(dedupeKey("Yankees place Hurt Pitcher on 15-day injured list"), dedupeKey("Yankees put Hurt Pitcher on the 15-day injured list"))).toBeGreaterThanOrEqual(0.5);
  });

  it("flags conflicting availability reports", () => {
    const base = { dataset: "demo" as const, sport_key: "x", participant_ids: '["t1"]', summary: null, source_tier: "media" as const, retrieved_at: "2026-06-16T12:00:00Z", dedupe_key: "", duplicate_of: null };
    const news = [
      { ...base, title: "Sam Example expected to play tonight", url: "https://a.example/1", source_name: "Wire", claim_type: "report" as const, published_at: "2026-06-16T11:00:00Z" },
      { ...base, title: "Sam Example ruled out tonight, sources say", url: "https://a.example/2", source_name: "Blog", claim_type: "speculation" as const, published_at: "2026-06-16T11:30:00Z" },
    ];
    const injuries = [{ dataset: "demo" as const, sport_key: "x", participant_id: "t1", player_id: null, player_name: "Sam Example", status: "day_to_day", detail: null, source: "Team", source_url: null, confirmation: "official" as const, source_time: null, retrieved_at: "2026-06-16T10:00:00Z" }];
    const c = detectConflicts(news, injuries, "2026-06-16T12:00:00Z");
    expect(c).toHaveLength(1);
    expect(c[0].statements.map((s) => s.stance).sort()).toEqual(["available", "unavailable"]);
    expect(detectConflicts([news[0]], injuries, "2026-06-16T12:00:00Z")).toHaveLength(0);
  });
});

describe("network safety", () => {
  it("only fetches allow-listed https hosts and blocks private addresses", async () => {
    expect(hostAllowed("api.the-odds-api.com", ["api.the-odds-api.com"])).toBe(true);
    expect(hostAllowed("evil.com", ["api.the-odds-api.com"])).toBe(false);
    expect(hostAllowed("api.the-odds-api.com.evil.com", ["api.the-odds-api.com"])).toBe(false);
    expect(hostAllowed("a.mlb.com", [".mlb.com"])).toBe(true);
    for (const a of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254", "::1", "fc00::1", "::ffff:127.0.0.1", "0.0.0.0", "100.64.0.1"]) {
      expect(isPublicAddress(a)).toBe(false);
    }
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("not an ip")).toBe(false);

    const { db, log } = makeDeps();
    const redirectT = fakeTransport([{ match: /feed\.example\.com/, respond: () => ({ status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" }, body: "" }) }]);
    const http = new HttpClient(db, log, redirectT, async () => undefined);
    await expect(http.get("rss", "https://feed.example.com/rss", { allowedHosts: ["feed.example.com"] })).rejects.toMatchObject({ kind: "blocked" });
    await expect(http.get("rss", "http://feed.example.com/rss", { allowedHosts: ["feed.example.com"] })).rejects.toMatchObject({ kind: "blocked" });
    await expect(http.get("rss", "https://user:pw@feed.example.com/rss", { allowedHosts: ["feed.example.com"] })).rejects.toMatchObject({ kind: "blocked" });
  });

  it("redacts secrets from log text", () => {
    expect(redact("GET https://x/v4/sports?apiKey=abc123&regions=us")).toBe("GET https://x/v4/sports?apiKey=[redacted]&regions=us");
    expect(redact("token sk-secret-value here", { oddsApiKey: "sk-secret-value", anthropicApiKey: null })).toBe("token [redacted] here");
  });
});

describe("partial outages", () => {
  it("a failing provider does not block the others, and failures are logged", async () => {
    const t = fakeTransport([
      { match: /statsapi\.mlb\.com\/api\/v1\/teams\?/, respond: () => ok(fixture("mlb-teams.json")) },
      { match: /statsapi\.mlb\.com\/api\/v1\/schedule/, respond: () => ok(fixture("mlb-schedule.json")) },
      { match: /statsapi\.mlb\.com\/api\/v1\/teams\/\d+\/roster/, respond: () => ok(fixture("mlb-roster.json")) },
      { match: /the-odds-api/, respond: () => ({ status: 503, headers: {}, body: "maintenance" }) },
      { match: /open-meteo/, respond: () => ok("{not json") },
    ]);
    const { deps, repo, log } = makeDeps({
      transport: t,
      settings: { providers: { oddsapi: { enabled: true }, mlb: { enabled: true, historySeasons: 1 }, openmeteo: { enabled: true }, rss: { enabled: false } } },
    });
    const ingest = new LiveIngest(deps);
    const steps = await ingest.refreshDay("2026-06-16");
    const by = (s: string) => steps.find((x) => x.step === s)!;
    expect(by("MLB schedule").ok).toBe(true);
    expect(by("Odds: baseball_mlb").ok).toBe(false);
    expect(by("Weather").ok).toBe(false);
    expect(by("News feeds").skipped).toBe(true);
    expect(repo.event("mlb:800002")).not.toBeNull();
    expect(log.list(50).some((e: any) => e.level === "error")).toBe(true);
  });
});
