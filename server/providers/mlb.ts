// MLB Stats API adapter (statsapi.mlb.com). Public JSON with no key; MLB publishes no formal
// public documentation, and every response carries an MLB Advanced Media copyright notice
// (http://gdx.mlb.com/components/copyright.txt). Use for individual, non-commercial
// classroom purposes, request gently, and do not redistribute the data.
//
// Used for: teams, schedules, official game status and final scores, probable pitchers,
// posted lineups, venue coordinates/roof type, and injured-list status from 40-man rosters.

import { z } from "zod";
import { DateTime } from "luxon";
import type { EventStatus } from "../../shared/settlement";
import type { EventRecord, InjuryRecord, LineupRecord } from "../repo";
import { addDaysToDate } from "../../shared/time";
import { iso, ProviderError, recordUsage, setObserved, type ProviderCapabilities, type ProviderDeps } from "./common";

export const MLB_HOST = "statsapi.mlb.com";
const BASE = `https://${MLB_HOST}/api/v1`;
const ID = "mlb";
const SPORT = "baseball_mlb";
export const MLB_GAME_TYPES = "R,F,D,L,W"; // regular season and postseason; spring training/exhibitions excluded

const personRef = z.object({ id: z.number(), fullName: z.string().optional() }).passthrough();
const teamSide = z
  .object({
    team: z.object({ id: z.number(), name: z.string().optional() }).passthrough(),
    score: z.number().optional().nullable(),
    isWinner: z.boolean().optional(),
    probablePitcher: personRef.optional().nullable(),
  })
  .passthrough();
export const mlbGameSchema = z
  .object({
    gamePk: z.number(),
    gameType: z.string().optional(),
    season: z.string().optional(),
    gameDate: z.string(),
    officialDate: z.string().optional(),
    rescheduledFrom: z.string().optional(),
    rescheduledFromDate: z.string().optional(),
    resumedFrom: z.string().optional(),
    status: z.object({ abstractGameState: z.string(), detailedState: z.string(), codedGameState: z.string().optional() }).passthrough(),
    teams: z.object({ home: teamSide, away: teamSide }),
    venue: z
      .object({
        id: z.number().optional(),
        name: z.string().optional(),
        location: z.object({ defaultCoordinates: z.object({ latitude: z.number(), longitude: z.number() }).optional() }).passthrough().optional(),
        fieldInfo: z.object({ roofType: z.string().optional() }).passthrough().optional(),
        timeZone: z.object({ id: z.string().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
    gameNumber: z.number().optional(),
    doubleHeader: z.string().optional(),
    lineups: z
      .object({
        homePlayers: z.array(z.object({ id: z.number(), fullName: z.string(), primaryPosition: z.object({ abbreviation: z.string() }).optional() }).passthrough()).optional(),
        awayPlayers: z.array(z.object({ id: z.number(), fullName: z.string(), primaryPosition: z.object({ abbreviation: z.string() }).optional() }).passthrough()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const scheduleSchema = z.object({ dates: z.array(z.object({ date: z.string(), games: z.array(z.unknown()) })).default([]) });
const teamsSchema = z.object({
  teams: z.array(
    z
      .object({
        id: z.number(),
        name: z.string(),
        abbreviation: z.string().optional(),
        teamName: z.string().optional(),
        shortName: z.string().optional(),
        franchiseName: z.string().optional(),
        clubName: z.string().optional(),
        locationName: z.string().optional(),
        active: z.boolean().optional(),
      })
      .passthrough(),
  ),
});
const rosterSchema = z.object({
  roster: z
    .array(
      z
        .object({
          person: personRef,
          position: z.object({ abbreviation: z.string().optional() }).passthrough().optional(),
          status: z.object({ code: z.string(), description: z.string().optional() }).passthrough().optional(),
        })
        .passthrough(),
    )
    .default([]),
});

export const MLB_CAPABILITIES: ProviderCapabilities = {
  id: ID,
  name: "MLB Stats API",
  roles: ["Schedules & official status", "Final scores", "Probable pitchers & posted lineups", "Injured-list status (40-man roster)", "Venue coordinates & roof type"],
  docsUrl: "https://statsapi.mlb.com/api/v1/schedule?sportId=1",
  requiresKey: false,
  keyEnvVar: null,
  licensing:
    "No key. Responses carry an MLB Advanced Media copyright notice (gdx.mlb.com/components/copyright.txt) limiting use to individual, non-commercial, non-bulk purposes. MLB publishes no formal public documentation; endpoints are community-documented and may change.",
  coverage: ["MLB regular season and postseason games (spring training excluded).", "Seasons fetched for model history: configurable (default 2 previous seasons plus the current one)."],
  history: "Full past-season schedules and scores (used to fit the model). No historical injury or lineup snapshots.",
  costNotes: "No usage fee. Requests are cached (teams 7 days, past seasons 7 days, today's schedule 10 minutes).",
  limitations: [
    "Injuries are limited to injured-list status; day-to-day injuries are not published there.",
    "Lineups appear only once teams post them; until then they are shown as unknown.",
    "Final times for past seasons are estimated as start + 4 hours for replay purposes.",
    "Not live-verified in the build environment (network blocked); covered by recorded-response contract tests.",
  ],
};

export function mapMlbStatus(st: { abstractGameState: string; detailedState: string; codedGameState?: string }): EventStatus {
  const d = st.detailedState.toLowerCase();
  if (d.startsWith("postponed")) return "postponed";
  if (d.startsWith("cancelled") || d.startsWith("canceled")) return "cancelled";
  if (d.startsWith("suspended")) return "suspended";
  if (d === "final" || d.startsWith("final:") || d.startsWith("completed early")) return "final";
  if (d === "game over") return "in_progress"; // not yet official
  if (st.abstractGameState === "Live") return "in_progress";
  if (st.abstractGameState === "Preview") return "scheduled";
  return "unknown";
}

export class MlbProvider {
  readonly id = ID;
  constructor(private deps: ProviderDeps) {}

  private ensureEnabled(): void {
    if (!this.deps.settings().providers.mlb.enabled) throw new ProviderError("MLB Stats API is disabled in Settings.", "disabled");
  }

  private async getJson(path: string, params: Record<string, string>, ttl: number, maxBytes = 25_000_000): Promise<unknown> {
    this.ensureEnabled();
    const u = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    let res;
    try {
      res = await this.deps.http.get(ID, u.toString(), { allowedHosts: [MLB_HOST], cacheTtlSec: ttl, maxBytes, timeoutMs: 30000 });
    } catch (e) {
      throw new ProviderError(`MLB Stats API unreachable: ${(e as Error).message}`, "network");
    }
    if (!res.fromCache) recordUsage(this.deps, ID, 0);
    if (res.status < 200 || res.status >= 300) throw new ProviderError(`MLB Stats API returned HTTP ${res.status}`, "http");
    try {
      return JSON.parse(res.body);
    } catch {
      throw new ProviderError("MLB Stats API returned non-JSON", "bad_response");
    }
  }

  async refreshTeams(season: string): Promise<number> {
    const data = await this.getJson("/teams", { sportId: "1", season }, 7 * 86400);
    return this.ingestTeams(data);
  }

  ingestTeams(data: unknown): number {
    const parsed = teamsSchema.safeParse(data);
    if (!parsed.success) throw new ProviderError("Unexpected MLB teams response", "bad_response");
    for (const t of parsed.data.teams) {
      const aliases = [t.teamName, t.clubName, t.franchiseName, t.shortName, t.locationName && t.teamName ? `${t.locationName} ${t.teamName}` : undefined].filter((x): x is string => !!x);
      // Common historical/alternate names used by odds feeds.
      if (t.teamName === "Athletics") aliases.push("Oakland Athletics", "Las Vegas Athletics", "Sacramento Athletics", "Athletics");
      if (t.name === "Cleveland Guardians") aliases.push("Cleveland Indians");
      this.deps.repo.upsertParticipant({
        id: `mlb-team:${t.id}`,
        dataset: "live",
        sport_key: SPORT,
        name: t.name,
        short_name: t.teamName ?? t.clubName ?? null,
        abbreviation: t.abbreviation ?? null,
        aliases,
        meta: { mlbId: t.id },
      });
    }
    return parsed.data.teams.length;
  }

  async refreshSchedule(startDate: string, endDate: string, opts: { hydrate?: boolean; ttl?: number } = {}): Promise<{ events: number; lineups: number }> {
    const params: Record<string, string> = { sportId: "1", startDate, endDate, gameType: MLB_GAME_TYPES };
    if (opts.hydrate !== false) params.hydrate = "probablePitcher,lineups,venue(location,fieldInfo,timezone)";
    const data = await this.getJson("/schedule", params, opts.ttl ?? 600);
    return this.ingestSchedule(data, iso(this.deps.now()));
  }

  ingestSchedule(data: unknown, retrievedAt: string): { events: number; lineups: number; rejected: number } {
    const parsed = scheduleSchema.safeParse(data);
    if (!parsed.success) throw new ProviderError("Unexpected MLB schedule response", "bad_response");
    // Group entries by gamePk: a postponed game can appear on its original date and on its make-up date.
    const byPk = new Map<number, z.infer<typeof mlbGameSchema>[]>();
    let rejected = 0;
    for (const d of parsed.data.dates) {
      for (const g of d.games) {
        const r = mlbGameSchema.safeParse(g);
        if (!r.success) {
          rejected++;
          continue;
        }
        byPk.set(r.data.gamePk, [...(byPk.get(r.data.gamePk) ?? []), r.data]);
      }
    }
    let events = 0;
    const lineups: LineupRecord[] = [];
    const now = retrievedAt;
    for (const [pk, entries] of byPk) {
      entries.sort((a, b) => a.gameDate.localeCompare(b.gameDate));
      const active = entries.filter((e) => mapMlbStatus(e.status) !== "postponed");
      const g = active.length ? active[active.length - 1] : entries[entries.length - 1];
      const status = mapMlbStatus(g.status);
      const start = DateTime.fromISO(g.gameDate, { zone: "utc" });
      if (!start.isValid) {
        rejected++;
        continue;
      }
      const startIso = start.toISO({ suppressMilliseconds: true })!;
      const id = `mlb:${pk}`;
      const existing = this.deps.repo.event(id);
      const homeId = `mlb-team:${g.teams.home.team.id}`;
      const awayId = `mlb-team:${g.teams.away.team.id}`;
      for (const [tid, name] of [
        [homeId, g.teams.home.team.name],
        [awayId, g.teams.away.team.name],
      ] as const) {
        if (!this.deps.repo.participant(tid)) {
          this.deps.repo.upsertParticipant({ id: tid, dataset: "live", sport_key: SPORT, name: name ?? tid, short_name: null, abbreviation: null, aliases: [], meta: {} });
        }
      }
      const estFinal = new Date(Math.min(Date.parse(now), Date.parse(startIso) + 4 * 3600000)).toISOString().replace(/\.\d{3}Z$/, "Z");
      const knownAt = new Date(Math.min(Date.parse(now), Date.parse(startIso) - 7 * 86400000)).toISOString().replace(/\.\d{3}Z$/, "Z");
      const roof = g.venue?.fieldInfo?.roofType ?? null;
      const coords = g.venue?.location?.defaultCoordinates;
      const originalDate = entries.length > 1 ? entries[0].gameDate : g.rescheduledFromDate ?? g.rescheduledFrom ?? null;
      this.deps.repo.upsertEvent({
        id,
        dataset: "live",
        sport_key: SPORT,
        league: "MLB",
        season: g.season ?? startIso.slice(0, 4),
        home_id: homeId,
        away_id: awayId,
        start_time: startIso,
        status,
        // For past games imported in bulk, the status became known around the game itself, not at import time.
        status_at:
          existing?.status === status
            ? existing.status_at
            : status === "final"
              ? existing?.final_at ?? estFinal
              : new Date(Math.min(Date.parse(now), Date.parse(startIso))).toISOString().replace(/\.\d{3}Z$/, "Z"),
        final_at: status === "final" ? existing?.final_at ?? estFinal : null,
        home_score: status === "final" || status === "suspended" ? g.teams.home.score ?? null : null,
        away_score: status === "final" || status === "suspended" ? g.teams.away.score ?? null : null,
        regulation_home: null,
        regulation_away: null,
        final_is_regulation: 0,
        neutral_site: 0,
        venue_name: g.venue?.name ?? null,
        venue_lat: coords?.latitude ?? null,
        venue_lon: coords?.longitude ?? null,
        venue_tz: g.venue?.timeZone?.id ?? null,
        indoor: roof && /dome/i.test(roof) ? 1 : 0,
        rescheduled_from: originalDate && !g.resumedFrom ? originalDate : null,
        game_number: g.gameNumber ?? 1,
        source: ID,
        source_updated_at: now,
        retrieved_at: now,
        known_at: existing?.known_at ?? knownAt,
        extra: { gamePk: pk, detailedState: g.status.detailedState, roofType: roof, resumed: !!g.resumedFrom, finalAtEstimated: status === "final" && !existing?.final_at },
      });
      events++;
      for (const side of ["home", "away"] as const) {
        const teamId = side === "home" ? homeId : awayId;
        const players = side === "home" ? g.lineups?.homePlayers : g.lineups?.awayPlayers;
        const pp = g.teams[side].probablePitcher;
        if (players?.length) {
          lineups.push({
            dataset: "live", event_id: id, participant_id: teamId, status: "confirmed", starter: pp?.fullName ?? null, starter_status: pp ? "probable" : null,
            players: JSON.stringify(players.map((p) => ({ name: p.fullName, position: p.primaryPosition?.abbreviation }))),
            source: "MLB Stats API (posted lineup)", source_url: `https://www.mlb.com/gameday/${pk}`, source_time: null, retrieved_at: now,
          });
        } else if (pp?.fullName) {
          lineups.push({
            dataset: "live", event_id: id, participant_id: teamId, status: "probable", starter: pp.fullName, starter_status: "probable", players: "[]",
            source: "MLB Stats API (probable pitcher)", source_url: `https://www.mlb.com/gameday/${pk}`, source_time: null, retrieved_at: now,
          });
        }
      }
    }
    // Only store a lineup snapshot when it differs from the latest one we have.
    const fresh = lineups.filter((l) => {
      const prev = this.deps.repo.lineupsAsOf(l.event_id, now).find((x) => x.participant_id === l.participant_id);
      return !prev || prev.status !== l.status || prev.players !== l.players || prev.starter !== l.starter;
    });
    this.deps.repo.insertLineups(fresh);
    return { events, lineups: fresh.length, rejected };
  }

  /** Import past and current seasons (scores only) so the model has history to learn from. */
  async importHistory(currentSeason: string, previousSeasons: number): Promise<{ seasons: string[]; events: number }> {
    const seasons: string[] = [];
    let events = 0;
    for (let i = previousSeasons; i >= 0; i--) {
      const season = String(Number(currentSeason) - i);
      const isPast = i > 0;
      const r = await this.getJson("/schedule", { sportId: "1", startDate: `${season}-03-01`, endDate: `${season}-11-30`, gameType: MLB_GAME_TYPES }, isPast ? 7 * 86400 : 12 * 3600);
      events += this.ingestSchedule(r, iso(this.deps.now())).events;
      seasons.push(season);
    }
    setObserved(this.deps.db, ID, { historySeasons: seasons, historyImportedAt: iso(this.deps.now()) });
    this.deps.log.add("info", ID, `Imported MLB history for ${seasons.join(", ")} (${events} games).`);
    return { seasons, events };
  }

  /** Injured-list status from each team's 40-man roster. */
  async refreshInjuries(teamIds: string[], date: string): Promise<number> {
    const now = iso(this.deps.now());
    let n = 0;
    for (const tid of teamIds) {
      const mlbId = tid.replace("mlb-team:", "");
      if (!/^\d+$/.test(mlbId)) continue;
      const data = await this.getJson(`/teams/${mlbId}/roster`, { rosterType: "40Man", date }, 3 * 3600);
      n += this.ingestRoster(tid, data, now);
    }
    this.deps.repo.recordFeedCheck("live", SPORT, "injuries", now, `${teamIds.length} team rosters`);
    return n;
  }

  ingestRoster(teamId: string, data: unknown, retrievedAt: string): number {
    const parsed = rosterSchema.safeParse(data);
    if (!parsed.success) throw new ProviderError("Unexpected MLB roster response", "bad_response");
    const mlbId = teamId.replace("mlb-team:", "");
    const rows: InjuryRecord[] = [];
    const current = new Set<string>();
    for (const r of parsed.data.roster) {
      const code = r.status?.code ?? "A";
      const name = r.person.fullName ?? `Player ${r.person.id}`;
      if (/^D\d+$/.test(code)) {
        current.add(name);
        rows.push({
          dataset: "live", sport_key: SPORT, participant_id: teamId, player_id: `mlb-player:${r.person.id}`, player_name: name, status: "injured_list",
          detail: r.status?.description ?? `Injured list (${code})`, source: "MLB Stats API 40-man roster", source_url: `https://${MLB_HOST}/api/v1/teams/${mlbId}/roster?rosterType=40Man`,
          confirmation: "official", source_time: null, retrieved_at: retrievedAt,
        });
      }
    }
    // Players previously listed as injured who are no longer on the IL become "active".
    const prev = this.deps.repo.injuriesAsOf("live", [teamId], retrievedAt).filter((i) => i.source === "MLB Stats API 40-man roster");
    for (const p of prev) {
      if (!current.has(p.player_name)) {
        rows.push({ ...p, id: undefined, status: "active", detail: "No longer on the injured list", retrieved_at: retrievedAt });
      }
    }
    return this.deps.repo.insertInjuries(rows);
  }

  todayRange(localDate: string): { start: string; end: string } {
    return { start: addDaysToDate(localDate, -1), end: addDaysToDate(localDate, 1) };
  }
}

export type { EventRecord };
