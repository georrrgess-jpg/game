// SQLite persistence via Node's built-in node:sqlite (no native add-ons to compile).

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type Row = Record<string, any>;
export type Param = SQLInputValue | boolean | undefined;

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  dataset TEXT NOT NULL,
  sport_key TEXT NOT NULL,
  name TEXT NOT NULL,
  short_name TEXT,
  abbreviation TEXT,
  aliases TEXT NOT NULL DEFAULT '[]',
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_participants_sport ON participants(dataset, sport_key);

CREATE TABLE IF NOT EXISTS participant_aliases (
  dataset TEXT NOT NULL,
  sport_key TEXT NOT NULL,
  alias TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  PRIMARY KEY (dataset, sport_key, alias)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  dataset TEXT NOT NULL,
  sport_key TEXT NOT NULL,
  league TEXT NOT NULL,
  season TEXT,
  home_id TEXT NOT NULL,
  away_id TEXT NOT NULL,
  start_time TEXT NOT NULL,
  status TEXT NOT NULL,
  status_at TEXT,
  final_at TEXT,
  home_score INTEGER,
  away_score INTEGER,
  regulation_home INTEGER,
  regulation_away INTEGER,
  final_is_regulation INTEGER NOT NULL DEFAULT 0,
  neutral_site INTEGER NOT NULL DEFAULT 0,
  venue_name TEXT,
  venue_lat REAL,
  venue_lon REAL,
  venue_tz TEXT,
  indoor INTEGER NOT NULL DEFAULT 0,
  rescheduled_from TEXT,
  game_number INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  source_updated_at TEXT,
  retrieved_at TEXT NOT NULL,
  known_at TEXT NOT NULL,
  extra TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(dataset, start_time);
CREATE INDEX IF NOT EXISTS idx_events_sport ON events(dataset, sport_key, start_time);

CREATE TABLE IF NOT EXISTS event_links (
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  matched_at TEXT NOT NULL,
  method TEXT NOT NULL,
  PRIMARY KEY (provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS idx_event_links_event ON event_links(event_id);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset TEXT NOT NULL,
  event_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  book_key TEXT NOT NULL,
  book_title TEXT NOT NULL,
  contract TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  provider_market TEXT NOT NULL,
  line REAL,
  outcome TEXT NOT NULL,
  price_decimal REAL NOT NULL,
  source_time TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  known_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quotes_event ON quotes(event_id, contract_id, known_at);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  dataset TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  position TEXT,
  role TEXT
);
CREATE INDEX IF NOT EXISTS idx_players_team ON players(participant_id);

CREATE TABLE IF NOT EXISTS injuries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset TEXT NOT NULL,
  sport_key TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  player_id TEXT,
  player_name TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  source TEXT NOT NULL,
  source_url TEXT,
  confirmation TEXT NOT NULL,
  source_time TEXT,
  retrieved_at TEXT NOT NULL,
  UNIQUE (dataset, participant_id, player_name, status, source, retrieved_at)
);
CREATE INDEX IF NOT EXISTS idx_injuries_team ON injuries(dataset, participant_id, retrieved_at);

CREATE TABLE IF NOT EXISTS lineups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset TEXT NOT NULL,
  event_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  starter TEXT,
  starter_status TEXT,
  players TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL,
  source_url TEXT,
  source_time TEXT,
  retrieved_at TEXT NOT NULL,
  UNIQUE (event_id, participant_id, status, retrieved_at)
);
CREATE INDEX IF NOT EXISTS idx_lineups_event ON lineups(event_id, retrieved_at);

CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset TEXT NOT NULL,
  sport_key TEXT,
  participant_ids TEXT NOT NULL DEFAULT '[]',
  title TEXT NOT NULL,
  summary TEXT,
  url TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_tier TEXT NOT NULL,
  claim_type TEXT NOT NULL,
  published_at TEXT,
  retrieved_at TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  duplicate_of INTEGER,
  UNIQUE (dataset, url)
);
CREATE INDEX IF NOT EXISTS idx_news_time ON news(dataset, published_at);

CREATE TABLE IF NOT EXISTS weather (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset TEXT NOT NULL,
  event_id TEXT NOT NULL,
  forecast_for TEXT NOT NULL,
  temperature_c REAL,
  precip_probability REAL,
  wind_kph REAL,
  source TEXT NOT NULL,
  source_url TEXT,
  source_time TEXT,
  retrieved_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_weather_event ON weather(event_id, retrieved_at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  dataset TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT,
  results_hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS forecasts (
  id TEXT PRIMARY KEY,
  dataset TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  author TEXT NOT NULL,
  event_id TEXT NOT NULL,
  contract TEXT NOT NULL,
  line REAL,
  outcome_probs TEXT,
  pick TEXT,
  model_version TEXT,
  info_as_of TEXT NOT NULL,
  created_at TEXT NOT NULL,
  event_start_snapshot TEXT NOT NULL,
  quoted_price REAL,
  quoted_book TEXT,
  quote_retrieved_at TEXT,
  input_snapshot TEXT NOT NULL,
  abstain_reason TEXT,
  run_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_forecasts_event ON forecasts(event_id);
CREATE INDEX IF NOT EXISTS idx_forecasts_session ON forecasts(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_forecasts_kind ON forecasts(dataset, kind, created_at);

CREATE TRIGGER IF NOT EXISTS forecasts_immutable_update BEFORE UPDATE ON forecasts
BEGIN SELECT RAISE(ABORT, 'forecasts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS forecasts_immutable_delete BEFORE DELETE ON forecasts
BEGIN SELECT RAISE(ABORT, 'forecasts are immutable'); END;

CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  dataset TEXT NOT NULL,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  starting_points REAL NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS experiment_entries (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  forecast_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  stake REAL NOT NULL,
  price_decimal REAL NOT NULL,
  book TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_exp ON experiment_entries(experiment_id);
CREATE TRIGGER IF NOT EXISTS entries_immutable_update BEFORE UPDATE ON experiment_entries
BEGIN SELECT RAISE(ABORT, 'experiment entries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS entries_immutable_delete BEFORE DELETE ON experiment_entries
BEGIN SELECT RAISE(ABORT, 'experiment entries are immutable'); END;

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  details TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_at ON activity_log(at);

CREATE TABLE IF NOT EXISTS provider_status (
  provider TEXT PRIMARY KEY,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  last_error_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  quota_remaining REAL,
  quota_used REAL,
  quota_last_cost REAL,
  quota_exhausted INTEGER NOT NULL DEFAULT 0,
  usage_day TEXT,
  requests_today INTEGER NOT NULL DEFAULT 0,
  credits_today REAL NOT NULL DEFAULT 0,
  observed TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS http_cache (
  key TEXT PRIMARY KEY,
  status INTEGER NOT NULL,
  headers TEXT NOT NULL,
  body TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  name TEXT PRIMARY KEY,
  last_run_at TEXT,
  last_success_at TEXT,
  last_result TEXT,
  next_run_at TEXT,
  running INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS feed_checks (
  dataset TEXT NOT NULL,
  sport_key TEXT NOT NULL,
  feed TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  detail TEXT,
  PRIMARY KEY (dataset, sport_key, feed, checked_at)
);

CREATE TABLE IF NOT EXISTS ai_usage (
  day TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0
);
`;

export class Db {
  readonly raw: DatabaseSync;
  private stmtCache = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.raw.exec(SCHEMA);
    const v = this.get("SELECT value FROM meta WHERE key = 'schema_version'");
    if (!v) this.run("INSERT INTO meta(key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
  }

  private stmt(sql: string) {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  private norm(params: Param[]): SQLInputValue[] {
    return params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p));
  }

  all<T = Row>(sql: string, params: Param[] = []): T[] {
    return this.stmt(sql).all(...this.norm(params)) as T[];
  }

  get<T = Row>(sql: string, params: Param[] = []): T | undefined {
    return this.stmt(sql).get(...this.norm(params)) as T | undefined;
  }

  run(sql: string, params: Param[] = []): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...this.norm(params));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** Run fn inside a transaction (nested calls join the outer transaction). */
  private depth = 0;
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    } finally {
      this.depth--;
    }
  }

  /** Fold the write-ahead log back into the main file (keeps the data folder small after bulk writes). */
  checkpoint(): void {
    this.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    this.stmtCache.clear();
    this.raw.close();
  }
}

export const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (s == null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
