// Server configuration from environment variables. Secrets stay here and are never
// sent to the browser, written to exports, or included in logs.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  dbFile: string;
  allowRemote: boolean;
  instructorPin: string | null;
  oddsApiKey: string | null;
  balldontlieApiKey: string | null;
  anthropicApiKey: string | null;
  aiModel: string;
  extraNewsFeeds: string[];
  dev: boolean;
  staticDir: string;
}

/** What happened when the server looked for its .env file. Names only: values never leave the server. */
export interface EnvFileStatus {
  path: string;
  found: boolean;
  /** Setting names read from the file (values are never reported). */
  keys: string[];
  /** Plain-language problems found, e.g. a file saved as ".env.txt". */
  hints: string[];
}

const KNOWN_KEYS = [
  "HOST", "PORT", "ALLOW_REMOTE", "INSTRUCTOR_PIN", "OVERROUND_DATA_DIR", "OVERROUND_DB_FILE", "OVERROUND_STATIC_DIR", "OVERROUND_DEV",
  "ODDS_API_KEY", "BALLDONTLIE_API_KEY", "ANTHROPIC_API_KEY", "AI_MODEL", "NEWS_FEEDS",
];

/** Decode a .env file whatever editor wrote it: UTF-8 with or without BOM, or UTF-16 (PowerShell 5 `>`). */
export function decodeEnvBuffer(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  // UTF-16 without a BOM: every other byte is zero for ASCII text.
  if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0 && buf[0] !== 0) return buf.toString("utf16le");
  return buf.toString("utf8").replace(/^\uFEFF/, "");
}

/**
 * Tolerant .env parser: KEY=value, optional `export `, spaces around `=`, single or double quotes,
 * `# comments` (after whitespace for unquoted values), Windows line endings.
 */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n|\r/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.lastIndexOf(q) > 0) v = v.slice(1, v.lastIndexOf(q));
    else v = v.replace(/\s+#.*$/, "").trim();
    out[m[1]] = v;
  }
  return out;
}

/** Look for likely mistakes without ever revealing a value. */
function diagnose(dir: string, found: boolean, vars: Record<string, string>): string[] {
  const hints: string[] = [];
  if (!found) {
    for (const alt of [".env.txt", "env", "env.txt", ".env.env", ".env.example.txt"]) {
      if (existsSync(path.join(dir, alt))) hints.push(`Found a file named "${alt}" but not ".env". Rename it to exactly ".env" (in File Explorer turn on View → Show → File name extensions to see the real name).`);
    }
    const example = path.join(dir, ".env.example");
    if (existsSync(example)) {
      try {
        const ex = parseEnvText(decodeEnvBuffer(readFileSync(example)));
        if (["ODDS_API_KEY", "BALLDONTLIE_API_KEY", "ANTHROPIC_API_KEY"].some((k) => ex[k])) {
          hints.push('A key is filled in inside ".env.example", which the app never reads. Copy that file to a new file named ".env" (or rename it).');
        }
      } catch {
        /* unreadable example file: ignore */
      }
    }
    for (const sub of ["client", "server", "data", ".."]) {
      if (existsSync(path.join(dir, sub, ".env"))) hints.push(`There is a ".env" in "${path.resolve(dir, sub)}", but it must be in the project folder itself (next to package.json).`);
    }
    if (!hints.length) hints.push(`No ".env" file in ${dir}. Copy ".env.example" to ".env" in that folder and put your key after ODDS_API_KEY=.`);
    return hints;
  }
  for (const k of Object.keys(vars)) {
    if (KNOWN_KEYS.includes(k)) continue;
    if (/ODDS|BALL|ANTHROPIC|API|KEY/i.test(k)) {
      const guess = /BALL/i.test(k) ? "BALLDONTLIE_API_KEY" : /ANTHROPIC|CLAUDE/i.test(k) ? "ANTHROPIC_API_KEY" : "ODDS_API_KEY";
      hints.push(`".env" has a setting named ${k}, which the app does not use. Did you mean ${guess}?`);
    }
  }
  for (const k of ["ODDS_API_KEY", "BALLDONTLIE_API_KEY", "ANTHROPIC_API_KEY"]) {
    const v = vars[k];
    if (v === undefined) continue;
    if (v === "") hints.push(`${k} is in ".env" but has no value after the "=".`);
    else if (/\s|[<>]|your|paste|here|xxxx/i.test(v)) hints.push(`${k} in ".env" looks like a placeholder or contains spaces. Paste only the key itself after "=", with nothing around it.`);
  }
  return hints;
}

let lastEnvStatus: EnvFileStatus | null = null;
export const envFileStatus = (): EnvFileStatus | null => lastEnvStatus;

function loadDotEnv(): void {
  const dir = process.cwd();
  const file = path.resolve(dir, ".env");
  const found = existsSync(file);
  let vars: Record<string, string> = {};
  const hints: string[] = [];
  if (found) {
    try {
      vars = parseEnvText(decodeEnvBuffer(readFileSync(file)));
      // Real environment variables win over the file, as with other .env loaders.
      for (const [k, v] of Object.entries(vars)) if (process.env[k] === undefined || process.env[k] === "") process.env[k] = v;
    } catch (err) {
      hints.push(`Could not read .env: ${(err as Error).message}`);
    }
  }
  lastEnvStatus = { path: file, found, keys: Object.keys(vars), hints: [...hints, ...diagnose(dir, found, vars)] };
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
    balldontlieApiKey: clean(env.BALLDONTLIE_API_KEY),
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
export function redact(s: string, cfg?: Pick<ServerConfig, "oddsApiKey" | "anthropicApiKey"> & { balldontlieApiKey?: string | null }): string {
  let out = s.replace(/(apiKey|api_key|key|token)=([^&\s"']+)/gi, "$1=[redacted]");
  for (const secret of [cfg?.oddsApiKey, cfg?.anthropicApiKey, cfg?.balldontlieApiKey]) {
    if (secret && secret.length >= 6) out = out.split(secret).join("[redacted]");
  }
  return out;
}
