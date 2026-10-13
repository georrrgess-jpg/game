// Orchestrates live provider refreshes. Each step is isolated so a partial outage
// (one provider down, quota exhausted, a malformed response) never blocks the others.

import { localDayBounds, addDaysToDate } from "../shared/time";
import type { ProviderDeps } from "./providers/common";
import { ProviderError } from "./providers/common";
import { OddsApiProvider } from "./providers/oddsapi";
import { MlbProvider } from "./providers/mlb";
import { OpenMeteoProvider } from "./providers/openmeteo";
import { RssProvider } from "./providers/rss";

export interface StepResult {
  step: string;
  provider: string;
  ok: boolean;
  skipped: boolean;
  detail: string;
}

export class LiveIngest {
  readonly odds: OddsApiProvider;
  readonly mlb: MlbProvider;
  readonly weather: OpenMeteoProvider;
  readonly rss: RssProvider;
  private running: Promise<StepResult[]> | null = null;

  constructor(private deps: ProviderDeps) {
    this.odds = new OddsApiProvider(deps);
    this.mlb = new MlbProvider(deps);
    this.weather = new OpenMeteoProvider(deps);
    this.rss = new RssProvider(deps);
  }

  private async step(name: string, provider: string, fn: () => Promise<string>): Promise<StepResult> {
    try {
      const detail = await fn();
      return { step: name, provider, ok: true, skipped: false, detail };
    } catch (e) {
      const skipped = e instanceof ProviderError && (e.code === "disabled" || e.code === "not_configured");
      const detail = (e as Error).message;
      if (!skipped) this.deps.log.add("error", provider, `${name} failed: ${detail}`);
      return { step: name, provider, ok: false, skipped, detail };
    }
  }

  /** Full refresh for a local day: schedules, odds, results, injuries, weather, news. Concurrent calls share one run. */
  refreshDay(localDate: string, parts: { odds?: boolean; news?: boolean } = {}): Promise<StepResult[]> {
    if (this.running) return this.running;
    this.running = this.doRefreshDay(localDate, parts).finally(() => {
      this.running = null;
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
      // Model history: import once per day at most (cached responses make repeats cheap).
      results.push(
        await this.step("MLB history", "mlb", async () => {
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

    if (parts.odds !== false) {
      for (const sport of s.providers.oddsapi.sports) {
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
        if (sport !== "baseball_mlb") {
          results.push(await this.step(`Scores: ${sport}`, "oddsapi", async () => `${(await this.odds.refreshScores(sport)).updated} results updated`));
        }
      }
    }

    const { startUtc, endUtc } = localDayBounds(localDate, zone);
    const now = this.deps.now().toISOString();
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
    for (const sport of this.deps.settings().providers.oddsapi.sports) {
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
    for (const sport of s.providers.oddsapi.sports.filter((x) => x !== "baseball_mlb")) {
      out.push(await this.step(`Scores: ${sport}`, "oddsapi", async () => `${(await this.odds.refreshScores(sport)).updated} results updated`));
    }
    return out;
  }

  async refreshNews(): Promise<StepResult[]> {
    return [await this.step("News feeds", "rss", async () => `${(await this.rss.refresh()).items} new items`)];
  }
}
