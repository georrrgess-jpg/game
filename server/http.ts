// Outbound HTTP for provider adapters: host allow-lists, private-network blocking,
// timeouts, size limits, retries with backoff, response caching, in-flight request
// de-duplication and provider health bookkeeping.

import https from "node:https";
import dns from "node:dns";
import ipaddr from "ipaddr.js";
import type { Db } from "./db";
import type { ActivityLog } from "./activity";
import { redact } from "./config";

export interface HttpRequest {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  method?: "GET" | "POST";
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  fromCache?: boolean;
}

export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

export type HttpErrorKind = "network" | "timeout" | "http" | "blocked" | "too_large" | "quota" | "auth";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly kind: HttpErrorKind,
    readonly status?: number,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
  get retryable(): boolean {
    if (this.kind === "network" || this.kind === "timeout") return true;
    if (this.kind === "http" && this.status != null) return this.status === 429 || this.status >= 500;
    return false;
  }
}

export function isPublicAddress(address: string): boolean {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
      parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    }
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

/** DNS lookup that refuses loopback, private, link-local and other non-public addresses. */
function guardedLookup(hostname: string, options: any, callback: any): void {
  const opts = typeof options === "object" && options ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = addresses as unknown as dns.LookupAddress[];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (!list.length || bad) {
      const e = new Error(`Refusing to connect to non-public address for ${hostname}`) as NodeJS.ErrnoException;
      e.code = "EBLOCKED";
      return callback(e);
    }
    if (opts.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

export const nodeTransport: Transport = (req) =>
  new Promise((resolve, reject) => {
    const url = new URL(req.url);
    if (url.protocol !== "https:") return reject(new HttpError("Only https:// URLs are fetched", "blocked"));
    const maxBytes = req.maxBytes ?? 5_000_000;
    const r = https.request(
      url,
      {
        method: req.method ?? "GET",
        headers: { "user-agent": "OverroundLab/1.0 (classroom research tool)", accept: "application/json, application/xml, text/xml, */*", ...req.headers },
        lookup: guardedLookup as any,
        timeout: req.timeoutMs ?? 15000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy();
            reject(new HttpError(`Response exceeded ${maxBytes} bytes`, "too_large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v != null) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", (e) => reject(new HttpError(e.message, "network")));
      },
    );
    r.on("timeout", () => {
      r.destroy();
      reject(new HttpError("Request timed out", "timeout"));
    });
    r.on("error", (e: NodeJS.ErrnoException) => {
      if (e instanceof HttpError) return reject(e);
      reject(new HttpError(e.message, e.code === "EBLOCKED" ? "blocked" : "network"));
    });
    if (req.body) r.write(req.body);
    r.end();
  });

export interface GetOptions {
  allowedHosts: string[];
  cacheTtlSec?: number;
  retries?: number;
  headers?: Record<string, string>;
  /** Cache key; defaults to the URL with secrets removed. */
  cacheKey?: string;
  maxBytes?: number;
  timeoutMs?: number;
}

export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => {
    const al = a.toLowerCase();
    return al.startsWith(".") ? h.endsWith(al) && h.length > al.length : h === al;
  });
}

export class HttpClient {
  private inflight = new Map<string, Promise<HttpResponse>>();
  constructor(
    private db: Db,
    private log: ActivityLog,
    private transport: Transport = nodeTransport,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private now: () => Date = () => new Date(),
  ) {}

  setTransport(t: Transport): void {
    this.transport = t;
  }

  async get(provider: string, url: string, opts: GetOptions): Promise<HttpResponse> {
    const safeUrl = redact(url);
    const key = opts.cacheKey ?? `${provider}:${safeUrl}`;
    if (opts.cacheTtlSec && opts.cacheTtlSec > 0) {
      const cached = this.db.get<{ status: number; headers: string; body: string; expires_at: string }>(
        "SELECT status, headers, body, expires_at FROM http_cache WHERE key = ?",
        [key],
      );
      if (cached && cached.expires_at > this.now().toISOString()) {
        return { status: cached.status, headers: JSON.parse(cached.headers), body: cached.body, fromCache: true };
      }
    }
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.fetchWithRetry(provider, url, opts).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    const res = await p;
    if (opts.cacheTtlSec && opts.cacheTtlSec > 0 && res.status >= 200 && res.status < 300) {
      const fetched = this.now();
      this.db.run(
        "INSERT INTO http_cache(key, status, headers, body, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET status=excluded.status, headers=excluded.headers, body=excluded.body, fetched_at=excluded.fetched_at, expires_at=excluded.expires_at",
        [key, res.status, JSON.stringify(res.headers), res.body, fetched.toISOString(), new Date(fetched.getTime() + opts.cacheTtlSec * 1000).toISOString()],
      );
      // Expired entries are never served, so drop them to keep the database small.
      this.db.run("DELETE FROM http_cache WHERE expires_at < ?", [fetched.toISOString()]);
    }
    return res;
  }

  private async fetchWithRetry(provider: string, url: string, opts: GetOptions): Promise<HttpResponse> {
    const retries = opts.retries ?? 2;
    let current = url;
    let lastErr: HttpError | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await this.fetchFollowingRedirects(current, opts);
        if (res.status === 429 || res.status >= 500) {
          const ra = Number(res.headers["retry-after"]);
          throw new HttpError(`HTTP ${res.status}`, "http", res.status, Number.isFinite(ra) ? ra : undefined);
        }
        if (res.status >= 200 && res.status < 300) this.recordSuccess(provider);
        return res;
      } catch (e) {
        const err = e instanceof HttpError ? e : new HttpError((e as Error).message, "network");
        lastErr = err;
        if (!err.retryable || attempt === retries) break;
        const backoff = err.retryAfterSec != null ? Math.min(30, err.retryAfterSec) * 1000 : 500 * 2 ** attempt + Math.floor(Math.random() * 250);
        await this.sleep(backoff);
      }
    }
    this.recordFailure(provider, lastErr!);
    this.log.add("warn", provider, `Request failed: ${redact(current)} (${lastErr!.message})`);
    throw lastErr!;
  }

  private async fetchFollowingRedirects(url: string, opts: GetOptions): Promise<HttpResponse> {
    let current = url;
    for (let hop = 0; hop < 4; hop++) {
      const u = new URL(current);
      if (u.protocol !== "https:") throw new HttpError("Only https:// URLs are fetched", "blocked");
      if (!hostAllowed(u.hostname, opts.allowedHosts)) throw new HttpError(`Host ${u.hostname} is not on this provider's allow-list`, "blocked");
      if (u.username || u.password) throw new HttpError("Credentials in URLs are not allowed", "blocked");
      const res = await this.transport({ url: current, headers: opts.headers, maxBytes: opts.maxBytes, timeoutMs: opts.timeoutMs });
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        current = new URL(res.headers.location, current).toString();
        continue;
      }
      return res;
    }
    throw new HttpError("Too many redirects", "blocked");
  }

  private ensureRow(provider: string) {
    this.db.run("INSERT OR IGNORE INTO provider_status(provider) VALUES (?)", [provider]);
  }

  recordSuccess(provider: string): void {
    this.ensureRow(provider);
    const now = this.now().toISOString();
    this.db.run(
      "UPDATE provider_status SET last_attempt_at = ?, last_success_at = ?, consecutive_failures = 0 WHERE provider = ?",
      [now, now, provider],
    );
  }

  recordFailure(provider: string, err: HttpError): void {
    this.ensureRow(provider);
    const now = this.now().toISOString();
    this.db.run(
      "UPDATE provider_status SET last_attempt_at = ?, last_error = ?, last_error_at = ?, consecutive_failures = consecutive_failures + 1 WHERE provider = ?",
      [now, redact(err.message).slice(0, 300), now, provider],
    );
  }
}
