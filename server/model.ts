// Independent statistical model: Elo team ratings feeding a logistic regression.
//
//   p(home win) = sigmoid( b_home * [not neutral] + b_elo * (R_home - R_away)/100 + b_rest * clamp(rest_home - rest_away, -3, 3) )
//
// Elo hyper-parameters (K, home bonus used in rating updates, between-season carry-over)
// are chosen by grid search on a chronological validation season; logistic weights are
// learned by maximum likelihood. Ratings for any game only use games completed before it,
// and parameters only use seasons completed before the forecast season — no leakage.

import { logit, sigmoid } from "../shared/odds";
import { logLoss, mean, pairedBootstrapCI } from "../shared/evaluation";

export const MODEL_NAME = "elo-logit-v1";
export const FEATURES = ["home_advantage", "elo_diff_per_100", "rest_diff_days"] as const;

export interface GameRow {
  id: string;
  start_time: string;
  home_id: string;
  away_id: string;
  home_score: number | null;
  away_score: number | null;
  neutral_site: number;
  season: string | null;
}

export interface ScheduleRow {
  id: string;
  home_id: string;
  away_id: string;
  start_time: string;
  status: string;
}

export interface EloParams {
  k: number;
  homeElo: number;
  carry: number;
}

export interface FeatureRow {
  id: string;
  start_time: string;
  season: string;
  x: number[];
  y: 0 | 1;
  eloHome: number;
  eloAway: number;
  gamesHome: number;
  gamesAway: number;
}

export interface SplitInfo {
  from: string | null;
  to: string | null;
  n: number;
  seasons: string[];
}

export interface ModelFit {
  available: true;
  version: string;
  name: string;
  sportKey: string;
  trainedSeasons: string[];
  forecastSeason: string;
  params: EloParams;
  beta: number[];
  cov: number[][];
  train: SplitInfo;
  validation: SplitInfo;
  validationMetrics: {
    model: { brier: number; logLoss: number; n: number };
    homeRate: { brier: number; logLoss: number; n: number };
    coin: { brier: number; logLoss: number; n: number };
    market: { brier: number; logLoss: number; n: number } | null;
    modelOnMarketGames: { brier: number; logLoss: number; n: number } | null;
    /** Mean(logLoss_model - logLoss_market) with a 95% paired-bootstrap interval; negative favours the model. */
    modelMinusMarketLogLoss: { mean: number; low: number; high: number } | null;
  };
  combined: { a: number; b: number; n: number } | null;
  featuresUsed: string[];
  homeWinRateTrain: number;
  gridSearched: number;
  notes: string[];
}

export interface ModelUnavailable {
  available: false;
  reason: string;
}

export type FitResult = ModelFit | ModelUnavailable;

const BASE = 1500;
const MIN_TRAIN_GAMES = 300;
const BURN_IN_GAMES = 120;

const seasonOf = (g: { season: string | null; start_time: string }) => g.season ?? g.start_time.slice(0, 4);

export class RestTracker {
  private lastStart = new Map<string, number>();
  /** Days of rest before this game for each team (capped at 5; first game after a long gap = 5). */
  restFor(teamId: string, startIso: string): number {
    const prev = this.lastStart.get(teamId);
    if (prev == null) return 5;
    const days = (Date.parse(startIso) - prev) / 86400000;
    if (days > 10) return 5;
    return Math.max(0, Math.min(5, Math.floor(days)));
  }
  record(teamId: string, startIso: string): void {
    this.lastStart.set(teamId, Date.parse(startIso));
  }
}

export function restDiffFor(schedule: ScheduleRow[], homeId: string, awayId: string, startIso: string): number {
  const before = (team: string) => {
    let last: string | null = null;
    for (const s of schedule) {
      if (s.start_time >= startIso) break;
      if ((s.home_id === team || s.away_id === team) && s.status !== "postponed" && s.status !== "cancelled") last = s.start_time;
    }
    return last;
  };
  const t = new RestTracker();
  const lh = before(homeId);
  const la = before(awayId);
  if (lh) t.record(homeId, lh);
  if (la) t.record(awayId, la);
  return clampRest(t.restFor(homeId, startIso) - t.restFor(awayId, startIso));
}

const clampRest = (d: number) => Math.max(-3, Math.min(3, d));

export interface EloState {
  ratings: Map<string, number>;
  games: Map<string, number>;
  season: string | null;
}

/** Run Elo through completed games in order, returning pre-game feature rows and the final state. */
export function runElo(games: GameRow[], params: EloParams, schedule?: ScheduleRow[]): { rows: FeatureRow[]; state: EloState } {
  const ratings = new Map<string, number>();
  const counts = new Map<string, number>();
  const rest = new RestTracker();
  let season: string | null = null;
  const rows: FeatureRow[] = [];
  // Rest uses the public schedule (including games the team played that aren't in `games`).
  const sched = schedule ? [...schedule].sort((a, b) => a.start_time.localeCompare(b.start_time)) : null;
  let si = 0;
  for (const g of games) {
    const s = seasonOf(g);
    if (season !== null && s !== season) {
      for (const [team, r] of ratings) ratings.set(team, BASE + params.carry * (r - BASE));
      counts.clear();
    }
    season = s;
    if (sched) {
      while (si < sched.length && sched[si].start_time < g.start_time) {
        const e = sched[si++];
        if (e.status === "postponed" || e.status === "cancelled") continue;
        rest.record(e.home_id, e.start_time);
        rest.record(e.away_id, e.start_time);
      }
    }
    const rh = ratings.get(g.home_id) ?? BASE;
    const ra = ratings.get(g.away_id) ?? BASE;
    const home = g.neutral_site ? 0 : 1;
    const restDiff = clampRest(rest.restFor(g.home_id, g.start_time) - rest.restFor(g.away_id, g.start_time));
    if (!sched) {
      rest.record(g.home_id, g.start_time);
      rest.record(g.away_id, g.start_time);
    }
    if (g.home_score == null || g.away_score == null || g.home_score === g.away_score) continue; // ties carry no 2-way signal
    const y: 0 | 1 = g.home_score > g.away_score ? 1 : 0;
    rows.push({
      id: g.id,
      start_time: g.start_time,
      season: s,
      x: [home, (rh - ra) / 100, restDiff],
      y,
      eloHome: rh,
      eloAway: ra,
      gamesHome: counts.get(g.home_id) ?? 0,
      gamesAway: counts.get(g.away_id) ?? 0,
    });
    const expected = 1 / (1 + 10 ** (-(rh + home * params.homeElo - ra) / 400));
    const delta = params.k * (y - expected);
    ratings.set(g.home_id, rh + delta);
    ratings.set(g.away_id, ra - delta);
    counts.set(g.home_id, (counts.get(g.home_id) ?? 0) + 1);
    counts.set(g.away_id, (counts.get(g.away_id) ?? 0) + 1);
  }
  return { rows, state: { ratings, games: counts, season } };
}

// ---------- small linear algebra ----------
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) throw new Error("singular matrix");
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

function invert(A: number[][]): number[][] {
  const n = A.length;
  const cols = Array.from({ length: n }, (_, j) => solve(A, Array.from({ length: n }, (_, i) => (i === j ? 1 : 0))));
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => cols[j][i]));
}

/** L2-regularised logistic regression by Newton/IRLS. Returns weights and their approximate covariance. */
export function fitLogistic(X: number[][], y: (0 | 1)[], lambda = 1e-3): { beta: number[]; cov: number[][] } {
  const k = X[0]?.length ?? 0;
  if (!k || X.length !== y.length) throw new Error("bad design matrix");
  let beta = new Array(k).fill(0);
  let H: number[][] = [];
  for (let iter = 0; iter < 100; iter++) {
    const g = new Array(k).fill(0);
    H = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let i = 0; i < X.length; i++) {
      const xi = X[i];
      let eta = 0;
      for (let j = 0; j < k; j++) eta += xi[j] * beta[j];
      const p = sigmoid(eta);
      const w = Math.max(p * (1 - p), 1e-10);
      for (let j = 0; j < k; j++) {
        g[j] += xi[j] * (y[i] - p);
        for (let l = 0; l < k; l++) H[j][l] += w * xi[j] * xi[l];
      }
    }
    for (let j = 0; j < k; j++) {
      g[j] -= lambda * beta[j];
      H[j][j] += lambda;
    }
    const step = solve(H, g);
    beta = beta.map((b, j) => b + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-9) break;
  }
  return { beta, cov: invert(H) };
}

function applyMask(x: number[], mask: boolean[]): number[] {
  return x.filter((_, i) => mask[i]);
}

/** Expand a fit on a subset of features back to the full feature vector (dropped weights are exactly 0). */
function expandFit(fit: { beta: number[]; cov: number[][] }, mask: boolean[]): { beta: number[]; cov: number[][] } {
  const idx = mask.map((m, i) => (m ? i : -1)).filter((i) => i >= 0);
  const n = mask.length;
  const beta = new Array(n).fill(0);
  const cov = Array.from({ length: n }, () => new Array(n).fill(0));
  idx.forEach((fi, a) => {
    beta[fi] = fit.beta[a];
    idx.forEach((fj, b) => (cov[fi][fj] = fit.cov[a][b]));
  });
  return { beta, cov };
}

export function linearPredictor(beta: number[], x: number[]): number {
  return beta.reduce((s, b, j) => s + b * x[j], 0);
}

/** Probability with an approximate 80% interval from parameter uncertainty (delta method on the linear predictor). */
export function predictWithInterval(beta: number[], cov: number[][], x: number[]): { p: number; low: number; high: number; se: number } {
  const eta = linearPredictor(beta, x);
  let v = 0;
  for (let i = 0; i < x.length; i++) for (let j = 0; j < x.length; j++) v += x[i] * cov[i][j] * x[j];
  const se = Math.sqrt(Math.max(v, 0));
  const z = 1.2816;
  return { p: sigmoid(eta), low: sigmoid(eta - z * se), high: sigmoid(eta + z * se), se };
}

const scores = (ps: number[], ys: (0 | 1)[]) => ({
  brier: mean(ps.map((p, i) => (p - ys[i]) ** 2)),
  logLoss: mean(ps.map((p, i) => logLoss(p, ys[i]))),
  n: ps.length,
});

export const GRID = {
  k: [4, 6, 8, 12, 16, 24],
  homeElo: [0, 20, 40],
  carry: [0.5, 0.7, 0.85],
};

export interface FitInput {
  sportKey: string;
  games: GameRow[]; // completed games known before the forecast time, any order
  schedule?: ScheduleRow[];
  forecastSeason: string;
  /** Pre-game market reference (home probability) for validation games, when historical quotes exist. */
  marketHome?: (eventId: string, startIso: string) => number | null;
}

/**
 * Fit the model on seasons strictly before `forecastSeason`.
 * Validation = the last training season (out-of-sample for weights fitted on earlier seasons);
 * the final weights are then refitted on all training seasons.
 */
export function fitModel(input: FitInput): FitResult {
  const games = input.games
    .filter((g) => seasonOf(g) < input.forecastSeason)
    .sort((a, b) => a.start_time.localeCompare(b.start_time) || a.id.localeCompare(b.id));
  const seasons = [...new Set(games.map(seasonOf))].sort();
  if (games.length < MIN_TRAIN_GAMES || seasons.length < 2) {
    return {
      available: false,
      reason:
        seasons.length < 2
          ? `Needs at least two completed seasons before ${input.forecastSeason} (found ${seasons.length}). No independent forecast is shown.`
          : `Only ${games.length} completed games before ${input.forecastSeason}; at least ${MIN_TRAIN_GAMES} are needed.`,
    };
  }
  const validationSeason = seasons[seasons.length - 1];
  const trainSeasons = seasons.slice(0, -1);
  const schedule = input.schedule;

  // Candidate factor sets. Home advantage and rating difference are always included;
  // rest is kept only if it improves validation log loss.
  const MASKS: boolean[][] = [
    [true, true, false],
    [true, true, true],
  ];
  let best: { params: EloParams; ll: number; rows: FeatureRow[]; mask: boolean[] } | null = null;
  let searched = 0;
  const restVaries = (rows: FeatureRow[]) => rows.filter((r) => r.x[2] !== 0).length >= 30;
  for (const k of GRID.k)
    for (const homeElo of GRID.homeElo)
      for (const carry of GRID.carry) {
        const params = { k, homeElo, carry };
        const { rows } = runElo(games, params, schedule);
        const usable = rows.slice(BURN_IN_GAMES);
        const tr = usable.filter((r) => r.season !== validationSeason);
        const va = usable.filter((r) => r.season === validationSeason);
        if (tr.length < 100 || va.length < 50) continue;
        for (const mask of MASKS) {
          if (mask[2] && !restVaries(tr)) continue;
          const { beta } = fitLogistic(tr.map((r) => applyMask(r.x, mask)), tr.map((r) => r.y));
          const ll = mean(va.map((r) => logLoss(sigmoid(linearPredictor(beta, applyMask(r.x, mask))), r.y)));
          searched++;
          if (!best || ll < best.ll - 1e-12) best = { params, ll, rows, mask };
        }
      }
  if (!best) return { available: false, reason: "Not enough games in the training and validation seasons to fit the model." };

  const mask = best.mask;
  const usable = best.rows.slice(BURN_IN_GAMES);
  const tr = usable.filter((r) => r.season !== validationSeason);
  const va = usable.filter((r) => r.season === validationSeason);
  const trainFit = fitLogistic(tr.map((r) => applyMask(r.x, mask)), tr.map((r) => r.y));
  const vaPreds = va.map((r) => sigmoid(linearPredictor(trainFit.beta, applyMask(r.x, mask))));
  const vaY = va.map((r) => r.y);
  const homeRate = mean(tr.map((r) => r.y));

  // Market comparison on the validation season (only where a pre-game market reference exists).
  let market: ModelFit["validationMetrics"]["market"] = null;
  let modelOnMarket: ModelFit["validationMetrics"]["modelOnMarketGames"] = null;
  let diffCI: ModelFit["validationMetrics"]["modelMinusMarketLogLoss"] = null;
  let combined: ModelFit["combined"] = null;
  if (input.marketHome) {
    const pairs: { pm: number; pk: number; y: 0 | 1 }[] = [];
    va.forEach((r, i) => {
      const pk = input.marketHome!(r.id, r.start_time);
      if (pk != null && pk > 0 && pk < 1) pairs.push({ pm: vaPreds[i], pk, y: r.y });
    });
    if (pairs.length >= 50) {
      market = scores(pairs.map((p) => p.pk), pairs.map((p) => p.y));
      modelOnMarket = scores(pairs.map((p) => p.pm), pairs.map((p) => p.y));
      diffCI = pairedBootstrapCI(
        pairs.map((p) => logLoss(p.pm, p.y)),
        pairs.map((p) => logLoss(p.pk, p.y)),
      );
    }
    if (pairs.length >= 150) {
      const blend = fitLogistic(pairs.map((p) => [logit(p.pm), logit(p.pk)]), pairs.map((p) => p.y));
      combined = { a: blend.beta[0], b: blend.beta[1], n: pairs.length };
    }
  }

  const reduced = fitLogistic(usable.map((r) => applyMask(r.x, mask)), usable.map((r) => r.y));
  const finalFit = expandFit(reduced, mask);
  const span = (rows: FeatureRow[], ss: string[]): SplitInfo => ({
    from: rows[0]?.start_time ?? null,
    to: rows[rows.length - 1]?.start_time ?? null,
    n: rows.length,
    seasons: ss,
  });
  const notes = [
    `Ratings start at ${BASE}; the first ${BURN_IN_GAMES} games are a burn-in and are not used to fit weights.`,
    mask[2]
      ? "Rest-day difference was evaluated and retained because it improved validation log loss."
      : "Rest-day difference was evaluated but not retained: it did not improve validation log loss (or varied too little to estimate).",
    "The interval reflects uncertainty in the fitted weights only. It does not capture rating noise, injuries, lineups or anything else the model does not see.",
    "The model does not use player availability, so injury and lineup news is not double-counted, and it is not reflected either.",
  ];
  return {
    available: true,
    version: `${MODEL_NAME}@${trainSeasons[0]}-${validationSeason}`,
    name: MODEL_NAME,
    sportKey: input.sportKey,
    trainedSeasons: seasons,
    forecastSeason: input.forecastSeason,
    params: best.params,
    beta: finalFit.beta,
    cov: finalFit.cov,
    train: span(tr, trainSeasons),
    validation: span(va, [validationSeason]),
    validationMetrics: {
      model: scores(vaPreds, vaY),
      homeRate: scores(vaY.map(() => homeRate), vaY),
      coin: scores(vaY.map(() => 0.5), vaY),
      market,
      modelOnMarketGames: modelOnMarket,
      modelMinusMarketLogLoss: diffCI,
    },
    combined,
    featuresUsed: FEATURES.filter((_, i) => mask[i]),
    homeWinRateTrain: homeRate,
    gridSearched: searched,
    notes,
  };
}

/** Elo state at a moment: run the fitted params through every game completed before it. */
export function ratingsAt(games: GameRow[], params: EloParams, forecastSeason: string): EloState {
  const sorted = [...games].sort((a, b) => a.start_time.localeCompare(b.start_time) || a.id.localeCompare(b.id));
  const { state } = runElo(sorted, params);
  // Apply the between-season regression if the forecast season has not started in the data yet.
  if (state.season !== null && state.season !== forecastSeason) {
    for (const [team, r] of state.ratings) state.ratings.set(team, BASE + params.carry * (r - BASE));
    state.season = forecastSeason;
    state.games = new Map();
  }
  return state;
}

export interface ModelPrediction {
  pHome: number;
  low: number;
  high: number;
  features: { name: string; value: number; weight: number; contribution: number }[];
  eloHome: number;
  eloAway: number;
  gamesHomeThisSeason: number;
  gamesAwayThisSeason: number;
}

export function predictGame(fit: ModelFit, state: EloState, homeId: string, awayId: string, neutral: boolean, restDiff: number): ModelPrediction {
  const rh = state.ratings.get(homeId) ?? BASE;
  const ra = state.ratings.get(awayId) ?? BASE;
  const x = [neutral ? 0 : 1, (rh - ra) / 100, clampRest(restDiff)];
  const r = predictWithInterval(fit.beta, fit.cov, x);
  return {
    pHome: r.p,
    low: r.low,
    high: r.high,
    features: FEATURES.map((name, i) => ({ name, value: x[i], weight: fit.beta[i], contribution: x[i] * fit.beta[i] })),
    eloHome: rh,
    eloAway: ra,
    gamesHomeThisSeason: state.games.get(homeId) ?? 0,
    gamesAwayThisSeason: state.games.get(awayId) ?? 0,
  };
}
