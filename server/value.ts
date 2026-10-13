// Value Finder and Average Lines.
//
// Three separate questions, never merged into one "best bets" list:
//   1. Most likely outcomes: the highest estimated probabilities today. Likely is not the same as
//      profitable: a 75% favourite priced at 1.25 loses money on average.
//   2. Price discrepancies: a quoted price that beats the margin-free consensus of several books
//      (the most reliable kind of edge), a model edge only where the model has beaten the market
//      out of sample, and arbitrage (prices across books that cover every outcome for a guaranteed return).
//   3. Track record: what each rule would have done on this season's completed games, with
//      confidence intervals and closing line value, so students can see whether it is noise.
// Simulation points only. Nothing here places, links to or sizes a real-money wager.

import { CONTRACTS, primaryContract, sportFamily, type ContractKey, type OutcomeKey } from "../shared/contracts";
import { arbitrage, averagePrice, closingLineValue } from "../shared/betting";
import { decimalToAmerican as toAmerican, expectedNetPointsWithPush, settledNetPoints, breakEvenProbability } from "../shared/odds";
import { mean, pairedBootstrapCI } from "../shared/evaluation";
import { settle } from "../shared/settlement";
import { seasonOf } from "../shared/contracts";
import type { AnalysisContext, AnalysisDeps, GameAnalysis } from "./analysis";
import { linesOffered, type MarketView } from "./market";
import type { Dataset, EventRecord } from "./repo";

/** American odds rounded to a whole number for display (prices are stored as decimals). */
const decimalToAmerican = (d: number) => Math.round(toAmerican(d));

export const MIN_EDGE = 0.01;
export const MIN_CONSENSUS_BOOKS = 3;
export const DECISION_MINUTES = 75;
export const CLOSING_MINUTES = 20;

export type Grade = "A" | "B" | "C" | "D";
export const GRADE_TEXT: Record<Grade, string> = {
  A: "Arbitrage: prices from different books cover every outcome for a guaranteed return, if all legs are placed at these prices at the same moment.",
  B: `Price beats the consensus: this price is better than the margin-free consensus of at least ${MIN_CONSENSUS_BOOKS} books by ${Math.round(MIN_EDGE * 100)}% or more.`,
  C: "Validated model edge: the model disagrees with the market and has beaten it on out-of-sample games.",
  D: "Unproven: only the model (not validated against the market) sees value. Treat as a hypothesis to test, not an edge.",
};

export interface Candidate {
  eventId: string;
  sport: string;
  league: string;
  start: string;
  matchup: string;
  contract: ContractKey;
  contractShort: string;
  line: number | null;
  outcome: OutcomeKey;
  selection: string;
  /** Best estimate of winning, and of a push (stake returned) for lines. */
  probability: number;
  push: number;
  estimateSource: "combined" | "market" | "model";
  estimateLabel: string;
  best: { decimal: number; american: number; book: string };
  /** Moneyline, or the most-quoted spread/total line (alternate lines are excluded from "most likely"). */
  mainLine: boolean;
  breakEven: number;
  fair: { decimal: number; american: number } | null;
  /** Expected net points per 1 point at the best price using the best estimate (pushes refunded). */
  ev: number;
  /** Margin-free consensus probability (given no push) and the edge of the best price against it. */
  consensus: { probability: number; books: number; edge: number } | null;
  grade: Grade | null;
  gradeReason: string | null;
}

export interface ArbitrageOpportunity {
  eventId: string;
  matchup: string;
  start: string;
  contract: ContractKey;
  contractShort: string;
  line: number | null;
  legs: { outcome: OutcomeKey; selection: string; decimal: number; american: number; book: string; stakeShare: number }[];
  impliedTotal: number;
  guaranteedReturn: number;
}

const selectionName = (a: GameAnalysis, contract: ContractKey, line: number | null, o: OutcomeKey): string => {
  const team = o === "home" ? a.event.home_name : o === "away" ? a.event.away_name : null;
  if (contract === "spread_full_game" && team && line != null) {
    const l = o === "home" ? line : -line;
    return `${team} ${l > 0 ? "+" : l === 0 ? "" : "−"}${l === 0 ? "PK" : Math.abs(l)}`;
  }
  if (contract === "total_full_game" && line != null) return `${o === "over" ? "Over" : "Under"} ${line}`;
  if (o === "draw") return "Draw";
  return team ?? o;
};

const fairPrice = (p: number) => (p > 0 && p < 1 ? { decimal: 1 / p, american: decimalToAmerican(1 / p) } : null);

function candidatesFor(a: GameAnalysis): { candidates: Candidate[]; arbs: ArbitrageOpportunity[] } {
  const candidates: Candidate[] = [];
  const arbs: ArbitrageOpportunity[] = [];
  const matchup = `${a.event.away_name} ${sportFamily(a.event.sport_key) === "tennis" ? "vs" : "at"} ${a.event.home_name}`;
  const base = { eventId: a.event.id, sport: a.event.sport_key, league: a.event.league, start: a.event.start_time, matchup };
  const markets: { m: MarketView; line: number | null; side?: GameAnalysis["lines"][number] }[] = [{ m: a.market, line: null }, ...a.lines.map((l) => ({ m: l.market, line: l.line, side: l }))];
  for (const { m, line, side } of markets) {
    const spec = CONTRACTS[m.contract];
    // ---- arbitrage across books (same contract, same line) ----
    if (spec.outcomes.every((o) => m.bestPrice[o])) {
      const best = spec.outcomes.map((o) => m.bestPrice[o]!);
      const arb = arbitrage(best.map((b) => b.decimal));
      if (arb.isArbitrage) {
        arbs.push({
          ...base,
          contract: m.contract,
          contractShort: spec.short,
          line,
          legs: spec.outcomes.map((o, i) => ({ outcome: o, selection: selectionName(a, m.contract, line, o), decimal: best[i].decimal, american: decimalToAmerican(best[i].decimal), book: best[i].book_title, stakeShare: arb.stakeShares[i] })),
          impliedTotal: arb.impliedTotal,
          guaranteedReturn: arb.margin,
        });
      }
    }
    for (const o of spec.outcomes) {
      const bp = m.bestPrice[o];
      if (!bp) continue;
      // ---- best estimate ----
      let win: number | null = null;
      let push = 0;
      let source: Candidate["estimateSource"] = "market";
      let label = "";
      if (!side) {
        if (a.combined.probs?.[o] != null) {
          win = a.combined.probs[o]!;
          source = "combined";
          label = "Combined (model + market, weights fitted on past seasons)";
        } else if (m.reference?.probs[o] != null) {
          win = m.reference.probs[o]!;
          label = `Market consensus (${m.reference.nBooks} book${m.reference.nBooks === 1 ? "" : "s"}, margin removed)`;
        } else if (a.model.probs?.[o] != null) {
          win = a.model.probs[o]!;
          source = "model";
          label = "Independent model only";
        }
      } else {
        const s = side.sides[o];
        if (s?.combined) {
          win = s.combined.win;
          push = s.combined.push;
          source = "combined";
          label = "Sharpened (model + market-implied line, weights fitted on past seasons)";
        } else if (s?.market != null) {
          win = s.market;
          label = `Market consensus (${m.reference!.nBooks} book${m.reference!.nBooks === 1 ? "" : "s"}, margin removed; pushes not modelled)`;
        } else if (s?.model) {
          win = s.model.win;
          push = s.model.push;
          source = "model";
          label = "Independent model only";
        }
      }
      if (win == null) continue;
      const loss = Math.max(0, 1 - win - push);
      const ev = expectedNetPointsWithPush(win, loss, Math.max(0, 1 - win - loss), bp.decimal);
      const cons = m.reference && m.reference.probs[o] != null ? { probability: m.reference.probs[o]!, books: m.reference.nBooks, edge: bp.decimal * m.reference.probs[o]! - 1 } : null;
      // ---- grade ----
      let grade: Grade | null = null;
      let reason: string | null = null;
      if (cons && cons.books >= MIN_CONSENSUS_BOOKS && cons.edge >= MIN_EDGE) {
        grade = "B";
        reason = `${bp.book_title} pays ${bp.decimal.toFixed(2)}; the consensus of ${cons.books} books implies a fair price of ${(1 / cons.probability).toFixed(2)} (edge ${(cons.edge * 100).toFixed(1)}%).`;
      } else if (!side && a.discrepancy?.[o]?.verdict === "research_lead" && ev >= MIN_EDGE) {
        grade = "C";
        reason = a.discrepancy[o]!.reason;
      } else if (ev >= MIN_EDGE && source !== "market") {
        grade = "D";
        reason =
          cons && cons.edge < 0
            ? `The ${source === "model" ? "model" : "combined estimate"} sees +${(ev * 100).toFixed(1)}%, but against the market consensus this price is ${(cons.edge * 100).toFixed(1)}%. The market has been the better forecaster.`
            : `The ${source === "model" ? "model" : "combined estimate"} sees +${(ev * 100).toFixed(1)}%, but it has not beaten the market out of sample.`;
      }
      candidates.push({
        ...base,
        contract: m.contract,
        contractShort: spec.short,
        line,
        outcome: o,
        selection: selectionName(a, m.contract, line, o),
        probability: win,
        push,
        estimateSource: source,
        estimateLabel: label,
        best: { decimal: bp.decimal, american: decimalToAmerican(bp.decimal), book: bp.book_title },
        mainLine: !side || side.isMainLine,
        breakEven: breakEvenProbability(bp.decimal),
        fair: fairPrice(win / Math.max(1e-9, win + loss)),
        ev,
        consensus: cons,
        grade,
        gradeReason: reason,
      });
    }
  }
  return { candidates, arbs };
}

export function valueFinder(analyses: GameAnalysis[], opts: { limit?: number } = {}) {
  const open = analyses.filter((a) => !a.status.started && !a.status.voided);
  const all: Candidate[] = [];
  const arbs: ArbitrageOpportunity[] = [];
  for (const a of open) {
    const r = candidatesFor(a);
    all.push(...r.candidates);
    arbs.push(...r.arbs);
  }
  const limit = opts.limit ?? 15;
  const order: Record<Grade, number> = { A: 0, B: 1, C: 2, D: 3 };
  // One entry per selection: the best price for the moneyline or main line (alternate lines would repeat it).
  const mostLikely = all
    .filter((c) => c.mainLine)
    .sort((x, y) => y.probability - x.probability || y.ev - x.ev)
    .slice(0, limit);
  const discrepancies = all.filter((c) => c.grade === "B" || c.grade === "C").sort((x, y) => order[x.grade!] - order[y.grade!] || (y.consensus?.edge ?? y.ev) - (x.consensus?.edge ?? x.ev));
  const unproven = all.filter((c) => c.grade === "D").sort((x, y) => y.ev - x.ev).slice(0, limit);
  const notes: string[] = [];
  if (!open.length) notes.push("No upcoming games with prices for this day. That is a valid result.");
  if (open.length && !discrepancies.length && !arbs.length) notes.push("No price beats the consensus today. The finder never fills a quota: an empty list is the honest answer on most days.");
  notes.push("Most likely and best value are different questions: a likely outcome at a short price usually returns less than it costs.");
  notes.push("Edges here are measured against prices at the information time. Prices move, and books limit or refuse winning customers; real-world results would be worse than these numbers.");
  return {
    games: open.length,
    candidatesConsidered: all.length,
    mostLikely,
    discrepancies,
    unproven,
    arbitrage: arbs.sort((x, y) => y.guaranteedReturn - x.guaranteedReturn),
    grades: GRADE_TEXT,
    thresholds: { minEdge: MIN_EDGE, minConsensusBooks: MIN_CONSENSUS_BOOKS },
    notes,
  };
}

// ---------------------------------------------------------------- average lines
export interface AverageOutcome {
  outcome: OutcomeKey;
  selection: string;
  books: number;
  average: { decimal: number; american: number } | null;
  best: { decimal: number; american: number; book: string } | null;
  worst: { decimal: number; american: number; book: string } | null;
  fair: { decimal: number; american: number; probability: number } | null;
}

export interface AverageMarket {
  contract: ContractKey;
  contractShort: string;
  line: number | null;
  /** Mean of each book's own current line for this contract (spreads/totals), and the range. */
  averageLine: number | null;
  lineRange: [number, number] | null;
  linesOffered: { line: number; books: number }[];
  hold: number | null;
  outcomes: AverageOutcome[];
}

export function averageLines(analyses: GameAnalysis[]) {
  const games = analyses.map((a) => {
    const markets: AverageMarket[] = [];
    const pick = (m: MarketView, offered: { line: number; books: number }[]) => {
      const spec = CONTRACTS[m.contract];
      const current = m.books.filter((b) => b.status === "current");
      const outcomes: AverageOutcome[] = spec.outcomes.map((o) => {
        const quotes = current.map((b) => ({ d: b.outcomes[o]?.decimal, book: b.book_title })).filter((x): x is { d: number; book: string } => x.d != null);
        const sorted = [...quotes].sort((x, y) => y.d - x.d);
        const avg = quotes.length ? averagePrice(quotes.map((q) => q.d)) : null;
        const p = m.reference?.probs[o];
        return {
          outcome: o,
          selection: selectionName(a, m.contract, m.line, o),
          books: quotes.length,
          average: avg ? { decimal: avg, american: decimalToAmerican(avg) } : null,
          best: sorted[0] ? { decimal: sorted[0].d, american: decimalToAmerican(sorted[0].d), book: sorted[0].book } : null,
          worst: sorted.length ? { decimal: sorted[sorted.length - 1].d, american: decimalToAmerican(sorted[sorted.length - 1].d), book: sorted[sorted.length - 1].book } : null,
          fair: p != null && p > 0 && p < 1 ? { decimal: 1 / p, american: decimalToAmerican(1 / p), probability: p } : null,
        };
      });
      const holds = current.map((b) => b.overround).filter((x): x is number => x != null);
      // Each book's current line for this contract (books quoting several lines count each line).
      let averageLine: number | null = null;
      let lineRange: [number, number] | null = null;
      if (spec.hasLine) {
        const all = a.otherMarkets.filter((x) => x.contract === m.contract).flatMap((x) => x.books.filter((b) => b.status === "current").map(() => x.line!));
        if (all.length) {
          averageLine = mean(all);
          lineRange = [Math.min(...all), Math.max(...all)];
        }
      }
      markets.push({ contract: m.contract, contractShort: spec.short, line: m.line, averageLine, lineRange, linesOffered: offered, hold: holds.length ? mean(holds) : null, outcomes });
    };
    pick(a.market, []);
    for (const lc of ["spread_full_game", "total_full_game"] as const) {
      const ls = a.lines.filter((l) => l.contract === lc);
      const main = ls.find((l) => l.isMainLine) ?? ls[0];
      if (main) pick(main.market, ls.map((l) => ({ line: l.line, books: l.booksQuoting })));
    }
    return {
      eventId: a.event.id,
      sport: a.event.sport_key,
      league: a.event.league,
      start: a.event.start_time,
      home: a.event.home_name,
      away: a.event.away_name,
      started: a.status.started,
      voided: a.status.voided,
      infoAsOf: a.infoAsOf,
      markets,
    };
  });
  return {
    games,
    method:
      "Average price = the price whose implied probability is the mean of the books' implied probabilities (averaging American odds directly is wrong across the ±100 gap). Fair price = margin-free consensus. Hold = average bookmaker margin. Only current quotes are used.",
  };
}

// ---------------------------------------------------------------- backtest
interface BetRecord {
  sport: string;
  net: number;
  clv: number | null;
  won: boolean;
  push: boolean;
}

const summarise = (bets: BetRecord[]) => {
  const n = bets.length;
  const settled = bets.filter((b) => !b.push);
  const clvs = bets.map((b) => b.clv).filter((x): x is number => x != null);
  return {
    bets: n,
    wins: bets.filter((b) => b.won).length,
    pushes: bets.filter((b) => b.push).length,
    hitRate: settled.length ? settled.filter((b) => b.won).length / settled.length : null,
    netPoints: bets.reduce((s, b) => s + b.net, 0),
    roi: n ? mean(bets.map((b) => b.net)) : null,
    roiCI: n >= 20 ? pairedBootstrapCI(bets.map((b) => b.net), bets.map(() => 0)) : null,
    meanClv: clvs.length ? mean(clvs) : null,
    clvCI: clvs.length >= 20 ? pairedBootstrapCI(clvs, clvs.map(() => 0)) : null,
  };
};

export class Backtester {
  private cache = new Map<string, unknown>();
  constructor(private deps: AnalysisDeps) {}

  /** Season-to-date backtest of the finder's rules on games that finished before the information time. */
  run(dataset: Dataset, asOf: string, sports: string[]) {
    const repo = this.deps.repo;
    const markets = this.deps.models.markets;
    const finals: EventRecord[] = [];
    const seasons: Record<string, string> = {};
    for (const sport of sports) {
      const all = repo.finalsBefore(dataset, sport, asOf);
      const last = all[all.length - 1];
      if (!last) continue;
      const season = last.season ?? seasonOf(sport, last.start_time);
      seasons[sport] = season;
      finals.push(...all.filter((g) => (g.season ?? seasonOf(sport, g.start_time)) === season));
    }
    const key = `${dataset}|${asOf}|${finals.length}|${finals.map((f) => f.id).slice(-1)[0] ?? ""}`;
    const hit = this.cache.get(key);
    if (hit) return hit as ReturnType<Backtester["compute"]>;
    const r = this.compute(finals, seasons, markets);
    if (this.cache.size > 20) this.cache.clear();
    this.cache.set(key, r);
    return r;
  }

  private compute(finals: EventRecord[], seasons: Record<string, string>, markets: AnalysisDeps["models"]["markets"]) {
    const consensusBets: BetRecord[] = [];
    const favouriteBets: BetRecord[] = [];
    let gamesWithPrices = 0;
    for (const e of finals) {
      const snap = markets.snapshot(e.id, e.start_time, DECISION_MINUTES);
      if (!snap.quotes.length) continue;
      const contracts: { c: ContractKey; line: number | null }[] = [{ c: primaryContract(e.sport_key), line: null }];
      for (const lc of ["spread_full_game", "total_full_game"] as const) {
        const main = linesOffered(snap.quotes, lc)[0];
        if (main) contracts.push({ c: lc, line: main.line });
      }
      let any = false;
      for (const { c, line } of contracts) {
        const m = markets.referenceAt(e, c, line, DECISION_MINUTES);
        if (!m?.reference) continue;
        any = true;
        const close = markets.referenceAt(e, c, line, CLOSING_MINUTES);
        const result = { status: e.status, homeScore: e.home_score, awayScore: e.away_score, regulationHome: e.regulation_home, regulationAway: e.regulation_away, finalIsRegulation: !!e.final_is_regulation };
        const record = (o: OutcomeKey, d: number): BetRecord | null => {
          const s = settle(c, o, line, result).settlement;
          if (s !== "win" && s !== "loss" && s !== "push" && s !== "void") return null;
          const pc = close?.reference?.probs[o];
          return { sport: e.sport_key, net: settledNetPoints(s, 1, d), clv: pc != null ? closingLineValue(d, pc) : null, won: s === "win", push: s === "push" || s === "void" };
        };
        for (const o of m.outcomes) {
          const bp = m.bestPrice[o];
          const p = m.reference.probs[o];
          if (!bp || p == null) continue;
          if (m.reference.nBooks >= MIN_CONSENSUS_BOOKS && bp.decimal * p - 1 >= MIN_EDGE) {
            const r = record(o, bp.decimal);
            if (r) consensusBets.push(r);
          }
        }
        if (c === primaryContract(e.sport_key)) {
          const fav = m.outcomes.reduce((x, y) => ((m.reference!.probs[y] ?? 0) > (m.reference!.probs[x] ?? 0) ? y : x));
          const bp = m.bestPrice[fav];
          if (bp) {
            const r = record(fav, bp.decimal);
            if (r) favouriteBets.push(r);
          }
        }
      }
      if (any) gamesWithPrices++;
    }
    const bySport = (bets: BetRecord[]) => Object.fromEntries([...new Set(bets.map((b) => b.sport))].sort().map((s) => [s, summarise(bets.filter((b) => b.sport === s))]));
    return {
      seasons,
      games: finals.length,
      gamesWithPrices,
      timing: `Decision at the quotes known ${DECISION_MINUTES} minutes before each start; closing line = consensus ${CLOSING_MINUTES} minutes before the start. Each rule stakes 1 simulation point per selection at the best quoted price.`,
      strategies: [
        {
          key: "consensus_edge",
          label: "Price beats the consensus (grade B rule)",
          rule: `Every outcome whose best price beat the margin-free consensus of ${MIN_CONSENSUS_BOOKS}+ books by at least ${Math.round(MIN_EDGE * 100)}%.`,
          ...summarise(consensusBets),
          bySport: bySport(consensusBets),
        },
        {
          key: "favourite",
          label: "Always back the most likely outcome (baseline)",
          rule: "The outcome with the highest consensus probability in every game, at the best quoted price.",
          ...summarise(favouriteBets),
          bySport: bySport(favouriteBets),
        },
      ],
      notes: [
        "ROI = average net points per point staked. The interval is a 95% bootstrap interval: if it includes 0, the result is consistent with luck.",
        "Closing line value (CLV) compares the price taken with the margin-free consensus shortly before the start. Consistently positive CLV is a better sign of skill than short-run profit.",
        "This is a backtest on prices that were available in the data. Real books move prices, limit stakes and close accounts that win.",
      ],
    };
  }
}

export type BacktestResult = ReturnType<Backtester["run"]>;
export type ValueContext = AnalysisContext;
