// In-process scheduler for live data. It runs ONLY while this server process is running:
// closing the app stops all scans, and missed runs are not back-filled automatically.

import { DateTime } from "luxon";
import type { Db } from "./db";
import type { ActivityLog } from "./activity";
import type { Settings } from "./settings";

export type JobName = "daily_scan" | "odds_refresh" | "results_refresh" | "news_refresh";

export const JOB_LABELS: Record<JobName, string> = {
  daily_scan: "Daily scan (full refresh + Analyze Today snapshot)",
  odds_refresh: "Odds refresh",
  results_refresh: "Results refresh",
  news_refresh: "News refresh",
};

export interface JobRow {
  name: JobName;
  last_run_at: string | null;
  last_success_at: string | null;
  last_result: string | null;
  next_run_at: string | null;
  running: number;
}

export function nextDailyRun(from: Date, hhmm: string, zone: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const local = DateTime.fromJSDate(from, { zone });
  let candidate = local.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  // On a spring-forward day a missing local time is shifted forward by luxon; that is acceptable.
  if (candidate <= local) candidate = candidate.plus({ days: 1 }).set({ hour: h, minute: m, second: 0, millisecond: 0 });
  return candidate.toUTC().toISO({ suppressMilliseconds: true })!;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<JobName>();
  readonly startedAt: string;

  constructor(
    private db: Db,
    private settings: () => Settings,
    private log: ActivityLog,
    private runners: Record<JobName, () => Promise<string>>,
    private now: () => Date = () => new Date(),
  ) {
    this.startedAt = this.now().toISOString();
    for (const name of Object.keys(JOB_LABELS) as JobName[]) {
      this.db.run("INSERT OR IGNORE INTO jobs(name) VALUES (?)", [name]);
    }
    // Clear stale "running" flags left by a crash, and note runs missed while the app was closed.
    this.db.run("UPDATE jobs SET running = 0");
    const missed = this.db.all<JobRow>("SELECT * FROM jobs WHERE next_run_at IS NOT NULL AND next_run_at < ?", [this.startedAt]);
    if (missed.length && !this.settings().scheduler.paused) {
      this.log.add("warn", "scheduler", `${missed.length} scheduled run(s) were missed while the app was closed; they are not back-filled. Use "Run now" if needed.`);
    }
    this.recomputeAll();
  }

  intervalMinutes(name: JobName): number | null {
    const s = this.settings().scheduler;
    switch (name) {
      case "odds_refresh":
        return s.oddsRefreshMinutes;
      case "results_refresh":
        return s.resultsRefreshMinutes;
      case "news_refresh":
        return s.newsRefreshMinutes;
      default:
        return null;
    }
  }

  computeNext(name: JobName, from: Date): string {
    if (name === "daily_scan") return nextDailyRun(from, this.settings().scheduler.dailyScanTime, this.settings().timezone);
    return new Date(from.getTime() + this.intervalMinutes(name)! * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  recomputeAll(): void {
    const now = this.now();
    for (const name of Object.keys(JOB_LABELS) as JobName[]) {
      this.db.run("UPDATE jobs SET next_run_at = ? WHERE name = ?", [this.computeNext(name, now), name]);
    }
  }

  start(intervalMs = 30000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.settings().scheduler.paused) return;
    const nowIso = this.now().toISOString();
    const due = this.db.all<JobRow>("SELECT * FROM jobs WHERE next_run_at IS NOT NULL AND next_run_at <= ?", [nowIso]);
    for (const j of due) {
      if (this.running.has(j.name)) continue;
      await this.run(j.name, "schedule");
    }
  }

  async run(name: JobName, trigger: "schedule" | "manual"): Promise<{ ok: boolean; result: string }> {
    if (this.running.has(name)) return { ok: false, result: "Already running" };
    this.running.add(name);
    const started = this.now().toISOString();
    this.db.run("UPDATE jobs SET running = 1, last_run_at = ? WHERE name = ?", [started, name]);
    let ok = true;
    let result: string;
    try {
      result = await this.runners[name]();
      this.db.run("UPDATE jobs SET last_success_at = ? WHERE name = ?", [this.now().toISOString(), name]);
    } catch (e) {
      ok = false;
      result = `Failed: ${(e as Error).message}`;
    } finally {
      this.running.delete(name);
    }
    this.db.run("UPDATE jobs SET running = 0, last_result = ?, next_run_at = ? WHERE name = ?", [result.slice(0, 500), this.computeNext(name, this.now()), name]);
    this.log.add(ok ? "info" : "error", "scheduler", `${JOB_LABELS[name]} (${trigger}): ${result}`);
    return { ok, result };
  }

  summary() {
    const s = this.settings();
    return {
      paused: s.scheduler.paused,
      processStartedAt: this.startedAt,
      timezone: s.timezone,
      note: "Scheduled scans run only while this program is running. Closing the app or the terminal stops them; missed runs are not back-filled.",
      jobs: this.db.all<JobRow>("SELECT * FROM jobs ORDER BY name").map((j) => ({ ...j, label: JOB_LABELS[j.name], running: this.running.has(j.name), intervalMinutes: this.intervalMinutes(j.name) })),
    };
  }
}
