import { readFileSync } from "node:fs";
import path from "node:path";
import { Db } from "../../server/db";
import { Repo } from "../../server/repo";
import { SettingsStore } from "../../server/settings";
import { ActivityLog } from "../../server/activity";
import { HttpClient, type HttpRequest, type HttpResponse, type Transport } from "../../server/http";
import { loadConfig, type ServerConfig } from "../../server/config";
import type { ProviderDeps } from "../../server/providers/common";

export const fixture = (name: string) => readFileSync(path.join(__dirname, "..", "fixtures", name), "utf8");

export interface FakeRoute {
  match: RegExp;
  respond: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;
}

export function fakeTransport(routes: FakeRoute[], calls: string[] = []): Transport {
  return async (req) => {
    calls.push(req.url);
    const r = routes.find((x) => x.match.test(req.url));
    if (!r) return { status: 404, headers: {}, body: "not found" };
    return r.respond(req);
  };
}

export const ok = (body: string, headers: Record<string, string> = {}): HttpResponse => ({ status: 200, headers, body });

export function makeDeps(opts: { transport?: Transport; now?: Date; config?: Partial<ServerConfig>; settings?: unknown } = {}) {
  const db = new Db(":memory:");
  const repo = new Repo(db);
  const settings = new SettingsStore(db);
  settings.update({ timezone: "America/New_York", ...(opts.settings as object) });
  const config = loadConfig({ dbFile: ":memory:", oddsApiKey: "test-key-123456", ...opts.config });
  const now = () => opts.now ?? new Date("2026-06-16T15:00:00Z");
  const log = new ActivityLog(db, { oddsApiKey: config.oddsApiKey, anthropicApiKey: null }, () => now().toISOString());
  const http = new HttpClient(db, log, opts.transport ?? fakeTransport([]), async () => undefined, now);
  const deps: ProviderDeps = { db, repo, http, log, settings: () => settings.get(), config, now };
  return { db, repo, settings, log, http, deps, config };
}
