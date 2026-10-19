import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import { DateTime } from "luxon";

import type { ServerConfig } from "./config";
import { envFileStatus, isLoopbackHost, redact } from "./config";
import { Db } from "./db";
import { Repo, type Dataset, type EventRecord } from "./repo";
import { SettingsStore, DEMO_START } from "./settings";
import { ActivityLog } from "./activity";
import { HttpClient, type Transport } from "./http";
import { ModelService, analyzeEvent, type AnalysisContext, type GameAnalysis } from "./analysis";
import { buildBoard, boardCsv, summarize } from "./board";
import { Backtester, averageLines, valueFinder } from "./value";
import { BALLDONTLIE_CAPABILITIES, NFLVERSE_CAPABILITIES, importResultsCsv } from "./providers/results";
import { sportFamily } from "../shared/contracts";
import { Classroom, ClassroomError, csvCell } from "./classroom";
import { Evaluator } from "./evaluation";
import { LiveIngest } from "./ingest";
import { Scheduler, type JobName } from "./scheduler";
import { AiExplainer } from "./ai";
import { generateDemoWorld, demoNeedsGeneration, clearDemoWorld, DEMO_VERSION } from "./demo";
import { ProviderError, providerStatus, usageToday, type ProviderDeps } from "./providers/common";
import { ODDSAPI_CAPABILITIES } from "./providers/oddsapi";
import { MLB_CAPABILITIES } from "./providers/mlb";
import { OPENMETEO_CAPABILITIES } from "./providers/openmeteo";
import { RSS_CAPABILITIES } from "./providers/rss";
import { localDateOf, isIsoDate, toUtcIso, localDayBounds, addDaysToDate } from "../shared/time";
import { americanToDecimal, breakEvenProbability, expectedNetPoints, expectedNetPointsWithPush, parseAmerican, parseDecimal } from "../shared/odds";
import { detectConflicts } from "./news";
import { json } from "./db";

export const APP_VERSION = "1.0.0";

export interface AppOptions {
  config: ServerConfig;
  transport?: Transport;
  now?: () => Date;
  startScheduler?: boolean;
  logger?: boolean;
}

export interface AppContext {
  warmup: () => void;
  app: FastifyInstance;
  db: Db;
  repo: Repo;
  settings: SettingsStore;
  log: ActivityLog;
  http: HttpClient;
  models: ModelService;
  classroom: Classroom;
  evaluator: Evaluator;
  ingest: LiveIngest;
  scheduler: Scheduler;
  ai: AiExplainer;
}

const datasetSchema = z.enum(["demo", "live"]).default("demo");
const isoInstant = z.string().max(40).refine((s) => {
  try {
    const y = Number(toUtcIso(s).slice(0, 4));
    return /^\d{4}-/.test(toUtcIso(s)) && y >= 2000 && y <= 2100;
  } catch {
    return false;
  }
}, "Invalid timestamp (expected an ISO date-time between 2000 and 2100)");

class HttpProblem extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function buildApp(opts: AppOptions): Promise<AppContext> {
  const cfg = opts.config;
  const now = opts.now ?? (() => new Date());
  const db = new Db(cfg.dbFile);
  const repo = new Repo(db);
  const settings = new SettingsStore(db);
  const log = new ActivityLog(db, { oddsApiKey: cfg.oddsApiKey, anthropicApiKey: cfg.anthropicApiKey, balldontlieApiKey: cfg.balldontlieApiKey }, () => now().toISOString());
  const http = new HttpClient(db, log, opts.transport);
  const models = new ModelService(repo, () => settings.get().staleQuoteMinutes);
  const classroom = new Classroom(db, repo);
  const evaluator = new Evaluator(repo, models, () => settings.get().staleQuoteMinutes);
  const deps: ProviderDeps = { db, repo, http, log, settings: () => settings.get(), config: cfg, now };
  const ingest = new LiveIngest(deps);
  const ai = new AiExplainer(db, cfg, () => settings.get(), log, now);

  const filled = repo.backfillSeasons();
  if (filled) log.add("info", "server", `Filled the season label of ${filled} older event(s).`);

  if (demoNeedsGeneration(repo)) {
    clearDemoWorld(repo);
    const r = generateDemoWorld(repo);
    log.add("info", "demo", `Generated fictional demo world ${DEMO_VERSION}: ${r.events} events, ${r.quotes} quotes.`);
  }

  const liveToday = () => localDateOf(now().toISOString(), settings.get().timezone);
  const analysisDeps = { repo, models };
  const backtester = new Backtester(analysisDeps);

  // Boards are expensive (one full analysis per game). Cache them per information time and data version,
  // so the Value Finder, Average Lines and the board page can share one computation.
  const boardCache = new Map<string, ReturnType<typeof buildBoard>>();
  function cachedBoard(ctx: AnalysisContext, date: string) {
    const v = db.get<{ q: number | null; e: string | null; n: number }>("SELECT (SELECT MAX(id) FROM quotes) q, (SELECT MAX(retrieved_at) FROM events) e, (SELECT COUNT(*) FROM events) n")!;
    const key = JSON.stringify([ctx, date, v]);
    const hit = boardCache.get(key);
    if (hit) return hit;
    const b = buildBoard(analysisDeps, ctx, date);
    if (boardCache.size >= 12) boardCache.delete(boardCache.keys().next().value!);
    boardCache.set(key, b);
    return b;
  }

  const scheduler = new Scheduler(
    db,
    () => settings.get(),
    log,
    {
      daily_scan: async () => {
        const date = liveToday();
        const steps = await ingest.refreshDay(date);
        const ctx = liveCtx();
        const board = buildBoard(analysisDeps, ctx, date);
        const snap = classroom.recordSystemSnapshot("live", board.analyses, toUtcIso(now()), randomUUID());
        return `${steps.filter((s) => s.ok).length}/${steps.length} steps ok; ${board.items.length} games; recorded ${snap.recorded} forecasts and ${snap.abstentions} abstentions.`;
      },
      odds_refresh: async () => {
        const date = liveToday();
        const { startUtc, endUtc } = localDayBounds(date, settings.get().timezone);
        const upcoming = repo.eventsInWindow("live", startUtc, endUtc, toUtcIso(now())).filter((e) => e.status === "scheduled");
        if (!upcoming.length && repo.db.get("SELECT 1 FROM events WHERE dataset = 'live' LIMIT 1")) return "No upcoming games today; skipped to save credits.";
        const r = await ingest.refreshOddsOnly();
        return r.map((x) => `${x.step}: ${x.ok ? x.detail : `failed (${x.detail})`}`).join("; ") || "No sports configured.";
      },
      results_refresh: async () => {
        const r = await ingest.refreshResults(liveToday());
        return r.map((x) => `${x.step}: ${x.ok ? x.detail : `failed (${x.detail})`}`).join("; ") || "Nothing to refresh.";
      },
      news_refresh: async () => {
        const r = await ingest.refreshNews();
        return r.map((x) => `${x.step}: ${x.ok ? x.detail : x.skipped ? "skipped" : `failed (${x.detail})`}`).join("; ");
      },
    },
    now,
  );
  if (opts.startScheduler) scheduler.start();

  function liveCtx(): AnalysisContext {
    const s = settings.get();
    return { dataset: "live", asOf: toUtcIso(now()), zone: s.timezone, staleMinutes: s.staleQuoteMinutes, discrepancyMinPoints: s.discrepancyMinPoints, mode: "live" };
  }

  /** "Now" for a dataset: the fictional demo clock, or the real clock for live data. */
  function clockFor(dataset: Dataset): string {
    return dataset === "demo" ? settings.get().demo.now : toUtcIso(now());
  }

  function ctxFrom(q: { dataset?: unknown; asOf?: unknown }): AnalysisContext {
    const dataset = datasetSchema.parse(q.dataset ?? "demo");
    const s = settings.get();
    const clock = clockFor(dataset);
    let asOf = clock;
    let mode: AnalysisContext["mode"] = dataset === "demo" ? "demo" : "live";
    if (q.asOf != null && q.asOf !== "") {
      asOf = toUtcIso(isoInstant.parse(q.asOf));
      if (Date.parse(asOf) > Date.parse(clock)) throw new HttpProblem(400, "Replay time cannot be later than the current clock: future information is not available.");
      if (Date.parse(asOf) < Date.parse(clock)) mode = "replay";
    }
    return { dataset, asOf, zone: s.timezone, staleMinutes: s.staleQuoteMinutes, discrepancyMinPoints: s.discrepancyMinPoints, mode };
  }

  const resultsHidden = () => settings.get().classroom.lockReveal;

  /** Instructor "hide results" masks final scores everywhere for classroom use. */
  function maskAnalysis(a: GameAnalysis): GameAnalysis {
    if (!resultsHidden() || !a.status.resultKnown) return a;
    return {
      ...a,
      event: { ...a.event, status: "final", home_score: null, away_score: null, regulation_home: null, regulation_away: null, final_at: null, status_at: null, extra: "{}" },
      status: { ...a.status, resultKnown: false },
      resultHidden: true,
    } as GameAnalysis;
  }

  // ---------------------------------------------------------------- Fastify
  const app = Fastify({
    logger: opts.logger ? { level: "info", redact: ["req.headers.x-instructor-pin"] } : false,
    bodyLimit: 200_000,
    trustProxy: false,
  });

  const allowedHosts = new Set<string>();
  for (const h of ["127.0.0.1", "localhost", "[::1]"]) {
    allowedHosts.add(`${h}:${cfg.port}`);
    if (cfg.dev) allowedHosts.add(`${h}:5173`);
  }
  if (!isLoopbackHost(cfg.host)) allowedHosts.add(`${cfg.host}:${cfg.port}`);

  app.addHook("onRequest", async (req, reply) => {
    // DNS-rebinding protection: only answer requests addressed to this machine by name we expect.
    const host = (req.headers.host ?? "").toLowerCase();
    if (!cfg.allowRemote && !allowedHosts.has(host)) {
      return reply.code(421).type("text/plain").send("Misdirected request: unexpected Host header.");
    }
    // Applies to EVERY state-changing request regardless of path, so encoded paths (e.g. /%61pi/...) cannot slip past.
    if (req.method !== "GET" && req.method !== "HEAD") {
      // CSRF protection: browsers cannot send this custom header cross-origin without a CORS preflight, which we never approve.
      if (req.headers["x-overround-client"] !== "1") return reply.code(403).send({ error: "Missing client header." });
      const origin = req.headers.origin;
      if (origin) {
        try {
          if (!allowedHosts.has(new URL(origin).host) && !cfg.allowRemote) return reply.code(403).send({ error: "Cross-origin request refused." });
        } catch {
          return reply.code(403).send({ error: "Bad origin." });
        }
      }
    }
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (_req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    return payload;
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "Invalid input", details: err.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`) });
    if (err instanceof HttpProblem) return reply.code(err.status).send({ error: err.message });
    if (err instanceof ClassroomError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof ProviderError) {
      const status = err.code === "disabled" || err.code === "not_configured" || err.code === "cap" || err.code === "quota" ? 409 : 502;
      return reply.code(status).send({ error: err.message, code: err.code });
    }
    if (err instanceof RangeError) return reply.code(400).send({ error: err.message });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message ?? "Bad request" });
    log.add("error", "server", `Unhandled error on ${req.method} ${redact(req.url)}: ${(err as Error)?.message}`);
    return reply.code(500).send({ error: "Internal error. Details were written to the activity log." });
  });

  function requireInstructor(req: FastifyRequest): void {
    if (!cfg.instructorPin) {
      if (cfg.allowRemote) throw new HttpProblem(403, "Instructor actions on a network-exposed server require INSTRUCTOR_PIN.");
      return;
    }
    const given = String(req.headers["x-instructor-pin"] ?? "");
    const a = Buffer.from(given);
    const b = Buffer.from(cfg.instructorPin);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpProblem(403, "Instructor PIN required or incorrect.");
  }

  const sendCsv = (reply: FastifyReply, name: string, body: string) =>
    reply.header("Content-Type", "text/csv; charset=utf-8").header("Content-Disposition", `attachment; filename="${name.replace(/[^a-z0-9_.-]/gi, "_")}"`).send("﻿" + body);

  const localDateParam = (q: { date?: unknown }, dataset: Dataset, asOf: string) => {
    const d = typeof q.date === "string" && q.date ? q.date : localDateOf(asOf, settings.get().timezone);
    if (!isIsoDate(d)) throw new HttpProblem(400, "date must be YYYY-MM-DD");
    void dataset;
    return d;
  };

  // ---------------------------------------------------------------- status & settings
  app.get("/api/health", async () => ({ ok: true, version: APP_VERSION }));

  app.get("/api/status", async (req) => {
    const q = req.query as Record<string, string>;
    const dataset = datasetSchema.parse(q.dataset ?? "demo");
    const s = settings.get();
    return {
      version: APP_VERSION,
      dataset,
      clock: clockFor(dataset),
      realNow: toUtcIso(now()),
      demoClock: s.demo.now,
      demoStart: DEMO_START,
      timezone: s.timezone,
      resultsHidden: s.classroom.lockReveal,
      instructorPinConfigured: !!cfg.instructorPin,
      host: cfg.host,
      scheduler: scheduler.summary(),
      providers: providerList().map((p) => ({ id: p.id, name: p.name, enabled: p.enabled, health: p.health.state })),
      ai: ai.status(),
      liveEvents: db.get<{ c: number }>("SELECT COUNT(*) c FROM events WHERE dataset = 'live'")?.c ?? 0,
    };
  });

  app.get("/api/settings", async () => ({
    settings: settings.get(),
    secrets: { oddsApiKey: !!cfg.oddsApiKey, anthropicApiKey: !!cfg.anthropicApiKey, balldontlieApiKey: !!cfg.balldontlieApiKey, instructorPin: !!cfg.instructorPin },
    // Where the server looked for .env and what went wrong (setting names only, never values). The folder
    // path is shown only to someone on this computer.
    envFile: (() => {
      const e = envFileStatus();
      if (!e) return null;
      return { path: cfg.allowRemote ? ".env" : e.path, found: e.found, keys: e.keys, hints: e.hints };
    })(),
  }));

  app.put("/api/settings", async (req) => {
    requireInstructor(req);
    const patch = z.record(z.string(), z.unknown()).parse(req.body ?? {});
    if ("demo" in patch) throw new HttpProblem(400, "Use the demo clock controls to change the demo clock.");
    const before = settings.get();
    const updated = settings.update(patch);
    if (before.scheduler.dailyScanTime !== updated.scheduler.dailyScanTime || before.timezone !== updated.timezone || JSON.stringify(before.scheduler) !== JSON.stringify(updated.scheduler)) {
      scheduler.recomputeAll();
    }
    log.add("info", "settings", "Settings updated.", Object.keys(patch));
    return { settings: updated };
  });

  // ---------------------------------------------------------------- providers
  function providerList() {
    const s = settings.get();
    const caps = [ODDSAPI_CAPABILITIES, MLB_CAPABILITIES, NFLVERSE_CAPABILITIES, BALLDONTLIE_CAPABILITIES, OPENMETEO_CAPABILITIES, RSS_CAPABILITIES];
    return caps.map((c) => {
      const st = providerStatus(db, c.id);
      const enabledMap: Record<string, boolean> = {
        oddsapi: s.providers.oddsapi.enabled,
        mlb: s.providers.mlb.enabled,
        nflverse: s.providers.nflverse.enabled,
        balldontlie: s.providers.balldontlie.enabled,
        openmeteo: s.providers.openmeteo.enabled,
        rss: s.providers.rss.enabled,
      };
      const enabled = enabledMap[c.id] ?? false;
      const keyConfigured = c.id === "oddsapi" ? !!cfg.oddsApiKey : c.id === "balldontlie" ? !!cfg.balldontlieApiKey : true;
      let state: "not_configured" | "disabled" | "never_used" | "ok" | "degraded" | "down" | "quota_exhausted" = "never_used";
      if (!keyConfigured) state = "not_configured";
      else if (!enabled) state = "disabled";
      else if (st?.quota_exhausted) state = "quota_exhausted";
      else if (st && st.consecutive_failures >= 3) state = "down";
      else if (st?.last_error_at && (!st.last_success_at || st.last_error_at > st.last_success_at)) state = "degraded";
      else if (st?.last_success_at) state = "ok";
      return {
        ...c,
        enabled,
        keyConfigured,
        verification: st?.last_success_at
          ? `Live connection succeeded on this installation (last success ${st.last_success_at}).`
          : "Implemented and tested against recorded responses; not yet live-verified on this installation.",
        health: {
          state,
          lastAttempt: st?.last_attempt_at ?? null,
          lastSuccess: st?.last_success_at ?? null,
          lastError: st?.last_error ?? null,
          lastErrorAt: st?.last_error_at ?? null,
          consecutiveFailures: st?.consecutive_failures ?? 0,
        },
        quota: c.id === "oddsapi" ? { remaining: st?.quota_remaining ?? null, used: st?.quota_used ?? null, lastCost: st?.quota_last_cost ?? null, exhausted: !!st?.quota_exhausted } : null,
        usageToday: usageToday(deps, c.id),
        observed: json<Record<string, unknown>>(st?.observed, {}),
      };
    });
  }

  app.get("/api/providers", async () => ({ providers: providerList(), ai: ai.status() }));

  app.post("/api/providers/:id/test", async (req) => {
    requireInstructor(req);
    const id = z.enum(["oddsapi", "mlb", "nflverse", "balldontlie", "openmeteo", "rss"]).parse((req.params as { id: string }).id);
    const t0 = Date.now();
    let detail: string;
    switch (id) {
      case "oddsapi": {
        const sports = await ingest.odds.listSports(true);
        detail = `Key accepted. ${sports.filter((s) => s.active).length} active sports listed (this call is free).`;
        break;
      }
      case "mlb": {
        const n = await ingest.mlb.refreshTeams(String(DateTime.fromJSDate(now()).year));
        detail = `${n} teams returned.`;
        break;
      }
      case "nflverse": {
        const csv = await ingest.nflverse.fetchCsv();
        detail = `games.csv downloaded (${Math.round(csv.length / 1024)} KB, ${csv.split("\n").length - 1} rows).`;
        break;
      }
      case "balldontlie": {
        const today = localDateOf(toUtcIso(now()), settings.get().timezone);
        const r = await ingest.balldontlie.refreshRange(today, today);
        detail = `Key accepted. ${r.games} game(s) listed for ${today}.`;
        break;
      }
      case "openmeteo": {
        if (!settings.get().providers.openmeteo.enabled) throw new ProviderError("Enable Open-Meteo first.", "disabled");
        const res = await http.get("openmeteo", "https://api.open-meteo.com/v1/forecast?latitude=40.83&longitude=-73.93&hourly=temperature_2m&forecast_days=1&timezone=UTC", {
          allowedHosts: ["api.open-meteo.com"],
        });
        if (res.status !== 200) throw new ProviderError(`HTTP ${res.status}`, "http");
        detail = "Forecast endpoint responded.";
        break;
      }
      case "rss": {
        const r = await ingest.rss.refresh();
        if (r.errors.length && !r.items) throw new ProviderError(r.errors.join("; "), "http");
        detail = `${r.feeds} feed(s) fetched, ${r.items} new item(s)${r.errors.length ? `; problems: ${r.errors.join("; ")}` : ""}.`;
        break;
      }
    }
    log.add("info", id, `Connection test passed: ${detail}`);
    return { ok: true, detail, latencyMs: Date.now() - t0 };
  });

  app.post("/api/providers/oddsapi/historical", async (req) => {
    requireInstructor(req);
    const body = z.object({ sport: z.string().regex(/^[a-z0-9_]+$/), date: isoInstant }).parse(req.body);
    return ingest.odds.historicalSnapshot(body.sport, body.date);
  });

  app.post("/api/providers/nflverse/import", async (req) => {
    requireInstructor(req);
    return ingest.nflverse.importSeasons(ingest.nflSeasons(localDateOf(toUtcIso(now()), settings.get().timezone)));
  });

  app.post("/api/providers/balldontlie/import", async (req) => {
    requireInstructor(req);
    const { seasons, current } = ingest.nbaSeasons(localDateOf(toUtcIso(now()), settings.get().timezone));
    return ingest.balldontlie.importSeasons(seasons, current);
  });

  // Results files the user downloaded themselves (e.g. tennis-data.co.uk saved as CSV). Up to 20 MB.
  app.post("/api/import/results", { bodyLimit: 20_000_000 }, async (req) => {
    requireInstructor(req);
    const body = z
      .object({
        sport: z.string().regex(/^[a-z0-9_]+$/).max(60),
        preset: z.enum(["tennis-data", "generic"]),
        csv: z.string().min(1).max(19_000_000),
      })
      .parse(req.body);
    if (body.preset === "tennis-data" && sportFamily(body.sport) !== "tennis") throw new HttpProblem(400, "The tennis-data preset needs a tennis sport (tennis_atp or tennis_wta).");
    const r = importResultsCsv(repo, body.sport, body.csv, body.preset, toUtcIso(now()));
    log.add("info", "import", `Imported ${r.imported} of ${r.rows} rows for ${body.sport} (${r.created} new games, ${r.quotes} closing quotes, ${r.skipped.length} skipped).`);
    return r;
  });

  app.post("/api/providers/mlb/history", async (req) => {
    requireInstructor(req);
    const season = String(DateTime.fromJSDate(now()).year);
    return ingest.mlb.importHistory(season, settings.get().providers.mlb.historySeasons);
  });

  // ---------------------------------------------------------------- analysis
  app.get("/api/board", async (req) => {
    const q = req.query as Record<string, string>;
    const ctx = ctxFrom(q);
    const date = localDateParam(q, ctx.dataset, ctx.asOf);
    const board = cachedBoard(ctx, date);
    const { analyses, ...rest } = board;
    void analyses;
    return { ...rest, items: rest.items.map((i) => (resultsHidden() && i.resultKnown ? { ...i, score: null, resultKnown: false, resultHidden: true } : i)) };
  });

  app.get("/api/board.csv", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const ctx = ctxFrom(q);
    const date = localDateParam(q, ctx.dataset, ctx.asOf);
    const board = cachedBoard(ctx, date);
    return sendCsv(reply, `board-${ctx.dataset}-${date}.csv`, boardCsv(board.items));
  });

  app.post("/api/analyze-today", async (req) => {
    const body = z.object({ dataset: datasetSchema, date: z.string().optional(), asOf: isoInstant.optional(), refresh: z.boolean().default(true) }).parse(req.body ?? {});
    const ctx0 = ctxFrom({ dataset: body.dataset, asOf: body.asOf });
    const date = localDateParam({ date: body.date }, ctx0.dataset, ctx0.asOf);
    let steps: Awaited<ReturnType<LiveIngest["refreshDay"]>> = [];
    if (ctx0.dataset === "live" && ctx0.mode !== "replay" && body.refresh) {
      steps = await ingest.refreshDay(date);
    }
    const ctx = ctx0.mode === "replay" ? ctx0 : ctxFrom({ dataset: body.dataset }); // re-read the clock after refreshing
    const board = buildBoard(analysisDeps, ctx, date);
    let snapshot = null;
    if (ctx.mode !== "replay") {
      snapshot = classroom.recordSystemSnapshot(ctx.dataset, board.analyses, toUtcIso(now()), randomUUID());
    }
    log.add("info", "analyze", `Analyze Today (${ctx.dataset}, ${date}): ${board.items.length} games, ${board.coverage.withCurrentMarket} with current quotes, ${board.coverage.withModel} with model.`);
    const { analyses, ...rest } = board;
    void analyses;
    return { board: rest, refresh: steps, snapshot };
  });

  app.get("/api/events", async (req) => {
    const q = req.query as Record<string, string>;
    const ctx = ctxFrom(q);
    const zone = settings.get().timezone;
    const from = q.from && isIsoDate(q.from) ? q.from : addDaysToDate(localDateOf(ctx.asOf, zone), -3);
    const to = q.to && isIsoDate(q.to) ? q.to : addDaysToDate(localDateOf(ctx.asOf, zone), 7);
    const lo = localDayBounds(from, zone).startUtc;
    const hi = localDayBounds(to, zone).endUtc;
    const query = typeof q.q === "string" ? q.q.slice(0, 80) : "";
    const events = repo.searchEvents(ctx.dataset, query, lo, hi, ctx.asOf, 300);
    const names = new Map<string, { name: string; abbr: string | null }>();
    const nm = (id: string) => {
      if (!names.has(id)) {
        const p = repo.participant(id);
        names.set(id, { name: p?.name ?? id, abbr: p?.abbreviation ?? null });
      }
      return names.get(id)!;
    };
    return {
      asOf: ctx.asOf,
      mode: ctx.mode,
      from,
      to,
      events: events.map((e) => ({
        id: e.id,
        sport: e.sport_key,
        league: e.league,
        start: e.start_time,
        localDate: localDateOf(e.start_time, zone),
        status: e.status,
        home: nm(e.home_id).name,
        away: nm(e.away_id).name,
        homeAbbr: nm(e.home_id).abbr,
        awayAbbr: nm(e.away_id).abbr,
        score: e.status === "final" && !resultsHidden() ? `${e.home_score}-${e.away_score}` : null,
        resultHidden: e.status === "final" && resultsHidden(),
        gameNumber: e.game_number,
        rescheduledFrom: e.rescheduled_from,
      })),
    };
  });

  const getAnalysis = (id: string, ctx: AnalysisContext, whatIf = {}) => {
    const a = analyzeEvent(analysisDeps, ctx, id, whatIf);
    if (!a) throw new HttpProblem(404, "Game not found in this dataset at this time.");
    return a;
  };

  app.get("/api/events/:id/analysis", async (req) => {
    const ctx = ctxFrom(req.query as Record<string, string>);
    const a = maskAnalysis(getAnalysis((req.params as { id: string }).id, ctx));
    return a;
  });

  app.get("/api/events/:id/history", async (req) => {
    const q = req.query as Record<string, string>;
    const ctx = ctxFrom(q);
    const id = (req.params as { id: string }).id;
    const a = getAnalysis(id, ctx);
    const contractId = typeof q.contractId === "string" && q.contractId ? q.contractId : a.market.contractId;
    // Pre-game only: in-play prices after the scheduled start can reveal the result.
    const rows = repo.quoteHistory(id, contractId, a.infoAsOf);
    return {
      eventId: id,
      contractId,
      asOf: ctx.asOf,
      start: a.event.start_time,
      points: rows.map((r) => ({ book: r.book_title, book_key: r.book_key, outcome: r.outcome, decimal: r.price_decimal, source_time: r.source_time, retrieved_at: r.known_at, known_at: r.known_at })),
    };
  });

  app.get("/api/events/:id/players", async (req) => {
    const ctx = ctxFrom(req.query as Record<string, string>);
    const a = getAnalysis((req.params as { id: string }).id, ctx);
    return {
      home: { id: a.event.home_id, name: a.event.home_name, players: repo.players(a.event.home_id) },
      away: { id: a.event.away_id, name: a.event.away_name, players: repo.players(a.event.away_id) },
    };
  });

  app.post("/api/events/:id/whatif", async (req) => {
    const body = z
      .object({
        dataset: datasetSchema,
        asOf: isoInstant.optional(),
        neutral: z.boolean().optional(),
        restDiff: z.number().int().min(-3).max(3).optional(),
        ratingAdjust: z.object({ home: z.number().min(-200).max(200), away: z.number().min(-200).max(200) }).optional(),
        unavailablePlayers: z.array(z.string().max(80)).max(30).optional(),
        price: z.object({ outcome: z.enum(["home", "away", "draw"]), format: z.enum(["american", "decimal"]), value: z.union([z.string().max(12), z.number()]) }).optional(),
        pushProbability: z.number().min(0).max(0.5).optional(),
      })
      .parse(req.body);
    const ctx = ctxFrom({ dataset: body.dataset, asOf: body.asOf });
    const id = (req.params as { id: string }).id;
    const base = getAnalysis(id, ctx);
    const supported = base.model.available;
    const whatIf = { neutral: body.neutral, restDiff: body.restDiff, ratingAdjust: body.ratingAdjust };
    const scen = supported ? getAnalysis(id, ctx, whatIf) : base;
    const notes: string[] = [];
    const recomputed: string[] = [];
    if (!supported) notes.push("No independent model for this game, so scenario changes cannot be recomputed. Only the price calculator below applies.");
    if (supported && body.neutral !== undefined) recomputed.push(`Venue: ${body.neutral ? "neutral site (home advantage removed)" : "home venue"}. Supported: home advantage is a fitted model input.`);
    if (supported && body.restDiff !== undefined) {
      const used = base.model.prediction?.features.find((f) => f.name === "rest_diff_days")?.weight ?? 0;
      recomputed.push(used === 0 ? "Rest difference: the fitted model gives rest zero weight (it did not improve validation), so this has no effect." : `Rest difference set to ${body.restDiff} day(s). Supported: rest is a fitted model input.`);
    }
    if (supported && body.ratingAdjust && (body.ratingAdjust.home || body.ratingAdjust.away)) {
      recomputed.push(`EXPERIMENTAL manual rating adjustment (home ${body.ratingAdjust.home >= 0 ? "+" : ""}${body.ratingAdjust.home}, away ${body.ratingAdjust.away >= 0 ? "+" : ""}${body.ratingAdjust.away} Elo points). Chosen by you, not estimated or validated by the model.`);
    }
    if (body.unavailablePlayers?.length) {
      notes.push(
        `Marked as hypothetically unavailable: ${body.unavailablePlayers.join(", ")}. The model has no validated player-impact estimate, so this alone changes nothing. To explore an effect, add a manual rating adjustment and treat the result as an experiment.`,
      );
    }
    let price: Record<string, unknown> | null = null;
    if (body.price) {
      const parsed = body.price.format === "american" ? parseAmerican(body.price.value) : parseDecimal(body.price.value);
      if (!parsed.ok) throw new HttpProblem(400, parsed.error);
      const d = body.price.format === "american" ? americanToDecimal(parsed.value) : parsed.value;
      const pModel = scen.model.probs?.[body.price.outcome] ?? null;
      const pMarket = scen.market.reference?.probs[body.price.outcome] ?? null;
      const pushP = body.pushProbability ?? 0;
      price = {
        decimal: d,
        breakEven: breakEvenProbability(d),
        rawImplied: 1 / d,
        evModel: pModel != null ? (pushP > 0 ? expectedNetPointsWithPush(pModel * (1 - pushP), (1 - pModel) * (1 - pushP), pushP, d) : expectedNetPoints(pModel, d)) : null,
        evMarket: pMarket != null ? expectedNetPoints(pMarket, d) : null,
        note: "Hypothetical price entered by you. Expected net points are per 1-point simulation stake and are only as good as the probability used.",
      };
    }
    return {
      baseline: summarize(maskAnalysis(base)),
      scenario: summarize(maskAnalysis(scen)),
      baselinePrediction: base.model.prediction,
      scenarioPrediction: scen.model.prediction,
      recomputed,
      notes,
      price,
      hypothetical: true,
    };
  });

  app.post("/api/events/:id/explain", async (req) => {
    const body = z.object({ dataset: datasetSchema, asOf: isoInstant.optional(), useAi: z.boolean().default(false) }).parse(req.body ?? {});
    const ctx = ctxFrom({ dataset: body.dataset, asOf: body.asOf });
    const a = getAnalysis((req.params as { id: string }).id, ctx);
    const aiResult = body.useAi ? await ai.explain(a) : { source: "deterministic" as const, text: null, note: "Deterministic summary (no AI used)." };
    return { deterministic: a.explanation, sources: a.sources, ai: aiResult };
  });

  app.get("/api/evidence", async (req) => {
    const q = req.query as Record<string, string>;
    const ctx = ctxFrom(q);
    const date = localDateParam(q, ctx.dataset, ctx.asOf);
    const { startUtc, endUtc } = localDayBounds(date, ctx.zone);
    const events = repo.eventsInWindow(ctx.dataset, startUtc, endUtc, ctx.asOf);
    const teamIds = [...new Set(events.flatMap((e) => [e.home_id, e.away_id]))];
    const names = new Map(teamIds.map((id) => [id, repo.participant(id)?.name ?? id]));
    const since = toUtcIso(Date.parse(ctx.asOf) - 7 * 86400000);
    const news = repo.newsAsOf(ctx.dataset, ctx.asOf, { sinceUtc: since, limit: 300 });
    const relevantNews = q.scope === "all" ? news : news.filter((n) => json<string[]>(n.participant_ids, []).some((id) => names.has(id)));
    const injuries = repo.injuriesAsOf(ctx.dataset, teamIds, ctx.asOf);
    const recentInjuryRows = teamIds.length
      ? db.all(
          `SELECT * FROM injuries WHERE dataset = ? AND participant_id IN (${teamIds.map(() => "?").join(",")}) AND retrieved_at <= ? AND retrieved_at >= ? AND status != 'active'`,
          [ctx.dataset, ...teamIds, ctx.asOf, toUtcIso(Date.parse(ctx.asOf) - 72 * 3600000)],
        )
      : [];
    const conflicts = detectConflicts(relevantNews, [...injuries, ...(recentInjuryRows as any[])], ctx.asOf);
    const lineups = events.map((e) => {
      const ls = repo.lineupsAsOf(e.id, ctx.asOf);
      const status = (team: string) => ls.find((l) => l.participant_id === team) ?? null;
      return {
        eventId: e.id,
        start: e.start_time,
        status: e.status,
        home: names.get(e.home_id),
        away: names.get(e.away_id),
        homeLineup: status(e.home_id) ? { status: status(e.home_id)!.status, starter: status(e.home_id)!.starter, source: status(e.home_id)!.source, url: status(e.home_id)!.source_url, retrieved_at: status(e.home_id)!.retrieved_at } : null,
        awayLineup: status(e.away_id) ? { status: status(e.away_id)!.status, starter: status(e.away_id)!.starter, source: status(e.away_id)!.source, url: status(e.away_id)!.source_url, retrieved_at: status(e.away_id)!.retrieved_at } : null,
      };
    });
    // Duplicate grouping for the evidence feed.
    const sortedAsc = [...relevantNews].reverse();
    const dupOf = new Map<number, number>();
    sortedAsc.forEach((n, i) => {
      for (let j = 0; j < i; j++) {
        const m = sortedAsc[j];
        if (dupOf.has(j)) continue;
        const A = new Set(n.dedupe_key.split(" "));
        const B = new Set(m.dedupe_key.split(" "));
        let inter = 0;
        for (const x of A) if (B.has(x)) inter++;
        const jac = inter / (A.size + B.size - inter || 1);
        const close = !n.published_at || !m.published_at || Math.abs(Date.parse(n.published_at) - Date.parse(m.published_at)) < 48 * 3600000;
        if (close && jac >= 0.5) {
          dupOf.set(i, j);
          break;
        }
      }
    });
    const newsOut = sortedAsc
      .map((n, i) => ({
        id: n.id,
        title: n.title,
        url: n.url,
        source: n.source_name,
        tier: n.source_tier,
        claim: n.claim_type,
        published_at: n.published_at,
        retrieved_at: n.retrieved_at,
        teams: json<string[]>(n.participant_ids, []).map((id) => names.get(id) ?? repo.participant(id)?.name ?? id),
        duplicateOf: dupOf.has(i) ? sortedAsc[dupOf.get(i)!].id : null,
      }))
      .reverse();
    return {
      date,
      asOf: ctx.asOf,
      mode: ctx.mode,
      dataset: ctx.dataset,
      news: newsOut,
      injuries: injuries.map((i) => ({ ...i, team: names.get(i.participant_id) ?? i.participant_id })),
      injuriesChecked: [...new Set(events.map((e) => e.sport_key))].map((sp) => ({ sport: sp, checked: repo.injuryFeedSeen(ctx.dataset, sp, ctx.asOf) })),
      conflicts: conflicts.map((c) => ({ ...c, team: names.get(c.teamId) ?? c.teamId })),
      lineups,
      classificationNote: "Claim type (official / report / speculation) is assigned by source tier and a keyword heuristic. It is a reading aid, not verification.",
    };
  });

  // ---------------------------------------------------------------- classroom
  app.get("/api/sessions", async (req) => {
    const dataset = datasetSchema.parse((req.query as Record<string, string>).dataset ?? "demo");
    const active = classroom.ensureDefaultSession(dataset, toUtcIso(now()));
    return { active, sessions: classroom.sessions(dataset), resultsHidden: resultsHidden() };
  });

  app.post("/api/sessions", async (req) => {
    requireInstructor(req);
    const body = z.object({ dataset: datasetSchema, name: z.string().min(1).max(80) }).parse(req.body);
    const id = classroom.restartSession(body.dataset, body.name, toUtcIso(now()));
    log.add("info", "classroom", `New ${body.dataset} session started: ${body.name}`);
    return { id };
  });

  app.post("/api/classroom/results-hidden", async (req) => {
    requireInstructor(req);
    const body = z.object({ hidden: z.boolean() }).parse(req.body);
    settings.update({ classroom: { lockReveal: body.hidden } });
    log.add("info", "classroom", body.hidden ? "Instructor hid results." : "Instructor allowed results to be shown.");
    return { resultsHidden: body.hidden };
  });

  const revealAllowed = (reveal: unknown) => reveal === "1" && !resultsHidden();

  app.get("/api/sessions/:id/forecasts", async (req) => {
    const q = req.query as Record<string, string>;
    const sess = classroom.session((req.params as { id: string }).id);
    if (!sess) throw new HttpProblem(404, "Unknown session");
    const reveal = revealAllowed(q.reveal);
    return {
      session: sess,
      revealed: reveal,
      hiddenByInstructor: resultsHidden(),
      resultsAsOf: clockFor(sess.dataset),
      forecasts: classroom.sessionForecasts(sess.id, clockFor(sess.dataset), reveal),
      scoreboard: reveal ? classroom.scoreboard(sess.id, clockFor(sess.dataset)) : null,
    };
  });

  app.get("/api/sessions/:id/forecasts.csv", async (req, reply) => {
    const sess = classroom.session((req.params as { id: string }).id);
    if (!sess) throw new HttpProblem(404, "Unknown session");
    const reveal = revealAllowed((req.query as Record<string, string>).reveal);
    return sendCsv(reply, `forecasts-${sess.name}.csv`, classroom.csvForecasts(sess.dataset, sess.id, clockFor(sess.dataset), reveal));
  });

  app.get("/api/forecasts.csv", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const dataset = datasetSchema.parse(q.dataset ?? "demo");
    return sendCsv(reply, `all-forecasts-${dataset}.csv`, classroom.csvForecasts(dataset, null, clockFor(dataset), !resultsHidden()));
  });

  app.post("/api/forecasts", async (req) => {
    const body = z
      .object({
        dataset: datasetSchema,
        sessionId: z.string().uuid(),
        eventId: z.string().min(1).max(120),
        asOf: isoInstant.optional(),
        author: z.string().min(1).max(40),
        probs: z.record(z.enum(["home", "away", "draw"]), z.number()),
        notes: z.string().max(500).optional(),
        stake: z.object({ experimentId: z.string().uuid(), outcome: z.enum(["home", "away", "draw"]), points: z.number().positive().max(10) }).optional(),
      })
      .parse(req.body);
    const ctx = ctxFrom({ dataset: body.dataset, asOf: body.asOf });
    const a = getAnalysis(body.eventId, ctx);
    const clock = clockFor(ctx.dataset);
    // Validate a points entry before saving anything, so a refused entry never leaves a half-done request.
    if (body.stake) classroom.checkEntryAllowed(body.stake.experimentId, body.author, a.event.start_time, clock);
    const f = classroom.saveStudentForecast({ dataset: body.dataset, sessionId: body.sessionId, author: body.author, analysis: a, probs: body.probs, createdAt: toUtcIso(now()), clock, notes: body.notes });
    let entryId: string | null = null;
    if (body.stake) entryId = classroom.addEntry(body.stake.experimentId, f.id, body.stake.outcome, body.stake.points, toUtcIso(now()), clock);
    return { forecast: { id: f.id, created_at: f.created_at, info_as_of: f.info_as_of, pick: f.pick, quoted_price: f.quoted_price }, entryId };
  });

  app.get("/api/sessions/:id/experiments", async (req) => ({ experiments: classroom.experiments((req.params as { id: string }).id) }));

  app.post("/api/experiments", async (req) => {
    const body = z.object({ dataset: datasetSchema, sessionId: z.string().uuid(), name: z.string().min(1).max(80), author: z.string().min(1).max(40) }).parse(req.body);
    return { id: classroom.createExperiment(body.dataset, body.sessionId, body.name, body.author, toUtcIso(now())) };
  });

  app.post("/api/experiments/:id/entries", async (req) => {
    const body = z.object({ forecastId: z.string().uuid(), outcome: z.enum(["home", "away", "draw"]), stake: z.number().positive().max(10) }).parse(req.body);
    const id = (req.params as { id: string }).id;
    const exp = db.get<{ dataset: Dataset }>("SELECT dataset FROM experiments WHERE id = ?", [id]);
    if (!exp) throw new HttpProblem(404, "Unknown experiment");
    return { id: classroom.addEntry(id, body.forecastId, body.outcome, body.stake, toUtcIso(now()), clockFor(exp.dataset)) };
  });

  app.get("/api/experiments/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    const exp = db.get<{ dataset: Dataset }>("SELECT dataset FROM experiments WHERE id = ?", [id]);
    if (!exp) throw new HttpProblem(404, "Unknown experiment");
    const reveal = revealAllowed((req.query as Record<string, string>).reveal);
    return { ...classroom.experimentReport(id, clockFor(exp.dataset), reveal), revealed: reveal, hiddenByInstructor: resultsHidden() };
  });

  app.get("/api/experiments/:id/csv", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const exp = db.get<{ dataset: Dataset; name: string }>("SELECT dataset, name FROM experiments WHERE id = ?", [id]);
    if (!exp) throw new HttpProblem(404, "Unknown experiment");
    const reveal = revealAllowed((req.query as Record<string, string>).reveal);
    const r = classroom.experimentReport(id, clockFor(exp.dataset), reveal);
    const header = ["entry_id", "game", "event_start", "outcome", "stake_points", "price_decimal", "book", "created_at", "settlement", "net_points"];
    const lines = [header.join(","), ...r.entries.map((e) => [e.id, e.game, e.start, e.outcome, e.stake, e.price_decimal, e.book, e.created_at, e.settlement ?? (reveal ? "" : "hidden"), e.points ?? ""].map(csvCell).join(","))];
    return sendCsv(reply, `experiment-${exp.name}.csv`, lines.join("\r\n") + "\r\n");
  });

  // ---------------------------------------------------------------- value finder & average lines
  app.get("/api/value", async (req) => {
    const q = req.query as Record<string, string>;
    const ctx = ctxFrom(q);
    const date = localDateParam(q, ctx.dataset, ctx.asOf);
    const board = cachedBoard(ctx, date);
    return { date, zone: ctx.zone, asOf: ctx.asOf, mode: ctx.mode, dataset: ctx.dataset, ...valueFinder(board.analyses) };
  });

  app.get("/api/value/backtest", async (req) => {
    const q = req.query as Record<string, string>;
    const ctx = ctxFrom(q);
    const sports = evaluator.sports(ctx.dataset);
    return { asOf: ctx.asOf, mode: ctx.mode, dataset: ctx.dataset, ...backtester.run(ctx.dataset, ctx.asOf, sports) };
  });

  app.get("/api/average-lines", async (req) => {
    const q = req.query as Record<string, string>;
    const ctx = ctxFrom(q);
    const date = localDateParam(q, ctx.dataset, ctx.asOf);
    const board = cachedBoard(ctx, date);
    return { date, zone: ctx.zone, asOf: ctx.asOf, mode: ctx.mode, dataset: ctx.dataset, ...averageLines(board.analyses) };
  });

  // ---------------------------------------------------------------- replay & demo clock
  app.get("/api/replay/range", async (req) => {
    const dataset = datasetSchema.parse((req.query as Record<string, string>).dataset ?? "demo");
    const clock = clockFor(dataset);
    const r = db.get<{ lo: string | null; hi: string | null }>("SELECT MIN(start_time) lo, MAX(start_time) hi FROM events WHERE dataset = ? AND start_time <= ?", [dataset, clock]);
    const q = db.get<{ lo: string | null }>("SELECT MIN(known_at) lo FROM quotes WHERE dataset = ?", [dataset]);
    return { dataset, clock, earliestEvent: r?.lo ?? null, latestEvent: r?.hi ?? null, earliestQuote: q?.lo ?? null };
  });

  app.post("/api/demo/clock", async (req) => {
    requireInstructor(req);
    const body = z.object({ action: z.enum(["advance_day", "back_day", "reset", "set"]), to: isoInstant.optional() }).parse(req.body);
    const cur = settings.get().demo.now;
    let next = cur;
    if (body.action === "advance_day") next = toUtcIso(new Date(Date.parse(cur) + 86400000));
    if (body.action === "back_day") next = toUtcIso(new Date(Date.parse(cur) - 86400000));
    if (body.action === "reset") next = DEMO_START;
    if (body.action === "set") {
      if (!body.to) throw new HttpProblem(400, "Provide a time to set.");
      next = toUtcIso(body.to);
    }
    if (next < "2024-03-01T00:00:00Z" || next > "2026-12-31T00:00:00Z") throw new HttpProblem(400, "The demo world covers 2024–2026 only.");
    settings.setDemoNow(next);
    log.add("info", "demo", `Demo clock ${body.action}: ${cur} → ${next}`);
    return { demoClock: settings.get().demo.now };
  });

  // ---------------------------------------------------------------- model report
  app.get("/api/report", async (req) => {
    const q = req.query as Record<string, string>;
    const ctx = ctxFrom(q);
    const sports = evaluator.sports(ctx.dataset);
    const sport = typeof q.sport === "string" && sports.includes(q.sport) ? q.sport : sports[0];
    if (!sport) return { sports, report: null, forward: evaluator.forwardRecord(ctx.dataset, clockFor(ctx.dataset)) };
    return { sports, sport, report: evaluator.report(ctx.dataset, sport, ctx.asOf), forward: evaluator.forwardRecord(ctx.dataset, clockFor(ctx.dataset)), asOf: ctx.asOf, mode: ctx.mode };
  });

  // ---------------------------------------------------------------- scheduler & activity
  app.get("/api/scheduler", async () => scheduler.summary());
  app.post("/api/scheduler/pause", async (req) => {
    requireInstructor(req);
    settings.update({ scheduler: { paused: true } });
    log.add("info", "scheduler", "Scheduler paused.");
    return scheduler.summary();
  });
  app.post("/api/scheduler/resume", async (req) => {
    requireInstructor(req);
    settings.update({ scheduler: { paused: false } });
    scheduler.recomputeAll();
    log.add("info", "scheduler", "Scheduler resumed.");
    return scheduler.summary();
  });
  app.post("/api/scheduler/run/:job", async (req) => {
    requireInstructor(req);
    const job = z.enum(["daily_scan", "odds_refresh", "results_refresh", "news_refresh"]).parse((req.params as { job: string }).job) as JobName;
    const r = await scheduler.run(job, "manual");
    return { ...r, summary: scheduler.summary() };
  });
  app.get("/api/activity", async (req) => {
    const q = req.query as Record<string, string>;
    return { entries: log.list(Number(q.limit ?? 200) || 200, typeof q.category === "string" && q.category ? q.category.slice(0, 40) : undefined) };
  });

  // ---------------------------------------------------------------- static client
  if (existsSync(cfg.staticDir)) {
    await app.register(fastifyStatic, { root: cfg.staticDir, prefix: "/", index: ["index.html"], wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.type("text/html").sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.type("text/plain").send("Client not built. Run `npm run build` (or use `npm start`).");
    });
  }

  app.addHook("onClose", async () => {
    scheduler.stop();
    db.close();
  });

  /** Fit models and build today's demo board once, so the first page load is fast. */
  function warmup(): void {
    try {
      const ctx = ctxFrom({ dataset: "demo" });
      cachedBoard(ctx, localDateOf(ctx.asOf, ctx.zone));
    } catch (e) {
      log.add("warn", "server", `Warm-up skipped: ${(e as Error).message}`);
    }
  }

  return { app, db, repo, settings, log, http, models, classroom, evaluator, ingest, scheduler, ai, warmup };
}

export type { EventRecord };
