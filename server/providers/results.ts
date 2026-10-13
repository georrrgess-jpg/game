// Results and schedules for the model's training history, beyond MLB:
//   - nflverse (NFL): public games.csv with schedules, final scores and closing lines. No key.
//     https://github.com/nflverse/nfldata (data/games.csv). Licence: CC-BY 4.0 per the nflverse project;
//     check the repository before redistributing.
//   - balldontlie (NBA): /v1/games with an API key in the Authorization header (free tier, rate-limited).
//     https://docs.balldontlie.io
//   - CSV import: results you download yourself, e.g. tennis-data.co.uk season files saved as CSV,
//     or a simple generic format (date, home, away, home_score, away_score).
// Every imported game is matched to an existing event (same teams, close start time) before a new
// one is created, so odds already attached to that event stay attached.

import { z } from "zod";
import { DateTime } from "luxon";
import { contractId, modelKeyFor, seasonOf, sportFamily, tennisSurfaceFromName, type ContractKey, type OutcomeKey } from "../../shared/contracts";
import { americanToDecimal, parseAmerican, parseDecimal } from "../../shared/odds";
import type { EventRecord, QuoteRecord, Repo } from "../repo";
import { normalizeAlias } from "../repo";
import { HttpError } from "../http";
import { iso, ProviderError, recordUsage, setObserved, type ProviderCapabilities, type ProviderDeps } from "./common";

// ---------------------------------------------------------------- CSV
/** RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). Returns rows of string cells. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === "") quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

/** CSV rows as objects keyed by trimmed header names. */
export function csvRecords(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

// ---------------------------------------------------------------- shared game upsert
export interface ImportedGame {
  sportKey: string;
  league: string;
  source: string;
  idHint: string;
  home: { name: string; abbreviation?: string | null; aliases?: string[] };
  away: { name: string; abbreviation?: string | null; aliases?: string[] };
  start: string;
  /** True when only the date is known (start set to noon UTC). Widens matching. */
  approximateTime?: boolean;
  status: "scheduled" | "final" | "postponed" | "cancelled";
  homeScore: number | null;
  awayScore: number | null;
  neutral?: boolean;
  indoor?: boolean;
  extra?: Record<string, unknown>;
  /**
   * The pairing depends on earlier results (tennis draws, playoffs): the game is only known once both
   * sides' previous games have finished, never a week ahead.
   */
  knockout?: boolean;
  /** Closing prices from the source, stored as quotes 60 minutes before the start (finals only). */
  closing?: { bookKey: string; bookTitle: string; contract: ContractKey; line: number | null; prices: Partial<Record<OutcomeKey, number | null>> }[];
}

const slug = (s: string) => normalizeAlias(s).replace(/ /g, "-").slice(0, 60);

/** "Novak Djokovic" -> "Djokovic N." so it matches the "Last F." style used by many tennis result files. */
export function tennisShortAlias(name: string): string | null {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2 || /^[A-Z]\.?$/.test(parts[parts.length - 1]) || /\.$/.test(name.trim())) return null; // already "Last F."
  return `${parts.slice(1).join(" ")} ${parts[0][0]}.`;
}

export class GameImporter {
  constructor(private repo: Repo) {}

  participant(sportKey: string, p: ImportedGame["home"], source: string): string {
    const short = sportFamily(sportKey) === "tennis" ? tennisShortAlias(p.name) : null;
    const existing =
      this.repo.resolveParticipant("live", sportKey, p.name) ??
      (p.abbreviation ? this.repo.resolveParticipant("live", sportKey, p.abbreviation) : null) ??
      (short ? this.repo.resolveParticipant("live", sportKey, short) : null);
    const id = existing ?? `${source}:${sportKey}:${slug(p.name)}`;
    const prev = this.repo.participant(id);
    const aliases = new Set([...(prev?.aliases ?? []), ...(p.aliases ?? [])]);
    if (short) aliases.add(short);
    this.repo.upsertParticipant({
      id,
      dataset: "live",
      sport_key: sportKey,
      name: prev?.name ?? p.name,
      short_name: prev?.short_name ?? null,
      abbreviation: prev?.abbreviation ?? p.abbreviation ?? null,
      aliases: [...aliases].filter((a) => a !== (prev?.name ?? p.name)),
      meta: { ...(prev?.meta ?? {}), source: (prev?.meta as Record<string, unknown> | undefined)?.source ?? source },
    });
    return id;
  }

  /** Existing event for the same pairing near this start time (either order for individual sports). */
  findEvent(sportKey: string, homeId: string, awayId: string, start: string, windowMinutes: number): EventRecord | null {
    const lo = iso(new Date(Date.parse(start) - windowMinutes * 60000));
    const hi = iso(new Date(Date.parse(start) + windowMinutes * 60000));
    const swap = sportFamily(sportKey) === "tennis";
    const rows = this.repo.db.all<EventRecord>(
      `SELECT * FROM events WHERE dataset = 'live' AND sport_key = ? AND start_time >= ? AND start_time <= ?
         AND ((home_id = ? AND away_id = ?)${swap ? " OR (home_id = ? AND away_id = ?)" : ""})`,
      swap ? [sportKey, lo, hi, homeId, awayId, awayId, homeId] : [sportKey, lo, hi, homeId, awayId],
    );
    rows.sort((a, b) => Math.abs(Date.parse(a.start_time) - Date.parse(start)) - Math.abs(Date.parse(b.start_time) - Date.parse(start)));
    return rows[0] ?? null;
  }

  /** Information time for a past game created by an import (see `knockout`). Imports must run in date order. */
  pastKnownAt(sportKey: string, homeId: string, awayId: string, start: string, knockout: boolean): string {
    const weekBefore = iso(new Date(Date.parse(start) - 7 * 86400000));
    if (!knockout) return weekBefore;
    const prev = this.repo.db.get<{ f: string | null }>(
      `SELECT MAX(final_at) f FROM events WHERE dataset = 'live' AND sport_key = ? AND status = 'final' AND start_time < ? AND start_time >= ?
         AND (home_id IN (?, ?) OR away_id IN (?, ?))`,
      [sportKey, start, weekBefore, homeId, awayId, homeId, awayId],
    );
    // Known when the later previous game ended, but never after the start itself.
    const t = prev?.f && prev.f > weekBefore ? prev.f : weekBefore;
    return t < start ? t : start;
  }

  upsert(g: ImportedGame, retrievedAt: string): { id: string; created: boolean; quotes: number } {
    const sportKey = modelKeyFor(g.sportKey);
    let homeId = this.participant(sportKey, g.home, g.source);
    let awayId = this.participant(sportKey, g.away, g.source);
    let homeScore = g.homeScore;
    let awayScore = g.awayScore;
    const found = this.findEvent(sportKey, homeId, awayId, g.start, g.approximateTime ? 18 * 60 : 150);
    let closing = g.closing ?? [];
    if (found && found.home_id === awayId) {
      // Individual sport listed in the other order by the existing event: keep the existing orientation.
      [homeId, awayId] = [awayId, homeId];
      [homeScore, awayScore] = [awayScore, homeScore];
      closing = closing.map((c) => ({ ...c, prices: { home: c.prices.away, away: c.prices.home } }));
    }
    const id = found?.id ?? `${g.source}:${g.idHint}`;
    const start = found && g.approximateTime ? found.start_time : g.start;
    const isFinal = g.status === "final" && homeScore != null && awayScore != null;
    // Results become known when the game ends; we do not know the exact end, so use a conservative estimate.
    const finalAt = isFinal ? (found?.final_at ?? iso(new Date(Date.parse(start) + 4 * 3600000))) : null;
    const prevExtra = found ? (JSON.parse(found.extra || "{}") as Record<string, unknown>) : {};
    this.repo.upsertEvent({
      id,
      dataset: "live",
      sport_key: sportKey,
      league: found?.league ?? g.league,
      season: seasonOf(sportKey, start),
      home_id: homeId,
      away_id: awayId,
      start_time: start,
      status: isFinal ? "final" : g.status === "final" ? (found?.status ?? "scheduled") : g.status,
      status_at: isFinal ? finalAt : (found?.status_at ?? retrievedAt),
      final_at: finalAt,
      home_score: isFinal ? homeScore : (found?.home_score ?? null),
      away_score: isFinal ? awayScore : (found?.away_score ?? null),
      regulation_home: found?.regulation_home ?? null,
      regulation_away: found?.regulation_away ?? null,
      final_is_regulation: found?.final_is_regulation ?? 0,
      neutral_site: g.neutral ? 1 : (found?.neutral_site ?? 0),
      venue_name: found?.venue_name ?? null,
      venue_lat: found?.venue_lat ?? null,
      venue_lon: found?.venue_lon ?? null,
      venue_tz: found?.venue_tz ?? null,
      indoor: g.indoor ? 1 : (found?.indoor ?? 0),
      rescheduled_from: found?.rescheduled_from ?? null,
      game_number: found?.game_number ?? 1,
      source: found?.source ?? g.source,
      source_updated_at: retrievedAt,
      retrieved_at: retrievedAt,
      // Upcoming games are known from now on. For past games assume the schedule was public a week ahead,
      // except knockout pairings, which exist only once both sides' previous games have finished.
      known_at: found ? found.known_at : start > retrievedAt ? retrievedAt : this.pastKnownAt(sportKey, homeId, awayId, start, !!g.knockout),
      extra: { ...prevExtra, ...(g.extra ?? {}), importedFrom: g.source },
    });
    let quotes = 0;
    if (isFinal && closing.length) {
      const t = iso(new Date(Date.parse(start) - 60 * 60000));
      const rows: QuoteRecord[] = [];
      for (const c of closing) {
        const outcomes = Object.entries(c.prices).filter(([, d]) => d != null && d > 1) as [OutcomeKey, number][];
        if (outcomes.length < 2) continue;
        for (const [o, d] of outcomes) {
          rows.push({
            dataset: "live", event_id: id, provider: g.source, book_key: c.bookKey, book_title: c.bookTitle, contract: c.contract, contract_id: contractId(c.contract, c.line),
            provider_market: `${g.source} closing`, line: c.line, outcome: o, price_decimal: d, source_time: t, retrieved_at: retrievedAt, known_at: t,
          });
        }
      }
      quotes = this.repo.insertQuotes(rows);
    }
    return { id, created: !found, quotes };
  }
}

// ---------------------------------------------------------------- NFL teams
/** nflverse abbreviation -> current franchise name (relocations map to the current franchise). */
export const NFL_TEAMS: Record<string, { name: string; aliases: string[] }> = {
  ARI: { name: "Arizona Cardinals", aliases: ["Cardinals"] },
  ATL: { name: "Atlanta Falcons", aliases: ["Falcons"] },
  BAL: { name: "Baltimore Ravens", aliases: ["Ravens"] },
  BUF: { name: "Buffalo Bills", aliases: ["Bills"] },
  CAR: { name: "Carolina Panthers", aliases: ["Panthers"] },
  CHI: { name: "Chicago Bears", aliases: ["Bears"] },
  CIN: { name: "Cincinnati Bengals", aliases: ["Bengals"] },
  CLE: { name: "Cleveland Browns", aliases: ["Browns"] },
  DAL: { name: "Dallas Cowboys", aliases: ["Cowboys"] },
  DEN: { name: "Denver Broncos", aliases: ["Broncos"] },
  DET: { name: "Detroit Lions", aliases: ["Lions"] },
  GB: { name: "Green Bay Packers", aliases: ["Packers"] },
  HOU: { name: "Houston Texans", aliases: ["Texans"] },
  IND: { name: "Indianapolis Colts", aliases: ["Colts"] },
  JAX: { name: "Jacksonville Jaguars", aliases: ["Jaguars"] },
  KC: { name: "Kansas City Chiefs", aliases: ["Chiefs"] },
  LA: { name: "Los Angeles Rams", aliases: ["Rams", "LA Rams", "St. Louis Rams", "STL"] },
  LAC: { name: "Los Angeles Chargers", aliases: ["Chargers", "LA Chargers", "San Diego Chargers", "SD"] },
  LV: { name: "Las Vegas Raiders", aliases: ["Raiders", "Oakland Raiders", "OAK"] },
  MIA: { name: "Miami Dolphins", aliases: ["Dolphins"] },
  MIN: { name: "Minnesota Vikings", aliases: ["Vikings"] },
  NE: { name: "New England Patriots", aliases: ["Patriots"] },
  NO: { name: "New Orleans Saints", aliases: ["Saints"] },
  NYG: { name: "New York Giants", aliases: ["Giants"] },
  NYJ: { name: "New York Jets", aliases: ["Jets"] },
  PHI: { name: "Philadelphia Eagles", aliases: ["Eagles"] },
  PIT: { name: "Pittsburgh Steelers", aliases: ["Steelers"] },
  SEA: { name: "Seattle Seahawks", aliases: ["Seahawks"] },
  SF: { name: "San Francisco 49ers", aliases: ["49ers"] },
  TB: { name: "Tampa Bay Buccaneers", aliases: ["Buccaneers"] },
  TEN: { name: "Tennessee Titans", aliases: ["Titans"] },
  WAS: { name: "Washington Commanders", aliases: ["Commanders", "Washington Football Team", "Washington Redskins", "Washington"] },
};
const NFL_RELOCATED: Record<string, string> = { OAK: "LV", SD: "LAC", STL: "LA" };

const num = (s: string | undefined) => (s != null && s !== "" && s !== "NA" && Number.isFinite(Number(s)) ? Number(s) : null);
const americanOrNull = (s: string | undefined) => {
  const n = num(s);
  if (n == null) return null;
  const p = parseAmerican(n);
  return p.ok ? americanToDecimal(p.value) : null;
};

export const NFLVERSE_HOST = "raw.githubusercontent.com";
export const NFLVERSE_URL = `https://${NFLVERSE_HOST}/nflverse/nfldata/master/data/games.csv`;

export const NFLVERSE_CAPABILITIES: ProviderCapabilities = {
  id: "nflverse",
  name: "nflverse (NFL schedules, results, closing lines)",
  roles: ["NFL schedule and final scores", "Closing moneyline, spread and total (for evaluation)"],
  docsUrl: "https://github.com/nflverse/nfldata",
  requiresKey: false,
  keyEnvVar: null,
  licensing: "Community-maintained open data (nflverse). Check the repository's licence and attribution requirements before redistributing.",
  coverage: ["NFL regular season and playoffs since 1999.", "Closing lines as recorded by nflverse (one consensus price per market)."],
  history: "Every season since 1999 in one file; this app imports the seasons you choose.",
  costNotes: "Free, no key. One file download (cached for 12 hours).",
  limitations: [
    "Kick-off times are local Eastern times converted to UTC; international games are matched by date and teams.",
    "Closing lines are stored 60 minutes before kick-off so they can serve as the market reference in evaluations; that is slightly optimistic for the market.",
    "Not live-verified in the build environment (network blocked); covered by recorded-response tests.",
  ],
};

export class NflverseProvider {
  readonly id = "nflverse";
  private importer: GameImporter;
  constructor(private deps: ProviderDeps) {
    this.importer = new GameImporter(deps.repo);
  }

  async fetchCsv(): Promise<string> {
    if (!this.deps.settings().providers.nflverse.enabled) throw new ProviderError("nflverse is disabled in Settings.", "disabled");
    let res;
    try {
      res = await this.deps.http.get(this.id, NFLVERSE_URL, { allowedHosts: [NFLVERSE_HOST], cacheTtlSec: 12 * 3600, maxBytes: 30_000_000, timeoutMs: 60_000 });
    } catch (e) {
      throw new ProviderError(`Could not download nflverse games.csv: ${(e as Error).message}`, e instanceof HttpError ? "http" : "network");
    }
    if (!res.fromCache) recordUsage(this.deps, this.id, 0);
    if (res.status !== 200) throw new ProviderError(`nflverse returned HTTP ${res.status}.`, "http");
    return res.body;
  }

  /** Import the given seasons (start years) from games.csv. */
  async importSeasons(seasons: number[]): Promise<{ games: number; created: number; quotes: number; seasons: number[] }> {
    const body = await this.fetchCsv();
    return this.ingest(body, seasons, iso(this.deps.now()));
  }

  ingest(csv: string, seasons: number[], retrievedAt: string): { games: number; created: number; quotes: number; seasons: number[] } {
    const recs = csvRecords(csv);
    if (!recs.length || !("home_team" in recs[0]) || !("gameday" in recs[0])) throw new ProviderError("games.csv does not have the expected columns (home_team, gameday, ...).", "bad_response");
    const want = new Set(seasons.map(String));
    let games = 0;
    let created = 0;
    let quotes = 0;
    this.deps.db.tx(() => {
      const ordered = [...recs].sort((x, y) => `${x.gameday} ${x.gametime}`.localeCompare(`${y.gameday} ${y.gametime}`));
      for (const r of ordered) {
        if (!want.has(r.season)) continue;
        const h = NFL_TEAMS[NFL_RELOCATED[r.home_team] ?? r.home_team];
        const a = NFL_TEAMS[NFL_RELOCATED[r.away_team] ?? r.away_team];
        if (!h || !a || !/^\d{4}-\d{2}-\d{2}$/.test(r.gameday)) continue;
        const time = /^\d{1,2}:\d{2}$/.test(r.gametime) ? r.gametime.padStart(5, "0") : "13:00";
        const start = DateTime.fromISO(`${r.gameday}T${time}`, { zone: "America/New_York" }).toUTC().toISO({ suppressMilliseconds: true });
        if (!start) continue;
        const hs = num(r.home_score);
        const as = num(r.away_score);
        const final = hs != null && as != null;
        const spread = num(r.spread_line); // positive = home favoured
        const total = num(r.total_line);
        const closing: ImportedGame["closing"] = [];
        const ml = { home: americanOrNull(r.home_moneyline), away: americanOrNull(r.away_moneyline) };
        if (ml.home && ml.away) closing.push({ bookKey: "nflverse_close", bookTitle: "Closing line (nflverse)", contract: "moneyline_2way_full_game", line: null, prices: ml });
        const so = { home: americanOrNull(r.home_spread_odds), away: americanOrNull(r.away_spread_odds) };
        if (spread != null && so.home && so.away) closing.push({ bookKey: "nflverse_close", bookTitle: "Closing line (nflverse)", contract: "spread_full_game", line: -spread, prices: so });
        const to = { over: americanOrNull(r.over_odds), under: americanOrNull(r.under_odds) };
        if (total != null && to.over && to.under) closing.push({ bookKey: "nflverse_close", bookTitle: "Closing line (nflverse)", contract: "total_full_game", line: total, prices: to });
        const hk = NFL_RELOCATED[r.home_team] ?? r.home_team;
        const ak = NFL_RELOCATED[r.away_team] ?? r.away_team;
        const out = this.importer.upsert(
          {
            sportKey: "americanfootball_nfl",
            league: "NFL",
            source: "nflverse",
            idHint: r.game_id || `${r.season}-${r.gameday}-${ak}-${hk}`,
            home: { name: h.name, abbreviation: hk, aliases: [...h.aliases, r.home_team] },
            away: { name: a.name, abbreviation: ak, aliases: [...a.aliases, r.away_team] },
            start,
            status: final ? "final" : "scheduled",
            homeScore: hs,
            awayScore: as,
            neutral: r.location === "Neutral",
            indoor: r.roof === "dome" || r.roof === "closed",
            extra: { week: num(r.week), gameType: r.game_type || null, overtime: r.overtime === "1" },
            knockout: !!r.game_type && r.game_type !== "REG",
            closing,
          },
          retrievedAt,
        );
        games++;
        if (out.created) created++;
        quotes += out.quotes;
      }
    });
    setObserved(this.deps.db, this.id, { lastImport: retrievedAt, seasonsImported: seasons });
    this.deps.log.add("info", this.id, `nflverse import: ${games} games (${created} new), ${quotes} closing quotes, seasons ${seasons.join(", ")}.`);
    return { games, created, quotes, seasons };
  }
}

// ---------------------------------------------------------------- NBA (balldontlie)
export const BALLDONTLIE_HOST = "api.balldontlie.io";
const bdlTeam = z.object({ id: z.number(), abbreviation: z.string(), full_name: z.string(), city: z.string().optional(), name: z.string().optional() }).passthrough();
export const bdlGameSchema = z
  .object({
    id: z.number(),
    date: z.string(),
    datetime: z.string().nullable().optional(),
    season: z.number(),
    status: z.string(),
    postseason: z.boolean().optional(),
    home_team: bdlTeam,
    visitor_team: bdlTeam,
    home_team_score: z.number().nullable().optional(),
    visitor_team_score: z.number().nullable().optional(),
  })
  .passthrough();
const bdlPageSchema = z.object({ data: z.array(z.unknown()), meta: z.object({ next_cursor: z.number().nullable().optional() }).passthrough().optional() });

export const BALLDONTLIE_CAPABILITIES: ProviderCapabilities = {
  id: "balldontlie",
  name: "balldontlie (NBA schedules and results)",
  roles: ["NBA schedule and final scores (model history)"],
  docsUrl: "https://docs.balldontlie.io",
  requiresKey: true,
  keyEnvVar: "BALLDONTLIE_API_KEY",
  licensing: "Commercial API with a free tier; use is governed by balldontlie's terms.",
  coverage: ["NBA regular season and playoffs; the free tier is rate-limited (about 5 requests per minute)."],
  history: "Past seasons are available; importing a full season takes about 15 requests.",
  costNotes: "Free tier: requests are spaced out automatically to respect the rate limit, so a season import takes a few minutes.",
  limitations: ["Not live-verified in the build environment (network blocked); covered by recorded-response tests."],
};

/** Odds feeds sometimes use a shorter name; register both. */
const NBA_EXTRA_ALIASES: Record<string, string[]> = { LAC: ["LA Clippers", "Los Angeles Clippers"], LAL: ["LA Lakers", "Los Angeles Lakers"] };

export class BalldontlieProvider {
  readonly id = "balldontlie";
  private importer: GameImporter;
  constructor(
    private deps: ProviderDeps,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.importer = new GameImporter(deps.repo);
  }

  private key(): string {
    const k = this.deps.config.balldontlieApiKey;
    if (!k) throw new ProviderError("BALLDONTLIE_API_KEY is not set in the server .env file.", "not_configured");
    return k;
  }

  private async page(params: URLSearchParams, cacheTtlSec: number): Promise<{ games: z.infer<typeof bdlGameSchema>[]; next: number | null; fromCache: boolean }> {
    const s = this.deps.settings().providers.balldontlie;
    if (!s.enabled) throw new ProviderError("balldontlie is disabled in Settings.", "disabled");
    const url = `https://${BALLDONTLIE_HOST}/v1/games?${params.toString()}`;
    const key = this.key();
    let res;
    try {
      res = await this.deps.http.get(this.id, url, { allowedHosts: [BALLDONTLIE_HOST], headers: { Authorization: key }, cacheTtlSec, timeoutMs: 30_000 });
    } catch (e) {
      throw new ProviderError(`Network error contacting balldontlie: ${(e as Error).message}`, "network");
    }
    if (!res.fromCache) recordUsage(this.deps, this.id, 1);
    if (res.status === 401) throw new ProviderError("balldontlie rejected the API key (HTTP 401). Check BALLDONTLIE_API_KEY.", "auth");
    if (res.status === 429) throw new ProviderError("balldontlie rate limit reached (HTTP 429). Try again in a minute.", "quota");
    if (res.status !== 200) throw new ProviderError(`balldontlie returned HTTP ${res.status}.`, "http");
    let body: unknown;
    try {
      body = JSON.parse(res.body);
    } catch {
      throw new ProviderError("balldontlie returned a response that is not JSON.", "bad_response");
    }
    const p = bdlPageSchema.safeParse(body);
    if (!p.success) throw new ProviderError("Unexpected balldontlie response shape.", "bad_response");
    const games = p.data.data.map((g) => bdlGameSchema.safeParse(g)).filter((x) => x.success).map((x) => x.data!);
    return { games, next: p.data.meta?.next_cursor ?? null, fromCache: !!res.fromCache };
  }

  private async fetchAll(base: URLSearchParams, cacheTtlSec: number, maxPages = 40): Promise<z.infer<typeof bdlGameSchema>[]> {
    const out: z.infer<typeof bdlGameSchema>[] = [];
    let cursor: number | null = null;
    const gapMs = Math.ceil(60000 / Math.max(1, this.deps.settings().providers.balldontlie.requestsPerMinute));
    for (let i = 0; i < maxPages; i++) {
      const params = new URLSearchParams(base);
      params.set("per_page", "100");
      if (cursor != null) params.set("cursor", String(cursor));
      const r = await this.page(params, cacheTtlSec);
      out.push(...r.games);
      if (r.next == null) break;
      cursor = r.next;
      if (!r.fromCache) await this.sleep(gapMs);
    }
    return out;
  }

  ingest(games: z.infer<typeof bdlGameSchema>[], retrievedAt: string): { games: number; created: number } {
    let n = 0;
    let created = 0;
    const ordered = [...games].sort((x, y) => (x.datetime ?? x.date).localeCompare(y.datetime ?? y.date));
    this.deps.db.tx(() => {
      for (const g of ordered) {
        const start = g.datetime && !Number.isNaN(Date.parse(g.datetime)) ? iso(new Date(g.datetime)) : null;
        const dateOnly = /^\d{4}-\d{2}-\d{2}/.test(g.date) ? g.date.slice(0, 10) : null;
        if (!start && !dateOnly) continue;
        const final = /^final/i.test(g.status) && g.home_team_score != null && g.visitor_team_score != null && (g.home_team_score > 0 || g.visitor_team_score > 0);
        const r = this.importer.upsert(
          {
            sportKey: "basketball_nba",
            league: "NBA",
            source: "balldontlie",
            idHint: String(g.id),
            home: { name: g.home_team.full_name, abbreviation: g.home_team.abbreviation, aliases: NBA_EXTRA_ALIASES[g.home_team.abbreviation] ?? [] },
            away: { name: g.visitor_team.full_name, abbreviation: g.visitor_team.abbreviation, aliases: NBA_EXTRA_ALIASES[g.visitor_team.abbreviation] ?? [] },
            start: start ?? `${dateOnly}T23:00:00Z`,
            approximateTime: !start,
            status: final ? "final" : "scheduled",
            homeScore: final ? g.home_team_score! : null,
            awayScore: final ? g.visitor_team_score! : null,
            indoor: true,
            extra: { postseason: !!g.postseason },
            knockout: !!g.postseason,
          },
          retrievedAt,
        );
        n++;
        if (r.created) created++;
      }
    });
    return { games: n, created };
  }

  /** Import whole seasons (start years). Completed seasons are cached for a week. */
  async importSeasons(seasons: number[], currentSeason: number): Promise<{ games: number; created: number; seasons: number[] }> {
    let games = 0;
    let created = 0;
    for (const season of seasons) {
      const list = await this.fetchAll(new URLSearchParams([["seasons[]", String(season)]]), season < currentSeason ? 7 * 86400 : 3600);
      const r = this.ingest(list, iso(this.deps.now()));
      games += r.games;
      created += r.created;
    }
    setObserved(this.deps.db, this.id, { lastImport: iso(this.deps.now()), seasonsImported: seasons });
    this.deps.log.add("info", this.id, `balldontlie import: ${games} games (${created} new), seasons ${seasons.join(", ")}.`);
    return { games, created, seasons };
  }

  /** Schedule and results for a short date range (daily refresh). */
  async refreshRange(fromDate: string, toDate: string): Promise<{ games: number }> {
    const list = await this.fetchAll(new URLSearchParams([["start_date", fromDate], ["end_date", toDate]]), 300, 5);
    return { games: this.ingest(list, iso(this.deps.now())).games };
  }
}

// ---------------------------------------------------------------- CSV import
export type CsvPreset = "tennis-data" | "generic";

const parseDayMonthYear = (s: string): string | null => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s.trim());
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? s.trim() : null;
};

/** Generic files: ISO dates (YYYY-MM-DD) or full ISO timestamps only, never ambiguous 01/07/2024. */
const isoDate = (s: string | undefined): string | null => {
  const t = (s ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return Number.isNaN(Date.parse(`${t}T00:00:00Z`)) ? null : t;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(t) && !Number.isNaN(Date.parse(t))) return iso(new Date(t));
  return null;
};

const decimalOrNull = (s: string | undefined) => {
  if (!s) return null;
  const d = parseDecimal(s);
  return d.ok ? d.value : null;
};

export interface CsvImportResult {
  rows: number;
  imported: number;
  created: number;
  quotes: number;
  skipped: { row: number; reason: string }[];
}

/** Import results from a CSV the user downloaded. Never fetches anything. */
export function importResultsCsv(repo: Repo, sportKey: string, csv: string, preset: CsvPreset, retrievedAt: string): CsvImportResult {
  const recs = csvRecords(csv);
  const importer = new GameImporter(repo);
  const out: CsvImportResult = { rows: recs.length, imported: 0, created: 0, quotes: 0, skipped: [] };
  const skip = (row: number, reason: string) => {
    if (out.skipped.length < 50) out.skipped.push({ row, reason });
  };
  if (!recs.length) return out;
  const cols = Object.keys(recs[0]);
  const need = preset === "tennis-data" ? ["Date", "Winner", "Loser"] : ["date", "home", "away", "home_score", "away_score"];
  const missing = need.filter((c) => !cols.includes(c));
  if (missing.length) throw new ProviderError(`The file is missing column(s): ${missing.join(", ")}. Expected ${preset === "tennis-data" ? "a tennis-data.co.uk results file saved as CSV" : "date, home, away, home_score, away_score"}.`, "bad_response");
  // Import in date order so knockout rounds see their earlier rounds (row numbers still refer to the file).
  const dateKey = (r: Record<string, string>) => (preset === "tennis-data" ? parseDayMonthYear(r.Date) : isoDate(r.date)) ?? "9999";
  const order = recs.map((r, i) => ({ r, i })).sort((a, b) => dateKey(a.r).localeCompare(dateKey(b.r)) || a.i - b.i);
  repo.db.tx(() => {
    order.forEach(({ r, i }) => {
      const rowNo = i + 2;
      if (preset === "tennis-data") {
        const date = parseDayMonthYear(r.Date);
        if (!date) return skip(rowNo, `unreadable date "${r.Date}"`);
        if (r.Comment && !/^completed$/i.test(r.Comment)) return skip(rowNo, `not completed (${r.Comment})`);
        const ws = num(r.Wsets);
        const ls = num(r.Lsets);
        if (!r.Winner || !r.Loser || ws == null || ls == null) return skip(rowNo, "missing players or set counts");
        // Home/away are only labels in tennis: list the alphabetically first player first.
        const winnerFirst = r.Winner.localeCompare(r.Loser) <= 0;
        const [home, away] = winnerFirst ? [r.Winner, r.Loser] : [r.Loser, r.Winner];
        const surface = (r.Surface || "").toLowerCase();
        const bestOf = num(r["Best of"]) ?? 3;
        const price = (w: string | undefined, l: string | undefined) => {
          const dw = decimalOrNull(w);
          const dl = decimalOrNull(l);
          return dw && dl ? (winnerFirst ? { home: dw, away: dl } : { home: dl, away: dw }) : null;
        };
        const closing: ImportedGame["closing"] = [];
        const ps = price(r.PSW, r.PSL);
        if (ps) closing.push({ bookKey: "td_pinnacle_close", bookTitle: "Pinnacle closing (tennis-data.co.uk)", contract: "moneyline_2way_full_game", line: null, prices: ps });
        const avg = price(r.AvgW, r.AvgL);
        if (avg) closing.push({ bookKey: "td_average_close", bookTitle: "Average closing (tennis-data.co.uk)", contract: "moneyline_2way_full_game", line: null, prices: avg });
        const res = importer.upsert(
          {
            sportKey,
            league: r.Tournament || r.Series || "Tennis",
            source: "import",
            idHint: `${sportKey}:${date}:${slug(home)}:${slug(away)}`,
            home: { name: home },
            away: { name: away },
            start: `${date}T12:00:00Z`,
            approximateTime: true,
            status: "final",
            homeScore: winnerFirst ? ws : ls,
            awayScore: winnerFirst ? ls : ws,
            neutral: true,
            extra: {
              surface: ["hard", "clay", "grass"].includes(surface) ? surface : tennisSurfaceFromName(r.Tournament || ""),
              bestOf,
              tournament: r.Tournament || null,
              round: r.Round || null,
              scoreUnit: "sets",
            },
            closing,
            knockout: true,
          },
          retrievedAt,
        );
        out.imported++;
        if (res.created) out.created++;
        out.quotes += res.quotes;
        return;
      }
      // generic
      const date = isoDate(r.date);
      if (!date) return skip(rowNo, `unreadable date "${r.date}" (use YYYY-MM-DD; day/month order is ambiguous)`);
      const hs = num(r.home_score);
      const as = num(r.away_score);
      if (!r.home || !r.away) return skip(rowNo, "missing team names");
      if (r.home_score && hs == null) return skip(rowNo, "home_score is not a number");
      if (r.away_score && as == null) return skip(rowNo, "away_score is not a number");
      const hasTime = date.includes("T") || /^\d{1,2}:\d{2}$/.test(r.time ?? "");
      const start = date.includes("T") ? date : `${date}T${hasTime ? r.time!.padStart(5, "0") : "12:00"}:00Z`;
      if (Number.isNaN(Date.parse(start))) return skip(rowNo, "unreadable start time");
      const res = importer.upsert(
        {
          sportKey,
          league: r.league || sportKey,
          source: "import",
          idHint: `${modelKeyFor(sportKey)}:${start.slice(0, 10)}:${slug(r.home)}:${slug(r.away)}`,
          home: { name: r.home },
          away: { name: r.away },
          start,
          approximateTime: !hasTime ? true : false,
          status: hs != null && as != null ? "final" : "scheduled",
          homeScore: hs,
          awayScore: as,
          neutral: r.neutral === "1" || /^true$/i.test(r.neutral ?? ""),
          extra: {
            ...(r.surface ? { surface: r.surface.toLowerCase() } : {}),
            ...(num(r.best_of) ? { bestOf: num(r.best_of) } : {}),
          },
        },
        retrievedAt,
      );
      out.imported++;
      if (res.created) out.created++;
    });
  });
  return out;
}
