import { z } from "zod";
import type { Db } from "./db";
import { isValidZone } from "../shared/time";

const feedSchema = z.object({
  url: z
    .string()
    .url()
    .max(500)
    .refine((u) => u.startsWith("https://"), "Feeds must use https://"),
  name: z.string().min(1).max(80),
  tier: z.enum(["official", "media"]),
  sportKey: z.string().max(60).optional(),
});

export const settingsSchema = z.object({
  timezone: z.string().refine(isValidZone, "Unknown IANA timezone"),
  staleQuoteMinutes: z.number().int().min(5).max(24 * 60),
  discrepancyMinPoints: z.number().min(0.01).max(0.2),
  scheduler: z.object({
    paused: z.boolean(),
    dailyScanTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    oddsRefreshMinutes: z.number().int().min(15).max(24 * 60),
    resultsRefreshMinutes: z.number().int().min(15).max(24 * 60),
    newsRefreshMinutes: z.number().int().min(30).max(24 * 60),
  }),
  providers: z.object({
    oddsapi: z.object({
      enabled: z.boolean(),
      sports: z.array(z.string().regex(/^[a-z0-9_]+$/).max(60)).max(10),
      regions: z.array(z.enum(["us", "us2", "uk", "eu", "au"])).min(1).max(4),
      markets: z.array(z.enum(["h2h", "h2h_3_way", "spreads", "totals"])).min(1).max(4),
      bookmakers: z.array(z.string().regex(/^[a-z0-9_]+$/).max(40)).max(40),
      dailyCreditCap: z.number().int().min(0).max(100000),
      minRemainingCredits: z.number().int().min(0).max(100000),
      allowHistorical: z.boolean(),
    }),
    mlb: z.object({ enabled: z.boolean(), historySeasons: z.number().int().min(1).max(5) }),
    openmeteo: z.object({ enabled: z.boolean() }),
    rss: z.object({ enabled: z.boolean(), feeds: z.array(feedSchema).max(25) }),
    ai: z.object({ enabled: z.boolean(), dailyRequestCap: z.number().int().min(0).max(500) }),
  }),
  classroom: z.object({ lockReveal: z.boolean() }),
  demo: z.object({ now: z.string().datetime() }),
});

export type Settings = z.infer<typeof settingsSchema>;

export const DEMO_START = "2026-06-16T15:00:00Z"; // 11:00 in New York on the fictional demo calendar

export function defaultSettings(): Settings {
  let tz = "America/New_York";
  try {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (local && isValidZone(local) && local !== "UTC" && local !== "Etc/UTC") tz = local;
  } catch {
    /* keep default */
  }
  return {
    timezone: tz,
    staleQuoteMinutes: 150,
    discrepancyMinPoints: 0.03,
    scheduler: {
      paused: true,
      dailyScanTime: "08:30",
      oddsRefreshMinutes: 120,
      resultsRefreshMinutes: 120,
      newsRefreshMinutes: 240,
    },
    providers: {
      oddsapi: {
        enabled: false,
        sports: ["baseball_mlb"],
        regions: ["us"],
        markets: ["h2h"],
        bookmakers: [],
        dailyCreditCap: 30,
        minRemainingCredits: 25,
        allowHistorical: false,
      },
      mlb: { enabled: false, historySeasons: 2 },
      openmeteo: { enabled: false },
      rss: {
        enabled: false,
        feeds: [{ url: "https://www.mlb.com/feeds/news/rss.xml", name: "MLB.com News", tier: "official", sportKey: "baseball_mlb" }],
      },
      ai: { enabled: false, dailyRequestCap: 20 },
    },
    classroom: { lockReveal: false },
    demo: { now: DEMO_START },
  };
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return (patch === undefined ? base : (patch as T));
  if (base === null || typeof base !== "object" || Array.isArray(base)) return patch as T;
  const out: any = { ...(base as any) };
  for (const [k, v] of Object.entries(patch as object)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}

export class SettingsStore {
  private cache: Settings | null = null;
  constructor(private db: Db) {}

  get(): Settings {
    if (this.cache) return this.cache;
    const row = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'app'");
    let s = defaultSettings();
    if (row) {
      try {
        const merged = deepMerge(s, JSON.parse(row.value));
        const parsed = settingsSchema.safeParse(merged);
        if (parsed.success) s = parsed.data;
      } catch {
        /* corrupted settings fall back to defaults */
      }
    }
    this.cache = s;
    return s;
  }

  /** The demo clock is changed only through instructor controls, never through a settings patch. */
  setDemoNow(nowIso: string): Settings {
    const next = settingsSchema.parse({ ...this.get(), demo: { now: nowIso } });
    this.persist(next);
    return next;
  }

  private persist(parsed: Settings): void {
    this.db.run(
      "INSERT INTO settings(key, value, updated_at) VALUES ('app', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [JSON.stringify(parsed), new Date().toISOString()],
    );
    this.cache = parsed;
  }

  /** Validate and persist a partial update. Throws a ZodError on invalid input. */
  update(patch: unknown): Settings {
    const merged = deepMerge(this.get(), patch);
    const parsed = settingsSchema.parse(merged);
    this.persist(parsed);
    return parsed;
  }
}
