// Daily research board: analyses for every game on a local calendar day, summarised for
// three distinct questions (most likely outcome, highest quoted price, model–market gap).

import { localDayBounds } from "../shared/time";
import { CONTRACTS, type OutcomeKey } from "../shared/contracts";
import { csvCell } from "./classroom";
import { analyzeEvent, type AnalysisContext, type AnalysisDeps, type GameAnalysis } from "./analysis";

export interface BoardItem {
  eventId: string;
  sport: string;
  league: string;
  start: string;
  status: string;
  started: boolean;
  voided: boolean;
  resultKnown: boolean;
  score: string | null;
  home: string;
  away: string;
  homeAbbr: string | null;
  awayAbbr: string | null;
  contract: string;
  contractShort: string;
  outcomes: OutcomeKey[];
  outcomeNames: Partial<Record<OutcomeKey, string>>;
  primary: GameAnalysis["primary"];
  market: { probs: Partial<Record<OutcomeKey, number>>; nBooks: number; range: Partial<Record<OutcomeKey, [number, number]>> } | null;
  marketUnavailable: string | null;
  model: { probs: Partial<Record<OutcomeKey, number>>; interval80: Partial<Record<OutcomeKey, [number, number]>>; version: string } | null;
  modelUnavailable: string | null;
  combined: Partial<Record<OutcomeKey, number>> | null;
  discrepancy: GameAnalysis["discrepancy"];
  verdict: GameAnalysis["overallVerdict"];
  bestPrice: GameAnalysis["market"]["bestPrice"];
  booksTotal: number;
  booksCurrent: number;
  newestQuote: string | null;
  completeness: GameAnalysis["completeness"];
  evidence: { injuries: number; conflicts: number; news: number; lineups: string; weather: string | null };
  uncertainty: string;
  asOf: string;
  fictional: boolean;
}

export function summarize(a: GameAnalysis): BoardItem {
  const spec = CONTRACTS[a.contract];
  const names: Partial<Record<OutcomeKey, string>> = { home: a.event.home_name, away: a.event.away_name, draw: "Draw" };
  const confirmed = a.evidence.lineups.filter((l) => l.status === "confirmed").length;
  const probable = a.evidence.lineups.filter((l) => l.status === "probable").length;
  const newest = a.market.books.map((b) => b.lastConfirmed).filter((x): x is string => !!x).sort();
  return {
    eventId: a.event.id,
    sport: a.event.sport_key,
    league: a.event.league,
    start: a.event.start_time,
    status: a.event.status,
    started: a.status.started,
    voided: a.status.voided,
    resultKnown: a.status.resultKnown,
    score: a.status.resultKnown ? `${a.event.home_score}-${a.event.away_score}` : null,
    home: a.event.home_name,
    away: a.event.away_name,
    homeAbbr: a.event.home_abbr,
    awayAbbr: a.event.away_abbr,
    contract: a.contract,
    contractShort: spec.short,
    outcomes: spec.outcomes,
    outcomeNames: Object.fromEntries(spec.outcomes.map((o) => [o, names[o] ?? o])),
    primary: a.primary,
    market: a.market.reference ? { probs: a.market.reference.probs, nBooks: a.market.reference.nBooks, range: a.market.reference.range } : null,
    marketUnavailable: a.market.referenceUnavailableReason,
    model: a.model.probs ? { probs: a.model.probs, interval80: a.model.interval80!, version: a.model.version! } : null,
    modelUnavailable: a.model.reason,
    combined: a.combined.probs,
    discrepancy: a.discrepancy,
    verdict: a.overallVerdict,
    bestPrice: a.market.bestPrice,
    booksTotal: a.market.books.length,
    booksCurrent: a.market.books.filter((b) => b.status === "current").length,
    newestQuote: newest[newest.length - 1] ?? null,
    completeness: a.completeness,
    evidence: {
      injuries: a.evidence.injuries.length,
      conflicts: a.evidence.conflicts.length,
      news: a.evidence.news.filter((n) => !n.isDuplicate).length,
      lineups: confirmed === 2 ? "confirmed" : confirmed + probable > 0 ? "partial" : "unknown",
      weather: a.evidence.weather && a.evidence.weatherRelevant ? `${a.evidence.weather.precip_probability ?? "?"}% precip.` : null,
    },
    uncertainty: a.uncertainty,
    asOf: a.infoAsOf,
    fictional: a.fictional,
  };
}

export function buildBoard(deps: AnalysisDeps, ctx: AnalysisContext, localDate: string) {
  const { startUtc, endUtc, hours } = localDayBounds(localDate, ctx.zone);
  const events = deps.repo.eventsInWindow(ctx.dataset, startUtc, endUtc, ctx.asOf);
  const analyses = events.map((e) => analyzeEvent(deps, ctx, e.id)).filter((a): a is GameAnalysis => !!a);
  const items = analyses.map(summarize);
  const books = new Set<string>();
  for (const a of analyses) for (const b of a.market.books) books.add(b.book_title);
  const coverage = {
    events: items.length,
    withCurrentMarket: items.filter((i) => i.market).length,
    withModel: items.filter((i) => i.model).length,
    voided: items.filter((i) => i.voided).length,
    started: items.filter((i) => i.started).length,
    books: [...books].sort(),
    sports: [...new Set(items.map((i) => i.sport))],
    researchLeads: items.filter((i) => i.verdict.verdict === "research_lead").length,
  };
  const notes: string[] = [];
  if (!items.length) notes.push("No games found for this day in the connected data. That is a valid result, not an error.");
  if (items.length && !coverage.withCurrentMarket) notes.push("No current market quotes for any game today.");
  if (hours !== 24) notes.push(`This local day has ${hours} hours (daylight-saving change).`);
  if (items.length && coverage.researchLeads === 0) notes.push("No model–market difference is credible today. This board never fills a quota of picks.");
  return { date: localDate, zone: ctx.zone, window: { startUtc, endUtc, hours }, asOf: ctx.asOf, mode: ctx.mode, dataset: ctx.dataset, coverage, notes, items, analyses };
}

export function boardCsv(items: BoardItem[]): string {
  const header = ["event_id", "league", "start_utc", "home", "away", "contract", "status", "primary_source", "outcome", "primary_probability", "market_reference", "market_books", "model_probability", "model_80_low", "model_80_high", "difference", "verdict", "highest_quoted_decimal", "highest_quoted_book", "quote_source_time", "inputs_available", "as_of"];
  const lines = [header.join(",")];
  for (const i of items) {
    for (const o of i.outcomes) {
      const bp = i.bestPrice[o];
      lines.push(
        [
          i.eventId, i.league, i.start, i.home, i.away, i.contractShort, i.status, i.primary.source, i.outcomeNames[o], fmt(i.primary.probs?.[o]), fmt(i.market?.probs[o]), i.market?.nBooks ?? "",
          fmt(i.model?.probs[o]), fmt(i.model?.interval80[o]?.[0]), fmt(i.model?.interval80[o]?.[1]), fmt(i.discrepancy?.[o]?.diff), i.discrepancy?.[o]?.verdict ?? i.verdict.verdict,
          bp?.decimal ?? "", bp?.book_title ?? "", bp?.source_time ?? "", `${i.completeness.available}/${i.completeness.applicable}`, i.asOf,
        ]
          .map(csvCell)
          .join(","),
      );
    }
  }
  return lines.join("\r\n") + "\r\n";
}

const fmt = (x: number | null | undefined) => (x == null ? "" : x.toFixed(4));
