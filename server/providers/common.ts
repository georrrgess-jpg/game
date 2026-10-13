import type { Db } from "../db";
import type { ActivityLog } from "../activity";
import type { HttpClient } from "../http";
import type { Repo } from "../repo";
import type { Settings } from "../settings";
import type { ServerConfig } from "../config";
import { localDateOf } from "../../shared/time";

export interface ProviderDeps {
  db: Db;
  repo: Repo;
  http: HttpClient;
  log: ActivityLog;
  settings: () => Settings;
  config: ServerConfig;
  now: () => Date;
}

export interface ProviderCapabilities {
  id: string;
  name: string;
  roles: string[];
  docsUrl: string;
  requiresKey: boolean;
  keyEnvVar: string | null;
  licensing: string;
  coverage: string[];
  history: string;
  costNotes: string;
  limitations: string[];
}

export interface ProviderStatusRow {
  provider: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  quota_remaining: number | null;
  quota_used: number | null;
  quota_last_cost: number | null;
  quota_exhausted: number;
  usage_day: string | null;
  requests_today: number;
  credits_today: number;
  observed: string;
}

export function providerStatus(db: Db, id: string): ProviderStatusRow | null {
  return db.get<ProviderStatusRow>("SELECT * FROM provider_status WHERE provider = ?", [id]) ?? null;
}

/** Count a request (and optional credits) against today's usage in the configured timezone. */
export function recordUsage(deps: ProviderDeps, id: string, credits: number): void {
  const day = localDateOf(deps.now().toISOString(), deps.settings().timezone);
  deps.db.run("INSERT OR IGNORE INTO provider_status(provider) VALUES (?)", [id]);
  deps.db.run(
    `UPDATE provider_status SET
       requests_today = CASE WHEN usage_day = ? THEN requests_today + 1 ELSE 1 END,
       credits_today = CASE WHEN usage_day = ? THEN credits_today + ? ELSE ? END,
       usage_day = ?
     WHERE provider = ?`,
    [day, day, credits, credits, day, id],
  );
}

export function usageToday(deps: ProviderDeps, id: string): { requests: number; credits: number } {
  const day = localDateOf(deps.now().toISOString(), deps.settings().timezone);
  const row = providerStatus(deps.db, id);
  if (!row || row.usage_day !== day) return { requests: 0, credits: 0 };
  return { requests: row.requests_today, credits: row.credits_today };
}

export function setObserved(db: Db, id: string, observed: Record<string, unknown>): void {
  db.run("INSERT OR IGNORE INTO provider_status(provider) VALUES (?)", [id]);
  const cur = db.get<{ observed: string }>("SELECT observed FROM provider_status WHERE provider = ?", [id]);
  let merged: Record<string, unknown> = {};
  try {
    merged = JSON.parse(cur?.observed ?? "{}");
  } catch {
    merged = {};
  }
  db.run("UPDATE provider_status SET observed = ? WHERE provider = ?", [JSON.stringify({ ...merged, ...observed }), id]);
}

export function setProviderError(db: Db, id: string, message: string, at: string): void {
  db.run("INSERT OR IGNORE INTO provider_status(provider) VALUES (?)", [id]);
  db.run(
    "UPDATE provider_status SET last_attempt_at = ?, last_error = ?, last_error_at = ?, consecutive_failures = consecutive_failures + 1 WHERE provider = ?",
    [at, message.slice(0, 300), at, id],
  );
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: "not_configured" | "disabled" | "quota" | "cap" | "auth" | "bad_response" | "http" | "network",
  ) {
    super(message);
  }
}

export const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
