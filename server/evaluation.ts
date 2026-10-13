// Honest model evaluation: chronological splits, walk-forward holdout predictions with
// parameters fitted on earlier seasons only, comparison with simple baselines and the
// market reference, calibration, and explicit sample-size warnings.

import { calibrationBins, expectedCalibrationError, brier, brierMulti, logLoss, logLossMulti, mean, pairedBootstrapCI } from "../shared/evaluation";
import { sigmoid, expectedNetPoints, settledNetPoints } from "../shared/odds";
import { CONTRACTS, sportFamily } from "../shared/contracts";
import { realisedOutcome } from "../shared/settlement";
import type { Dataset, Repo } from "./repo";
import { eventAsOf } from "./repo";
import { MODEL_SPORTS, ModelService, buildMarket, primaryContract } from "./analysis";
import { runElo, linearPredictor, type ModelFit } from "./model";
import { json } from "./db";

interface Scored {
  n: number;
  brier: number;
  logLoss: number;
}

const score2 = (ps: number[], ys: (0 | 1)[]): Scored => ({ n: ps.length, brier: mean(ps.map((p, i) => brier(p, ys[i]))), logLoss: mean(ps.map((p, i) => logLoss(p, ys[i]))) });

export function sampleWarning(n: number): string | null {
  if (n === 0) return "No settled games in this period: nothing can be concluded.";
  if (n < 100) return `Only ${n} games: far too few to tell forecasters apart. Differences here are mostly noise.`;
  if (n < 500) return `${n} games: small sample. Score differences of a few thousandths are usually not meaningful; check the intervals.`;
  return null;
}

export class Evaluator {
  constructor(
    private repo: Repo,
    private models: ModelService,
    private staleMinutes: () => number,
  ) {}

  sports(dataset: Dataset): string[] {
    return this.repo.db.all<{ sport_key: string }>("SELECT DISTINCT sport_key FROM events WHERE dataset = ? ORDER BY sport_key", [dataset]).map((r) => r.sport_key);
  }

  currentSeason(dataset: Dataset, sportKey: string, asOf: string): string | null {
    const r = this.repo.db.get<{ season: string | null; start_time: string }>(
      "SELECT season, start_time FROM events WHERE dataset = ? AND sport_key = ? AND start_time <= ? ORDER BY start_time DESC LIMIT 1",
      [dataset, sportKey, asOf],
    );
    return r ? r.season ?? r.start_time.slice(0, 4) : null;
  }

  report(dataset: Dataset, sportKey: string, asOf: string) {
    const season = this.currentSeason(dataset, sportKey, asOf);
    if (!season) return { sportKey, available: false, reason: "No games for this sport have been loaded yet." };
    const contract = primaryContract(sportKey);
    const finals = this.repo.finalsBefore(dataset, sportKey, asOf);
    const holdoutGames = finals.filter((g) => (g.season ?? g.start_time.slice(0, 4)) === season);
    const base = {
      sportKey,
      season,
      asOf,
      contract,
      contractLabel: CONTRACTS[contract].label,
      evaluationTiming: "Market reference = margin-adjusted consensus of quotes known 60 minutes before the scheduled start (stale quotes excluded).",
    };

    if (!MODEL_SPORTS.has(sportKey) || contract !== "moneyline_2way_full_game") {
      return { ...base, available: true, model: null, modelReason: "No independent model for this sport: market-reference evaluation only.", ...this.marketOnly(sportKey, holdoutGames, contract) };
    }

    const fit = this.models.fit(dataset, sportKey, season, asOf);
    if (!fit.available) {
      return { ...base, available: true, model: null, modelReason: fit.reason, ...this.marketOnly(sportKey, holdoutGames, contract) };
    }
    const schedule = this.repo.scheduleFor(dataset, sportKey, finals[0]?.start_time ?? asOf, asOf);
    return { ...base, available: true, ...this.walkForward(fit, finals, holdoutGames.map((g) => g.id), schedule) };
  }

  /** Walk-forward holdout: fixed parameters from earlier seasons; ratings update only on games completed before each game. */
  private walkForward(fit: ModelFit, finals: ReturnType<Repo["finalsBefore"]>, holdoutIds: string[], schedule: ReturnType<Repo["scheduleFor"]>) {
    const ids = new Set(holdoutIds);
    const sorted = [...finals].sort((a, b) => a.start_time.localeCompare(b.start_time) || a.id.localeCompare(b.id));
    const { rows } = runElo(sorted, fit.params, schedule);
    const hold = rows.filter((r) => ids.has(r.id));
    const pm = hold.map((r) => sigmoid(linearPredictor(fit.beta, r.x)));
    const ys = hold.map((r) => r.y);
    const coin = hold.map(() => 0.5);
    const homeRate = hold.map(() => fit.homeWinRateTrain);
    const pk: (number | null)[] = hold.map((r) => this.models.marketHomeAt(r.id, r.start_time));
    const withMkt = hold.map((_, i) => i).filter((i) => pk[i] != null);
    const combinedP = fit.combined ? withMkt.map((i) => sigmoid(fit.combined!.a * Math.log(pm[i] / (1 - pm[i])) + fit.combined!.b * Math.log(pk[i]! / (1 - pk[i]!)))) : null;

    // Hypothetical points: 1 point on each side with positive model-estimated expected value at the best fresh price 60 minutes before.
    let bets = 0;
    let net = 0;
    const perBet: number[] = [];
    hold.forEach((r, i) => {
      if (pk[i] == null) return;
      const t = new Date(Date.parse(r.start_time) - 3600000).toISOString().replace(/\.\d{3}Z$/, "Z");
      const m = buildMarket(this.repo.latestQuotes(r.id, t), "moneyline_2way_full_game", null, { start_time: r.start_time }, t, this.staleMinutes());
      for (const o of ["home", "away"] as const) {
        const bp = m.bestPrice[o];
        const p = o === "home" ? pm[i] : 1 - pm[i];
        if (bp && expectedNetPoints(p, bp.decimal) > 0) {
          const won = (o === "home") === (r.y === 1);
          const pts = settledNetPoints(won ? "win" : "loss", 1, bp.decimal);
          bets++;
          net += pts;
          perBet.push(pts);
        }
      }
    });
    const pointsCI = perBet.length >= 20 ? pairedBootstrapCI(perBet, perBet.map(() => 0)) : null;

    const modelCal = calibrationBins(pm, ys, 10);
    const mktIdx = withMkt;
    const marketCal = calibrationBins(mktIdx.map((i) => pk[i]!), mktIdx.map((i) => ys[i]), 10);
    const llM = hold.map((_, i) => logLoss(pm[i], ys[i]));
    const vsHome = pairedBootstrapCI(llM, hold.map((_, i) => logLoss(homeRate[i], ys[i])));
    const vsMarket = mktIdx.length >= 20 ? pairedBootstrapCI(mktIdx.map((i) => llM[i]), mktIdx.map((i) => logLoss(pk[i]!, ys[i]))) : null;

    return {
      model: {
        version: fit.version,
        params: fit.params,
        weights: Object.fromEntries(["home_advantage", "elo_diff_per_100", "rest_diff_days"].map((n, i) => [n, fit.beta[i]])),
        featuresUsed: fit.featuresUsed,
        notes: fit.notes,
        gridSearched: fit.gridSearched,
      },
      splits: {
        train: fit.train,
        validation: fit.validation,
        holdout: { from: hold[0]?.start_time ?? null, to: hold[hold.length - 1]?.start_time ?? null, n: hold.length, seasons: [fit.forecastSeason] },
      },
      validationMetrics: fit.validationMetrics,
      holdout: {
        n: hold.length,
        warning: sampleWarning(hold.length),
        model: hold.length ? score2(pm, ys) : null,
        coin: hold.length ? score2(coin, ys) : null,
        homeRate: hold.length ? score2(homeRate, ys) : null,
        market: mktIdx.length ? score2(mktIdx.map((i) => pk[i]!), mktIdx.map((i) => ys[i])) : null,
        modelOnMarketGames: mktIdx.length ? score2(mktIdx.map((i) => pm[i]), mktIdx.map((i) => ys[i])) : null,
        combined: combinedP && combinedP.length ? score2(combinedP, mktIdx.map((i) => ys[i])) : null,
        marketCoverage: hold.length ? mktIdx.length / hold.length : 0,
        modelMinusHomeRateLogLoss: vsHome,
        modelMinusMarketLogLoss: vsMarket,
        calibration: { model: modelCal, market: marketCal, modelECE: expectedCalibrationError(modelCal), marketECE: expectedCalibrationError(marketCal) },
        hypotheticalPoints: {
          rule: "1 simulation point on each outcome where the model's estimated expected value was positive at the highest quoted price among connected sources 60 minutes before the start.",
          bets,
          netPoints: net,
          perBetMeanCI: pointsCI,
          caveat: "Hypothetical point totals are not evidence of model quality on their own: they are dominated by variance and depend on prices you may not have been able to get. Use the scoring rules and calibration above.",
        },
      },
    };
  }

  /** Market-only evaluation (e.g. 3-way soccer): market reference vs uniform and frequency baselines. */
  private marketOnly(sportKey: string, games: ReturnType<Repo["finalsBefore"]>, contract: ReturnType<typeof primaryContract>) {
    const outcomes = CONTRACTS[contract].outcomes;
    const rows: { probs: number[]; idx: number }[] = [];
    for (const g of games) {
      const r = realisedOutcome(contract, {
        status: g.status,
        homeScore: g.home_score,
        awayScore: g.away_score,
        regulationHome: g.regulation_home,
        regulationAway: g.regulation_away,
        finalIsRegulation: !!g.final_is_regulation,
      });
      if (!r) continue;
      const t = new Date(Date.parse(g.start_time) - 3600000).toISOString().replace(/\.\d{3}Z$/, "Z");
      const m = buildMarket(this.repo.latestQuotes(g.id, t), contract, null, { start_time: g.start_time }, t, this.staleMinutes());
      if (!m.reference) continue;
      rows.push({ probs: outcomes.map((o) => m.reference!.probs[o] ?? 0), idx: outcomes.indexOf(r) });
    }
    const uniform = outcomes.map(() => 1 / outcomes.length);
    const freq = outcomes.map((_, k) => (rows.length ? rows.filter((r) => r.idx === k).length / rows.length : 1 / outcomes.length));
    const s = (f: (r: { probs: number[]; idx: number }) => number[]) =>
      rows.length ? { n: rows.length, brier: mean(rows.map((r) => brierMulti(f(r), r.idx))), logLoss: mean(rows.map((r) => logLossMulti(f(r), r.idx))) } : null;
    const homeP = rows.map((r) => r.probs[0]);
    const homeY = rows.map((r) => (r.idx === 0 ? 1 : 0) as 0 | 1);
    return {
      marketOnly: {
        outcomes,
        n: rows.length,
        warning: sampleWarning(rows.length),
        market: s((r) => r.probs),
        uniform: s(() => uniform),
        frequency: s(() => freq),
        frequencyNote: "The frequency baseline uses outcome rates from the same evaluation period (in-sample), so it is slightly optimistic.",
        calibrationHome: calibrationBins(homeP, homeY, 10),
        family: sportFamily(sportKey),
      },
    };
  }

  /** Live forward record: the latest pre-start system forecast per event, settled. Abstentions are counted, not hidden. */
  forwardRecord(dataset: Dataset, resultsAsOf: string) {
    const rows = this.repo.db.all<{ id: string; event_id: string; kind: string; outcome_probs: string | null; info_as_of: string; event_start_snapshot: string; contract: string }>(
      `SELECT f.* FROM forecasts f JOIN (SELECT event_id, MAX(info_as_of) m FROM forecasts WHERE dataset = ? AND kind IN ('system','abstention') AND info_as_of < event_start_snapshot GROUP BY event_id) x
         ON f.event_id = x.event_id AND f.info_as_of = x.m WHERE f.dataset = ? AND f.kind IN ('system','abstention')`,
      [dataset, dataset],
    );
    let abstentions = 0;
    const model: { p: number; y: 0 | 1 }[] = [];
    const market: { p: number; y: 0 | 1 }[] = [];
    const pairs: { pm: number; pk: number; y: 0 | 1 }[] = [];
    let pending = 0;
    let voided = 0;
    for (const f of rows) {
      if (f.kind === "abstention") {
        abstentions++;
        continue;
      }
      const raw = this.repo.event(f.event_id);
      if (!raw) continue;
      if (Math.abs(Date.parse(raw.start_time) - Date.parse(f.event_start_snapshot)) > 12 * 3600000) {
        voided++;
        continue;
      }
      const e = eventAsOf(raw, resultsAsOf);
      if (e.status === "postponed" || e.status === "cancelled") {
        voided++;
        continue;
      }
      if (e.status !== "final" || f.contract !== "moneyline_2way_full_game") {
        if (e.status !== "final") pending++;
        continue;
      }
      const real = realisedOutcome("moneyline_2way_full_game", { status: e.status, homeScore: e.home_score, awayScore: e.away_score });
      if (!real) continue;
      const y: 0 | 1 = real === "home" ? 1 : 0;
      const probs = json<any>(f.outcome_probs, {});
      if (probs.model?.home != null) model.push({ p: probs.model.home, y });
      if (probs.market?.home != null) market.push({ p: probs.market.home, y });
      if (probs.model?.home != null && probs.market?.home != null) pairs.push({ pm: probs.model.home, pk: probs.market.home, y });
    }
    return {
      events: rows.length,
      abstentions,
      pending,
      voided,
      model: model.length ? score2(model.map((x) => x.p), model.map((x) => x.y)) : null,
      market: market.length ? score2(market.map((x) => x.p), market.map((x) => x.y)) : null,
      paired: pairs.length ? { n: pairs.length, model: score2(pairs.map((x) => x.pm), pairs.map((x) => x.y)), market: score2(pairs.map((x) => x.pk), pairs.map((x) => x.y)) } : null,
      warning: sampleWarning(model.length),
      note: "Every recorded pre-start forecast counts, including bad results; abstentions are listed. Only 2-way moneyline forecasts are scored here.",
    };
  }
}
