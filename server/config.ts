// Server configuration from environment variables. Secrets stay here and are never
// sent to the browser, written to exports, or included in logs.

import { existsSync } from "node:fs";
import path from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  dbFile: string;
  allowRemote: boolean;
  instructorPin: string | null;
  oddsApiKey: string | null;
  anthropicApiKey: string | null;
  aiModel: string;
  extraNewsFeeds: string[];
  dev: boolean;
  staticDir: string;
}

function loadDotEnv(): void {
  const file = path.resolve(process.cwd(), ".env");
  if (existsSync(file) && typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(file);
    } catch (err) {
      console.warn(`Could not read .env: ${(err as Error).message}`);
    }
  }
}

const clean = (v: string | undefined) => {
  const t = v?.trim();
  return t ? t : null;
};

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  loadDotEnv();
  const env = process.env;
  const dataDir = path.resolve(env.OVERROUND_DATA_DIR ?? "data");
  const cfg: ServerConfig = {
    host: env.HOST?.trim() || "127.0.0.1",
    port: Number(env.PORT ?? 5180),
    dataDir,
    dbFile: path.join(dataDir, env.OVERROUND_DB_FILE?.trim() || "overround.sqlite"),
    allowRemote: env.ALLOW_REMOTE === "1" || env.ALLOW_REMOTE === "true",
    instructorPin: clean(env.INSTRUCTOR_PIN),
    oddsApiKey: clean(env.ODDS_API_KEY),
    anthropicApiKey: clean(env.ANTHROPIC_API_KEY),
    aiModel: clean(env.AI_MODEL) ?? "claude-opus-5-5",
    extraNewsFeeds: (env.NEWS_FEEDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    dev: env.OVERROUND_DEV === "1",
    staticDir: path.resolve(env.OVERROUND_STATIC_DIR ?? "build/client"),
    ...overrides,
  };
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new Error(`Invalid PORT: ${env.PORT}`);
  return cfg;
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Redact secrets from any string that might be logged (API keys in query strings, headers). */
export function redact(s: string, cfg?: Pick<ServerConfig, "oddsApiKey" | "anthropicApiKey">): string {
  let out = s.replace(/(apiKey|api_key|key|token)=([^&\s"']+)/gi, "$1=[redacted]");
  for (const secret of [cfg?.oddsApiKey, cfg?.anthropicApiKey]) {
    if (secret && secret.length >= 6) out = out.split(secret).join("[redacted]");
  }
  return out;
}
