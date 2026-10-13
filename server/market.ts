// Market reference: per-book margin removal, consensus across books, and a per-sport market
// configuration learned from earlier seasons only:
//   - which margin-removal method (proportional, power, Shin, odds ratio) best matched results, and
//   - how much weight each book deserves in the consensus, based on its past accuracy.
// Every learned choice is shown with its evidence; without enough history the defaults are used.

import { CONTRACTS, contractId, primaryContract, seasonOf, type ContractKey, type OutcomeKey } from "../shared/contracts";
import { consensusFromBooks, decimalToAmerican, impliedProbability, median } from "../shared/odds";
import { DEVIG_METHODS, devig, type DevigMethod } from "../shared/betting";
import { logLossMulti, brierMulti, mean } from "../shared/evaluation";
import { realisedOutcome } from "../shared/settlement";
import { minutesBetween, toUtcIso } from "../shared/time";
import type { Dataset, EventRecord, QuoteRecord, Repo } from "./repo";

const COMPARABLE_MINUTES = 5;

export interface MarketConfig {
  method: DevigMethod;
  /** Consensus weight per book (book_key). Books without a weight use `defaultWeight`. Empty = plain median. */
  weights: Record<string, number>;
  defaultWeight: number;
  source: "default" | "fitted";
  calibration: MarketCalibration | null;
}

export interface MarketCalibration {
  sportKey: string;
  season: string;
  forSeason: string;
  games: number;
  timing: string;
  methods: { method: DevigMethod; label: string; logLoss: number; brier: number }[];
  chosen: DevigMethod;
  books: { book_key: string; book_title: string; n: number; logLoss: number; vsConsensus: number; weight: number | null }[];
  weighting: { used: boolean; checkGames: number; medianLogLoss: number | null; weightedLogLoss: number | null; reason: string };
  notes: string[];
}

export const DEFAULT_METHOD: DevigMethod = "shin";
export const DEFAULT_MARKET_CONFIG: MarketConfig = { method: DEFAULT_METHOD, weights: {}, defaultWeight: 1, source: "default", calibration: null };

export const methodLabel = (m: DevigMethod) => DEVIG_METHODS.find((x) => x.key === m)?.label ?? m;

// ---------------- market view ----------------
export interface BookQuoteView {
  book_key: string;
  book_title: string;
  outcomes: Partial<Record<OutcomeKey, { decimal: number; american: number; rawImplied: number; source_time: string; retrieved_at: string; known_at: string }>>;
  complete: boolean;
  comparable: boolean;
  fresh: boolean;
  status: "current" | "stale" | "incomplete" | "after_start" | "mismatched_times";
  newestSource: string | null;
  lastConfirmed: string | null;
  ageMinutes: number | null;
  overround: number | null;
  noVig: Partial<Record<OutcomeKey, number>> | null;
  /** Weight of this book in the consensus (null when not used in it). */
  weight: number | null;
}

export interface MarketView {
  contract: ContractKey;
  contractId: string;
  line: number | null;
  label: string;
  outcomes: OutcomeKey[];
  books: BookQuoteView[];
  reference: {
    probs: Partial<Record<OutcomeKey, number>>;
    nBooks: number;
    range: Partial<Record<OutcomeKey, [number, number]>>;
    method: string;
    devig: DevigMethod;
    weighted: boolean;
  } | null;
  referenceUnavailableReason: string | null;
  bestPrice: Partial<Record<OutcomeKey, { decimal: number; american: number; book_title: string; book_key: string; source_time: string; retrieved_at: string; label: string }>>;
}

export function buildMarket(
  quotes: QuoteRecord[],
  contract: ContractKey,
  line: number | null,
  event: { start_time: string },
  asOf: string,
  staleMinutes: number,
  cfg: MarketConfig = DEFAULT_MARKET_CONFIG,
): MarketView {
  const spec = CONTRACTS[contract];
  const cid = contractId(contract, line);
  const mine = quotes.filter((q) => q.contract_id === cid);
  const byBook = new Map<string, QuoteRecord[]>();
  for (const q of mine) byBook.set(q.book_key, [...(byBook.get(q.book_key) ?? []), q]);
  const books: BookQuoteView[] = [];
  for (const [book_key, qs] of byBook) {
    const outcomes: BookQuoteView["outcomes"] = {};
    for (const q of qs) {
      if (!spec.outcomes.includes(q.outcome)) continue;
      outcomes[q.outcome] = {
        decimal: q.price_decimal,
        american: decimalToAmerican(q.price_decimal),
        rawImplied: impliedProbability(q.price_decimal),
        source_time: q.source_time,
        retrieved_at: q.retrieved_at,
        known_at: q.known_at,
      };
    }
    const present = spec.outcomes.filter((o) => outcomes[o]);
    const complete = present.length === spec.outcomes.length;
    const times = present.map((o) => outcomes[o]!.source_time).sort();
    const newest = times[times.length - 1] ?? null;
    const comparable = complete && minutesBetween(times[0], newest!) <= COMPARABLE_MINUTES;
    // Freshness = time since the quote was last confirmed by a retrieval (a price can stay unchanged
    // for hours and still be current). The source time shows when the book last changed it.
    // known_at is the information time (equal to the retrieval time for live polling, and to the snapshot
    // time for imported historical snapshots), so replays measure freshness correctly.
    const retrievals = present.map((o) => outcomes[o]!.known_at).sort();
    const oldestConfirmation = retrievals[0] ?? null;
    const ageMinutes = oldestConfirmation ? minutesBetween(oldestConfirmation, asOf) : null;
    const afterStart = newest != null && newest >= event.start_time;
    const fresh = !afterStart && ageMinutes != null && ageMinutes >= 0 && ageMinutes <= staleMinutes;
    let overround: number | null = null;
    let noVig: BookQuoteView["noVig"] = null;
    if (complete && comparable) {
      const ds = spec.outcomes.map((o) => outcomes[o]!.decimal);
      overround = ds.reduce((s, d) => s + 1 / d, 0) - 1;
      const p = devig(ds, cfg.method);
      noVig = Object.fromEntries(spec.outcomes.map((o, i) => [o, p[i]]));
    }
    books.push({
      book_key,
      book_title: qs[0].book_title,
      outcomes,
      complete,
      comparable,
      fresh,
      status: afterStart ? "after_start" : !complete ? "incomplete" : !comparable ? "mismatched_times" : fresh ? "current" : "stale",
      newestSource: newest,
      lastConfirmed: retrievals[retrievals.length - 1] ?? null,
      ageMinutes,
      overround,
      noVig,
      weight: null,
    });
  }
  books.sort((a, b) => a.book_title.localeCompare(b.book_title));

  const eligible = books.filter((b) => b.status === "current" && b.noVig);
  let reference: MarketView["reference"] = null;
  let reason: string | null = null;
  if (eligible.length) {
    const rows = eligible.map((b) => spec.outcomes.map((o) => b.noVig![o]!));
    const weighted = Object.keys(cfg.weights).length > 0 && eligible.length > 1;
    const ws = eligible.map((b) => (weighted ? cfg.weights[b.book_key] ?? cfg.defaultWeight : 1));
    eligible.forEach((b, i) => (b.weight = ws[i]));
    const c = weighted ? weightedConsensus(rows, ws) : consensusFromBooks(rows);
    const range: Partial<Record<OutcomeKey, [number, number]>> = {};
    spec.outcomes.forEach((o, i) => {
      const vals = rows.map((r) => r[i]);
      range[o] = [Math.min(...vals), Math.max(...vals)];
    });
    const how = `${methodLabel(cfg.method).toLowerCase()} margin removal`;
    reference = {
      probs: Object.fromEntries(spec.outcomes.map((o, i) => [o, c[i]])),
      nBooks: eligible.length,
      range,
      devig: cfg.method,
      weighted,
      method:
        eligible.length === 1
          ? `One book's complete outcome set with its margin removed (${how}).`
          : weighted
            ? `Weighted average across ${eligible.length} books of each book's own margin-adjusted probabilities (${how}); books that tracked results better in earlier seasons get more weight. Prices from different books are never mixed into one set.`
            : `Median across ${eligible.length} books of each book's own margin-adjusted probabilities (${how}), renormalised. Prices from different books are never mixed into one set.`,
    };
  } else if (!books.length) {
    reason = "No quotes from connected sources for this contract.";
  } else if (books.some((b) => b.status === "stale")) {
    reason = `Only stale quotes (older than ${staleMinutes} min) are available, so no current market reference is shown.`;
  } else if (books.every((b) => b.status === "after_start")) {
    reason = "Quotes after the scheduled start are excluded (pre-game analysis only).";
  } else {
    reason = "No book offers a complete, same-time set of outcomes.";
  }

  const bestPrice: MarketView["bestPrice"] = {};
  for (const o of spec.outcomes) {
    let best: (typeof bestPrice)[OutcomeKey] | undefined;
    for (const b of books) {
      const q = b.outcomes[o];
      if (!q || b.status === "after_start") continue;
      const age = minutesBetween(q.known_at, asOf);
      if (age > staleMinutes || age < 0) continue;
      if (!best || q.decimal > best.decimal) {
        best = {
          decimal: q.decimal,
          american: q.american,
          book_title: b.book_title,
          book_key: b.book_key,
          source_time: q.source_time,
          retrieved_at: q.known_at,
          label: `Highest quoted price among connected sources as of ${asOf}`,
        };
      }
    }
    if (best) bestPrice[o] = best;
  }
  return { contract, contractId: cid, line, label: spec.label, outcomes: spec.outcomes, books, reference, referenceUnavailableReason: reason, bestPrice };
}

/** Weighted mean of per-book probability sets, renormalised. */
export function weightedConsensus(rows: number[][], weights: number[]): number[] {
  if (!rows.length || rows.length !== weights.length) throw new RangeError("rows and weights must match");
  const W = weights.reduce((a, b) => a + b, 0);
  if (!(W > 0)) throw new RangeError("weights must be positive");
  const n = rows[0].length;
  const out = Array.from({ length: n }, (_, i) => rows.reduce((s, r, b) => s + weights[b] * r[i], 0) / W);
  const total = out.reduce((a, b) => a + b, 0);
  return out.map((x) => x / total);
}

/** Distinct lines quoted for a line contract, with how many books quote each (most-quoted first). */
export function linesOffered(quotes: QuoteRecord[], contract: ContractKey): { line: number; books: number }[] {
  const byLine = new Map<number, Set<string>>();
  for (const q of quotes) {
    if (q.contract !== contract || q.line == null) continue;
    const s = byLine.get(q.line) ?? new Set<string>();
    s.add(q.book_key);
    byLine.set(q.line, s);
  }
  return [...byLine.entries()].map(([line, s]) => ({ line, books: s.size })).sort((a, b) => b.books - a.books || Math.abs(a.line) - Math.abs(b.line) || a.line - b.line);
}

// ---------------- learned configuration ----------------
interface CalibrationGame {
  id: string;
  start: string;
  outcomeIdx: number;
  books: { key: string; title: string; decimals: number[] }[];
}

const MIN_CAL_GAMES = 150;
const MIN_BOOK_GAMES = 100;
const WEIGHT_SHARPNESS = 100; // weight = exp(-sharpness × excess log loss over the best book)

export const DECISION_MINUTES = 60;

export class MarketService {
  private configs = new Map<string, MarketConfig>();
  private snapshots = new Map<string, QuoteRecord[]>();

  constructor(
    private repo: Repo,
    private staleMinutes: () => number,
  ) {}

  /** Quotes known `minutesBefore` the scheduled start (cached; historical snapshots never change). */
  snapshot(eventId: string, startIso: string, minutesBefore: number): { quotes: QuoteRecord[]; t: string } {
    const t = toUtcIso(Date.parse(startIso) - minutesBefore * 60000);
    const key = `${eventId}|${t}`;
    let q = this.snapshots.get(key);
    if (!q) {
      q = this.repo.latestQuotes(eventId, t);
      if (this.snapshots.size > 30000) this.snapshots.clear();
      this.snapshots.set(key, q);
    }
    return { quotes: q, t };
  }

  private seasonCache = new Map<string, { at: number; seasons: { s: string; last: string }[] }>();

  /** Completed seasons for a sport with the time their last result became final (cached briefly). */
  private seasons(dataset: Dataset, sportKey: string): { s: string; last: string }[] {
    const key = `${dataset}|${sportKey}`;
    const hit = this.seasonCache.get(key);
    if (hit && Date.now() - hit.at < 30000) return hit.seasons;
    const seasons = this.repo.db.all<{ s: string; last: string }>(
      "SELECT COALESCE(season, substr(start_time, 1, 4)) AS s, MAX(final_at) AS last FROM events WHERE dataset = ? AND sport_key = ? AND status = 'final' GROUP BY s ORDER BY s",
      [dataset, sportKey],
    );
    this.seasonCache.set(key, { at: Date.now(), seasons });
    return seasons;
  }

  previousSeason(dataset: Dataset, sportKey: string, season: string): { s: string; last: string } | null {
    const earlier = this.seasons(dataset, sportKey).filter((r) => r.s < season);
    return earlier[earlier.length - 1] ?? null;
  }

  /**
   * Market configuration for forecasts in `season`, learned on the most recent earlier season only.
   * When `asOf` is given and that season was not complete by then, the defaults are used (no leakage).
   */
  configFor(dataset: Dataset, sportKey: string, season: string, contract: ContractKey, asOf?: string): MarketConfig {
    const p = this.previousSeason(dataset, sportKey, season);
    if (!p || (asOf && p.last > asOf)) return DEFAULT_MARKET_CONFIG;
    const prev = p.s;
    const key = `${dataset}|${sportKey}|${season}|${prev}|${contract}`;
    const cached = this.configs.get(key);
    if (cached) return cached;
    const cfg = this.learn(dataset, sportKey, prev, season, contract);
    if (this.configs.size > 100) this.configs.clear();
    this.configs.set(key, cfg);
    return cfg;
  }

  configForEvent(e: Pick<EventRecord, "dataset" | "sport_key" | "season" | "start_time">, contract: ContractKey, asOf?: string): MarketConfig {
    return this.configFor(e.dataset, e.sport_key, e.season ?? seasonOf(e.sport_key, e.start_time), contract, asOf ?? e.start_time);
  }

  private calibrationGames(dataset: Dataset, sportKey: string, season: string, contract: ContractKey): CalibrationGame[] {
    const spec = CONTRACTS[contract];
    const events = this.repo.db.all<EventRecord>(
      `SELECT * FROM events WHERE dataset = ? AND sport_key = ? AND status = 'final' AND home_score IS NOT NULL
         AND COALESCE(season, substr(start_time, 1, 4)) = ? ORDER BY start_time, id`,
      [dataset, sportKey, season],
    );
    const out: CalibrationGame[] = [];
    for (const e of events) {
      const r = realisedOutcome(contract, {
        status: e.status,
        homeScore: e.home_score,
        awayScore: e.away_score,
        regulationHome: e.regulation_home,
        regulationAway: e.regulation_away,
        finalIsRegulation: !!e.final_is_regulation,
      });
      if (!r) continue;
      const { quotes, t } = this.snapshot(e.id, e.start_time, DECISION_MINUTES);
      if (!quotes.length) continue;
      const m = buildMarket(quotes, contract, null, e, t, this.staleMinutes(), { ...DEFAULT_MARKET_CONFIG, method: "proportional" });
      const books = m.books
        .filter((b) => b.status === "current" && b.noVig)
        .map((b) => ({ key: b.book_key, title: b.book_title, decimals: spec.outcomes.map((o) => b.outcomes[o]!.decimal) }));
      if (books.length) out.push({ id: e.id, start: e.start_time, outcomeIdx: spec.outcomes.indexOf(r), books });
    }
    return out;
  }

  private learn(dataset: Dataset, sportKey: string, season: string, forSeason: string, contract: ContractKey): MarketConfig {
    const games = this.calibrationGames(dataset, sportKey, season, contract);
    if (games.length < MIN_CAL_GAMES) return DEFAULT_MARKET_CONFIG;
    const consensusLL = (g: CalibrationGame, m: DevigMethod, w?: Record<string, number>, dw = 1) => {
      const rows = g.books.map((b) => devig(b.decimals, m));
      const p = w ? weightedConsensus(rows, g.books.map((b) => w[b.key] ?? dw)) : consensusFromBooks(rows);
      return { ll: logLossMulti(p, g.outcomeIdx), br: brierMulti(p, g.outcomeIdx) };
    };
    const methods = DEVIG_METHODS.map(({ key, label }) => {
      const s = games.map((g) => consensusLL(g, key));
      return { method: key, label, logLoss: mean(s.map((x) => x.ll)), brier: mean(s.map((x) => x.br)) };
    });
    const best = methods.reduce((a, b) => (b.logLoss < a.logLoss - 1e-9 ? b : a));
    // Prefer the default unless another method is better by a visible margin (avoid chasing noise).
    const def = methods.find((m) => m.method === DEFAULT_METHOD)!;
    const chosen = best.logLoss < def.logLoss - 0.0002 ? best.method : DEFAULT_METHOD;

    // Book accuracy, measured against the plain consensus on the same games.
    const bookStats = (gs: CalibrationGame[]) => {
      const stats = new Map<string, { title: string; ll: number[]; diff: number[] }>();
      for (const g of gs) {
        const cons = consensusLL(g, chosen).ll;
        for (const b of g.books) {
          const ll = logLossMulti(devig(b.decimals, chosen), g.outcomeIdx);
          const s = stats.get(b.key) ?? { title: b.title, ll: [], diff: [] };
          s.ll.push(ll);
          s.diff.push(ll - cons);
          stats.set(b.key, s);
        }
      }
      return stats;
    };
    const weightsFrom = (stats: ReturnType<typeof bookStats>) => {
      const enough = [...stats.entries()].filter(([, s]) => s.ll.length >= MIN_BOOK_GAMES);
      if (enough.length < 2) return null;
      const excess = enough.map(([k, s]) => [k, mean(s.diff)] as const);
      const bestExcess = Math.min(...excess.map(([, d]) => d));
      const w: Record<string, number> = {};
      for (const [k, d] of excess) w[k] = Math.max(0.2, Math.exp(-WEIGHT_SHARPNESS * (d - bestExcess)));
      return { weights: w, defaultWeight: median(Object.values(w)) };
    };

    // Honest check: learn weights on the first half of the season, test on the second half.
    const half = Math.floor(games.length / 2);
    const early = games.slice(0, half);
    const late = games.slice(half);
    const trial = weightsFrom(bookStats(early));
    let medianLL: number | null = null;
    let weightedLL: number | null = null;
    let used = false;
    let reason: string;
    if (!trial) {
      reason = `Fewer than two books quoted at least ${MIN_BOOK_GAMES} games in the first half of ${season}, so books are weighted equally (median).`;
    } else {
      const multi = late.filter((g) => g.books.length > 1);
      medianLL = mean(multi.map((g) => consensusLL(g, chosen).ll));
      weightedLL = mean(multi.map((g) => consensusLL(g, chosen, trial.weights, trial.defaultWeight).ll));
      used = multi.length >= 50 && weightedLL < medianLL;
      reason = used
        ? `Weights learned on the first half of ${season} improved log loss on the second half (${weightedLL.toFixed(4)} vs ${medianLL.toFixed(4)} for the median), so the weighted consensus is used.`
        : `Weights learned on the first half of ${season} did not improve the second half (${weightedLL.toFixed(4)} vs ${medianLL.toFixed(4)} for the median), so books are weighted equally.`;
    }
    const allStats = bookStats(games);
    const final = used ? weightsFrom(allStats) : null;
    const books = [...allStats.entries()]
      .map(([k, s]) => ({ book_key: k, book_title: s.title, n: s.ll.length, logLoss: mean(s.ll), vsConsensus: mean(s.diff), weight: final ? final.weights[k] ?? null : null }))
      .sort((a, b) => a.vsConsensus - b.vsConsensus);
    const calibration: MarketCalibration = {
      sportKey,
      season,
      forSeason,
      games: games.length,
      timing: `Quotes known ${DECISION_MINUTES} minutes before each scheduled start; stale quotes excluded.`,
      methods,
      chosen,
      books,
      weighting: { used: !!final, checkGames: late.length, medianLogLoss: medianLL, weightedLogLoss: weightedLL, reason },
      notes: [
        `Chosen on ${games.length} completed ${season} games and applied to ${forSeason}: nothing from ${forSeason} is used.`,
        chosen === best.method
          ? `${methodLabel(chosen)} had the lowest log loss.`
          : `${methodLabel(best.method)} was marginally better than the default (${methodLabel(DEFAULT_METHOD)}) but not by a visible margin, so the default is kept.`,
        "A better-calibrated market reference is still only an estimate. Differences between methods are usually small.",
      ],
    };
    return { method: chosen, weights: final?.weights ?? {}, defaultWeight: final?.defaultWeight ?? 1, source: "fitted", calibration };
  }

  /** Margin-adjusted market probabilities `minutesBefore` the start, with the season's learned configuration. */
  referenceAt(e: EventRecord, contract: ContractKey, line: number | null, minutesBefore = DECISION_MINUTES): MarketView | null {
    const { quotes, t } = this.snapshot(e.id, e.start_time, minutesBefore);
    if (!quotes.length) return null;
    return buildMarket(quotes, contract, line, e, t, this.staleMinutes(), this.configForEvent(e, primaryContract(e.sport_key), t));
  }

  /** Pre-game market home probability (2-way moneyline) 60 minutes before the start. */
  homeProbAt(eventId: string): number | null {
    const e = this.repo.event(eventId);
    if (!e) return null;
    return this.referenceAt(e, "moneyline_2way_full_game", null)?.reference?.probs.home ?? null;
  }
}
