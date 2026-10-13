import type { Db } from "./db";
import { redact } from "./config";

export type LogLevel = "info" | "warn" | "error";

export class ActivityLog {
  constructor(
    private db: Db,
    private secrets: { oddsApiKey: string | null; anthropicApiKey: string | null },
    private now: () => string = () => new Date().toISOString(),
  ) {}

  add(level: LogLevel, category: string, message: string, details?: unknown): void {
    const safeMessage = redact(message, this.secrets).slice(0, 1000);
    const safeDetails = details === undefined ? null : redact(JSON.stringify(details), this.secrets).slice(0, 4000);
    this.db.run("INSERT INTO activity_log(at, level, category, message, details) VALUES (?, ?, ?, ?, ?)", [
      this.now(),
      level,
      category,
      safeMessage,
      safeDetails,
    ]);
    // Keep the log bounded.
    this.db.run("DELETE FROM activity_log WHERE id <= (SELECT MAX(id) FROM activity_log) - 5000");
  }

  list(limit = 200, category?: string) {
    const lim = Math.max(1, Math.min(1000, limit));
    return category
      ? this.db.all("SELECT * FROM activity_log WHERE category = ? ORDER BY id DESC LIMIT ?", [category, lim])
      : this.db.all("SELECT * FROM activity_log ORDER BY id DESC LIMIT ?", [lim]);
  }
}
