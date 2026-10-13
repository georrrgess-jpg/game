// News handling: RSS parsing, team tagging, duplicate detection, claim classification and
// conflict detection. Feed content is untrusted DATA: it is stored as plain text, never
// executed, never followed as instructions, and rendered escaped in the browser.

import { XMLParser } from "fast-xml-parser";
import { parseTimestamp } from "../shared/time";
import type { NewsRecord, InjuryRecord, Participant } from "./repo";
import { normalizeAlias } from "./repo";
import { json } from "./db";

const STOP = new Set(["the", "a", "an", "of", "on", "in", "to", "for", "with", "and", "at", "by", "after", "from", "is", "says", "say", "per", "team", "his", "her", "their", "has", "have", "be", "will", "as"]);

export function tokens(title: string): string[] {
  return normalizeAlias(title)
    .split(" ")
    .map((w) => w.replace(/(ed|ing|s)$/, ""))
    .filter((w) => w.length > 1 && !STOP.has(w));
}

export function dedupeKey(title: string): string {
  return [...new Set(tokens(title))].sort().join(" ");
}

export function jaccard(a: string, b: string): number {
  const A = new Set(a.split(" ").filter(Boolean));
  const B = new Set(b.split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Group near-identical stories published within 48h; later copies point at the earliest. */
export function markDuplicates<T extends { title: string; url: string; published_at: string | null; dedupe_key?: string }>(
  items: T[],
): (T & { duplicateOfIndex: number | null })[] {
  const sorted = items.map((it, i) => ({ it, i })).sort((a, b) => (a.it.published_at ?? "").localeCompare(b.it.published_at ?? "") || a.i - b.i);
  const out: (T & { duplicateOfIndex: number | null })[] = items.map((it) => ({ ...it, duplicateOfIndex: null }));
  for (let x = 0; x < sorted.length; x++) {
    const a = sorted[x];
    const ka = a.it.dedupe_key ?? dedupeKey(a.it.title);
    for (let y = 0; y < x; y++) {
      const b = sorted[y];
      if (out[b.i].duplicateOfIndex != null) continue;
      const kb = b.it.dedupe_key ?? dedupeKey(b.it.title);
      const close =
        !a.it.published_at || !b.it.published_at || Math.abs(Date.parse(a.it.published_at) - Date.parse(b.it.published_at)) < 48 * 3600000;
      if (a.it.url === b.it.url || (close && jaccard(ka, kb) >= 0.5)) {
        out[a.i].duplicateOfIndex = b.i;
        break;
      }
    }
  }
  return out;
}

const SPECULATIVE = /\b(rumou?r|could|might|may|reportedly|sources? (say|said|tell)|per sources|expected to|likely|possibl[ey]|speculat|linked with|in talks)\b/i;

/** Keyword heuristic, labelled as such in the UI. Official-tier feeds are treated as official announcements. */
export function classifyClaim(title: string, tier: NewsRecord["source_tier"]): NewsRecord["claim_type"] {
  if (/\b(rumou?r|speculat|sources? say)\b/i.test(title)) return "speculation";
  if (tier === "official") return "official";
  if (SPECULATIVE.test(title)) return "speculation";
  return "report";
}

/** Tag a headline with the teams it mentions (whole-word alias matches). */
export function tagTeams(text: string, teams: Participant[]): string[] {
  const hay = ` ${normalizeAlias(text)} `;
  const ids: string[] = [];
  for (const t of teams) {
    const names = [t.name, t.short_name, ...t.aliases].filter((n): n is string => !!n && n.length >= 4);
    if (names.some((n) => hay.includes(` ${normalizeAlias(n)} `))) ids.push(t.id);
  }
  return ids;
}

export interface ParsedFeedItem {
  title: string;
  url: string;
  summary: string | null;
  published_at: string | null;
}

const stripHtml = (s: string) =>
  s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

const text = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object" && "#text" in (v as any)) return String((v as any)["#text"]);
  return "";
};

/** Parse RSS 2.0 or Atom. Only http(s) links are kept; everything is reduced to plain text. */
export function parseFeed(xml: string): ParsedFeedItem[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", processEntities: true, htmlEntities: true });
  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new Error("Feed is not valid XML");
  }
  const rssItems = doc?.rss?.channel?.item;
  const atomEntries = doc?.feed?.entry;
  const raw: any[] = rssItems ? (Array.isArray(rssItems) ? rssItems : [rssItems]) : atomEntries ? (Array.isArray(atomEntries) ? atomEntries : [atomEntries]) : [];
  const out: ParsedFeedItem[] = [];
  for (const it of raw.slice(0, 200)) {
    const title = stripHtml(text(it.title)).slice(0, 300);
    let link = text(it.link);
    if (!link && it.link) {
      const links = Array.isArray(it.link) ? it.link : [it.link];
      const alt = links.find((l: any) => !l["@_rel"] || l["@_rel"] === "alternate") ?? links[0];
      link = alt?.["@_href"] ?? "";
    }
    if (!link && typeof it.guid === "string" && /^https?:\/\//.test(it.guid)) link = it.guid;
    link = link.trim();
    if (!title || !/^https?:\/\//i.test(link)) continue;
    try {
      new URL(link);
    } catch {
      continue;
    }
    const summary = stripHtml(text(it.description ?? it.summary ?? it.content)).slice(0, 500) || null;
    out.push({ title, url: link, summary, published_at: parseTimestamp(text(it.pubDate ?? it.published ?? it.updated ?? it["dc:date"])) });
  }
  return out;
}

// ---------- conflicts ----------
const NEGATIVE = /\b(ruled out|out for|injured list|sidelined|scratched|will not play|won't play|placed on|miss(es)? (tonight|the game))\b/i;
const POSITIVE = /\b(expected to play|will play|in the lineup|available|activated|cleared|returns?|back in)\b/i;

export interface Conflict {
  player: string;
  teamId: string;
  statements: { title: string; url: string; source: string; tier: string; claim: string; published_at: string | null; stance: "unavailable" | "available" }[];
  injuryStatuses: { status: string; source: string }[];
}

/**
 * Flag players with contradictory signals within 72 hours: one source suggests they will
 * not play while another suggests they will, or official injury sources disagree.
 */
export function detectConflicts(news: NewsRecord[], injuries: InjuryRecord[], asOf: string): Conflict[] {
  const conflicts: Conflict[] = [];
  const players = new Map<string, { teamId: string; name: string }>();
  for (const i of injuries) players.set(`${i.participant_id}|${i.player_name}`, { teamId: i.participant_id, name: i.player_name });
  const recent = news.filter((n) => !n.published_at || Date.parse(asOf) - Date.parse(n.published_at) < 72 * 3600000);
  for (const { teamId, name } of players.values()) {
    const last = name.split(" ").slice(-1)[0];
    const mentions = recent.filter((n) => n.title.includes(name) || (last.length > 3 && new RegExp(`\\b${last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(n.title) && json<string[]>(n.participant_ids, []).includes(teamId)));
    const statements = mentions
      .map((n) => {
        const neg = NEGATIVE.test(n.title);
        const pos = POSITIVE.test(n.title);
        if (neg === pos) return null;
        return { title: n.title, url: n.url, source: n.source_name, tier: n.source_tier, claim: n.claim_type, published_at: n.published_at, stance: neg ? ("unavailable" as const) : ("available" as const) };
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    const statuses = injuries
      .filter((i) => i.participant_id === teamId && i.player_name === name)
      .map((i) => ({ status: i.status, source: i.source }))
      .filter((x, k, arr) => arr.findIndex((y) => y.status === x.status && y.source === x.source) === k);
    const stances = new Set(statements.map((s) => s.stance));
    const distinctStatuses = new Set(statuses.map((s) => s.status));
    if (stances.size > 1 || distinctStatuses.size > 1) conflicts.push({ player: name, teamId, statements, injuryStatuses: statuses });
  }
  return conflicts;
}
