// Data access with explicit information cut-offs. Every read used for analysis takes an
// `asOf` instant and only returns what was known at that instant, which is what makes
// historical replay and leakage-free evaluation possible.

import { seasonOf } from "../shared/contracts";
import type { Db } from "./db";
import { json } from "./db";
import type { ContractKey, OutcomeKey } from "../shared/contracts";
import { contractId } from "../shared/contracts";
import type { EventStatus } from "../shared/settlement";

export type Dataset = "demo" | "live";

export interface Participant {
  id: string;
  dataset: Dataset;
  sport_key: string;
  name: string;
  short_name: string | null;
  abbreviation: string | null;
  aliases: string[];
  meta: Record<string, unknown>;
}

export interface EventRecord {
  id: string;
  dataset: Dataset;
  sport_key: string;
  league: string;
  season: string | null;
  home_id: string;
  away_id: string;
  start_time: string;
  status: EventStatus;
  status_at: string | null;
  final_at: string | null;
  home_score: number | null;
  away_score: number | null;
  regulation_home: number | null;
  regulation_away: number | null;
  final_is_regulation: number;
  neutral_site: number;
  venue_name: string | null;
  venue_lat: number | null;
  venue_lon: number | null;
  venue_tz: string | null;
  indoor: number;
  rescheduled_from: string | null;
  game_number: number;
  source: string;
  source_updated_at: string | null;
  retrieved_at: string;
  known_at: string;
  extra: string;
}

export interface QuoteRecord {
  id?: number;
  dataset: Dataset;
  event_id: string;
  provider: string;
  book_key: string;
  book_title: string;
  contract: ContractKey;
  contract_id: string;
  provider_market: string;
  line: number | null;
  outcome: OutcomeKey;
  price_decimal: number;
  source_time: string;
  retrieved_at: string;
  known_at: string;
}

export interface InjuryRecord {
  id?: number;
  dataset: Dataset;
  sport_key: string;
  participant_id: string;
  player_id: string | null;
  player_name: string;
  status: string; // out | injured_list | doubtful | questionable | day_to_day | probable | active
  detail: string | null;
  source: string;
  source_url: string | null;
  confirmation: "official" | "reported" | "speculative";
  source_time: string | null;
  retrieved_at: string;
}

export interface LineupRecord {
  id?: number;
  dataset: Dataset;
  event_id: string;
  participant_id: string;
  status: "confirmed" | "probable" | "unknown";
  starter: string | null;
  starter_status: string | null;
  players: string; // JSON array of {name, position}
  source: string;
  source_url: string | null;
  source_time: string | null;
  retrieved_at: string;
}

export interface NewsRecord {
  id?: number;
  dataset: Dataset;
  sport_key: string | null;
  participant_ids: string; // JSON
  title: string;
  summary: string | null;
  url: string;
  source_name: string;
  source_tier: "official" | "media" | "unverified";
  claim_type: "official" | "report" | "speculation";
  published_at: string | null;
  retrieved_at: string;
  dedupe_key: string;
  duplicate_of: number | null;
}

export interface WeatherRecord {
  id?: number;
  dataset: Dataset;
  event_id: string;
  forecast_for: string;
  temperature_c: number | null;
  precip_probability: number | null;
  wind_kph: number | null;
  source: string;
  source_url: string | null;
  source_time: string | null;
  retrieved_at: string;
}

export const normalizeAlias = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bst\.?\s/g, "st ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const FINAL_LIKE: EventStatus[] = ["final"];
const VOID_LIKE: EventStatus[] = ["postponed", "cancelled"];

/** The event as it was known at `asOf`: later results and status changes are masked. */
export function eventAsOf(e: EventRecord, asOf: string): EventRecord {
  const v = { ...e };
  if (FINAL_LIKE.includes(e.status) && (!e.final_at || e.final_at > asOf)) {
    v.status = e.start_time <= asOf ? "in_progress" : "scheduled";
    v.home_score = v.away_score = v.regulation_home = v.regulation_away = null;
    v.final_at = null;
  } else if (VOID_LIKE.includes(e.status) && (!e.status_at || e.status_at > asOf)) {
    v.status = "scheduled";
  } else if (e.status === "suspended" && e.status_at && e.status_at > asOf) {
    v.status = e.start_time <= asOf ? "in_progress" : "scheduled";
    v.home_score = v.away_score = null;
  }
  if (v.status === "in_progress") v.home_score = v.away_score = null; // no live scores are modelled
  return v;
}

export class Repo {
  constructor(readonly db: Db) {}

  // ---------- participants ----------
  upsertParticipant(p: Participant): void {
    this.db.run(
      `INSERT INTO participants(id, dataset, sport_key, name, short_name, abbreviation, aliases, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, short_name=excluded.short_name,
         abbreviation=excluded.abbreviation, aliases=excluded.aliases, meta=excluded.meta`,
      [p.id, p.dataset, p.sport_key, p.name, p.short_name, p.abbreviation, JSON.stringify(p.aliases), JSON.stringify(p.meta)],
    );
    for (const a of new Set([p.name, p.short_name, p.abbreviation, ...p.aliases].filter(Boolean) as string[])) {
      this.db.run(
        "INSERT INTO participant_aliases(dataset, sport_key, alias, participant_id) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET participant_id = excluded.participant_id",
        [p.dataset, p.sport_key, normalizeAlias(a), p.id],
      );
    }
  }

  resolveParticipant(dataset: Dataset, sportKey: string, name: string): string | null {
    const r = this.db.get<{ participant_id: string }>(
      "SELECT participant_id FROM participant_aliases WHERE dataset = ? AND sport_key = ? AND alias = ?",
      [dataset, sportKey, normalizeAlias(name)],
    );
    return r?.participant_id ?? null;
  }

  participant(id: string): Participant | null {
    const r = this.db.get("SELECT * FROM participants WHERE id = ?", [id]);
    if (!r) return null;
    return { ...r, aliases: json(r.aliases, []), meta: json(r.meta, {}) } as unknown as Participant;
  }

  participants(dataset: Dataset, sportKey?: string): Participant[] {
    const rows = sportKey
      ? this.db.all("SELECT * FROM participants WHERE dataset = ? AND sport_key = ? ORDER BY name", [dataset, sportKey])
      : this.db.all("SELECT * FROM participants WHERE dataset = ? ORDER BY name", [dataset]);
    return rows.map((r) => ({ ...r, aliases: json(r.aliases, []), meta: json(r.meta, {}) }) as unknown as Participant);
  }

  // ---------- events ----------
  upsertEvent(e: Omit<EventRecord, "extra"> & { extra?: Record<string, unknown> }): void {
    this.db.run(
      `INSERT INTO events(id, dataset, sport_key, league, season, home_id, away_id, start_time, status, status_at, final_at,
         home_score, away_score, regulation_home, regulation_away, final_is_regulation, neutral_site, venue_name, venue_lat,
         venue_lon, venue_tz, indoor, rescheduled_from, game_number, source, source_updated_at, retrieved_at, known_at, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         start_time=excluded.start_time,
         status=excluded.status,
         status_at=CASE WHEN events.status = excluded.status THEN events.status_at ELSE excluded.status_at END,
         final_at=CASE WHEN events.final_at IS NOT NULL AND events.status = excluded.status THEN events.final_at ELSE excluded.final_at END,
         home_score=excluded.home_score, away_score=excluded.away_score,
         regulation_home=excluded.regulation_home, regulation_away=excluded.regulation_away,
         final_is_regulation=excluded.final_is_regulation, neutral_site=excluded.neutral_site,
         venue_name=COALESCE(excluded.venue_name, events.venue_name), venue_lat=COALESCE(excluded.venue_lat, events.venue_lat),
         venue_lon=COALESCE(excluded.venue_lon, events.venue_lon), venue_tz=COALESCE(excluded.venue_tz, events.venue_tz),
         indoor=excluded.indoor, rescheduled_from=COALESCE(excluded.rescheduled_from, events.rescheduled_from),
         game_number=excluded.game_number, source_updated_at=excluded.source_updated_at, retrieved_at=excluded.retrieved_at,
         known_at=MIN(events.known_at, excluded.known_at),
         extra=excluded.extra`,
      [
        e.id, e.dataset, e.sport_key, e.league, e.season ?? seasonOf(e.sport_key, e.start_time), e.home_id, e.away_id, e.start_time, e.status, e.status_at, e.final_at,
        e.home_score, e.away_score, e.regulation_home, e.regulation_away, e.final_is_regulation, e.neutral_site, e.venue_name,
        e.venue_lat, e.venue_lon, e.venue_tz, e.indoor, e.rescheduled_from, e.game_number, e.source, e.source_updated_at,
        e.retrieved_at, e.known_at, JSON.stringify(e.extra ?? {}),
      ],
    );
  }

  /** Fill missing season labels (older databases) with the sport's own season rule. */
  backfillSeasons(): number {
    const rows = this.db.all<{ id: string; sport_key: string; start_time: string }>("SELECT id, sport_key, start_time FROM events WHERE season IS NULL");
    this.db.tx(() => {
      for (const r of rows) this.db.run("UPDATE events SET season = ? WHERE id = ?", [seasonOf(r.sport_key, r.start_time), r.id]);
    });
    return rows.length;
  }

  event(id: string): EventRecord | null {
    return (this.db.get<EventRecord>("SELECT * FROM events WHERE id = ?", [id]) as EventRecord) ?? null;
  }

  /** Events whose start falls in [startUtc, endUtc) and which were known at asOf. */
  eventsInWindow(dataset: Dataset, startUtc: string, endUtc: string, asOf: string, sportKeys?: string[]): EventRecord[] {
    const rows = this.db.all<EventRecord>(
      "SELECT * FROM events WHERE dataset = ? AND start_time >= ? AND start_time < ? AND known_at <= ? ORDER BY start_time, id",
      [dataset, startUtc, endUtc, asOf],
    );
    return (sportKeys?.length ? rows.filter((r) => sportKeys.includes(r.sport_key)) : rows).map((e) => eventAsOf(e, asOf));
  }

  searchEvents(dataset: Dataset, q: string, fromUtc: string, toUtc: string, asOf: string, limit = 200): EventRecord[] {
    const needle = normalizeAlias(q);
    const rows = this.db.all<EventRecord & { hn: string; an: string }>(
      `SELECT e.*, h.name AS hn, a.name AS an FROM events e
         JOIN participants h ON h.id = e.home_id JOIN participants a ON a.id = e.away_id
       WHERE e.dataset = ? AND e.start_time >= ? AND e.start_time < ? AND e.known_at <= ?
       ORDER BY e.start_time LIMIT 3000`,
      [dataset, fromUtc, toUtc, asOf],
    );
    const hits = needle
      ? rows.filter((r) => {
          const hay = normalizeAlias(`${r.hn} ${r.an} ${r.league}`);
          return needle.split(" ").every((w) => hay.includes(w));
        })
      : rows;
    return hits.slice(0, limit).map(({ hn: _h, an: _a, ...e }) => eventAsOf(e as EventRecord, asOf));
  }

  /** Completed games known by asOf, oldest first (model training input). */
  finalsBefore(dataset: Dataset, sportKey: string, asOf: string): EventRecord[] {
    return this.db.all<EventRecord>(
      `SELECT * FROM events WHERE dataset = ? AND sport_key = ? AND status = 'final' AND final_at IS NOT NULL
         AND final_at <= ? AND start_time < ? AND home_score IS NOT NULL ORDER BY start_time, id`,
      [dataset, sportKey, asOf, asOf],
    );
  }

  /** All scheduled-or-played events for a sport (used for rest-day features; schedules are public in advance). */
  scheduleFor(dataset: Dataset, sportKey: string, fromUtc: string, toUtc: string): { id: string; home_id: string; away_id: string; start_time: string; status: string }[] {
    return this.db.all(
      "SELECT id, home_id, away_id, start_time, status FROM events WHERE dataset = ? AND sport_key = ? AND start_time >= ? AND start_time < ? ORDER BY start_time",
      [dataset, sportKey, fromUtc, toUtc],
    );
  }

  linkEvent(provider: string, providerEventId: string, eventId: string, method: string, at: string): void {
    this.db.run(
      "INSERT INTO event_links(provider, provider_event_id, event_id, matched_at, method) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET event_id = excluded.event_id, matched_at = excluded.matched_at, method = excluded.method",
      [provider, providerEventId, eventId, at, method],
    );
  }

  linkedEvent(provider: string, providerEventId: string): string | null {
    return this.db.get<{ event_id: string }>("SELECT event_id FROM event_links WHERE provider = ? AND provider_event_id = ?", [provider, providerEventId])?.event_id ?? null;
  }

  // ---------- quotes ----------
  /** Insert quote snapshots. Exact duplicates (same book, contract, outcome, price time and retrieval) are skipped. */
  insertQuotes(rows: QuoteRecord[], opts: { skipDedupe?: boolean } = {}): number {
    let n = 0;
    this.db.tx(() => {
      for (const q of rows) {
        const cid = q.contract_id ?? contractId(q.contract, q.line);
        if (
          !opts.skipDedupe &&
          this.db.get(
            "SELECT 1 FROM quotes WHERE event_id = ? AND contract_id = ? AND known_at = ? AND book_key = ? AND outcome = ? AND source_time = ? AND retrieved_at = ? LIMIT 1",
            [q.event_id, cid, q.known_at, q.book_key, q.outcome, q.source_time, q.retrieved_at],
          )
        ) {
          continue;
        }
        n += this.db.run(
          `INSERT INTO quotes(dataset, event_id, provider, book_key, book_title, contract, contract_id, provider_market, line, outcome, price_decimal, source_time, retrieved_at, known_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [q.dataset, q.event_id, q.provider, q.book_key, q.book_title, q.contract, cid, q.provider_market, q.line, q.outcome, q.price_decimal, q.source_time, q.retrieved_at, q.known_at],
        ).changes;
      }
    });
    return n;
  }

  /** Latest quote per (book, contract, line, outcome) known at asOf. */
  latestQuotes(eventId: string, asOf: string): QuoteRecord[] {
    return this.db.all<QuoteRecord>(
      `SELECT q.* FROM quotes q
       JOIN (SELECT book_key, contract_id, outcome, MAX(known_at) AS k FROM quotes
             WHERE event_id = ? AND known_at <= ? AND source_time <= ? GROUP BY book_key, contract_id, outcome) m
         ON q.book_key = m.book_key AND q.contract_id = m.contract_id AND q.outcome = m.outcome AND q.known_at = m.k
       WHERE q.event_id = ? AND q.source_time <= ?
       ORDER BY q.contract_id, q.book_key, q.outcome, q.id DESC`,
      [eventId, asOf, asOf, eventId, asOf],
    ).filter((q, i, arr) => i === 0 || !(arr[i - 1].book_key === q.book_key && arr[i - 1].contract_id === q.contract_id && arr[i - 1].outcome === q.outcome));
  }

  quoteHistory(eventId: string, contractIdValue: string, asOf: string): QuoteRecord[] {
    return this.db.all<QuoteRecord>(
      "SELECT * FROM quotes WHERE event_id = ? AND contract_id = ? AND known_at <= ? AND source_time <= ? ORDER BY known_at, book_key, outcome",
      [eventId, contractIdValue, asOf, asOf],
    );
  }

  // ---------- injuries / lineups / news / weather ----------
  insertInjuries(rows: InjuryRecord[]): number {
    let n = 0;
    this.db.tx(() => {
      for (const r of rows) {
        n += this.db.run(
          `INSERT OR IGNORE INTO injuries(dataset, sport_key, participant_id, player_id, player_name, status, detail, source, source_url, confirmation, source_time, retrieved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [r.dataset, r.sport_key, r.participant_id, r.player_id, r.player_name, r.status, r.detail, r.source, r.source_url, r.confirmation, r.source_time, r.retrieved_at],
        ).changes;
      }
    });
    return n;
  }

  /** Latest record per (team, player, source) known at asOf. Players whose latest status is "active" are dropped. */
  injuriesAsOf(dataset: Dataset, teamIds: string[], asOf: string): InjuryRecord[] {
    if (!teamIds.length) return [];
    const ph = teamIds.map(() => "?").join(",");
    const rows = this.db.all<InjuryRecord>(
      `SELECT i.* FROM injuries i
       JOIN (SELECT participant_id, player_name, source, MAX(retrieved_at) AS r FROM injuries
             WHERE dataset = ? AND participant_id IN (${ph}) AND retrieved_at <= ? AND (source_time IS NULL OR source_time <= ?)
             GROUP BY participant_id, player_name, source) m
         ON i.participant_id = m.participant_id AND i.player_name = m.player_name AND i.source = m.source AND i.retrieved_at = m.r
       WHERE i.dataset = ? ORDER BY i.participant_id, i.player_name`,
      [dataset, ...teamIds, asOf, asOf, dataset],
    );
    return rows.filter((r) => r.status !== "active");
  }

  /** True if any injury information for these teams had been retrieved by asOf (distinguishes "none reported" from "not checked"). */
  injuryFeedSeen(dataset: Dataset, sportKey: string, asOf: string): boolean {
    return (
      !!this.db.get("SELECT 1 FROM injuries WHERE dataset = ? AND sport_key = ? AND retrieved_at <= ? LIMIT 1", [dataset, sportKey, asOf]) ||
      !!this.db.get("SELECT 1 FROM feed_checks WHERE dataset = ? AND sport_key = ? AND feed = 'injuries' AND checked_at <= ? LIMIT 1", [dataset, sportKey, asOf])
    );
  }

  recordFeedCheck(dataset: Dataset, sportKey: string, feed: string, at: string, detail?: string): void {
    this.db.run("INSERT OR IGNORE INTO feed_checks(dataset, sport_key, feed, checked_at, detail) VALUES (?, ?, ?, ?, ?)", [dataset, sportKey, feed, at, detail ?? null]);
  }

  insertLineups(rows: LineupRecord[]): void {
    this.db.tx(() => {
      for (const r of rows) {
        this.db.run(
          `INSERT OR IGNORE INTO lineups(dataset, event_id, participant_id, status, starter, starter_status, players, source, source_url, source_time, retrieved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [r.dataset, r.event_id, r.participant_id, r.status, r.starter, r.starter_status, r.players, r.source, r.source_url, r.source_time, r.retrieved_at],
        );
      }
    });
  }

  lineupsAsOf(eventId: string, asOf: string): LineupRecord[] {
    return this.db.all<LineupRecord>(
      `SELECT l.* FROM lineups l JOIN (SELECT participant_id, MAX(retrieved_at) AS r FROM lineups WHERE event_id = ? AND retrieved_at <= ? GROUP BY participant_id) m
         ON l.participant_id = m.participant_id AND l.retrieved_at = m.r WHERE l.event_id = ? ORDER BY l.id DESC`,
      [eventId, asOf, eventId],
    ).filter((r, i, arr) => arr.findIndex((x) => x.participant_id === r.participant_id) === i);
  }

  insertNews(rows: NewsRecord[]): number {
    let n = 0;
    this.db.tx(() => {
      for (const r of rows) {
        n += this.db.run(
          `INSERT OR IGNORE INTO news(dataset, sport_key, participant_ids, title, summary, url, source_name, source_tier, claim_type, published_at, retrieved_at, dedupe_key, duplicate_of)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [r.dataset, r.sport_key, r.participant_ids, r.title, r.summary, r.url, r.source_name, r.source_tier, r.claim_type, r.published_at, r.retrieved_at, r.dedupe_key, r.duplicate_of],
        ).changes;
      }
    });
    return n;
  }

  newsAsOf(dataset: Dataset, asOf: string, opts: { teamIds?: string[]; sinceUtc?: string; limit?: number } = {}): NewsRecord[] {
    const rows = this.db.all<NewsRecord>(
      `SELECT * FROM news WHERE dataset = ? AND retrieved_at <= ? AND (published_at IS NULL OR published_at <= ?)
         AND (? IS NULL OR published_at >= ?) ORDER BY COALESCE(published_at, retrieved_at) DESC LIMIT 2000`,
      [dataset, asOf, asOf, opts.sinceUtc ?? null, opts.sinceUtc ?? null],
    );
    const filtered = opts.teamIds?.length
      ? rows.filter((r) => {
          const ids: string[] = json(r.participant_ids, []);
          return ids.some((id) => opts.teamIds!.includes(id));
        })
      : rows;
    return filtered.slice(0, opts.limit ?? 200);
  }

  insertWeather(rows: WeatherRecord[]): void {
    this.db.tx(() => {
      for (const r of rows) {
        this.db.run(
          `INSERT INTO weather(dataset, event_id, forecast_for, temperature_c, precip_probability, wind_kph, source, source_url, source_time, retrieved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [r.dataset, r.event_id, r.forecast_for, r.temperature_c, r.precip_probability, r.wind_kph, r.source, r.source_url, r.source_time, r.retrieved_at],
        );
      }
    });
  }

  weatherAsOf(eventId: string, asOf: string): WeatherRecord | null {
    return (
      this.db.get<WeatherRecord>("SELECT * FROM weather WHERE event_id = ? AND retrieved_at <= ? ORDER BY retrieved_at DESC, id DESC LIMIT 1", [eventId, asOf]) ?? null
    );
  }

  players(teamId: string): { id: string; name: string; position: string | null; role: string | null }[] {
    return this.db.all("SELECT id, name, position, role FROM players WHERE participant_id = ? ORDER BY role, name", [teamId]);
  }
}
