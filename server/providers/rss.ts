// RSS/Atom news adapter. Only feeds configured in Settings are fetched (no open-ended
// browsing, no arbitrary URLs from the browser). Each request is restricted to the feed's
// own host, must be https, and is refused if DNS resolves to a private/loopback address.
// Headlines are stored as untrusted plain text with their links and publication times.

import type { NewsRecord } from "../repo";
import { classifyClaim, dedupeKey, parseFeed, tagTeams } from "../news";
import { iso, ProviderError, recordUsage, type ProviderCapabilities, type ProviderDeps } from "./common";

const ID = "rss";

export const RSS_CAPABILITIES: ProviderCapabilities = {
  id: ID,
  name: "News feeds (RSS/Atom)",
  roles: ["Source-linked headlines from official team/league feeds and publishers you choose"],
  docsUrl: "https://www.rssboard.org/rss-specification",
  requiresKey: false,
  keyEnvVar: null,
  licensing: "Use only feeds the publisher offers for this purpose and follow each publisher's terms. Headlines and links are shown; full articles are not copied.",
  coverage: ["Exactly the feed URLs listed in Settings (https only, max 25).", "Headlines are tagged to teams by name matching."],
  history: "Only items the feed still lists when fetched.",
  costNotes: "No fee. Each feed is fetched at most once per refresh and cached for 15 minutes.",
  limitations: [
    "Claim type (official / report / speculation) is a keyword heuristic and is labelled as such.",
    "Headlines are not verified facts; official sources are preferred and conflicts are flagged.",
    "The default MLB.com feed URL is a starting point; confirm it still exists.",
  ],
};

export class RssProvider {
  readonly id = ID;
  constructor(private deps: ProviderDeps) {}

  async refresh(): Promise<{ feeds: number; items: number; errors: string[] }> {
    const s = this.deps.settings().providers.rss;
    if (!s.enabled) throw new ProviderError("News feeds are disabled in Settings.", "disabled");
    const feeds = [
      ...s.feeds,
      ...this.deps.config.extraNewsFeeds.filter((u) => u.startsWith("https://")).map((url) => ({ url, name: new URL(url).hostname, tier: "media" as const, sportKey: undefined })),
    ];
    const errors: string[] = [];
    let items = 0;
    const now = iso(this.deps.now());
    for (const f of feeds) {
      try {
        const host = new URL(f.url).hostname;
        const res = await this.deps.http.get(ID, f.url, { allowedHosts: [host], cacheTtlSec: 900, maxBytes: 3_000_000, retries: 1 });
        if (!res.fromCache) recordUsage(this.deps, ID, 0);
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        items += this.ingestFeed(f, res.body, now);
      } catch (e) {
        errors.push(`${f.name}: ${(e as Error).message}`);
        this.deps.log.add("warn", ID, `Feed failed: ${f.name} (${(e as Error).message})`);
      }
    }
    return { feeds: feeds.length, items, errors };
  }

  ingestFeed(feed: { url: string; name: string; tier: "official" | "media"; sportKey?: string }, xml: string, retrievedAt: string): number {
    const parsed = parseFeed(xml);
    const teams = this.deps.repo.participants("live", feed.sportKey);
    const rows: NewsRecord[] = parsed.map((p) => ({
      dataset: "live",
      sport_key: feed.sportKey ?? null,
      participant_ids: JSON.stringify(tagTeams(`${p.title} ${p.summary ?? ""}`, teams)),
      title: p.title,
      summary: p.summary,
      url: p.url,
      source_name: feed.name,
      source_tier: feed.tier,
      claim_type: classifyClaim(p.title, feed.tier),
      published_at: p.published_at,
      retrieved_at: retrievedAt,
      dedupe_key: dedupeKey(p.title),
      duplicate_of: null,
    }));
    return this.deps.repo.insertNews(rows);
  }
}
