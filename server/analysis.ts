// Per-game analysis: market quotes, margin-adjusted reference, independent model,
// combined estimate, discrepancy verdicts, data completeness, evidence and a
// deterministic plain-language explanation. All numbers come from code, not prose.

import { CONTRACTS, modelSupportedSport, primaryContract, seasonOf, sportFamily, tennisBestOfFromKey, weatherRelevant, type ContractKey, type OutcomeKey } from "../shared/contracts";
import { breakEvenProbability, expectedNetPoints, expectedNetPointsWithPush, formatPct, formatPctPoints, logit, sigmoid } from "../shared/odds";
import { minutesBetween, toUtcIso } from "../shared/time";
import type { Dataset, EventRecord, InjuryRecord, LineupRecord, NewsRecord, QuoteRecord, Repo, WeatherRecord } from "./repo";
import { eventAsOf } from "./repo";
import { json } from "./db";
import {
  fitModel,
  linearPredictor,
  predictGame,
  ratingsAt,
  runElo,
  blendedCover,
  discreteDistribution,
  lineProbabilities,
  MARGIN_RANGE,
  TOTAL_RANGE,
  scheduleFeatures,
  sportConfig,
  spreadProbabilities,
  totalProbabilities,
  type EloState,
  type FitResult,
  type ModelFit,
  type ModelPrediction,
} from "./model";
import { buildMarket, linesOffered, MarketService, methodLabel, type MarketView } from "./market";

export { buildMarket, primaryContract };
export type { BookQuoteView, MarketView } from "./market";

/** Sports with an independent model. Kept as a set-like helper for callers. */
export const MODEL_SPORTS = { has: (sportKey: string) => modelSupportedSport(sportKey) };
import { logLoss, pairedBootstrapCI } from "../shared/evaluation";
import { detectConflicts, type Conflict } from "./news";

export interface AnalysisContext {
  dataset: Dataset;
  asOf: string;
  zone: string;
  staleMinutes: number;
  discrepancyMinPoints: number;
  mode: "demo" | "replay" | "live";
}

export const HOLDOUT_MIN_GAMES = 200;

export interface MarketTrackRecord {
  source: "holdout" | "validation";
  n: number;
  ci: { mean: number; low: number; high: number } | null;
}
// ---------------- model service ----------------
interface EventExtra {
  surface?: string | null;
  bestOf?: number | null;
}
export function eventExtra(e: Pick<EventRecord, "extra" | "sport_key">): EventExtra {
  const x = json<EventExtra>(e.extra, {});
  if (sportFamily(e.sport_key) === "tennis" && x.bestOf == null) x.bestOf = tennisBestOfFromKey(e.sport_key);
  return x;
}

export class ModelService {
  private fits = new Map<string, FitResult>();
  private states = new Map<string, EloState>();
  readonly markets: MarketService;
  constructor(
    private repo: Repo,
    private staleMinutes: () => number,
  ) {
    this.markets = new MarketService(repo, staleMinutes);
  }

  forecastSeason(e: Pick<EventRecord, "season" | "start_time" | "sport_key">): string {
    return e.season ?? seasonOf(e.sport_key, e.start_time);
  }

  /** Pre-game market home probability 60 minutes before the start, from quotes known then. */
  marketHomeAt(eventId: string, _startIso?: string): number | null {
    return this.markets.homeProbAt(eventId);
  }

  /** Most-quoted line 60 minutes before the start and the market's no-push probability for its first outcome. */
  marketLineAt(eventId: string, contract: "spread_full_game" | "total_full_game"): { line: number; pFirst: number } | null {
    const e = this.repo.event(eventId);
    if (!e) return null;
    const main = linesOffered(this.markets.snapshot(e.id, e.start_time, 60).quotes, contract)[0];
    if (!main) return null;
    const m = this.markets.referenceAt(e, contract, main.line);
    const p = m?.reference?.probs[contract === "spread_full_game" ? "home" : "over"];
    return p == null ? null : { line: main.line, pFirst: p };
  }

  fit(dataset: Dataset, sportKey: string, forecastSeason: string, asOf: string): FitResult {
    if (!modelSupportedSport(sportKey)) return { available: false, reason: "No validated independent model is implemented for this sport; only the market reference is shown." };
    const games = this.repo.finalsBefore(dataset, sportKey, asOf).filter((g) => (g.season ?? seasonOf(sportKey, g.start_time)) < forecastSeason);
    const key = `${dataset}|${sportKey}|${forecastSeason}|${games.length}|${games[games.length - 1]?.id ?? ""}`;
    const cached = this.fits.get(key);
    if (cached) return cached;
    const first = games[0]?.start_time ?? asOf;
    const schedule = this.repo.scheduleFor(dataset, sportKey, first, asOf);
    const fit = fitModel({ sportKey, games, schedule, forecastSeason, marketHome: (id) => this.marketHomeAt(id), marketLine: (id, c) => this.marketLineAt(id, c) });
    if (this.fits.size > 50) this.fits.clear();
    this.fits.set(key, fit);
    return fit;
  }

  state(dataset: Dataset, sportKey: string, fit: ModelFit, asOf: string): EloState {
    const games = this.repo.finalsBefore(dataset, sportKey, asOf);
    const key = `${dataset}|${sportKey}|${fit.version}|${asOf}|${games.length}`;
    const cached = this.states.get(key);
    if (cached) return cached;
    const st = ratingsAt(games, fit.params, fit.forecastSeason, sportKey);
    if (this.states.size > 200) this.states.clear();
    this.states.set(key, st);
    return st;
  }

  private records = new Map<string, MarketTrackRecord>();

  /**
   * How the model has fared against the market. Prefers the walk-forward holdout (this season's games
   * before the information time, with parameters fixed beforehand); falls back to the validation season,
   * which is optimistic because the model's settings were chosen on it.
   */
  trackRecord(dataset: Dataset, sportKey: string, fit: ModelFit, asOf: string): MarketTrackRecord {
    const finals = this.repo.finalsBefore(dataset, sportKey, asOf);
    const key = `${dataset}|${sportKey}|${fit.version}|${finals.length}|${finals[finals.length - 1]?.id ?? ""}`;
    const cached = this.records.get(key);
    if (cached) return cached;
    const schedule = this.repo.scheduleFor(dataset, sportKey, finals[0]?.start_time ?? asOf, asOf);
    const { rows } = runElo(finals, fit.params, schedule, sportConfig(sportKey));
    const llModel: number[] = [];
    const llMarket: number[] = [];
    for (const r of rows) {
      if (r.season !== fit.forecastSeason) continue;
      const pk = this.marketHomeAt(r.id);
      if (pk == null || pk <= 0 || pk >= 1) continue;
      llModel.push(logLoss(sigmoid(linearPredictor(fit.beta, r.x)), r.y));
      llMarket.push(logLoss(pk, r.y));
    }
    let rec: MarketTrackRecord;
    if (llModel.length >= HOLDOUT_MIN_GAMES) {
      rec = { source: "holdout", n: llModel.length, ci: pairedBootstrapCI(llModel, llMarket) };
    } else {
      const v = fit.validationMetrics;
      rec = { source: "validation", n: v.market?.n ?? 0, ci: v.modelMinusMarketLogLoss };
    }
    if (this.records.size > 100) this.records.clear();
    this.records.set(key, rec);
    return rec;
  }

  predict(
    ctx: { dataset: Dataset; asOf: string },
    e: EventRecord,
    overrides: { neutral?: boolean; restDiff?: number; ratingAdjust?: { home: number; away: number } } = {},
  ): { fit: FitResult; prediction: ModelPrediction | null; restDiff: number | null; b2bDiff: number | null } {
    const season = this.forecastSeason(e);
    const fit = this.fit(ctx.dataset, e.sport_key, season, ctx.asOf);
    if (!fit.available) return { fit, prediction: null, restDiff: null, b2bDiff: null };
    const st = this.state(ctx.dataset, e.sport_key, fit, ctx.asOf);
    const from = toUtcIso(Date.parse(e.start_time) - 20 * 86400000);
    const schedule = this.repo.scheduleFor(ctx.dataset, e.sport_key, from, e.start_time);
    const sf = scheduleFeatures(schedule, e.home_id, e.away_id, e.start_time);
    const restDiff = overrides.restDiff ?? sf.restDiff;
    let state = st;
    if (overrides.ratingAdjust && (overrides.ratingAdjust.home || overrides.ratingAdjust.away)) {
      const ratings = new Map(st.ratings);
      ratings.set(e.home_id, (ratings.get(e.home_id) ?? 1500) + overrides.ratingAdjust.home);
      ratings.set(e.away_id, (ratings.get(e.away_id) ?? 1500) + overrides.ratingAdjust.away);
      // Surface ratings move with the overall rating so a what-if applies on every surface.
      const surface = new Map(st.surface);
      for (const [k, v] of surface) {
        if (k.startsWith(`${e.home_id}|`)) surface.set(k, v + overrides.ratingAdjust.home);
        if (k.startsWith(`${e.away_id}|`)) surface.set(k, v + overrides.ratingAdjust.away);
      }
      state = { ...st, ratings, surface };
    }
    const neutral = overrides.neutral ?? !!e.neutral_site;
    const x = eventExtra(e);
    const prediction = predictGame(fit, state, e.home_id, e.away_id, { neutral, restDiff, b2bDiff: sf.b2bDiff, bestOf: x.bestOf ?? undefined, surface: x.surface ?? null });
    return { fit, prediction, restDiff, b2bDiff: sf.b2bDiff };
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
  /** How the market reference was built for this sport (learned on earlier seasons, or defaults). */
  marketConfig: { method: string; methodKey: string; weighted: boolean; source: "default" | "fitted"; season: string | null; note: string };
  /** Spread and total lines with model probabilities (including pushes) where the sport has a margin model. */
  lines: LineAnalysis[];
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

export interface LineSide {
  /** Model probability of winning, pushing (stake returned) and losing at this line. */
  model: { win: number; push: number; loss: number } | null;
  /** Market no-vig probability of winning given no push (prices settle pushes as refunds). */
  market: number | null;
  best: { decimal: number; american: number; book: string } | null;
  /** Model expected net points per 1 point staked at the best price (pushes return the stake). */
  ev: number | null;
  /** Sharpened estimate: model and market-implied means blended with weights chosen on the validation season. */
  combined: { win: number; push: number; loss: number } | null;
  combinedEv: number | null;
  breakEven: number | null;
}

export interface LineAnalysis {
  contract: "spread_full_game" | "total_full_game";
  line: number;
  booksQuoting: number;
  isMainLine: boolean;
  market: MarketView;
  sides: Partial<Record<OutcomeKey, LineSide>>;
  /** Model's expected home margin (spreads) or expected total points (totals). */
  modelExpected: number | null;
  /** Blended expected margin/total and the model's weight in it (null when no validated blend exists). */
  combinedExpected: number | null;
  combinedWeight: number | null;
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
  const fam = sportFamily(e.sport_key);
  const quotes = deps.repo.latestQuotes(e.id, infoAsOf);
  const mcfg = deps.models.markets.configForEvent(raw, contract, infoAsOf);
  const market = buildMarket(quotes, contract, null, e, infoAsOf, ctx.staleMinutes, mcfg);
  const otherIds = [...new Set(quotes.filter((q) => q.contract !== contract).map((q) => `${q.contract}|${q.line ?? ""}`))];
  const otherMarkets = otherIds.map((k) => {
    const [c, l] = k.split("|");
    return buildMarket(quotes, c as ContractKey, l === "" ? null : Number(l), e, infoAsOf, ctx.staleMinutes, mcfg);
  });
  const marketConfig: GameAnalysis["marketConfig"] = {
    method: methodLabel(mcfg.method),
    methodKey: mcfg.method,
    weighted: Object.keys(mcfg.weights).length > 0,
    source: mcfg.source,
    season: mcfg.calibration?.season ?? null,
    note:
      mcfg.source === "fitted"
        ? `Margin removal method and book weights were chosen on the ${mcfg.calibration!.season} season (${mcfg.calibration!.games} games) and are applied unchanged to later games.`
        : "Not enough earlier-season results with quotes to learn the market settings, so defaults are used (Shin margin removal, books weighted equally).",
  };

  // ---- model ----
  let model: GameAnalysis["model"] = {
    available: false, reason: null, version: null, probs: null, interval80: null, prediction: null, restDiff: null, trainedThrough: null, validation: null, notes: [],
  };
  let fitAvail: ModelFit | null = null;
  if (contract === "moneyline_2way_full_game" && modelSupportedSport(e.sport_key)) {
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

  // ---- spreads and totals ----
  const lines: LineAnalysis[] = [];
  for (const lc of ["spread_full_game", "total_full_game"] as const) {
    const offered = linesOffered(quotes, lc);
    offered.forEach(({ line, books }, idx) => {
      const m = otherMarkets.find((x) => x.contract === lc && x.line === line);
      if (!m) return;
      const pred = model.prediction;
      const probs =
        fitAvail && pred
          ? lc === "spread_full_game"
            ? spreadProbabilities(fitAvail, pred, line)
            : (() => {
                const t = totalProbabilities(fitAvail!, pred, line);
                return t ? { over: t.over, under: t.under } : null;
              })()
          : null;
      // Sharpened estimate: blend the model's mean with the mean implied by the market's price for this line.
      const blend = fitAvail?.lineBlend[lc === "spread_full_game" ? "spread" : "total"] ?? null;
      const dm = lc === "spread_full_game" ? fitAvail?.margin : fitAvail?.total;
      const muModel = lc === "spread_full_game" ? pred?.expectedMargin : pred?.expectedTotal;
      const first = m.outcomes[0];
      let combinedMu: number | null = null;
      let combinedProbs: Record<string, { win: number; push: number; loss: number }> | null = null;
      if (blend && dm && muModel != null && m.reference?.probs[first] != null) {
        combinedMu = blendedCover(dm, lc, line, muModel, m.reference.probs[first]!, blend.w).mu;
        const dist = discreteDistribution(combinedMu, dm, lc === "spread_full_game" ? MARGIN_RANGE : TOTAL_RANGE);
        const signed = lc === "spread_full_game" ? line : -line;
        const plus = lineProbabilities(dist, signed, "plus");
        const minus = lineProbabilities(dist, signed, "minus");
        combinedProbs = lc === "spread_full_game" ? { home: plus, away: minus } : { over: plus, under: minus };
      }
      const sides: LineAnalysis["sides"] = {};
      for (const o of m.outcomes) {
        const mp = (probs as Record<string, { win: number; push: number; loss: number }> | null)?.[o] ?? null;
        const cp = combinedProbs?.[o] ?? null;
        const bp = m.bestPrice[o];
        sides[o] = {
          model: mp,
          market: m.reference?.probs[o] ?? null,
          best: bp ? { decimal: bp.decimal, american: bp.american, book: bp.book_title } : null,
          ev: mp && bp ? expectedNetPointsWithPush(mp.win, mp.loss, mp.push, bp.decimal) : null,
          combined: cp,
          combinedEv: cp && bp ? expectedNetPointsWithPush(cp.win, cp.loss, cp.push, bp.decimal) : null,
          breakEven: bp ? breakEvenProbability(bp.decimal) : null,
        };
      }
      lines.push({
        contract: lc,
        line,
        booksQuoting: books,
        isMainLine: idx === 0,
        market: m,
        sides,
        modelExpected: lc === "spread_full_game" ? pred?.expectedMargin ?? null : pred?.expectedTotal ?? null,
        combinedExpected: combinedMu,
        combinedWeight: combinedMu != null ? blend!.w : null,
      });
    });
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
  if (model.probs && market.reference && fitAvail) {
    discrepancy = {};
    const record = deps.models.trackRecord(ctx.dataset, e.sport_key, fitAvail, infoAsOf);
    const ci = record.ci;
    const where = record.source === "holdout" ? `On this season's ${record.n} earlier games (out of sample)` : `On the validation season (${record.n} games; optimistic, because the model's settings were chosen there)`;
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
            ? `${where}, the market reference had lower log loss than the model (difference ${ci.mean.toFixed(3)}, 95% interval ${ci.low.toFixed(3)} to ${ci.high.toFixed(3)}), so differences are treated as model error, not opportunity.`
            : `${where}, the model's advantage over the market was not statistically clear (95% interval ${ci.low.toFixed(3)} to ${ci.high.toFixed(3)} includes zero).`;
      } else if (record.source === "validation") {
        verdict = "insufficient_evidence";
        reason = `${where}, the model beat the market, but that has not yet been confirmed on enough out-of-sample games (${HOLDOUT_MIN_GAMES} needed).`;
      } else if (bigEnough && outsideInterval) {
        verdict = "research_lead";
        reason = `The difference exceeds the model's stated uncertainty and the minimum threshold, and ${where.charAt(0).toLowerCase() + where.slice(1)} the model beat the market. Treat it as a research lead, not a prediction of profit.`;
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
    [ctx.dataset, e.home_id, e.away_id, infoAsOf, toUtcIso(Date.parse(infoAsOf) - 72 * 3600000)],
  );
  const lineups = deps.repo.lineupsAsOf(e.id, infoAsOf).map((l) => ({ ...l, team_name: teamName(l.participant_id), playersParsed: json<{ name: string; position?: string }[]>(l.players, []) }));
  const since = toUtcIso(Date.parse(infoAsOf) - 7 * 86400000);
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
    status: model.available ? "ok" : modelSupportedSport(e.sport_key) && contract === "moneyline_2way_full_game" ? "missing" : "not_applicable",
    detail: model.available ? model.version! : model.reason ?? "Unavailable",
  });
  const confirmed = lineups.filter((l) => l.status === "confirmed").length;
  const probable = lineups.filter((l) => l.status === "probable").length;
  items.push(
    fam === "tennis"
      ? { key: "lineups", label: "Lineups / starters", status: "not_applicable", detail: "Individual sport: no lineups" }
      : {
          key: "lineups",
          label: "Lineups / starters",
          status: confirmed === 2 ? "ok" : confirmed + probable > 0 ? "partial" : "unknown",
          detail: confirmed === 2 ? "Both lineups confirmed" : confirmed + probable > 0 ? `${confirmed} confirmed, ${probable} probable only` : "Not announced or not available: unknown",
        },
  );
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
  const unit = fam === "tennis" ? "Player" : "Team";
  if (model.prediction) {
    facts.push(
      `${unit} ratings reflect ${model.prediction.gamesHomeThisSeason} and ${model.prediction.gamesAwayThisSeason} completed ${fam === "tennis" ? "matches" : "games"} this season (Elo ${Math.round(model.prediction.eloHome)} vs ${Math.round(model.prediction.eloAway)}).`,
    );
    if (model.prediction.expectedMargin != null) facts.push(`Model expected margin: ${homeName} ${model.prediction.expectedMargin >= 0 ? "by" : "losing by"} ${Math.abs(model.prediction.expectedMargin).toFixed(1)} points.`);
    if (model.prediction.expectedTotal != null) facts.push(`Model expected total: ${model.prediction.expectedTotal.toFixed(1)} points, from both teams' recent scoring form.`);
  }
  if (weatherSrc && weather) facts.push(`Weather forecast: ${weather.precip_probability ?? "?"}% chance of precipitation${cite([weatherSrc])}.`);
  newsSrc.filter(({ n }) => n.claim_type === "official").slice(0, 3).forEach(({ n, id }) => facts.push(`Official: ${n.title}${cite([id])}.`));
  const assumptions: string[] = [];
  const unseen =
    fam === "baseball" ? "injuries, lineups or starting pitchers" : fam === "tennis" ? "injuries, fatigue, retirements or withdrawals" : fam === "american_football" ? "injuries, quarterback changes or weather" : "injuries, rest decisions or lineups";
  if (model.available && fitAvail) {
    const used = fitAvail.featuresUsed.filter((f) => f !== "elo_diff_per_100").map((f) => featureLabelLower(f));
    assumptions.push(`The model uses ${fam === "tennis" ? "player" : "team"} ratings (${fitAvail.config.label})${used.length ? `, ${used.join(", ")}` : ""}; weights were fitted on earlier seasons only.`);
    assumptions.push(`The model does not see ${unseen}. News is shown as evidence but is not converted into a numeric adjustment.`);
  }
  if (market.reference) assumptions.push(`Margin removal: ${marketConfig.method}. ${marketConfig.note} It approximates the market's view; it does not measure the true probability.`);
  assumptions.push(`${spec.label}: ${spec.settlement}`);
  const missing = items.filter((i) => ["missing", "unknown", "stale", "partial"].includes(i.status)).map((i) => `${i.label}: ${i.detail}`);
  const changes: string[] = [];
  if (confirmed < 2 && fam !== "tennis") changes.push(fam === "baseball" ? "Lineup or starting-pitcher announcements." : "Lineup and availability announcements.");
  if (conflicts.length) changes.push(`Resolution of conflicting reports about ${conflicts.map((c) => c.player).join(", ")}.`);
  newsSrc.filter(({ n }) => n.claim_type === "speculation").slice(0, 2).forEach(({ n, id }) => changes.push(`Unconfirmed report: "${n.title}"${cite([id])}. Treat it as speculation until official.`));
  if (weather && wRel && (weather.precip_probability ?? 0) >= 50) changes.push("Weather: a high precipitation chance raises postponement risk (a postponed game is void).");
  changes.push("Price movement as books react to new information.");
  if (model.available) changes.push(`Anything the model does not measure, such as ${unseen} and motivation.`);

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
    marketConfig,
    lines,
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

function featureLabelLower(f: string): string {
  switch (f) {
    case "home_advantage":
      return "home advantage";
    case "rest_diff_days":
      return "rest days";
    case "back_to_back_diff":
      return "back-to-back games";
    case "elo_diff_best_of_5":
      return "best-of-five format";
    default:
      return f;
  }
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
