// Open-Meteo forecast adapter — https://open-meteo.com/en/docs
// No key. Free tier is for non-commercial use (documented limits: under 10,000 calls/day,
// 5,000/hour, 600/minute). Data is CC BY 4.0: show "Weather data by Open-Meteo.com".

import { z } from "zod";
import type { EventRecord, WeatherRecord } from "../repo";
import { weatherRelevant } from "../../shared/contracts";
import { iso, ProviderError, recordUsage, type ProviderCapabilities, type ProviderDeps } from "./common";

export const OPEN_METEO_HOST = "api.open-meteo.com";
const ID = "openmeteo";

const forecastSchema = z.object({
  hourly: z.object({
    time: z.array(z.string()),
    temperature_2m: z.array(z.number().nullable()).optional(),
    precipitation_probability: z.array(z.number().nullable()).optional(),
    wind_speed_10m: z.array(z.number().nullable()).optional(),
  }),
});

export const OPENMETEO_CAPABILITIES: ProviderCapabilities = {
  id: ID,
  name: "Open-Meteo",
  roles: ["Weather forecast at the venue for outdoor sports"],
  docsUrl: "https://open-meteo.com/en/docs",
  requiresKey: false,
  keyEnvVar: null,
  licensing: "Free API for non-commercial use; data licensed CC BY 4.0 with attribution (Weather data by Open-Meteo.com).",
  coverage: ["Global hourly forecasts up to 16 days ahead.", "Used only for outdoor venues with known coordinates (MLB venues from the MLB feed)."],
  history: "Forecasts are stored as retrieved; no historical forecast archive is used.",
  costNotes: "No fee on the free tier within the documented daily, hourly and per-minute limits. Responses cached for 1 hour.",
  limitations: ["Weather is shown as context only; the model does not use it.", "Not live-verified in the build environment (network blocked)."],
};

export class OpenMeteoProvider {
  readonly id = ID;
  constructor(private deps: ProviderDeps) {}

  async refreshForEvents(events: EventRecord[]): Promise<number> {
    if (!this.deps.settings().providers.openmeteo.enabled) throw new ProviderError("Open-Meteo is disabled in Settings.", "disabled");
    const now = this.deps.now();
    const rows: WeatherRecord[] = [];
    for (const e of events) {
      if (!weatherRelevant(e.sport_key) || e.indoor || e.venue_lat == null || e.venue_lon == null) continue;
      const startMs = Date.parse(e.start_time);
      if (startMs < now.getTime() - 3600000 || startMs > now.getTime() + 15 * 86400000) continue;
      const day = e.start_time.slice(0, 10);
      const u = new URL(`https://${OPEN_METEO_HOST}/v1/forecast`);
      u.searchParams.set("latitude", e.venue_lat.toFixed(4));
      u.searchParams.set("longitude", e.venue_lon.toFixed(4));
      u.searchParams.set("hourly", "temperature_2m,precipitation_probability,wind_speed_10m");
      u.searchParams.set("timezone", "UTC");
      u.searchParams.set("start_date", day);
      u.searchParams.set("end_date", day);
      let res;
      try {
        res = await this.deps.http.get(ID, u.toString(), { allowedHosts: [OPEN_METEO_HOST], cacheTtlSec: 3600 });
      } catch (err) {
        throw new ProviderError(`Open-Meteo unreachable: ${(err as Error).message}`, "network");
      }
      if (!res.fromCache) recordUsage(this.deps, ID, 0);
      if (res.status !== 200) throw new ProviderError(`Open-Meteo returned HTTP ${res.status}`, "http");
      const row = this.parseForecast(e, JSON.parse(res.body), iso(now), u.toString());
      if (row) rows.push(row);
    }
    this.deps.repo.insertWeather(rows);
    return rows.length;
  }

  parseForecast(e: EventRecord, data: unknown, retrievedAt: string, url: string): WeatherRecord | null {
    const parsed = forecastSchema.safeParse(data);
    if (!parsed.success) throw new ProviderError("Unexpected Open-Meteo response", "bad_response");
    const h = parsed.data.hourly;
    const target = e.start_time.slice(0, 13); // YYYY-MM-DDTHH in UTC
    const idx = h.time.findIndex((t) => t.slice(0, 13) === target);
    if (idx < 0) return null;
    return {
      dataset: "live",
      event_id: e.id,
      forecast_for: `${target}:00:00Z`,
      temperature_c: h.temperature_2m?.[idx] ?? null,
      precip_probability: h.precipitation_probability?.[idx] ?? null,
      wind_kph: h.wind_speed_10m?.[idx] ?? null,
      source: "Open-Meteo (Weather data by Open-Meteo.com)",
      source_url: url,
      source_time: null,
      retrieved_at: retrievedAt,
    };
  }
}
