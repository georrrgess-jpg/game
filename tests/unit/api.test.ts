// End-to-end API workflows through Fastify's inject (no network), using a real SQLite file
// so restart persistence and immutability can be checked.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp, type AppContext } from "../../server/app";
import { loadConfig, type ServerConfig } from "../../server/config";
import { fakeTransport, fixture, ok } from "./helpers";
import { Scheduler, nextDailyRun } from "../../server/scheduler";
import { csvCell } from "../../server/classroom";

const HOST = "127.0.0.1:5180";
const H = { host: HOST, "x-overround-client": "1", "content-type": "application/json" };

let dir: string;
let cfg: ServerConfig;
let ctx: AppContext;
let now = new Date("2026-10-13T12:00:00Z");

async function req(method: "GET" | "POST" | "PUT", url: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await ctx.app.inject({ method, url, headers: { ...H, ...headers }, payload: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = null;
  try {
    json = r.json();
  } catch {
    json = null;
  }
  return { status: r.statusCode, json, body: r.body, headers: r.headers };
}

const transport = fakeTransport([
  { match: /statsapi\.mlb\.com\/api\/v1\/teams\?/, respond: () => ok(fixture("mlb-teams.json")) },
  { match: /statsapi\.mlb\.com\/api\/v1\/schedule/, respond: () => ok(fixture("mlb-schedule.json")) },
  { match: /statsapi\.mlb\.com\/api\/v1\/teams\/\d+\/roster/, respond: () => ok(fixture("mlb-roster.json")) },
]);

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "overround-test-"));
  cfg = loadConfig({ dbFile: path.join(dir, "test.sqlite"), staticDir: path.join(dir, "no-client"), oddsApiKey: null, balldontlieApiKey: null, anthropicApiKey: null, instructorPin: null, allowRemote: false, port: 5180, host: "127.0.0.1" });
  ctx = await buildApp({ config: cfg, transport, now: () => now });
}, 60000);

afterAll(async () => {
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("security", () => {
  it("rejects unexpected Host headers (DNS rebinding) and cross-site writes", async () => {
    expect((await req("GET", "/api/health", undefined, { host: "evil.example:5180" })).status).toBe(421);
    const noHeader = await ctx.app.inject({ method: "POST", url: "/api/analyze-today", headers: { host: HOST, "content-type": "application/json" }, payload: "{}" });
    expect(noHeader.statusCode).toBe(403);
    expect((await req("POST", "/api/analyze-today", { dataset: "demo" }, { origin: "https://evil.example" })).status).toBe(403);
    const ok = await req("POST", "/api/analyze-today", { dataset: "demo" }, { origin: "http://127.0.0.1:5180" });
    expect(ok.status).toBe(200);
  });

  it("sends security headers and never exposes secrets", async () => {
    const r = await req("GET", "/api/settings");
    expect(r.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.json.secrets).toEqual({ oddsApiKey: false, anthropicApiKey: false, balldontlieApiKey: false, instructorPin: false });
    expect(JSON.stringify(r.json)).not.toMatch(/apiKey"\s*:\s*"/);
  });

  it("validates inputs", async () => {
    expect((await req("PUT", "/api/settings", { timezone: "Mars/Base" })).status).toBe(400);
    expect((await req("PUT", "/api/settings", { staleQuoteMinutes: 1 })).status).toBe(400);
    expect((await req("PUT", "/api/settings", { providers: { rss: { feeds: [{ url: "http://insecure.example/feed", name: "x", tier: "media" }] } } })).status).toBe(400);
    expect((await req("PUT", "/api/settings", { demo: { now: "2026-01-01T00:00:00Z" } })).status).toBe(400);
    expect((await req("GET", "/api/board?dataset=demo&date=2026-13-45")).status).toBe(400);
    expect((await req("GET", "/api/board?dataset=nope")).status).toBe(400);
    expect((await req("GET", "/api/board?dataset=demo&asOf=2027-01-01T00:00:00Z")).status).toBe(400); // future information
    expect((await req("GET", "/api/events/does-not-exist/analysis?dataset=demo")).status).toBe(404);
  });

  it("requires the instructor PIN when one is configured", async () => {
    const d2 = mkdtempSync(path.join(tmpdir(), "overround-pin-"));
    const c2 = await buildApp({ config: { ...cfg, dbFile: path.join(d2, "p.sqlite"), instructorPin: "4321" }, transport, now: () => now });
    try {
      const r1 = await c2.app.inject({ method: "POST", url: "/api/demo/clock", headers: H, payload: JSON.stringify({ action: "advance_day" }) });
      expect(r1.statusCode).toBe(403);
      const r2 = await c2.app.inject({ method: "POST", url: "/api/demo/clock", headers: { ...H, "x-instructor-pin": "0000" }, payload: JSON.stringify({ action: "advance_day" }) });
      expect(r2.statusCode).toBe(403);
      const r3 = await c2.app.inject({ method: "POST", url: "/api/demo/clock", headers: { ...H, "x-instructor-pin": "4321" }, payload: JSON.stringify({ action: "advance_day" }) });
      expect(r3.statusCode).toBe(200);
      const r4 = await c2.app.inject({ method: "PUT", url: "/api/settings", headers: H, payload: JSON.stringify({ staleQuoteMinutes: 90 }) });
      expect(r4.statusCode).toBe(403);
    } finally {
      await c2.app.close();
      rmSync(d2, { recursive: true, force: true });
    }
  }, 60000);

  it("percent-encoded paths cannot bypass the CSRF check", async () => {
    for (const url of ["/%61pi/scheduler/pause", "/%61pi/classroom/results-hidden", "/api/%73cheduler/run/daily_scan"]) {
      const r = await ctx.app.inject({ method: "POST", url, headers: { host: HOST, origin: "http://evil.example" } });
      expect(r.statusCode, url).toBe(403);
    }
    expect((await req("GET", "/api/scheduler")).json.paused).toBe(true);
  });

  it("rejects out-of-range and oddly formatted information times", async () => {
    expect((await req("GET", "/api/board?dataset=demo&asOf=%2B010000-01-01T00:00:00Z")).status).toBe(400);
    expect((await req("GET", "/api/board?dataset=demo&asOf=1999-01-01T00:00:00Z")).status).toBe(400);
    const msOk = await req("GET", "/api/board?dataset=demo&asOf=2026-06-16T14:59:59.500Z");
    expect(msOk.status).toBe(200);
    expect(msOk.json.asOf).toBe("2026-06-16T14:59:59Z");
  });

  it("CSV exports neutralise spreadsheet formulas", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvCell("+cmd")).toBe("'+cmd");
    expect(csvCell("-0.0123")).toBe("-0.0123");
    expect(csvCell("a,b")).toBe('"a,b"');
  });
});

describe("Analyze Today and selected-game workflows (demo)", () => {
  it("status is always labelled and the demo board is fictional", async () => {
    const s = await req("GET", "/api/status?dataset=demo");
    expect(s.json.dataset).toBe("demo");
    expect(s.json.clock).toBe("2026-06-16T15:00:00Z");
    const r = await req("POST", "/api/analyze-today", { dataset: "demo" });
    expect(r.status).toBe(200);
    expect(r.json.board.mode).toBe("demo");
    expect(r.json.board.items.length).toBeGreaterThan(0);
    expect(r.json.board.items.every((i: any) => i.fictional)).toBe(true);
    expect(r.json.refresh).toEqual([]); // demo never calls providers
  });

  it("Analyze Today records system forecasts once per hour, including abstentions", async () => {
    const r1 = await req("POST", "/api/analyze-today", { dataset: "demo" });
    expect(r1.json.snapshot.recorded).toBe(0); // already recorded in the previous test for this information time
    const n = ctx.db.get<{ c: number }>("SELECT COUNT(*) c FROM forecasts WHERE dataset = 'demo' AND kind IN ('system','abstention')")!.c;
    expect(n).toBeGreaterThan(0);
  });

  it("selected-game analysis returns all layers and a deterministic explanation", async () => {
    const b = await req("GET", "/api/board?dataset=demo");
    const id = b.json.items.find((i: any) => !i.voided).eventId;
    const a = await req("GET", `/api/events/${encodeURIComponent(id)}/analysis?dataset=demo`);
    expect(a.status).toBe(200);
    expect(a.json.market.books.length).toBeGreaterThan(0);
    expect(a.json.model.available).toBe(true);
    expect(a.json.explanation.estimate).toMatch(/%/);
    const ex = await req("POST", `/api/events/${encodeURIComponent(id)}/explain`, { dataset: "demo", useAi: true });
    expect(ex.json.ai.source).toBe("deterministic"); // no key: falls back cleanly
    const h = await req("GET", `/api/events/${encodeURIComponent(id)}/history?dataset=demo`);
    expect(h.json.points.every((p: any) => p.known_at <= "2026-06-16T15:00:00Z")).toBe(true);
    const w = await req("POST", `/api/events/${encodeURIComponent(id)}/whatif`, { dataset: "demo", unavailablePlayers: ["Someone"], price: { outcome: "home", format: "american", value: "+120" } });
    expect(w.json.hypothetical).toBe(true);
    expect(w.json.price.decimal).toBeCloseTo(2.2, 12);
    expect(w.json.notes.join(" ")).toMatch(/no validated player-impact/);
    expect((await req("POST", `/api/events/${encodeURIComponent(id)}/whatif`, { dataset: "demo", price: { outcome: "home", format: "american", value: "0" } })).status).toBe(400);
    const csv = await req("GET", "/api/board.csv?dataset=demo");
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\r\n")[0]).toContain("event_id");
  });

  it("search finds teams by name", async () => {
    const r = await req("GET", "/api/events?dataset=demo&q=gulls");
    expect(r.json.events.length).toBeGreaterThan(0);
    expect(r.json.events.every((e: any) => /Gulls/.test(e.home + e.away))).toBe(true);
  });
});

describe("classroom experiments", () => {
  let sessionId: string;
  let gameId: string;
  it("saves immutable student forecasts with snapshots, then reveals results after the clock moves", async () => {
    sessionId = (await req("GET", "/api/sessions?dataset=demo")).json.active;
    const b = await req("GET", "/api/board?dataset=demo");
    gameId = b.json.items.find((i: any) => !i.voided && !i.started).eventId;
    const exp = await req("POST", "/api/experiments", { dataset: "demo", sessionId, name: "Week 1", author: "Ana" });
    const f = await req("POST", "/api/forecasts", { dataset: "demo", sessionId, eventId: gameId, author: "Ana", probs: { home: 0.55, away: 0.45 }, stake: { experimentId: exp.json.id, outcome: "home", points: 3 } });
    expect(f.status).toBe(200);
    expect(f.json.forecast.info_as_of).toBe("2026-06-16T15:00:00Z");
    // Immutable at the database level.
    expect(() => ctx.db.run("UPDATE forecasts SET author = 'x' WHERE id = ?", [f.json.forecast.id])).toThrow(/immutable/);
    expect(() => ctx.db.run("DELETE FROM forecasts WHERE id = ?", [f.json.forecast.id])).toThrow(/immutable/);
    // Bad inputs.
    expect((await req("POST", "/api/forecasts", { dataset: "demo", sessionId, eventId: gameId, author: "Ana", probs: { home: 0.7, away: 0.4 } })).status).toBe(400);
    expect((await req("POST", "/api/forecasts", { dataset: "demo", sessionId, eventId: gameId, author: "  ", probs: { home: 0.5, away: 0.5 } })).status).toBe(400);
    // Results are not known yet.
    const before = await req("GET", `/api/sessions/${sessionId}/forecasts?reveal=1`);
    expect(before.json.forecasts[0].result.settlement).toBe("pending");
    // Advance the demo clock: the game is now final and can be scored.
    await req("POST", "/api/demo/clock", { action: "advance_day" });
    const after = await req("GET", `/api/sessions/${sessionId}/forecasts?reveal=1`);
    expect(["win", "loss"]).toContain(after.json.forecasts[0].result.settlement);
    expect(after.json.scoreboard[0].scored).toBe(1);
    const er = await req("GET", `/api/experiments/${exp.json.id}?reveal=1`);
    expect(er.json.summary.settled).toBe(1);
    expect(Math.abs(er.json.summary.netPoints)).toBeGreaterThan(0);
    // Forecasting after the start is refused.
    const late = await req("POST", "/api/forecasts", { dataset: "demo", sessionId, eventId: gameId, author: "Ben", probs: { home: 0.5, away: 0.5 } });
    expect(late.status).toBe(409);
  });

  it("points can only go on your own forecasts, before the start by the real clock", async () => {
    const b = await req("GET", "/api/board?dataset=demo");
    const open = b.json.items.find((i: any) => !i.voided && !i.started && i.eventId !== gameId).eventId;
    const mine = await req("POST", "/api/experiments", { dataset: "demo", sessionId, name: "Mine", author: "Cara" });
    const theirs = await req("POST", "/api/experiments", { dataset: "demo", sessionId, name: "Theirs", author: "Dev" });
    // Someone else's experiment: refused, and nothing is saved.
    const before = ctx.db.get<{ c: number }>("SELECT COUNT(*) c FROM forecasts")!.c;
    const wrong = await req("POST", "/api/forecasts", { dataset: "demo", sessionId, eventId: open, author: "Cara", probs: { home: 0.5, away: 0.5 }, stake: { experimentId: theirs.json.id, outcome: "home", points: 2 } });
    expect(wrong.status).toBe(403);
    expect(ctx.db.get<{ c: number }>("SELECT COUNT(*) c FROM forecasts")!.c).toBe(before);
    // Own forecast, then the game starts: a later entry is refused.
    const f = await req("POST", "/api/forecasts", { dataset: "demo", sessionId, eventId: open, author: "Cara", probs: { home: 0.5, away: 0.5 } });
    expect(f.status).toBe(200);
    await req("POST", "/api/demo/clock", { action: "advance_day" });
    const late = await req("POST", `/api/experiments/${mine.json.id}/entries`, { forecastId: f.json.forecast.id, outcome: "home", stake: 2 });
    expect(late.status).toBe(409);
    await req("POST", "/api/demo/clock", { action: "reset" });
  });

  it("replay forecasts on already-played games are flagged, scored separately and never earn points", async () => {
    // Clock is back at the demo start; replay a game from two days earlier whose result is known.
    const past = await req("GET", "/api/board?dataset=demo&date=2026-06-13&asOf=2026-06-13T15:00:00Z");
    const g = past.json.items.find((i: any) => !i.voided && !i.started);
    const exp = await req("POST", "/api/experiments", { dataset: "demo", sessionId, name: "Replay", author: "Eve" });
    const withStake = await req("POST", "/api/forecasts", { dataset: "demo", sessionId, eventId: g.eventId, asOf: "2026-06-13T15:00:00Z", author: "Eve", probs: { home: 0.6, away: 0.4 }, stake: { experimentId: exp.json.id, outcome: "home", points: 5 } });
    expect(withStake.status).toBe(409);
    const ok = await req("POST", "/api/forecasts", { dataset: "demo", sessionId, eventId: g.eventId, asOf: "2026-06-13T15:00:00Z", author: "Eve", probs: { home: 0.6, away: 0.4 } });
    expect(ok.status).toBe(200);
    const list = await req("GET", `/api/sessions/${sessionId}/forecasts?reveal=1`);
    const eve = list.json.forecasts.find((x: any) => x.author === "Eve");
    expect(eve.replay).toBe(true);
    const rows = list.json.scoreboard.filter((r: any) => r.author === "Eve");
    expect(rows).toHaveLength(1);
    expect(rows[0].replay).toBe(true);
  });

  it("the instructor can hide results everywhere", async () => {
    await req("POST", "/api/demo/clock", { action: "advance_day" }); // make the forecast game final
    await req("POST", "/api/classroom/results-hidden", { hidden: true });
    const hidden = await req("GET", `/api/sessions/${sessionId}/forecasts?reveal=1`);
    expect(hidden.json.revealed).toBe(false);
    expect(hidden.json.forecasts[0].result).toBeNull();
    const a = await req("GET", `/api/events/${encodeURIComponent(gameId)}/analysis?dataset=demo`);
    expect(a.json.event.home_score).toBeNull();
    expect(a.json.resultHidden).toBe(true);
    const ev = await req("GET", "/api/events?dataset=demo&q=");
    expect(ev.json.events.every((e: any) => e.score === null)).toBe(true);
    // Soccer stores regulation-time scores too: they must be masked as well.
    const soccer = ctx.db.get<{ id: string }>("SELECT id FROM events WHERE sport_key = 'demo_soccer' AND status = 'final' AND start_time < '2026-06-16' ORDER BY start_time DESC LIMIT 1")!;
    const sa = await req("GET", `/api/events/${encodeURIComponent(soccer.id)}/analysis?dataset=demo`);
    expect([sa.json.event.home_score, sa.json.event.away_score, sa.json.event.regulation_home, sa.json.event.regulation_away, sa.json.event.final_at]).toEqual([null, null, null, null, null]);
    await req("POST", "/api/classroom/results-hidden", { hidden: false });
    expect((await req("GET", `/api/sessions/${sessionId}/forecasts?reveal=1`)).json.revealed).toBe(true);
    await req("POST", "/api/demo/clock", { action: "reset" });
  });

  it("restarting a session archives it without deleting forecasts", async () => {
    const before = ctx.db.get<{ c: number }>("SELECT COUNT(*) c FROM forecasts")!.c;
    const r = await req("POST", "/api/sessions", { dataset: "demo", name: "Period 2" });
    expect(r.status).toBe(200);
    const s = await req("GET", "/api/sessions?dataset=demo");
    expect(s.json.active).toBe(r.json.id);
    expect(ctx.db.get<{ c: number }>("SELECT COUNT(*) c FROM forecasts")!.c).toBe(before);
    await req("POST", "/api/demo/clock", { action: "reset" });
  });

  it("persists forecasts and settings across a restart", async () => {
    await req("PUT", "/api/settings", { staleQuoteMinutes: 120 });
    const count = ctx.db.get<{ c: number }>("SELECT COUNT(*) c FROM forecasts")!.c;
    await ctx.app.close();
    ctx = await buildApp({ config: cfg, transport, now: () => now });
    expect(ctx.db.get<{ c: number }>("SELECT COUNT(*) c FROM forecasts")!.c).toBe(count);
    expect((await req("GET", "/api/settings")).json.settings.staleQuoteMinutes).toBe(120);
  }, 60000);
});

describe("connected mode never substitutes demo data", () => {
  it("shows an empty board until providers are enabled, then real (fixture) data", async () => {
    const empty = await req("GET", "/api/board?dataset=live&date=2026-06-16");
    expect(empty.json.items).toHaveLength(0);
    expect(empty.json.dataset).toBe("live");
    now = new Date("2026-06-16T15:00:00Z");
    await req("PUT", "/api/settings", { timezone: "America/New_York", providers: { mlb: { enabled: true, historySeasons: 1 } } });
    const r = await req("POST", "/api/analyze-today", { dataset: "live", date: "2026-06-16" });
    expect(r.status).toBe(200);
    expect(r.json.refresh.find((s: any) => s.step === "MLB schedule").ok).toBe(true);
    expect(r.json.refresh.find((s: any) => s.step.startsWith("Odds")).skipped).toBe(true); // disabled / no key: skipped, never faked
    const items = r.json.board.items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i: any) => !i.fictional)).toBe(true);
    // No odds key: market reference is honestly unavailable, and with one season of history the model abstains.
    expect(items.every((i: any) => i.market === null)).toBe(true);
    expect(items.every((i: any) => i.model === null)).toBe(true);
    const providers = await req("GET", "/api/providers");
    expect(providers.json.providers.find((p: any) => p.id === "oddsapi").health.state).toBe("not_configured");
    expect(providers.json.providers.find((p: any) => p.id === "mlb").verification).toMatch(/Live connection succeeded/);
    now = new Date("2026-10-13T12:00:00Z");
  });
});

describe("scheduler", () => {
  it("computes the next daily run in local time across DST", () => {
    expect(nextDailyRun(new Date("2026-03-07T20:00:00Z"), "08:30", "America/New_York")).toBe("2026-03-08T12:30:00Z"); // after spring-forward: EDT
    expect(nextDailyRun(new Date("2026-10-31T20:00:00Z"), "08:30", "America/New_York")).toBe("2026-11-01T13:30:00Z"); // after fall-back: EST
    expect(nextDailyRun(new Date("2026-06-16T11:00:00Z"), "08:30", "America/New_York")).toBe("2026-06-16T12:30:00Z");
  });

  it("does nothing while paused, runs due jobs when resumed, and records results", async () => {
    let t = new Date("2026-06-16T12:00:00Z");
    const ran: string[] = [];
    const settings = { scheduler: { paused: true, dailyScanTime: "08:30", oddsRefreshMinutes: 60, resultsRefreshMinutes: 60, newsRefreshMinutes: 60 }, timezone: "America/New_York" } as any;
    const sched = new Scheduler(
      ctx.db,
      () => settings,
      ctx.log,
      {
        daily_scan: async () => (ran.push("daily"), "ok"),
        odds_refresh: async () => (ran.push("odds"), "ok"),
        results_refresh: async () => {
          throw new Error("provider down");
        },
        news_refresh: async () => (ran.push("news"), "ok"),
      },
      () => t,
    );
    t = new Date("2026-06-16T14:00:00Z");
    await sched.tick();
    expect(ran).toEqual([]);
    settings.scheduler.paused = false;
    await sched.tick();
    expect(ran.sort()).toEqual(["daily", "news", "odds"]);
    const jobs = sched.summary().jobs;
    expect(jobs.find((j) => j.name === "results_refresh")!.last_result).toMatch(/Failed: provider down/);
    expect(jobs.find((j) => j.name === "odds_refresh")!.next_run_at).toBe("2026-06-16T15:00:00Z");
    expect(sched.summary().note).toMatch(/only while this program is running/);
  });
});

describe("value finder, average lines and imports", () => {
  it("serves the value finder, average lines and backtest for the demo day", async () => {
    const v = await req("GET", "/api/value?dataset=demo");
    expect(v.status).toBe(200);
    expect(v.json.date).toBe("2026-06-16");
    expect(v.json.mostLikely.length).toBeGreaterThan(5);
    expect(Object.keys(v.json.grades)).toEqual(["A", "B", "C", "D"]);
    expect(JSON.stringify(v.json)).not.toMatch(/\block\b|guarantee(d)? win/i);
    const al = await req("GET", "/api/average-lines?dataset=demo&date=2026-06-16");
    expect(al.status).toBe(200);
    expect(al.json.games.some((g: any) => g.markets.some((m: any) => m.contract === "spread_full_game"))).toBe(true);
    const bt = await req("GET", "/api/value/backtest?dataset=demo");
    expect(bt.status).toBe(200);
    expect(bt.json.strategies.map((s: any) => s.key)).toEqual(["consensus_edge", "favourite"]);
    // Replays cannot look into the future, here too.
    expect((await req("GET", "/api/value?dataset=demo&asOf=2027-01-01T00:00:00Z")).status).toBe(400);
    expect((await req("GET", "/api/average-lines?dataset=demo&date=16-06-2026")).status).toBe(400);
  }, 60000);

  it("lists the new providers and imports results files only through a validated write", async () => {
    const p = await req("GET", "/api/providers");
    expect(p.json.providers.map((x: any) => x.id)).toEqual(["oddsapi", "mlb", "nflverse", "balldontlie", "openmeteo", "rss"]);
    expect(p.json.providers.find((x: any) => x.id === "balldontlie").keyConfigured).toBe(false);
    const csv = "date,time,home,away,home_score,away_score\n2025-01-05,19:30,Alpha,Beta,101,99\n";
    const noHeader = await ctx.app.inject({ method: "POST", url: "/api/import/results", headers: { host: HOST, "content-type": "application/json" }, payload: JSON.stringify({ sport: "basketball_nba", preset: "generic", csv }) });
    expect(noHeader.statusCode).toBe(403);
    expect((await req("POST", "/api/import/results", { sport: "basketball_nba", preset: "tennis-data", csv })).status).toBe(400);
    expect((await req("POST", "/api/import/results", { sport: "../etc", preset: "generic", csv })).status).toBe(400);
    const ok = await req("POST", "/api/import/results", { sport: "basketball_nba", preset: "generic", csv });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ rows: 1, imported: 1, created: 1 });
    // Imported live data never appears in the demo dataset.
    expect((await req("GET", "/api/events?dataset=demo&q=Alpha&from=2025-01-01&to=2025-01-10")).json.events).toHaveLength(0);
    // A larger file than the default body limit is accepted on this route.
    const big = "date,home,away,home_score,away_score\n" + Array.from({ length: 7000 }, (_, i) => `2024-0${1 + (i % 9)}-1${i % 10},Team ${i % 30},Team ${(i + 7) % 30},${90 + (i % 20)},${88 + (i % 17)}`).join("\n");
    expect(big.length).toBeGreaterThan(200_000);
    const r = await req("POST", "/api/import/results", { sport: "basketball_nba", preset: "generic", csv: big });
    expect(r.status).toBe(200);
    expect(r.json.rows).toBe(7000);
  }, 60000);

  it("settings accept the new provider options and reject bad ones", async () => {
    const r = await req("PUT", "/api/settings", { providers: { nflverse: { enabled: true, historySeasons: 4 }, oddsapi: { tennisAuto: true } } });
    expect(r.status).toBe(200);
    expect(r.json.settings.providers.nflverse.historySeasons).toBe(4);
    expect((await req("PUT", "/api/settings", { providers: { balldontlie: { requestsPerMinute: 0 } } })).status).toBe(400);
    await req("PUT", "/api/settings", { providers: { nflverse: { enabled: false }, oddsapi: { tennisAuto: false } } });
  });
});
