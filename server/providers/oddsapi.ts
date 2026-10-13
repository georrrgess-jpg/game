// The Odds API (v4) adapter — https://the-odds-api.com/liveapi/guides/v4/
// Documented behaviour this adapter relies on (verify against the current docs):
//   GET /v4/sports                     list sports; does not count against the usage quota
//   GET /v4/sports/{sport}/odds        cost = number of markets x number of regions (empty responses are free)
//   GET /v4/sports/{sport}/scores      cost 1, or 2 with daysFrom (1..3) for completed games
//   GET /v4/historical/sports/{sport}/odds?date=   paid plans only; cost 10 x markets x regions
//   Usage headers: x-requests-remaining, x-requests-used, x-requests-last
// Credentials are sent as the apiKey query parameter and are redacted from every log line.

import { z } from "zod";
import { contractFromOddsApiMarket, contractId, CONTRACTS, sportFamily, type OutcomeKey } from "../../shared/contracts";
import { parseDecimal } from "../../shared/odds";
import { toUtcIso } from "../../shared/time";
import type { EventRecord, QuoteRecord } from "../repo";
import { normalizeAlias } from "../repo";
import { HttpError } from "../http";
import { iso, ProviderError, recordUsage, setObserved, setProviderError, usageToday, providerStatus, type ProviderCapabilities, type ProviderDeps } from "./common";

export const ODDS_API_HOST = "api.the-odds-api.com";
const BASE = `https://${ODDS_API_HOST}/v4`;
const ID = "oddsapi";

const outcomeSchema = z.object({ name: z.string(), price: z.number(), point: z.number().optional().nullable() });
const marketSchema = z.object({ key: z.string(), last_update: z.string().optional().nullable(), outcomes: z.array(outcomeSchema) });
const bookmakerSchema = z.object({ key: z.string(), title: z.string(), last_update: z.string().optional().nullable(), markets: z.array(marketSchema) });
export const oddsEventSchema = z.object({
  id: z.string(),
  sport_key: z.string(),
  sport_title: z.string().optional(),
  commence_time: z.string(),
  home_team: z.string().nullable().optional(),
  away_team: z.string().nullable().optional(),
  bookmakers: z.array(bookmakerSchema).default([]),
});
export const scoresEventSchema = z.object({
  id: z.string(),
  sport_key: z.string(),
  commence_time: z.string(),
  completed: z.boolean(),
  home_team: z.string().nullable().optional(),
  away_team: z.string().nullable().optional(),
  scores: z.array(z.object({ name: z.string(), score: z.string().nullable() })).nullable().optional(),
  last_update: z.string().nullable().optional(),
});
export const sportSchema = z.object({
  key: z.string(),
  group: z.string(),
  title: z.string(),
  description: z.string().optional().nullable(),
  active: z.boolean(),
  has_outrights: z.boolean().optional(),
});
const historicalSchema = z.object({
  timestamp: z.string(),
  previous_timestamp: z.string().nullable().optional(),
  next_timestamp: z.string().nullable().optional(),
  data: z.array(oddsEventSchema),
});

export const ODDSAPI_CAPABILITIES: ProviderCapabilities = {
  id: ID,
  name: "The Odds API (v4)",
  roles: ["Market quotes (moneyline, 3-way, spreads, totals)", "Recent scores (last 3 days)", "Historical quote snapshots (paid plans)"],
  docsUrl: "https://the-odds-api.com/liveapi/guides/v4/",
  requiresKey: true,
  keyEnvVar: "ODDS_API_KEY",
  licensing: "Commercial API with a free starter tier; use is governed by The Odds API's terms. Bookmaker coverage depends on region and plan.",
  coverage: [
    "Sports: whatever /v4/sports lists as active for your key (shown below after a connection test).",
    "Regions: us, us2, uk, eu, au (each region adds cost).",
    "Markets used here: h2h (moneyline / soccer 1X2), h2h_3_way, spreads, totals.",
    "Books: exactly the bookmakers returned in responses; the list observed on this installation is shown below.",
  ],
  history: "Documented: historical odds snapshots from June 2020 on paid plans (10-minute snapshots, 5-minute from September 2022). Disabled here unless you explicitly allow it.",
  costNotes: "Usage credits per request: markets x regions for live odds; 10x that for historical snapshots. Scores cost 1 (2 with completed games). /sports is free.",
  limitations: [
    "Scores endpoint only returns completed games from the last 3 days.",
    "Overtime and settlement rules for h2h can differ by bookmaker; this app treats US-sport h2h as full-game including overtime and soccer h2h as 3-way regulation time.",
    "Not live-verified in the build environment (network blocked); covered by recorded-response contract tests.",
  ],
};

export function oddsApiCost(markets: number, regions: number, bookmakers: number): number {
  const regionUnits = bookmakers > 0 ? Math.ceil(bookmakers / 10) : regions;
  return markets * regionUnits;
}

/** Leagues where the final soccer score is the regulation score (no extra time). Cups are excluded. */
export function soccerLeagueFinalIsRegulation(sportKey: string): boolean {
  if (sportFamily(sportKey) !== "soccer") return false;
  return !/(cup|copa|champs|champions|europa|conference|libertadores|sudamericana|world_cup|euro|nations|qualif|playoff|trophy)/.test(sportKey);
}

export class OddsApiProvider {
  readonly id = ID;
  constructor(private deps: ProviderDeps) {}

  private key(): string {
    const k = this.deps.config.oddsApiKey;
    if (!k) throw new ProviderError("ODDS_API_KEY is not set in the server .env file.", "not_configured");
    return k;
  }

  private url(path: string, params: Record<string, string>): string {
    const u = new URL(`${BASE}${path}`);
    u.searchParams.set("apiKey", this.key());
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  private captureQuota(headers: Record<string, string>): void {
    const num = (v: string | undefined) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
    const remaining = num(headers["x-requests-remaining"]);
    const used = num(headers["x-requests-used"]);
    const last = num(headers["x-requests-last"]);
    this.deps.db.run("INSERT OR IGNORE INTO provider_status(provider) VALUES (?)", [ID]);
    this.deps.db.run(
      "UPDATE provider_status SET quota_remaining = COALESCE(?, quota_remaining), quota_used = COALESCE(?, quota_used), quota_last_cost = COALESCE(?, quota_last_cost), quota_exhausted = CASE WHEN ? IS NOT NULL AND ? <= 0 THEN 1 ELSE 0 END WHERE provider = ?",
      [remaining, used, last, remaining, remaining, ID],
    );
  }

  /** Throws unless the request fits inside the configured caps and the remaining provider quota. */
  checkBudget(cost: number): void {
    const s = this.deps.settings().providers.oddsapi;
    if (!s.enabled) throw new ProviderError("The Odds API is disabled in Settings.", "disabled");
    this.key();
    const st = providerStatus(this.deps.db, ID);
    if (st?.quota_exhausted) throw new ProviderError("Provider reports the usage quota is exhausted; paid requests are paused. Use Test connection (free) to re-check the remaining quota.", "quota");
    const used = usageToday(this.deps, ID).credits;
    if (used + cost > s.dailyCreditCap) {
      throw new ProviderError(`Daily credit cap reached (${used} used + ${cost} needed > cap ${s.dailyCreditCap}). Raise the cap in Settings or wait until tomorrow.`, "cap");
    }
    if (st?.quota_remaining != null && st.quota_remaining - cost < s.minRemainingCredits) {
      throw new ProviderError(`Request would leave fewer than ${s.minRemainingCredits} credits (provider reports ${st.quota_remaining} remaining).`, "quota");
    }
  }

  private async call(path: string, params: Record<string, string>, cost: number, cacheTtlSec: number): Promise<unknown> {
    if (cost > 0) this.checkBudget(cost);
    else {
      if (!this.deps.settings().providers.oddsapi.enabled) throw new ProviderError("The Odds API is disabled in Settings.", "disabled");
      this.key();
    }
    let res;
    try {
      res = await this.deps.http.get(ID, this.url(path, params), { allowedHosts: [ODDS_API_HOST], cacheTtlSec, cacheKey: `${ID}:${path}?${new URLSearchParams(params).toString()}`, maxBytes: 20_000_000 });
    } catch (e) {
      if (e instanceof HttpError && e.status === 429) {
        throw new ProviderError("Rate limited by The Odds API (HTTP 429). Try again later.", "quota");
      }
      throw new ProviderError(`Network error contacting The Odds API: ${(e as Error).message}`, "network");
    }
    if (!res.fromCache) {
      this.captureQuota(res.headers);
      recordUsage(this.deps, ID, Number(res.headers["x-requests-last"] ?? cost) || 0);
    }
    const at = iso(this.deps.now());
    if (res.status === 401) {
      const quota = /quota|credit|usage/i.test(res.body);
      if (quota) this.deps.db.run("UPDATE provider_status SET quota_exhausted = 1 WHERE provider = ?", [ID]);
      setProviderError(this.deps.db, ID, quota ? "Usage quota exhausted (401)" : "API key rejected (401)", at);
      throw new ProviderError(quota ? "The Odds API reports the usage quota is exhausted." : "The Odds API rejected the API key (HTTP 401). Check ODDS_API_KEY.", quota ? "quota" : "auth");
    }
    if (res.status === 422) {
      setProviderError(this.deps.db, ID, `Invalid request (422): ${res.body.slice(0, 160)}`, at);
      throw new ProviderError(`The Odds API rejected the request parameters (422): ${res.body.slice(0, 160)}`, "http");
    }
    if (res.status < 200 || res.status >= 300) {
      setProviderError(this.deps.db, ID, `HTTP ${res.status}`, at);
      throw new ProviderError(`The Odds API returned HTTP ${res.status}.`, "http");
    }
    try {
      return JSON.parse(res.body);
    } catch {
      setProviderError(this.deps.db, ID, "Response was not JSON", at);
      throw new ProviderError("The Odds API returned a response that is not JSON.", "bad_response");
    }
  }

  async listSports(): Promise<z.infer<typeof sportSchema>[]> {
    const data = await this.call("/sports", {}, 0, 6 * 3600);
    const parsed = z.array(sportSchema).safeParse(data);
    if (!parsed.success) throw new ProviderError("Unexpected /sports response shape.", "bad_response");
    setObserved(this.deps.db, ID, { sports: parsed.data.filter((s) => s.active).map((s) => ({ key: s.key, title: s.title, group: s.group })), sportsCheckedAt: iso(this.deps.now()) });
    return parsed.data;
  }

  /** Fetch current odds for one sport and store quotes. Returns counts for the activity log. */
  async refreshOdds(sportKey: string): Promise<{ events: number; quotes: number; unmatched: number; books: string[] }> {
    const s = this.deps.settings().providers.oddsapi;
    const params: Record<string, string> = { markets: s.markets.join(","), oddsFormat: "decimal", dateFormat: "iso" };
    if (s.bookmakers.length) params.bookmakers = s.bookmakers.join(",");
    else params.regions = s.regions.join(",");
    const cost = oddsApiCost(s.markets.length, s.regions.length, s.bookmakers.length);
    const data = await this.call(`/sports/${encodeURIComponent(sportKey)}/odds`, params, cost, 0);
    const result = this.ingestOdds(sportKey, data, iso(this.deps.now()), null);
    this.deps.log.add("info", ID, `Odds refreshed for ${sportKey}: ${result.events} events, ${result.quotes} new quotes, ${result.unmatched} unmatched events. Cost ${cost} credit(s).`);
    return result;
  }

  /** Validate and store an odds payload. `knownAt` overrides the information time for historical snapshots. */
  ingestOdds(sportKey: string, data: unknown, retrievedAt: string, knownAt: string | null): { events: number; quotes: number; unmatched: number; books: string[]; rejected: number } {
    const arr = z.array(z.unknown()).safeParse(data);
    if (!arr.success) throw new ProviderError("Odds response is not a list.", "bad_response");
    const quotes: QuoteRecord[] = [];
    const books = new Set<string>();
    let events = 0;
    let unmatched = 0;
    let rejected = 0;
    for (const raw of arr.data) {
      const ev = oddsEventSchema.safeParse(raw);
      if (!ev.success) {
        rejected++;
        continue;
      }
      const e = ev.data;
      const eventId = this.matchOrCreateEvent(sportKey, e, retrievedAt);
      if (!eventId) {
        unmatched++;
        continue;
      }
      events++;
      for (const b of e.bookmakers) {
        books.add(`${b.key}|${b.title}`);
        for (const m of b.markets) {
          const contract = contractFromOddsApiMarket(e.sport_key, m.key);
          if (!contract) continue;
          const spec = CONTRACTS[contract];
          const sourceTime = safeIso(m.last_update ?? b.last_update ?? null) ?? retrievedAt;
          // Lines are stored from the home team's perspective; both sides must agree.
          let homeLine: number | null = null;
          if (contract === "spread_full_game") {
            const h = m.outcomes.find((o) => o.name === e.home_team);
            homeLine = h?.point ?? null;
            if (homeLine == null) continue;
          } else if (contract === "total_full_game") {
            homeLine = m.outcomes[0]?.point ?? null;
            if (homeLine == null || m.outcomes.some((o) => o.point !== homeLine)) continue;
          }
          const mapped: { outcome: OutcomeKey; price: number }[] = [];
          for (const o of m.outcomes) {
            const outcome = mapOutcome(o.name, e.home_team ?? "", e.away_team ?? "");
            if (!outcome || !spec.outcomes.includes(outcome)) continue;
            if (contract === "spread_full_game") {
              const expected = outcome === "home" ? homeLine! : -homeLine!;
              if (o.point == null || Math.abs(o.point - expected) > 1e-9) continue; // mismatched handicap: different contract
            }
            const d = parseDecimal(o.price);
            if (!d.ok) {
              rejected++;
              continue;
            }
            mapped.push({ outcome, price: d.value });
          }
          for (const q of mapped) {
            quotes.push({
              dataset: "live",
              event_id: eventId,
              provider: ID,
              book_key: b.key,
              book_title: b.title,
              contract,
              contract_id: contractId(contract, homeLine),
              provider_market: m.key,
              line: homeLine,
              outcome: q.outcome,
              price_decimal: q.price,
              source_time: knownAt && sourceTime > knownAt ? knownAt : sourceTime,
              retrieved_at: retrievedAt,
              known_at: knownAt ?? retrievedAt,
            });
          }
        }
      }
    }
    const inserted = this.deps.repo.insertQuotes(quotes);
    const bookList = [...books].map((b) => b.split("|")[1]).sort();
    setObserved(this.deps.db, ID, { [`books:${sportKey}`]: bookList, [`booksCheckedAt:${sportKey}`]: retrievedAt });
    return { events, quotes: inserted, unmatched, books: bookList, rejected };
  }

  /**
   * Map a provider event to a canonical event. For sports with an official schedule provider
   * (MLB), quotes attach only to existing schedule events (matched by teams and start time).
   * For other sports a canonical event is created from the odds feed itself.
   */
  matchOrCreateEvent(sportKey: string, e: z.infer<typeof oddsEventSchema>, retrievedAt: string): string | null {
    const repo = this.deps.repo;
    const commence = safeIso(e.commence_time);
    if (!commence || !e.home_team || !e.away_team) return null;
    const linked = repo.linkedEvent(ID, e.id);
    if (linked && repo.event(linked)) {
      if (linked.startsWith("oddsapi:")) this.upsertOddsEvent(sportKey, e, commence, retrievedAt, linked);
      return linked;
    }
    if (sportKey === "baseball_mlb") {
      const h = repo.resolveParticipant("live", sportKey, e.home_team);
      const a = repo.resolveParticipant("live", sportKey, e.away_team);
      if (!h || !a) return null;
      const lo = new Date(Date.parse(commence) - 6 * 3600000).toISOString();
      const hi = new Date(Date.parse(commence) + 6 * 3600000).toISOString();
      const cands = repo.db.all<EventRecord>(
        "SELECT * FROM events WHERE dataset = 'live' AND sport_key = ? AND home_id = ? AND away_id = ? AND start_time >= ? AND start_time <= ? AND status NOT IN ('postponed','cancelled')",
        [sportKey, h, a, lo, hi],
      );
      if (!cands.length) return null;
      // Doubleheaders: choose the closest start time; refuse if two candidates are equally close.
      cands.sort((x, y) => Math.abs(Date.parse(x.start_time) - Date.parse(commence)) - Math.abs(Date.parse(y.start_time) - Date.parse(commence)));
      if (cands.length > 1 && Math.abs(Date.parse(cands[0].start_time) - Date.parse(commence)) === Math.abs(Date.parse(cands[1].start_time) - Date.parse(commence))) return null;
      repo.linkEvent(ID, e.id, cands[0].id, "teams+start-time", retrievedAt);
      return cands[0].id;
    }
    const id = `oddsapi:${e.id}`;
    this.upsertOddsEvent(sportKey, e, commence, retrievedAt, id);
    repo.linkEvent(ID, e.id, id, "provider-id", retrievedAt);
    return id;
  }

  private teamId(sportKey: string, name: string): string {
    const repo = this.deps.repo;
    const existing = repo.resolveParticipant("live", sportKey, name);
    if (existing) return existing;
    const id = `odds-team:${sportKey}:${normalizeAlias(name).replace(/ /g, "-")}`;
    repo.upsertParticipant({ id, dataset: "live", sport_key: sportKey, name, short_name: null, abbreviation: null, aliases: [], meta: { source: ID } });
    return id;
  }

  private upsertOddsEvent(sportKey: string, e: z.infer<typeof oddsEventSchema>, commence: string, retrievedAt: string, id: string): void {
    const existing = this.deps.repo.event(id);
    this.deps.repo.upsertEvent({
      id,
      dataset: "live",
      sport_key: sportKey,
      league: e.sport_title ?? sportKey,
      season: null,
      home_id: this.teamId(sportKey, e.home_team!),
      away_id: this.teamId(sportKey, e.away_team!),
      start_time: commence,
      status: existing?.status ?? "scheduled",
      status_at: existing?.status_at ?? retrievedAt,
      final_at: existing?.final_at ?? null,
      home_score: existing?.home_score ?? null,
      away_score: existing?.away_score ?? null,
      regulation_home: existing?.regulation_home ?? null,
      regulation_away: existing?.regulation_away ?? null,
      final_is_regulation: soccerLeagueFinalIsRegulation(sportKey) ? 1 : 0,
      neutral_site: 0,
      venue_name: null,
      venue_lat: null,
      venue_lon: null,
      venue_tz: null,
      indoor: 0,
      rescheduled_from: existing && Math.abs(Date.parse(existing.start_time) - Date.parse(commence)) > 12 * 3600000 ? existing.start_time : null,
      game_number: 1,
      source: ID,
      source_updated_at: retrievedAt,
      retrieved_at: retrievedAt,
      known_at: existing?.known_at ?? retrievedAt,
      extra: { providerEventId: e.id },
    });
  }

  /** Update results for events created from this feed (MLB results come from the official MLB feed instead). */
  async refreshScores(sportKey: string): Promise<{ updated: number }> {
    const data = await this.call(`/sports/${encodeURIComponent(sportKey)}/scores`, { daysFrom: "3", dateFormat: "iso" }, 2, 0);
    return this.ingestScores(sportKey, data, iso(this.deps.now()));
  }

  ingestScores(sportKey: string, data: unknown, retrievedAt: string): { updated: number } {
    const arr = z.array(scoresEventSchema).safeParse(data);
    if (!arr.success) throw new ProviderError("Unexpected scores response shape.", "bad_response");
    let updated = 0;
    for (const s of arr.data) {
      const id = this.deps.repo.linkedEvent(ID, s.id);
      if (!id || !id.startsWith("oddsapi:")) continue;
      const ev = this.deps.repo.event(id);
      if (!ev) continue;
      let status = ev.status;
      let hs: number | null = ev.home_score;
      let as: number | null = ev.away_score;
      let finalAt = ev.final_at;
      if (s.completed && s.scores) {
        const h = s.scores.find((x) => x.name === s.home_team)?.score;
        const a = s.scores.find((x) => x.name === s.away_team)?.score;
        if (h != null && a != null && /^\d+$/.test(h) && /^\d+$/.test(a)) {
          status = "final";
          hs = Number(h);
          as = Number(a);
          finalAt = ev.final_at ?? safeIso(s.last_update ?? null) ?? retrievedAt;
        }
      } else if (Date.parse(s.commence_time) <= Date.parse(retrievedAt)) {
        status = "in_progress";
      }
      if (status !== ev.status || hs !== ev.home_score || as !== ev.away_score) {
        this.deps.repo.upsertEvent({ ...ev, status, status_at: retrievedAt, final_at: finalAt, home_score: hs, away_score: as, retrieved_at: retrievedAt, extra: JSON.parse(ev.extra || "{}") });
        updated++;
      }
    }
    return { updated };
  }

  /** One historical snapshot (paid plans only). Information time = the snapshot timestamp. */
  async historicalSnapshot(sportKey: string, dateIso: string): Promise<{ timestamp: string; quotes: number }> {
    const s = this.deps.settings().providers.oddsapi;
    if (!s.allowHistorical) throw new ProviderError("Historical snapshots are disabled. Enable them explicitly in Settings (they cost 10x credits).", "disabled");
    const params: Record<string, string> = { markets: s.markets.join(","), oddsFormat: "decimal", dateFormat: "iso", date: toUtcIso(dateIso) };
    if (s.bookmakers.length) params.bookmakers = s.bookmakers.join(",");
    else params.regions = s.regions.join(",");
    const cost = 10 * oddsApiCost(s.markets.length, s.regions.length, s.bookmakers.length);
    const data = await this.call(`/historical/sports/${encodeURIComponent(sportKey)}/odds`, params, cost, 7 * 86400);
    const parsed = historicalSchema.safeParse(data);
    if (!parsed.success) throw new ProviderError("Unexpected historical response shape.", "bad_response");
    const ts = toUtcIso(parsed.data.timestamp);
    const r = this.ingestOdds(sportKey, parsed.data.data, iso(this.deps.now()), ts);
    return { timestamp: ts, quotes: r.quotes };
  }
}

export function mapOutcome(name: string, home: string, away: string): OutcomeKey | null {
  if (name === home) return "home";
  if (name === away) return "away";
  const n = name.trim().toLowerCase();
  if (n === "draw" || n === "tie") return "draw";
  if (n === "over") return "over";
  if (n === "under") return "under";
  return null;
}

function safeIso(s: string | null | undefined): string | null {
  if (!s) return null;
  try {
    return toUtcIso(s);
  } catch {
    return null;
  }
}
