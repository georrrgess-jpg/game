// Per-game analysis: market quotes, margin-adjusted reference, independent model,
// combined estimate, discrepancy verdicts, data completeness, evidence and a
// deterministic plain-language explanation. All numbers come from code, not prose.

import { CONTRACTS, contractId, sportFamily, weatherRelevant, type ContractKey, type OutcomeKey } from "../shared/contracts";
import {
  breakEvenProbability,
  consensusFromBooks,
  decimalToAmerican,
  expectedNetPoints,
  formatPct,
  formatPctPoints,
  impliedProbability,
  logit,
  proportionalNoVig,
  sigmoid,
} from "../shared/odds";
import { minutesBetween } from "../shared/time";
import type { Dataset, EventRecord, InjuryRecord, LineupRecord, NewsRecord, QuoteRecord, Repo, WeatherRecord } from "./repo";
import { eventAsOf } from "./repo";
import { json } from "./db";
import { fitModel, predictGame, ratingsAt, restDiffFor, type FitResult, type ModelFit, type ModelPrediction, type EloState } from "./model";
import { detectConflicts, type Conflict } from "./news";

export interface AnalysisContext {
  dataset: Dataset;
  asOf: string;
  zone: string;
  staleMinutes: number;
  discrepancyMinPoints: number;
  mode: "demo" | "replay" | "live";
}

export const MODEL_SPORTS = new Set(["demo_baseball", "baseball_mlb"]);
const COMPARABLE_MINUTES = 5;

export function primaryContract(sportKey: string): ContractKey {
  return sportFamily(sportKey) === "soccer" ? "moneyline_3way_regulation" : "moneyline_2way_full_game";
}

// ---------------- market ----------------
export interface BookQuoteView {
  book_key: string;
  book_title: string;
  outcomes: Partial<Record<OutcomeKey, { decimal: number; american: number; rawImplied: number; source_time: string; retrieved_at: string }>>;
  complete: boolean;
  comparable: boolean;
  fresh: boolean;
  status: "current" | "stale" | "incomplete" | "after_start" | "mismatched_times";
  newestSource: string | null;
  lastConfirmed: string | null;
  ageMinutes: number | null;
  overround: number | null;
  noVig: Partial<Record<OutcomeKey, number>> | null;
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
      };
    }
    const present = spec.outcomes.filter((o) => outcomes[o]);
    const complete = present.length === spec.outcomes.length;
    const times = present.map((o) => outcomes[o]!.source_time).sort();
    const newest = times[times.length - 1] ?? null;
    const comparable = complete && minutesBetween(times[0], newest!) <= COMPARABLE_MINUTES;
    // Freshness = time since the quote was last confirmed by a retrieval (a price can stay unchanged
    // for hours and still be current). The source time shows when the book last changed it.
    const retrievals = present.map((o) => outcomes[o]!.retrieved_at).sort();
    const oldestConfirmation = retrievals[0] ?? null;
    const ageMinutes = oldestConfirmation ? minutesBetween(oldestConfirmation, asOf) : null;
    const afterStart = newest != null && newest >= event.start_time;
    const fresh = !afterStart && ageMinutes != null && ageMinutes <= staleMinutes;
    let overround: number | null = null;
    let noVig: BookQuoteView["noVig"] = null;
    if (complete && comparable) {
      const ds = spec.outcomes.map((o) => outcomes[o]!.decimal);
      overround = ds.reduce((s, d) => s + 1 / d, 0) - 1;
      const p = proportionalNoVig(ds);
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
    });
  }
  books.sort((a, b) => a.book_title.localeCompare(b.book_title));

  const eligible = books.filter((b) => b.status === "current" && b.noVig);
  let reference: MarketView["reference"] = null;
  let reason: string | null = null;
  if (eligible.length) {
    const rows = eligible.map((b) => spec.outcomes.map((o) => b.noVig![o]!));
    const c = consensusFromBooks(rows);
    const range: Partial<Record<OutcomeKey, [number, number]>> = {};
    spec.outcomes.forEach((o, i) => {
      const vals = rows.map((r) => r[i]);
      range[o] = [Math.min(...vals), Math.max(...vals)];
    });
    reference = {
      probs: Object.fromEntries(spec.outcomes.map((o, i) => [o, c[i]])),
      nBooks: eligible.length,
      range,
      method:
        eligible.length === 1
          ? "One book's complete outcome set with its margin removed proportionally (p = q / sum q)."
          : `Median across ${eligible.length} books of each book's own margin-adjusted probabilities (p = q / sum q per book), renormalised. Prices from different books are never mixed into one set.`,
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
      const age = minutesBetween(q.retrieved_at, asOf);
      if (age > staleMinutes) continue;
      if (!best || q.decimal > best.decimal) {
        best = {
          decimal: q.decimal,
          american: q.american,
          book_title: b.book_title,
          book_key: b.book_key,
          source_time: q.source_time,
          retrieved_at: q.retrieved_at,
          label: `Highest quoted price among connected sources as of ${asOf}`,
        };
      }
    }
    if (best) bestPrice[o] = best;
  }
  return { contract, contractId: cid, line, label: spec.label, outcomes: spec.outcomes, books, reference, referenceUnavailableReason: reason, bestPrice };
}

// ---------------- model service ----------------
export class ModelService {
  private fits = new Map<string, FitResult>();
  private states = new Map<string, EloState>();
  constructor(
    private repo: Repo,
    private staleMinutes: () => number,
  ) {}

  forecastSeason(e: Pick<EventRecord, "season" | "start_time">): string {
    return e.season ?? e.start_time.slice(0, 4);
  }

  /** Pre-game market home probability 60 minutes before the start, from quotes known then. */
  marketHomeAt(eventId: string, startIso: string): number | null {
    const t = new Date(Date.parse(startIso) - 60 * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const quotes = this.repo.latestQuotes(eventId, t);
    if (!quotes.length) return null;
    const m = buildMarket(quotes, "moneyline_2way_full_game", null, { start_time: startIso }, t, this.staleMinutes());
    return m.reference?.probs.home ?? null;
  }

  fit(dataset: Dataset, sportKey: string, forecastSeason: string, asOf: string): FitResult {
    if (!MODEL_SPORTS.has(sportKey)) return { available: false, reason: "No validated independent model is implemented for this sport; only the market reference is shown." };
    const games = this.repo.finalsBefore(dataset, sportKey, asOf).filter((g) => (g.season ?? g.start_time.slice(0, 4)) < forecastSeason);
    const key = `${dataset}|${sportKey}|${forecastSeason}|${games.length}|${games[games.length - 1]?.id ?? ""}`;
    const cached = this.fits.get(key);
    if (cached) return cached;
    const first = games[0]?.start_time ?? asOf;
    const schedule = this.repo.scheduleFor(dataset, sportKey, first, asOf);
    const fit = fitModel({ sportKey, games, schedule, forecastSeason, marketHome: (id, start) => this.marketHomeAt(id, start) });
    if (this.fits.size > 50) this.fits.clear();
    this.fits.set(key, fit);
    return fit;
  }

  state(dataset: Dataset, sportKey: string, fit: ModelFit, asOf: string): EloState {
    const games = this.repo.finalsBefore(dataset, sportKey, asOf);
    const key = `${dataset}|${sportKey}|${fit.version}|${asOf}|${games.length}`;
    const cached = this.states.get(key);
    if (cached) return cached;
    const st = ratingsAt(games, fit.params, fit.forecastSeason);
    if (this.states.size > 200) this.states.clear();
    this.states.set(key, st);
    return st;
  }

  predict(
    ctx: { dataset: Dataset; asOf: string },
    e: EventRecord,
    overrides: { neutral?: boolean; restDiff?: number; ratingAdjust?: { home: number; away: number } } = {},
  ): { fit: FitResult; prediction: ModelPrediction | null; restDiff: number | null } {
    const season = this.forecastSeason(e);
    const fit = this.fit(ctx.dataset, e.sport_key, season, ctx.asOf);
    if (!fit.available) return { fit, prediction: null, restDiff: null };
    const st = this.state(ctx.dataset, e.sport_key, fit, ctx.asOf);
    const from = new Date(Date.parse(e.start_time) - 20 * 86400000).toISOString();
    const schedule = this.repo.scheduleFor(ctx.dataset, e.sport_key, from, e.start_time);
    const restDiff = overrides.restDiff ?? restDiffFor(schedule, e.home_id, e.away_id, e.start_time);
    let state = st;
    if (overrides.ratingAdjust && (overrides.ratingAdjust.home || overrides.ratingAdjust.away)) {
      const ratings = new Map(st.ratings);
      ratings.set(e.home_id, (ratings.get(e.home_id) ?? 1500) + overrides.ratingAdjust.home);
      ratings.set(e.away_id, (ratings.get(e.away_id) ?? 1500) + overrides.ratingAdjust.away);
      state = { ...st, ratings };
    }
    const neutral = overrides.neutral ?? !!e.neutral_site;
    return { fit, prediction: predictGame(fit, state, e.home_id, e.away_id, neutral, restDiff), restDiff };
  }
}

// ---------------- analysis ----------------
export type Verdict = "research_lead" | "no_credible_difference" | "insufficient_evidence";

export interface CompletenessItem {
  key: string;
  label: string;
  status: "ok" | "partial" | "missing" | "stale" | "unknown" | "not_applicable";
  detail: string;
}

export interface SourceRef {
  id: string;
  kind: "news" | "injury" | "lineup" | "quote" | "weather" | "results";
  title: string;
  url: string | null;
  source: string;
  time: string | null;
  tier: string;
}

export interface GameAnalysis {
  event: EventRecord & { home_name: string; away_name: string; home_abbr: string | null; away_abbr: string | null };
  asOf: string;
  /** Information time actually used: the as-of time, or the scheduled start once the game has started. */
  infoAsOf: string;
  mode: AnalysisContext["mode"];
  dataset: Dataset;
  fictional: boolean;
  contract: ContractKey;
  market: MarketView;
  otherMarkets: MarketView[];
  model: {
    available: boolean;
    reason: string | null;
    version: string | null;
    probs: Partial<Record<OutcomeKey, number>> | null;
    interval80: Partial<Record<OutcomeKey, [number, number]>> | null;
    prediction: ModelPrediction | null;
    restDiff: number | null;
    trainedThrough: string | null;
    validation: ModelFit["validationMetrics"] | null;
    notes: string[];
  };
  combined: { available: boolean; probs: Partial<Record<OutcomeKey, number>> | null; label: string; reason: string | null; weights: { model: number; market: number } | null };
  primary: { source: "model" | "market" | "none"; probs: Partial<Record<OutcomeKey, number>> | null; mostLikely: OutcomeKey | null };
  discrepancy: Partial<Record<OutcomeKey, { diff: number; verdict: Verdict; reason: string }>> | null;
  overallVerdict: { verdict: Verdict; text: string };
  expectedPoints: Partial<Record<OutcomeKey, { atPrice: number; book: string; ev: number; breakEven: number }>> | null;
  completeness: { items: CompletenessItem[]; available: number; applicable: number };
  evidence: {
    injuries: (InjuryRecord & { team_name: string })[];
    lineups: (LineupRecord & { team_name: string; playersParsed: { name: string; position?: string }[] })[];
    news: (NewsRecord & { duplicateCount: number; isDuplicate: boolean })[];
    weather: (WeatherRecord & { relevant: boolean }) | null;
    weatherRelevant: boolean;
    conflicts: Conflict[];
  };
  sources: SourceRef[];
  uncertainty: string;
  explanation: { estimate: string; facts: string[]; assumptions: string[]; missing: string[]; changes: string[] };
  status: { started: boolean; resultKnown: boolean; voided: boolean };
}

export interface AnalysisDeps {
  repo: Repo;
  models: ModelService;
}

export function analyzeEvent(deps: AnalysisDeps, ctx: AnalysisContext, eventId: string, whatIf: Parameters<ModelService["predict"]>[2] = {}): GameAnalysis | null {
  const raw = deps.repo.event(eventId);
  if (!raw || raw.dataset !== ctx.dataset || raw.known_at > ctx.asOf) return null;
  const e = eventAsOf(raw, ctx.asOf);
  // Pre-game analysis: once a game has started, everything is frozen at the scheduled start so that
  // later quotes, news and the game's own result can never feed back into its forecast.
  const infoAsOf = ctx.asOf > raw.start_time ? raw.start_time : ctx.asOf;
  const infoCtx = { ...ctx, asOf: infoAsOf };
  const home = deps.repo.participant(e.home_id);
  const away = deps.repo.participant(e.away_id);
  const homeName = home?.name ?? e.home_id;
  const awayName = away?.name ?? e.away_id;
  const contract = primaryContract(e.sport_key);
  const spec = CONTRACTS[contract];
  const quotes = deps.repo.latestQuotes(e.id, infoAsOf);
  const market = buildMarket(quotes, contract, null, e, infoAsOf, ctx.staleMinutes);
  const otherIds = [...new Set(quotes.filter((q) => q.contract !== contract).map((q) => `${q.contract}|${q.line ?? ""}`))];
  const otherMarkets = otherIds.map((k) => {
    const [c, l] = k.split("|");
    return buildMarket(quotes, c as ContractKey, l === "" ? null : Number(l), e, infoAsOf, ctx.staleMinutes);
  });

  // ---- model ----
  let model: GameAnalysis["model"] = {
    available: false, reason: null, version: null, probs: null, interval80: null, prediction: null, restDiff: null, trainedThrough: null, validation: null, notes: [],
  };
  let fitAvail: ModelFit | null = null;
  if (contract === "moneyline_2way_full_game" && MODEL_SPORTS.has(e.sport_key)) {
    const r = deps.models.predict(infoCtx, raw, whatIf);
    if (r.fit.available && r.prediction) {
      fitAvail = r.fit;
      const p = r.prediction;
      model = {
        available: true,
        reason: null,
        version: r.fit.version,
        probs: { home: p.pHome, away: 1 - p.pHome },
        interval80: { home: [p.low, p.high], away: [1 - p.high, 1 - p.low] },
        prediction: p,
        restDiff: r.restDiff,
        trainedThrough: r.fit.validation.to,
        validation: r.fit.validationMetrics,
        notes: r.fit.notes,
      };
    } else {
      model.reason = r.fit.available ? "Prediction failed." : r.fit.reason;
    }
  } else {
    model.reason =
      contract === "moneyline_3way_regulation"
        ? "No independent 3-way (draw-aware) model is implemented. Only the market reference is shown."
        : "No validated independent model is implemented for this sport. Only the market reference is shown.";
  }

  // ---- combined ----
  let combined: GameAnalysis["combined"] = { available: false, probs: null, label: "Combined estimate (uses market odds as an input)", reason: null, weights: null };
  if (fitAvail?.combined && model.probs && market.reference) {
    const pm = model.probs.home!;
    const pk = market.reference.probs.home!;
    const pc = sigmoid(fitAvail.combined.a * logit(pm) + fitAvail.combined.b * logit(pk));
    combined = { available: true, probs: { home: pc, away: 1 - pc }, label: combined.label, reason: null, weights: { model: fitAvail.combined.a, market: fitAvail.combined.b } };
  } else {
    combined.reason = !model.available
      ? "Needs an independent model estimate."
      : !market.reference
        ? "Needs a current market reference."
        : "Blend weights need at least 150 validation games with historical quotes; not available for this data.";
  }

  // ---- primary estimate ----
  const primaryProbs = model.probs ?? market.reference?.probs ?? null;
  const primarySource: GameAnalysis["primary"]["source"] = model.probs ? "model" : market.reference ? "market" : "none";
  const mostLikely = primaryProbs ? (spec.outcomes.reduce((a, b) => ((primaryProbs[b] ?? 0) > (primaryProbs[a] ?? 0) ? b : a)) as OutcomeKey) : null;

  // ---- discrepancy verdicts ----
  let discrepancy: GameAnalysis["discrepancy"] = null;
  let overall: GameAnalysis["overallVerdict"];
  const vm = fitAvail?.validationMetrics;
  if (model.probs && market.reference) {
    discrepancy = {};
    const ci = vm?.modelMinusMarketLogLoss ?? null;
    for (const o of spec.outcomes) {
      const diff = model.probs[o]! - market.reference.probs[o]!;
      const iv = model.interval80![o]!;
      const mref = market.reference.probs[o]!;
      const outsideInterval = mref < iv[0] || mref > iv[1];
      const bigEnough = Math.abs(diff) >= ctx.discrepancyMinPoints;
      let verdict: Verdict;
      let reason: string;
      if (!ci) {
        verdict = "insufficient_evidence";
        reason = "The model has not been evaluated against historical market prices for this data, so a model–market difference cannot be judged.";
      } else if (ci.high >= 0) {
        verdict = "no_credible_difference";
        reason =
          ci.mean >= 0
            ? `In validation the market reference had lower log loss than the model (difference ${ci.mean.toFixed(3)}, 95% interval ${ci.low.toFixed(3)} to ${ci.high.toFixed(3)}), so differences are treated as model error, not opportunity.`
            : `In validation the model's advantage over the market was not statistically clear (95% interval ${ci.low.toFixed(3)} to ${ci.high.toFixed(3)} includes zero).`;
      } else if (bigEnough && outsideInterval) {
        verdict = "research_lead";
        reason = "The difference exceeds the model's stated uncertainty and the minimum threshold, and the model beat the market in validation. Treat it as a research lead, not a prediction of profit.";
      } else {
        verdict = "no_credible_difference";
        reason = `The difference (${formatPctPoints(diff)}) is within the model's uncertainty or below the ${formatPctPoints(ctx.discrepancyMinPoints)} threshold.`;
      }
      discrepancy[o] = { diff, verdict, reason };
    }
    const verdicts = Object.values(discrepancy).map((d) => d!.verdict);
    const v: Verdict = verdicts.includes("research_lead") ? "research_lead" : verdicts.includes("insufficient_evidence") ? "insufficient_evidence" : "no_credible_difference";
    overall = {
      verdict: v,
      text:
        v === "research_lead"
          ? "Research lead: the model and market disagree by more than the model's uncertainty."
          : v === "insufficient_evidence"
            ? "Insufficient evidence to judge the model–market difference."
            : "No credible difference from the market.",
    };
  } else {
    overall = {
      verdict: "insufficient_evidence",
      text: !model.probs ? "No independent forecast available: market reference only." : "No current market reference to compare with.",
    };
  }

  // ---- expected points (simulation) ----
  let expectedPoints: GameAnalysis["expectedPoints"] = null;
  if (model.probs) {
    expectedPoints = {};
    for (const o of spec.outcomes) {
      const bp = market.bestPrice[o];
      if (!bp) continue;
      expectedPoints[o] = { atPrice: bp.decimal, book: bp.book_title, ev: expectedNetPoints(model.probs[o]!, bp.decimal), breakEven: breakEvenProbability(bp.decimal) };
    }
  }

  // ---- evidence ----
  const teamIds = [e.home_id, e.away_id];
  const teamName = (id: string) => (id === e.home_id ? homeName : id === e.away_id ? awayName : id);
  const injuries = deps.repo.injuriesAsOf(ctx.dataset, teamIds, infoAsOf).map((i) => ({ ...i, team_name: teamName(i.participant_id) }));
  const allInjuryRecords = deps.repo.db.all<InjuryRecord>(
    "SELECT * FROM injuries WHERE dataset = ? AND participant_id IN (?, ?) AND retrieved_at <= ? AND retrieved_at >= ?",
    [ctx.dataset, e.home_id, e.away_id, infoAsOf, new Date(Date.parse(infoAsOf) - 72 * 3600000).toISOString()],
  );
  const lineups = deps.repo.lineupsAsOf(e.id, infoAsOf).map((l) => ({ ...l, team_name: teamName(l.participant_id), playersParsed: json<{ name: string; position?: string }[]>(l.players, []) }));
  const since = new Date(Date.parse(infoAsOf) - 7 * 86400000).toISOString();
  const rawNews = deps.repo.newsAsOf(ctx.dataset, infoAsOf, { teamIds, sinceUtc: since, limit: 40 });
  const news = groupDuplicates(rawNews);
  const wRel = weatherRelevant(e.sport_key) && !e.indoor;
  const w = deps.repo.weatherAsOf(e.id, infoAsOf);
  const weather = w ? { ...w, relevant: wRel } : null;
  const conflicts = detectConflicts(rawNews, [...injuries, ...allInjuryRecords.filter((r) => r.status !== "active")], infoAsOf);

  // ---- sources ----
  const sources: SourceRef[] = [];
  const addSource = (s: Omit<SourceRef, "id">) => {
    const id = `S${sources.length + 1}`;
    sources.push({ id, ...s });
    return id;
  };
  const injurySrc = injuries.map((i) => addSource({ kind: "injury", title: `${i.player_name} (${i.team_name}): ${i.status.replace(/_/g, " ")}${i.detail ? ` — ${i.detail}` : ""}`, url: i.source_url, source: i.source, time: i.source_time, tier: i.confirmation }));
  const lineupSrc = lineups.map((l) => addSource({ kind: "lineup", title: `${l.team_name} lineup: ${l.status}${l.starter ? ` (starter ${l.starter}, ${l.starter_status})` : ""}`, url: l.source_url, source: l.source, time: l.source_time, tier: l.status === "confirmed" ? "official" : "announced" }));
  const newsSrc = news.filter((n) => !n.isDuplicate).slice(0, 12).map((n) => ({ n, id: addSource({ kind: "news", title: n.title, url: n.url, source: n.source_name, time: n.published_at, tier: `${n.source_tier} / ${n.claim_type}` }) }));
  const quoteSrc = market.books.length
    ? addSource({ kind: "quote", title: `${market.books.length} book(s) quoting ${spec.short}; newest ${market.books.map((b) => b.newestSource).filter(Boolean).sort().slice(-1)[0] ?? "—"}`, url: null, source: [...new Set(market.books.map((b) => b.book_title))].join(", "), time: market.books.map((b) => b.newestSource).filter(Boolean).sort().slice(-1)[0] ?? null, tier: "quote" })
    : null;
  const weatherSrc = weather && wRel ? addSource({ kind: "weather", title: `Forecast for start time: ${weather.temperature_c ?? "?"}°C, ${weather.precip_probability ?? "?"}% precipitation, wind ${weather.wind_kph ?? "?"} km/h`, url: weather.source_url, source: weather.source, time: weather.retrieved_at, tier: "forecast" }) : null;

  // ---- completeness ----
  const items: CompletenessItem[] = [];
  const nCurrent = market.books.filter((b) => b.status === "current").length;
  items.push({
    key: "quotes",
    label: "Market quotes",
    status: nCurrent >= 2 ? "ok" : nCurrent === 1 ? "partial" : market.books.some((b) => b.status === "stale") ? "stale" : "missing",
    detail: nCurrent ? `${nCurrent} current book(s) of ${market.books.length}` : market.referenceUnavailableReason ?? "No quotes",
  });
  items.push({
    key: "model",
    label: "Independent model",
    status: model.available ? "ok" : MODEL_SPORTS.has(e.sport_key) && contract === "moneyline_2way_full_game" ? "missing" : "not_applicable",
    detail: model.available ? model.version! : model.reason ?? "Unavailable",
  });
  const confirmed = lineups.filter((l) => l.status === "confirmed").length;
  const probable = lineups.filter((l) => l.status === "probable").length;
  items.push({
    key: "lineups",
    label: "Lineups / starters",
    status: confirmed === 2 ? "ok" : confirmed + probable > 0 ? "partial" : "unknown",
    detail: confirmed === 2 ? "Both lineups confirmed" : confirmed + probable > 0 ? `${confirmed} confirmed, ${probable} probable only` : "Not announced or not available: unknown",
  });
  const injurySeen = deps.repo.injuryFeedSeen(ctx.dataset, e.sport_key, infoAsOf);
  items.push({
    key: "injuries",
    label: "Injury reports",
    status: injurySeen ? "ok" : "unknown",
    detail: injurySeen ? `${injuries.length} active report(s) for these teams` : "No injury source checked for this sport by this time",
  });
  items.push({
    key: "news",
    label: "News (7 days)",
    status: rawNews.length ? "ok" : "unknown",
    detail: rawNews.length ? `${news.filter((n) => !n.isDuplicate).length} distinct item(s), ${conflicts.length} conflict(s)` : "No news retrieved for these teams",
  });
  items.push({
    key: "weather",
    label: "Weather",
    status: !wRel ? "not_applicable" : weather ? "ok" : "missing",
    detail: !wRel ? (e.indoor ? "Indoor venue" : "Not relevant for this sport") : weather ? `Forecast retrieved ${Math.max(0, Math.round(minutesBetween(weather.retrieved_at, infoAsOf)))} min before the information time` : "No forecast retrieved",
  });
  const applicable = items.filter((i) => i.status !== "not_applicable");
  const available = applicable.filter((i) => i.status === "ok").length;

  // ---- uncertainty statement ----
  const name = (o: OutcomeKey) => (o === "home" ? homeName : o === "away" ? awayName : o === "draw" ? "Draw" : o);
  const parts: string[] = [];
  if (model.probs && model.interval80) {
    const iv = model.interval80.home!;
    parts.push(`Model gives ${homeName} ${formatPct(model.probs.home)} (approximate 80% range ${formatPct(iv[0])}–${formatPct(iv[1])} from parameter uncertainty only).`);
  } else {
    parts.push("No independent model estimate.");
  }
  if (market.reference) {
    const rr = market.reference.range;
    const o0 = spec.outcomes[0];
    parts.push(
      `Market reference for ${name(o0)}: ${formatPct(market.reference.probs[o0])} from ${market.reference.nBooks} book(s)${market.reference.nBooks > 1 ? ` (books range ${formatPct(rr[o0]![0])}–${formatPct(rr[o0]![1])})` : ""}.`,
    );
  } else {
    parts.push(market.referenceUnavailableReason ?? "No market reference.");
  }
  parts.push(`${available} of ${applicable.length} input groups available.`);
  parts.push("A probability is not a confidence score: a 60% outcome should still fail about 4 times in 10.");
  const uncertainty = parts.join(" ");

  // ---- explanation ----
  const cite = (ids: (string | null)[]) => {
    const f = ids.filter(Boolean);
    return f.length ? ` [${f.join(", ")}]` : "";
  };
  const estimate = primaryProbs
    ? `${primarySource === "model" ? "Independent model" : "Market reference (no independent model)"}: ${spec.outcomes.map((o) => `${name(o)} ${formatPct(primaryProbs[o])}`).join(", ")}.` +
      (model.probs && market.reference ? ` Market reference: ${spec.outcomes.map((o) => `${name(o)} ${formatPct(market.reference!.probs[o])}`).join(", ")}.` : "") +
      (combined.available ? ` Combined (uses market as input): ${homeName} ${formatPct(combined.probs!.home)}.` : "") +
      ` ${overall.text}`
    : "No estimate: neither a model forecast nor a current market reference is available.";
  const facts: string[] = [];
  if (quoteSrc) facts.push(`Quotes from ${market.books.length} connected book(s); ${nCurrent} current within ${ctx.staleMinutes} minutes${cite([quoteSrc])}.`);
  lineups.forEach((l, i) => facts.push(`${l.team_name}: lineup ${l.status}${l.starter ? `, starting pitcher ${l.starter} (${l.starter_status})` : ""}${cite([lineupSrc[i]])}.`));
  injuries.forEach((inj, i) => facts.push(`${inj.player_name} (${inj.team_name}): ${injuryPhrase(inj.status)}, per ${inj.source} (${inj.confirmation})${cite([injurySrc[i]])}.`));
  if (model.prediction) {
    facts.push(
      `Team ratings reflect ${model.prediction.gamesHomeThisSeason} and ${model.prediction.gamesAwayThisSeason} completed games this season (Elo ${Math.round(model.prediction.eloHome)} vs ${Math.round(model.prediction.eloAway)}).`,
    );
  }
  if (weatherSrc && weather) facts.push(`Weather forecast: ${weather.precip_probability ?? "?"}% chance of precipitation${cite([weatherSrc])}.`);
  newsSrc.filter(({ n }) => n.claim_type === "official").slice(0, 3).forEach(({ n, id }) => facts.push(`Official: ${n.title}${cite([id])}.`));
  const assumptions: string[] = [];
  if (model.available) {
    assumptions.push("The model uses team ratings, home advantage" + (fitAvail?.featuresUsed.includes("rest_diff_days") ? " and rest days" : "") + "; weights were fitted on earlier seasons only.");
    assumptions.push("The model does not see injuries, lineups or starting pitchers. News is shown as evidence but is not converted into a numeric adjustment.");
  }
  if (market.reference) assumptions.push("Margin removal is proportional (p = q / sum q). It approximates each book's view; it does not measure the true probability.");
  assumptions.push(`${spec.label}: ${spec.settlement}`);
  const missing = items.filter((i) => ["missing", "unknown", "stale", "partial"].includes(i.status)).map((i) => `${i.label}: ${i.detail}`);
  const changes: string[] = [];
  if (confirmed < 2) changes.push("Lineup or starting-pitcher announcements.");
  if (conflicts.length) changes.push(`Resolution of conflicting reports about ${conflicts.map((c) => c.player).join(", ")}.`);
  newsSrc.filter(({ n }) => n.claim_type === "speculation").slice(0, 2).forEach(({ n, id }) => changes.push(`Unconfirmed report: "${n.title}"${cite([id])}. Treat it as speculation until official.`));
  if (weather && wRel && (weather.precip_probability ?? 0) >= 50) changes.push("Weather: a high precipitation chance raises postponement risk (a postponed game is void).");
  changes.push("Price movement as books react to new information.");
  if (model.available) changes.push("Anything the model does not measure, such as starting pitchers, injuries and motivation.");

  const started = ctx.asOf >= e.start_time;
  return {
    event: { ...e, home_name: homeName, away_name: awayName, home_abbr: home?.abbreviation ?? null, away_abbr: away?.abbreviation ?? null },
    asOf: ctx.asOf,
    infoAsOf,
    mode: ctx.mode,
    dataset: ctx.dataset,
    fictional: ctx.dataset === "demo",
    contract,
    market,
    otherMarkets,
    model,
    combined,
    primary: { source: primarySource, probs: primaryProbs, mostLikely },
    discrepancy,
    overallVerdict: overall,
    expectedPoints,
    completeness: { items, available, applicable: applicable.length },
    evidence: { injuries, lineups, news, weather, weatherRelevant: wRel, conflicts },
    sources,
    uncertainty,
    explanation: { estimate, facts, assumptions, missing, changes },
    status: { started, resultKnown: e.status === "final", voided: e.status === "postponed" || e.status === "cancelled" },
  };
}

export function injuryPhrase(status: string): string {
  switch (status) {
    case "injured_list":
      return "on the injured list";
    case "day_to_day":
      return "day-to-day";
    case "out":
      return "ruled out";
    default:
      return status.replace(/_/g, " ");
  }
}

function groupDuplicates(items: NewsRecord[]): (NewsRecord & { duplicateCount: number; isDuplicate: boolean })[] {
  // items are newest first; detect duplicates oldest-first so the earliest report is the canonical one.
  const asc = [...items].reverse();
  const canon: { key: string; idx: number; time: number }[] = [];
  const flags = asc.map(() => ({ isDuplicate: false, duplicateCount: 0 }));
  asc.forEach((n, i) => {
    const t = n.published_at ? Date.parse(n.published_at) : 0;
    const match = canon.find((c) => (asc[c.idx].url === n.url || jaccardKey(c.key, n.dedupe_key) >= 0.5) && Math.abs(c.time - t) < 48 * 3600000);
    if (match) {
      flags[i].isDuplicate = true;
      flags[match.idx].duplicateCount++;
    } else canon.push({ key: n.dedupe_key, idx: i, time: t });
  });
  return asc.map((n, i) => ({ ...n, ...flags[i] })).reverse();
}

function jaccardKey(a: string, b: string): number {
  const A = new Set(a.split(" ").filter(Boolean));
  const B = new Set(b.split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export { eventAsOf };
