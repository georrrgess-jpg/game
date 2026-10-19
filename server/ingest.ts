// Orchestrates live provider refreshes. Each step is isolated so a partial outage
// (one provider down, quota exhausted, a malformed response) never blocks the others.

import { localDayBounds, addDaysToDate, toUtcIso } from "../shared/time";
import type { ProviderDeps } from "./providers/common";
import { ProviderError, providerStatus, setObserved } from "./providers/common";
import { OddsApiProvider } from "./providers/oddsapi";
import { MlbProvider } from "./providers/mlb";
import { OpenMeteoProvider } from "./providers/openmeteo";
import { RssProvider } from "./providers/rss";
import { BalldontlieProvider, NflverseProvider } from "./providers/results";
import { seasonOf } from "../shared/contracts";

export interface StepResult {
  step: string;
  provider: string;
  ok: boolean;
  skipped: boolean;
  detail: string;
  /** How long the step took, so slow providers are visible. */
  ms?: number;
}

export type RefreshProgress = { type: "start"; step: string; provider: string } | { type: "done"; result: StepResult };

/** History imports re-use their data for this long before an interactive refresh imports again. */
const HISTORY_FRESH_HOURS = 20;

export class LiveIngest {
  readonly odds: OddsApiProvider;
  readonly mlb: MlbProvider;
  readonly weather: OpenMeteoProvider;
  readonly rss: RssProvider;
  readonly nflverse: NflverseProvider;
  readonly balldontlie: BalldontlieProvider;
  private running: Promise<StepResult[]> | null = null;
  private listener: ((e: RefreshProgress) => void) | null = null;
  private nbaHistoryRun: Promise<unknown> | null = null;
  private nbaHistoryStartedAt: string | null = null;
  private runningDate: string | null = null;

  constructor(private deps: ProviderDeps) {
    this.odds = new OddsApiProvider(deps);
    this.mlb = new MlbProvider(deps);
    this.weather = new OpenMeteoProvider(deps);
    this.rss = new RssProvider(deps);
    this.nflverse = new NflverseProvider(deps);
    this.balldontlie = new BalldontlieProvider(deps);
  }

  /** NFL seasons to import: the current season (by start year) and the configured number before it. */
  nflSeasons(localDate: string): number[] {
    const cur = Number(seasonOf("americanfootball_nfl", `${localDate}T12:00:00Z`));
    const n = this.deps.settings().providers.nflverse.historySeasons;
    return Array.from({ length: n + 1 }, (_, i) => cur - n + i);
  }

  nbaSeasons(localDate: string): { seasons: number[]; current: number } {
    const cur = Number(seasonOf("basketball_nba", `${localDate}T12:00:00Z`));
    const n = this.deps.settings().providers.balldontlie.historySeasons;
    return { seasons: Array.from({ length: n + 1 }, (_, i) => cur - n + i), current: cur };
  }

  private async step(name: string, provider: string, fn: () => Promise<string>): Promise<StepResult> {
    this.listener?.({ type: "start", step: name, provider });
    const t0 = Date.now();
    let result: StepResult;
    try {
      const detail = await fn();
      result = { step: name, provider, ok: true, skipped: false, detail, ms: Date.now() - t0 };
    } catch (e) {
      const skipped = e instanceof ProviderError && (e.code === "disabled" || e.code === "not_configured");
      const detail = (e as Error).message;
      if (!skipped) this.deps.log.add("error", provider, `${name} failed: ${detail}`);
      result = { step: name, provider, ok: false, skipped, detail, ms: Date.now() - t0 };
    }
    this.listener?.({ type: "done", result });
    return result;
  }

  private observed(provider: string): Record<string, unknown> {
    try {
      return JSON.parse(providerStatus(this.deps.db, provider)?.observed ?? "{}");
    } catch {
      return {};
    }
  }

  /** When a provider last imported exactly these history seasons (from its observed status), or null. */
  private historyImportedAt(provider: string, key: string, seasonsKey: string, seasons: (string | number)[]): string | null {
    const o = this.observed(provider);
    const at = o[key];
    const had = Array.isArray(o[seasonsKey]) ? (o[seasonsKey] as unknown[]).map(String) : [];
    return typeof at === "string" && seasons.every((x) => had.includes(String(x))) ? at : null;
  }

  private freshSince(at: string | null): boolean {
    const now = this.deps.now().getTime();
    return !!at && now - Date.parse(at) < HISTORY_FRESH_HOURS * 3600000 && Date.parse(at) <= now + 60000;
  }

  /**
   * NBA history is slow on the free tier (about 5 requests a minute), so it never blocks an interactive
   * refresh: it starts in the background at most once per day and the model appears when it finishes.
   */
  startNbaHistory(localDate: string): string {
    if (this.nbaHistoryRun) return `Still importing in the background (started ${this.nbaHistoryStartedAt}). The NBA model appears when it finishes.`;
    const { seasons, current } = this.nbaSeasons(localDate);
    const past = seasons.filter((x) => x < current);
    const last = this.historyImportedAt("balldontlie", "lastImport", "seasonsImported", past);
    if (this.freshSince(last)) return `History already imported (${last}).`;
    const rpm = this.deps.settings().providers.balldontlie.requestsPerMinute;
    const minutes = Math.max(1, Math.round((past.length * 15) / rpm));
    this.nbaHistoryStartedAt = new Date(this.deps.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
    this.nbaHistoryRun = this.balldontlie
      .importSeasons(past, current)
      .catch((e) => this.deps.log.add("error", "balldontlie", `Background NBA history import failed: ${(e as Error).message}`))
      .finally(() => {
        this.nbaHistoryRun = null;
        this.nbaHistoryStartedAt = null;
      });
    return `Started in the background for ${past.join(", ")} (about ${minutes} minute(s) at ${rpm} requests per minute). Analyze again afterwards to use it.`;
  }

  backgroundStatus(): { nbaHistory: { running: boolean; startedAt: string | null } } {
    return { nbaHistory: { running: !!this.nbaHistoryRun, startedAt: this.nbaHistoryStartedAt } };
  }

  /** Full refresh for a local day: schedules, odds, results, injuries, weather, news. Concurrent calls share one run. */
  async refreshDay(localDate: string, parts: { odds?: boolean; news?: boolean } = {}, onProgress?: (e: RefreshProgress) => void): Promise<StepResult[]> {
    // A refresh for the same day already in progress is shared; a different day waits for it, then runs.
    if (this.running && this.runningDate === localDate) return this.running;
    if (this.running) await this.running.catch(() => undefined);
    this.runningDate = localDate;
    this.listener = onProgress ?? null;
    this.running = this.doRefreshDay(localDate, parts).finally(() => {
      this.running = null;
      this.runningDate = null;
      this.listener = null;
    });
    return this.running;
  }

  private async doRefreshDay(localDate: string, parts: { odds?: boolean; news?: boolean }): Promise<StepResult[]> {
    const s = this.deps.settings();
    const zone = s.timezone;
    const results: StepResult[] = [];
    const season = localDate.slice(0, 4);

    if (s.providers.mlb.enabled) {
      results.push(await this.step("MLB teams", "mlb", async () => `${await this.mlb.refreshTeams(season)} teams`));
      // Model history: import at most once a day; the daily schedule step below keeps recent games current.
      results.push(
        await this.step("MLB history", "mlb", async () => {
          const want = Array.from({ length: s.providers.mlb.historySeasons + 1 }, (_, i) => String(Number(season) - i));
          const last = this.historyImportedAt("mlb", "historyImportedAt", "historySeasons", want);
          if (this.freshSince(last)) return `Already imported (${last}); reused.`;
          const r = await this.mlb.importHistory(season, s.providers.mlb.historySeasons);
          return `${r.events} games across ${r.seasons.join(", ")}`;
        }),
      );
      results.push(
        await this.step("MLB schedule", "mlb", async () => {
          const r = await this.mlb.refreshSchedule(addDaysToDate(localDate, -1), addDaysToDate(localDate, 1));
          return `${r.events} games, ${r.lineups} lineup updates`;
        }),
      );
    } else {
      results.push({ step: "MLB schedule", provider: "mlb", ok: false, skipped: true, detail: "MLB Stats API disabled in Settings." });
    }

    if (s.providers.nflverse.enabled) {
      results.push(
        await this.step("NFL schedule and results", "nflverse", async () => {
          // Full history at most once a day; otherwise only the current season (new results and lines).
          const all = this.nflSeasons(localDate);
          const fresh = this.freshSince(this.historyImportedAt("nflverse", "fullImportAt", "fullSeasons", all));
          const r = await this.nflverse.importSeasons(fresh ? all.slice(-1) : all);
          if (!fresh) setObserved(this.deps.db, "nflverse", { fullImportAt: new Date(this.deps.now()).toISOString().replace(/\.\d{3}Z$/, "Z"), fullSeasons: all });
          return `${r.games} games (${r.created} new), ${r.quotes} closing quotes, seasons ${r.seasons.join(", ")}`;
        }),
      );
    }
    if (s.providers.balldontlie.enabled) {
      results.push(await this.step("NBA history", "balldontlie", async () => this.startNbaHistory(localDate)));
      results.push(
        await this.step("NBA schedule", "balldontlie", async () => `${(await this.balldontlie.refreshRange(addDaysToDate(localDate, -2), addDaysToDate(localDate, 1))).games} games`),
      );
    }

    if (parts.odds !== false) {
      const oddsSports = s.providers.oddsapi.enabled ? await this.odds.sportsToRefresh() : s.providers.oddsapi.sports;
      for (const sport of oddsSports) {
        results.push(
          await this.step(`Odds: ${sport}`, "oddsapi", async () => {
            const r = await this.odds.refreshOdds(sport);
            const hint =
              sport === "baseball_mlb" && r.unmatched > 0 && !s.providers.mlb.enabled
                ? " (MLB quotes attach to the official MLB schedule: enable the MLB Stats API in Settings, no key needed)"
                : r.unmatched > 0
                  ? " (unmatched events are listed as unmatched, never guessed)"
                  : "";
            return `${r.events} events, ${r.quotes} new quotes, ${r.unmatched} unmatched${hint}, books: ${r.books.join(", ") || "none"}`;
          }),
        );
        // MLB results come from the official feed; tennis results from imported files (score coverage for tennis is limited).
        if (sport !== "baseball_mlb" && !sport.startsWith("tennis")) {
          results.push(await this.step(`Scores: ${sport}`, "oddsapi", async () => `${(await this.odds.refreshScores(sport)).updated} results updated`));
        }
      }
    }

    const { startUtc, endUtc } = localDayBounds(localDate, zone);
    const now = toUtcIso(this.deps.now());
    const todays = this.deps.repo.eventsInWindow("live", startUtc, endUtc, now);

    if (s.providers.mlb.enabled) {
      const mlbTeams = [...new Set(todays.filter((e) => e.sport_key === "baseball_mlb").flatMap((e) => [e.home_id, e.away_id]))];
      results.push(await this.step("MLB injured lists", "mlb", async () => `${await this.mlb.refreshInjuries(mlbTeams, localDate)} changes for ${mlbTeams.length} teams`));
    }
    results.push(await this.step("Weather", "openmeteo", async () => `${await this.weather.refreshForEvents(todays.map((e) => this.deps.repo.event(e.id)!).filter(Boolean))} forecasts`));
    if (parts.news !== false) {
      results.push(
        await this.step("News feeds", "rss", async () => {
          const r = await this.rss.refresh();
          return `${r.items} new items from ${r.feeds} feed(s)${r.errors.length ? `; errors: ${r.errors.join("; ")}` : ""}`;
        }),
      );
    }
    const failed = results.filter((r) => !r.ok && !r.skipped);
    this.deps.log.add(failed.length ? "warn" : "info", "refresh", `Refresh for ${localDate}: ${results.filter((r) => r.ok).length} ok, ${failed.length} failed, ${results.filter((r) => r.skipped).length} skipped.`, results);
    return results;
  }

  async refreshOddsOnly(): Promise<StepResult[]> {
    const out: StepResult[] = [];
    const sports = this.deps.settings().providers.oddsapi.enabled ? await this.odds.sportsToRefresh() : this.deps.settings().providers.oddsapi.sports;
    for (const sport of sports) {
      out.push(await this.step(`Odds: ${sport}`, "oddsapi", async () => {
        const r = await this.odds.refreshOdds(sport);
        return `${r.events} events, ${r.quotes} new quotes`;
      }));
    }
    return out;
  }

  async refreshResults(localDate: string): Promise<StepResult[]> {
    const out: StepResult[] = [];
    const s = this.deps.settings();
    if (s.providers.mlb.enabled) {
      out.push(await this.step("MLB results", "mlb", async () => {
        const r = await this.mlb.refreshSchedule(addDaysToDate(localDate, -2), addDaysToDate(localDate, 1), { hydrate: true, ttl: 300 });
        return `${r.events} games checked`;
      }));
    }
    if (s.providers.balldontlie.enabled) {
      out.push(await this.step("NBA results", "balldontlie", async () => `${(await this.balldontlie.refreshRange(addDaysToDate(localDate, -2), localDate)).games} games checked`));
    }
    const oddsSports = s.providers.oddsapi.enabled ? await this.odds.sportsToRefresh() : s.providers.oddsapi.sports;
    for (const sport of oddsSports.filter((x) => x !== "baseball_mlb" && !x.startsWith("tennis"))) {
      out.push(await this.step(`Scores: ${sport}`, "oddsapi", async () => `${(await this.odds.refreshScores(sport)).updated} results updated`));
    }
    return out;
  }

  async refreshNews(): Promise<StepResult[]> {
    return [await this.step("News feeds", "rss", async () => `${(await this.rss.refresh()).items} new items`)];
  }
}
