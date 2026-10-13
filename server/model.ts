// Independent statistical models: rating systems feeding a calibrated logistic layer, plus
// discrete margin and total distributions for spreads and totals.
//
//   p(home win) = sigmoid( Σ b_j x_j )  with x = [home, Δrating/100, Δrest days, Δback-to-back, Δrating·[best of 5]]
//
// Rating system per sport:
//   baseball   Elo (win/loss)
//   basketball Elo with a margin-of-victory multiplier (FiveThirtyEight-style)
//   football   Elo with a margin-of-victory multiplier
//   tennis     player Elo with experience-dependent K and surface-specific ratings blended in
//
// Hyper-parameters are chosen by grid search on a chronological validation season, optional
// factors are kept only if they improve validation log loss, and weights are learned by maximum
// likelihood. Ratings for any game only use games completed before it, and parameters only use
// seasons completed before the forecast season — no leakage.
//
// Spreads and totals: margin ~ discrete distribution with mean from an OLS fit on rating
// difference and home advantage, Normal shape with the fitted spread, re-weighted by
// empirically learned "key number" frequencies (e.g. NFL margins of 3 and 7).

import { logit, sigmoid } from "../shared/odds";
import { logLoss, mean, pairedBootstrapCI } from "../shared/evaluation";
import { sportFamily, type SportFamily } from "../shared/contracts";

export const MODEL_NAME = "rating-logit-v2";
export const FEATURES = ["home_advantage", "elo_diff_per_100", "rest_diff_days", "back_to_back_diff", "elo_diff_best_of_5"] as const;
export type FeatureName = (typeof FEATURES)[number];

export interface GameRow {
  id: string;
  start_time: string;
  home_id: string;
  away_id: string;
  home_score: number | null;
  away_score: number | null;
  neutral_site: number;
  season: string | null;
  extra?: string | null;
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
  /** Tennis: weight of the surface-specific rating in the blended rating (0 = ignore surface). */
  surfaceWeight?: number;
}

export interface SportConfig {
  family: SportFamily;
  label: string;
  mov: boolean;
  tennis: boolean;
  homeFeature: boolean;
  optional: FeatureName[];
  burnIn: number;
  minGames: number;
  margins: boolean;
  allowTies: boolean;
  grid: { k: number[]; homeElo: number[]; carry: number[]; surfaceWeight: number[] };
}

export function sportConfig(sportKey: string): SportConfig {
  const family = sportFamily(sportKey);
  switch (family) {
    case "basketball":
      return { family, label: "Elo with margin of victory", mov: true, tennis: false, homeFeature: true, optional: ["rest_diff_days", "back_to_back_diff"], burnIn: 100, minGames: 300, margins: true, allowTies: false, grid: { k: [10, 15, 20, 28], homeElo: [0, 50, 100], carry: [0.6, 0.75], surfaceWeight: [0] } };
    case "american_football":
      return { family, label: "Elo with margin of victory", mov: true, tennis: false, homeFeature: true, optional: ["rest_diff_days"], burnIn: 48, minGames: 250, margins: true, allowTies: true, grid: { k: [12, 20, 30, 40], homeElo: [0, 40, 70], carry: [0.5, 0.67, 0.8], surfaceWeight: [0] } };
    case "tennis":
      return { family, label: "Player Elo (experience-weighted K, surface blend)", mov: false, tennis: true, homeFeature: false, optional: ["elo_diff_best_of_5"], burnIn: 300, minGames: 600, margins: false, allowTies: false, grid: { k: [0.7, 1, 1.3], homeElo: [0], carry: [0.9, 1], surfaceWeight: [0, 0.35, 0.6] } };
    default:
      return { family, label: "Elo", mov: false, tennis: false, homeFeature: true, optional: ["rest_diff_days"], burnIn: 120, minGames: 300, margins: true, allowTies: false, grid: { k: [4, 6, 8, 12, 16, 24], homeElo: [0, 20, 40], carry: [0.5, 0.7, 0.85], surfaceWeight: [0] } };
  }
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
  margin: number;
  total: number;
  /** Expected total from pre-game scoring form (team sports only). */
  totalFeature: number;
}

export interface SplitInfo {
  from: string | null;
  to: string | null;
  n: number;
  seasons: string[];
}

export interface Scored {
  brier: number;
  logLoss: number;
  n: number;
}

export interface DiscreteModel {
  beta: number[];
  sigma: number;
  /** Learned multiplicative weights for specific integer values (key numbers); 1 = no adjustment. */
  keyWeights: Record<number, number>;
  n: number;
  meanAbsError: number;
}

export interface ModelFit {
  available: true;
  version: string;
  name: string;
  sportKey: string;
  config: { label: string; family: SportFamily };
  trainedSeasons: string[];
  forecastSeason: string;
  params: EloParams;
  beta: number[];
  cov: number[][];
  train: SplitInfo;
  validation: SplitInfo;
  validationMetrics: {
    model: Scored;
    homeRate: Scored;
    coin: Scored;
    market: Scored | null;
    modelOnMarketGames: Scored | null;
    /** Mean(logLoss_model - logLoss_market) with a 95% paired-bootstrap interval; negative favours the model. */
    modelMinusMarketLogLoss: { mean: number; low: number; high: number } | null;
  };
  combined: { a: number; b: number; n: number } | null;
  featuresUsed: string[];
  homeWinRateTrain: number;
  gridSearched: number;
  margin: DiscreteModel | null;
  total: DiscreteModel | null;
  /**
   * Sharpened line estimates: the model's expected margin/total blended with the market-implied one,
   * weight w on the model chosen on the validation season (null without enough quoted lines).
   */
  lineBlend: { spread: LineBlend | null; total: LineBlend | null };
  notes: string[];
}

export interface LineBlend {
  w: number;
  n: number;
  logLoss: { model: number; market: number; blend: number };
}

export type LineContract = "spread_full_game" | "total_full_game";

export interface ModelUnavailable {
  available: false;
  reason: string;
}

export type FitResult = ModelFit | ModelUnavailable;

const BASE = 1500;

const seasonOfRow = (g: { season: string | null; start_time: string }) => g.season ?? g.start_time.slice(0, 4);

interface GameExtra {
  surface?: string | null;
  bestOf?: number | null;
}
const extraOf = (g: GameRow): GameExtra => {
  if (!g.extra) return {};
  try {
    return JSON.parse(g.extra) as GameExtra;
  } catch {
    return {};
  }
};

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
  /** 1 when the team also played within the previous 36 hours (second night of a back-to-back). */
  backToBack(teamId: string, startIso: string): number {
    const prev = this.lastStart.get(teamId);
    return prev != null && Date.parse(startIso) - prev < 36 * 3600000 ? 1 : 0;
  }
  record(teamId: string, startIso: string): void {
    this.lastStart.set(teamId, Date.parse(startIso));
  }
}

const clampRest = (d: number) => Math.max(-3, Math.min(3, d));

/** Rest-day and back-to-back differences (home minus away) from the public schedule. */
export function scheduleFeatures(schedule: ScheduleRow[], homeId: string, awayId: string, startIso: string): { restDiff: number; b2bDiff: number } {
  const t = new RestTracker();
  for (const s of schedule) {
    if (s.start_time >= startIso) break;
    if (s.status === "postponed" || s.status === "cancelled") continue;
    if (s.home_id === homeId || s.away_id === homeId) t.record(homeId, s.start_time);
    if (s.home_id === awayId || s.away_id === awayId) t.record(awayId, s.start_time);
  }
  return {
    restDiff: clampRest(t.restFor(homeId, startIso) - t.restFor(awayId, startIso)),
    b2bDiff: t.backToBack(homeId, startIso) - t.backToBack(awayId, startIso),
  };
}

/** Kept for compatibility: rest-day difference only. */
export function restDiffFor(schedule: ScheduleRow[], homeId: string, awayId: string, startIso: string): number {
  return scheduleFeatures(schedule, homeId, awayId, startIso).restDiff;
}

export interface EloState {
  ratings: Map<string, number>;
  surface: Map<string, number>;
  games: Map<string, number>;
  careerGames: Map<string, number>;
  surfaceGames: Map<string, number>;
  offense: Map<string, number>;
  defense: Map<string, number>;
  leagueAvg: number;
  season: string | null;
}

const surfaceKey = (player: string, surface: string) => `${player}|${surface}`;

function blendedRating(state: EloState, id: string, surface: string | null | undefined, w: number): number {
  const overall = state.ratings.get(id) ?? BASE;
  if (!surface || !w) return overall;
  const s = state.surface.get(surfaceKey(id, surface)) ?? overall;
  return (1 - w) * overall + w * s;
}

/** FiveThirtyEight-style tennis K: large for newcomers, shrinking with experience. */
const tennisK = (matches: number, mult: number) => (mult * 250) / (matches + 5) ** 0.4;

/** Margin-of-victory multiplier (FiveThirtyEight): larger wins move ratings more, damped for favourites. */
export function movMultiplier(margin: number, winnerEloDiff: number): number {
  return (Math.log(Math.abs(margin) + 1) * 2.2) / (winnerEloDiff * 0.001 + 2.2);
}

function newState(): EloState {
  return { ratings: new Map(), surface: new Map(), games: new Map(), careerGames: new Map(), surfaceGames: new Map(), offense: new Map(), defense: new Map(), leagueAvg: NaN, season: null };
}

/** Run the rating system through completed games in order, returning pre-game feature rows and the final state. */
export function runElo(games: GameRow[], params: EloParams, schedule?: ScheduleRow[], cfg: SportConfig = sportConfig("baseball")): { rows: FeatureRow[]; state: EloState } {
  const st = newState();
  const rest = new RestTracker();
  const rows: FeatureRow[] = [];
  const sched = schedule ? [...schedule].sort((a, b) => a.start_time.localeCompare(b.start_time)) : null;
  let si = 0;
  const w = params.surfaceWeight ?? 0;
  let ptsSum = 0;
  let ptsN = 0;
  const ALPHA = 0.12; // scoring-form smoothing
  for (const g of games) {
    const s = seasonOfRow(g);
    if (st.season !== null && s !== st.season) {
      for (const [team, r] of st.ratings) st.ratings.set(team, BASE + params.carry * (r - BASE));
      for (const [k, r] of st.surface) st.surface.set(k, BASE + params.carry * (r - BASE));
      if (Number.isFinite(st.leagueAvg)) {
        for (const m of [st.offense, st.defense]) for (const [team, v] of m) m.set(team, st.leagueAvg + 0.5 * (v - st.leagueAvg));
      }
      st.games.clear();
    }
    st.season = s;
    if (sched) {
      while (si < sched.length && sched[si].start_time < g.start_time) {
        const e = sched[si++];
        if (e.status === "postponed" || e.status === "cancelled") continue;
        rest.record(e.home_id, e.start_time);
        rest.record(e.away_id, e.start_time);
      }
    }
    const ex = extraOf(g);
    const surface = cfg.tennis ? ex.surface ?? null : null;
    const rh = cfg.tennis ? blendedRating(st, g.home_id, surface, w) : st.ratings.get(g.home_id) ?? BASE;
    const ra = cfg.tennis ? blendedRating(st, g.away_id, surface, w) : st.ratings.get(g.away_id) ?? BASE;
    const home = cfg.homeFeature && !g.neutral_site ? 1 : 0;
    const restDiff = clampRest(rest.restFor(g.home_id, g.start_time) - rest.restFor(g.away_id, g.start_time));
    const b2bDiff = rest.backToBack(g.home_id, g.start_time) - rest.backToBack(g.away_id, g.start_time);
    const bo5 = (ex.bestOf ?? 3) >= 5 ? 1 : 0;
    if (!sched) {
      rest.record(g.home_id, g.start_time);
      rest.record(g.away_id, g.start_time);
    }
    if (g.home_score == null || g.away_score == null) continue;
    const avg = Number.isFinite(st.leagueAvg) ? st.leagueAvg : (g.home_score + g.away_score) / 2;
    const oH = st.offense.get(g.home_id) ?? avg;
    const dH = st.defense.get(g.home_id) ?? avg;
    const oA = st.offense.get(g.away_id) ?? avg;
    const dA = st.defense.get(g.away_id) ?? avg;
    const totalFeature = (oH + dA) / 2 + (oA + dH) / 2;
    const tie = g.home_score === g.away_score;
    const y: 0 | 1 = g.home_score > g.away_score ? 1 : 0;
    const eloDiff = (rh - ra) / 100;
    if (!tie) {
      rows.push({
        id: g.id,
        start_time: g.start_time,
        season: s,
        x: [home, eloDiff, restDiff, b2bDiff, eloDiff * bo5],
        y,
        eloHome: rh,
        eloAway: ra,
        gamesHome: st.games.get(g.home_id) ?? 0,
        gamesAway: st.games.get(g.away_id) ?? 0,
        margin: g.home_score - g.away_score,
        total: g.home_score + g.away_score,
        totalFeature,
      });
    }
    // ---- rating update ----
    const outcome = tie ? 0.5 : y;
    const expected = 1 / (1 + 10 ** (-(rh + home * params.homeElo - ra) / 400));
    if (cfg.tennis) {
      const nH = st.careerGames.get(g.home_id) ?? 0;
      const nA = st.careerGames.get(g.away_id) ?? 0;
      const oh = st.ratings.get(g.home_id) ?? BASE;
      const oa = st.ratings.get(g.away_id) ?? BASE;
      const eOverall = 1 / (1 + 10 ** (-(oh - oa) / 400));
      st.ratings.set(g.home_id, oh + tennisK(nH, params.k) * (outcome - eOverall));
      st.ratings.set(g.away_id, oa - tennisK(nA, params.k) * (outcome - eOverall));
      st.careerGames.set(g.home_id, nH + 1);
      st.careerGames.set(g.away_id, nA + 1);
      if (surface) {
        const kH = surfaceKey(g.home_id, surface);
        const kA = surfaceKey(g.away_id, surface);
        const sh = st.surface.get(kH) ?? oh;
        const sa = st.surface.get(kA) ?? oa;
        const sH = st.surfaceGames.get(kH) ?? 0;
        const sA = st.surfaceGames.get(kA) ?? 0;
        const eSurf = 1 / (1 + 10 ** (-(sh - sa) / 400));
        st.surface.set(kH, sh + tennisK(sH, params.k) * (outcome - eSurf));
        st.surface.set(kA, sa - tennisK(sA, params.k) * (outcome - eSurf));
        st.surfaceGames.set(kH, sH + 1);
        st.surfaceGames.set(kA, sA + 1);
      }
    } else {
      let k = params.k;
      if (cfg.mov && !tie) {
        const margin = Math.abs(g.home_score - g.away_score);
        const winnerDiff = y === 1 ? rh + home * params.homeElo - ra : ra - rh - home * params.homeElo;
        k *= movMultiplier(margin, winnerDiff);
      }
      const delta = k * (outcome - expected);
      st.ratings.set(g.home_id, rh + delta);
      st.ratings.set(g.away_id, ra - delta);
      // scoring form (points scored and allowed), used for totals
      st.offense.set(g.home_id, oH + ALPHA * (g.home_score - oH));
      st.defense.set(g.home_id, dH + ALPHA * (g.away_score - dH));
      st.offense.set(g.away_id, oA + ALPHA * (g.away_score - oA));
      st.defense.set(g.away_id, dA + ALPHA * (g.home_score - dA));
      ptsSum += g.home_score + g.away_score;
      ptsN += 2;
      st.leagueAvg = ptsSum / ptsN;
    }
    st.games.set(g.home_id, (st.games.get(g.home_id) ?? 0) + 1);
    st.games.set(g.away_id, (st.games.get(g.away_id) ?? 0) + 1);
  }
  return { rows, state: st };
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

/** Ordinary least squares with a tiny ridge for stability. */
export function fitOLS(X: number[][], y: number[]): { beta: number[]; sigma: number } {
  const k = X[0].length;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  X.forEach((xi, i) => {
    for (let a = 0; a < k; a++) {
      Xty[a] += xi[a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += xi[a] * xi[b];
    }
  });
  for (let a = 0; a < k; a++) XtX[a][a] += 1e-6;
  const beta = solve(XtX, Xty);
  const resid = X.map((xi, i) => y[i] - linearPredictor(beta, xi));
  const sigma = Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / Math.max(1, X.length - k));
  return { beta, sigma };
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

const scores = (ps: number[], ys: (0 | 1)[]): Scored => ({
  brier: mean(ps.map((p, i) => (p - ys[i]) ** 2)),
  logLoss: mean(ps.map((p, i) => logLoss(p, ys[i]))),
  n: ps.length,
});

/** Kept for tests and documentation: the baseball grid. */
export const GRID = sportConfig("baseball").grid;

// ---------- discrete margin / total distributions ----------
const normPdf = (x: number, mu: number, sigma: number) => Math.exp(-0.5 * ((x - mu) / sigma) ** 2) / (sigma * Math.sqrt(2 * Math.PI));

/**
 * Learn key-number weights: observed frequency of each integer outcome divided by the frequency the
 * smooth Normal model expects across the same games. Values the sport lands on more often than a
 * smooth curve predicts (NFL margins of 3 and 7, for example) get weights above 1.
 */
function learnKeyWeights(actual: number[], mus: number[], sigma: number, range: [number, number], allowZero: boolean, symmetric: boolean): Record<number, number> {
  const weights: Record<number, number> = {};
  const counts = new Map<number, number>();
  for (const a of actual) counts.set(Math.round(a), (counts.get(Math.round(a)) ?? 0) + 1);
  const expectedAt = (m: number) => mus.reduce((s, mu) => s + normPdf(m, mu, sigma), 0);
  for (let m = range[0]; m <= range[1]; m++) {
    if (m === 0 && !allowZero) {
      weights[m] = 0;
      continue;
    }
    // Margins: a 3-point win and a 3-point loss are the same key number, so pool ±m (halves the noise).
    const pooled = symmetric && m !== 0;
    const expected = pooled ? expectedAt(m) + expectedAt(-m) : expectedAt(m);
    const observed = pooled ? (counts.get(m) ?? 0) + (counts.get(-m) ?? 0) : counts.get(m) ?? 0;
    // Shrink towards 1 with a pseudo-count so rare values don't produce wild weights.
    const pseudo = 3;
    weights[m] = Math.min(4, Math.max(0.25, (observed + pseudo) / (expected + pseudo)));
  }
  return weights;
}

/** P(first outcome wins | no push) — home covers for spreads, over for totals. */
export function coverProbability(mu: number, model: DiscreteModel, contract: LineContract, line: number): number {
  const dist = discreteDistribution(mu, model, contract === "spread_full_game" ? MARGIN_RANGE : TOTAL_RANGE);
  const lp = lineProbabilities(dist, contract === "spread_full_game" ? line : -line, "plus");
  return lp.win / Math.max(1e-12, lp.win + lp.loss);
}

/** Expected margin/total at which the model's distribution matches the market's no-push probability. */
export function impliedMean(model: DiscreteModel, contract: LineContract, line: number, pFirst: number): number {
  const center = contract === "spread_full_game" ? -line : line;
  let lo = center - 60;
  let hi = center + 60;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (coverProbability(mid, model, contract, line) < pFirst) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Blend a model mean with the market-implied mean, then price the line with the model's distribution. */
export function blendedCover(model: DiscreteModel, contract: LineContract, line: number, muModel: number, pMarket: number, w: number): { mu: number; p: number } {
  const mu = w * muModel + (1 - w) * impliedMean(model, contract, line, pMarket);
  return { mu, p: coverProbability(mu, model, contract, line) };
}

/** Probability mass function over integer outcomes: Normal shape times learned key-number weights. */
export function discreteDistribution(mu: number, model: DiscreteModel, range: [number, number]): Map<number, number> {
  const out = new Map<number, number>();
  let total = 0;
  // Mass beyond 8 standard deviations is negligible (< 1e-15).
  const lo = Math.max(range[0], Math.floor(mu - 8 * model.sigma));
  const hi = Math.min(range[1], Math.ceil(mu + 8 * model.sigma));
  for (let m = lo; m <= hi; m++) {
    const w = model.keyWeights[m] ?? 1;
    const v = normPdf(m, mu, model.sigma) * w;
    if (v > 0) {
      out.set(m, v);
      total += v;
    }
  }
  for (const [k, v] of out) out.set(k, v / total);
  return out;
}

/** Win / push / loss probabilities for "value + line > 0" (spread: home margin + home line; total: total − line). */
export function lineProbabilities(dist: Map<number, number>, line: number, side: "plus" | "minus"): { win: number; push: number; loss: number } {
  let over = 0;
  let push = 0;
  let under = 0;
  for (const [v, p] of dist) {
    const x = v + line;
    if (Math.abs(x) < 1e-9) push += p;
    else if (x > 0) over += p;
    else under += p;
  }
  return side === "plus" ? { win: over, push, loss: under } : { win: under, push, loss: over };
}

export const MARGIN_RANGE: [number, number] = [-90, 90];
export const TOTAL_RANGE: [number, number] = [0, 340];

function fitDiscrete(X: number[][], y: number[], range: [number, number], allowZero: boolean, symmetric = false): DiscreteModel {
  const { beta, sigma } = fitOLS(X, y);
  const mus = X.map((x) => linearPredictor(beta, x));
  const s = Math.max(0.75, sigma);
  return {
    beta,
    sigma: s,
    keyWeights: learnKeyWeights(y, mus, s, range, allowZero, symmetric),
    n: y.length,
    meanAbsError: mean(y.map((v, i) => Math.abs(v - mus[i]))),
  };
}

// ---------- fitting ----------
export interface FitInput {
  sportKey: string;
  games: GameRow[]; // completed games known before the forecast time, any order
  schedule?: ScheduleRow[];
  forecastSeason: string;
  /** Pre-game market reference (home probability) for validation games, when historical quotes exist. */
  marketHome?: (eventId: string, startIso: string) => number | null;
  /** Most-quoted pre-game line and the market's no-push probability for its first outcome. */
  marketLine?: (eventId: string, contract: LineContract) => { line: number; pFirst: number } | null;
}

function fitLineBlend(contract: LineContract, dm: DiscreteModel, va: FeatureRow[], marketLine: NonNullable<FitInput["marketLine"]>): LineBlend | null {
  const pts: { mu: number; muMkt: number; line: number; y: 0 | 1; pk: number }[] = [];
  for (const r of va) {
    const mu = contract === "spread_full_game" ? linearPredictor(dm.beta, [r.x[0], r.x[1]]) : Number.isFinite(r.totalFeature) ? linearPredictor(dm.beta, [1, r.totalFeature]) : NaN;
    if (!Number.isFinite(mu)) continue;
    const ml = marketLine(r.id, contract);
    if (!ml || !(ml.pFirst > 0 && ml.pFirst < 1)) continue;
    const value = contract === "spread_full_game" ? r.margin + ml.line : r.total - ml.line;
    if (value === 0) continue;
    pts.push({ mu, muMkt: impliedMean(dm, contract, ml.line, ml.pFirst), line: ml.line, y: value > 0 ? 1 : 0, pk: ml.pFirst });
  }
  if (pts.length < 100) return null;
  const clampP = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));
  const llAt = (w: number) => mean(pts.map((q) => logLoss(clampP(coverProbability(w * q.mu + (1 - w) * q.muMkt, dm, contract, q.line)), q.y)));
  let best = { w: 0, ll: llAt(0) };
  for (let w = 0.1; w <= 1.0001; w += 0.1) {
    const ll = llAt(w);
    if (ll < best.ll - 1e-9) best = { w: Math.round(w * 10) / 10, ll };
  }
  return { w: best.w, n: pts.length, logLoss: { model: llAt(1), market: mean(pts.map((q) => logLoss(clampP(q.pk), q.y))), blend: best.ll } };
}

function masksFor(cfg: SportConfig): boolean[][] {
  const base = FEATURES.map((f) => f === "elo_diff_per_100" || (f === "home_advantage" && cfg.homeFeature));
  const optIdx = cfg.optional.map((f) => FEATURES.indexOf(f));
  const masks: boolean[][] = [];
  for (let bits = 0; bits < 1 << optIdx.length; bits++) {
    const m = [...base];
    optIdx.forEach((idx, j) => {
      if (bits & (1 << j)) m[idx] = true;
    });
    masks.push(m);
  }
  return masks;
}

/**
 * Fit the model on seasons strictly before `forecastSeason`.
 * Validation = the last training season (out-of-sample for weights fitted on earlier seasons);
 * the final weights are then refitted on all training seasons.
 */
export function fitModel(input: FitInput): FitResult {
  const cfg = sportConfig(input.sportKey);
  const games = input.games
    .filter((g) => seasonOfRow(g) < input.forecastSeason)
    .sort((a, b) => a.start_time.localeCompare(b.start_time) || a.id.localeCompare(b.id));
  const seasons = [...new Set(games.map(seasonOfRow))].sort();
  if (games.length < cfg.minGames || seasons.length < 2) {
    return {
      available: false,
      reason:
        seasons.length < 2
          ? `Needs at least two completed seasons before ${input.forecastSeason} (found ${seasons.length}). No independent forecast is shown.`
          : `Only ${games.length} completed games before ${input.forecastSeason}; at least ${cfg.minGames} are needed.`,
    };
  }
  const validationSeason = seasons[seasons.length - 1];
  const trainSeasons = seasons.slice(0, -1);
  const schedule = input.schedule;
  const masks = masksFor(cfg);

  let best: { params: EloParams; ll: number; rows: FeatureRow[]; mask: boolean[] } | null = null;
  let searched = 0;
  const varies = (rows: FeatureRow[], j: number) => rows.filter((r) => r.x[j] !== 0).length >= 30;
  for (const k of cfg.grid.k)
    for (const homeElo of cfg.grid.homeElo)
      for (const carry of cfg.grid.carry)
        for (const surfaceWeight of cfg.grid.surfaceWeight) {
          const params: EloParams = { k, homeElo, carry, surfaceWeight };
          const { rows } = runElo(games, params, schedule, cfg);
          const usable = rows.slice(cfg.burnIn);
          const tr = usable.filter((r) => r.season !== validationSeason);
          const va = usable.filter((r) => r.season === validationSeason);
          if (tr.length < 100 || va.length < 50) continue;
          for (const mask of masks) {
            if (mask.some((on, j) => on && !varies(tr, j))) continue;
            let beta: number[];
            try {
              beta = fitLogistic(tr.map((r) => applyMask(r.x, mask)), tr.map((r) => r.y)).beta;
            } catch {
              continue;
            }
            const ll = mean(va.map((r) => logLoss(sigmoid(linearPredictor(beta, applyMask(r.x, mask))), r.y)));
            searched++;
            if (!best || ll < best.ll - 1e-12) best = { params, ll, rows, mask };
          }
        }
  if (!best) return { available: false, reason: "Not enough games in the training and validation seasons to fit the model." };

  const mask = best.mask;
  const usable = best.rows.slice(cfg.burnIn);
  const tr = usable.filter((r) => r.season !== validationSeason);
  const va = usable.filter((r) => r.season === validationSeason);
  const trainFit = fitLogistic(tr.map((r) => applyMask(r.x, mask)), tr.map((r) => r.y));
  const vaPreds = va.map((r) => sigmoid(linearPredictor(trainFit.beta, applyMask(r.x, mask))));
  const vaY = va.map((r) => r.y);
  const homeRate = mean(tr.map((r) => r.y));

  let market: Scored | null = null;
  let modelOnMarket: Scored | null = null;
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
      diffCI = pairedBootstrapCI(pairs.map((p) => logLoss(p.pm, p.y)), pairs.map((p) => logLoss(p.pk, p.y)));
    }
    if (pairs.length >= 150) {
      const blend = fitLogistic(pairs.map((p) => [logit(p.pm), logit(p.pk)]), pairs.map((p) => p.y));
      combined = { a: blend.beta[0], b: blend.beta[1], n: pairs.length };
    }
  }

  const reduced = fitLogistic(usable.map((r) => applyMask(r.x, mask)), usable.map((r) => r.y));
  const finalFit = expandFit(reduced, mask);

  // Margin and total distributions (team sports with scores).
  let marginModel: DiscreteModel | null = null;
  let totalModel: DiscreteModel | null = null;
  if (cfg.margins && usable.length >= 200) {
    marginModel = fitDiscrete(usable.map((r) => [r.x[0], r.x[1]]), usable.map((r) => r.margin), MARGIN_RANGE, cfg.allowTies, true);
    const withForm = usable.filter((r) => Number.isFinite(r.totalFeature));
    if (withForm.length >= 200) totalModel = fitDiscrete(withForm.map((r) => [1, r.totalFeature]), withForm.map((r) => r.total), TOTAL_RANGE, true);
  }

  // Line blends are chosen on the validation season with the margin/total models fitted on training seasons.
  const lineBlend: ModelFit["lineBlend"] = { spread: null, total: null };
  if (input.marketLine && cfg.margins) {
    const trM = tr.length >= 200 ? fitDiscrete(tr.map((r) => [r.x[0], r.x[1]]), tr.map((r) => r.margin), MARGIN_RANGE, cfg.allowTies, true) : null;
    const trForm = tr.filter((r) => Number.isFinite(r.totalFeature));
    const trT = trForm.length >= 200 ? fitDiscrete(trForm.map((r) => [1, r.totalFeature]), trForm.map((r) => r.total), TOTAL_RANGE, true) : null;
    if (trM) lineBlend.spread = fitLineBlend("spread_full_game", trM, va, input.marketLine);
    if (trT) lineBlend.total = fitLineBlend("total_full_game", trT, va, input.marketLine);
  }

  const span = (rows: FeatureRow[], ss: string[]): SplitInfo => ({ from: rows[0]?.start_time ?? null, to: rows[rows.length - 1]?.start_time ?? null, n: rows.length, seasons: ss });
  const used = FEATURES.filter((_, i) => mask[i]);
  const optionalNotes = cfg.optional.map((f) =>
    used.includes(f)
      ? `${featureLabel(f)} was evaluated and retained because it improved validation log loss.`
      : `${featureLabel(f)} was evaluated but not retained: it did not improve validation log loss (or varied too little to estimate).`,
  );
  const notes = [
    `Rating system: ${cfg.label}. Ratings start at ${BASE}; the first ${cfg.burnIn} games are a burn-in and are not used to fit weights.`,
    ...optionalNotes,
    ...(marginModel ? [`Spreads use a margin distribution (typical error ±${marginModel.sigma.toFixed(1)}) adjusted for key numbers learned from ${marginModel.n} games.`] : []),
    ...(totalModel ? [`Totals use a total-points distribution (typical error ±${totalModel.sigma.toFixed(1)}) built from recent scoring form.`] : []),
    ...(["spread", "total"] as const).flatMap((k) => {
      const b = lineBlend[k];
      return b ? [`Sharpened ${k} estimate: ${Math.round(b.w * 100)}% model, ${Math.round((1 - b.w) * 100)}% market-implied ${k === "spread" ? "margin" : "total"}, chosen on ${b.n} validation games (log loss ${b.logLoss.blend.toFixed(4)} vs model ${b.logLoss.model.toFixed(4)} and market ${b.logLoss.market.toFixed(4)}).`] : [];
    }),
    "The interval reflects uncertainty in the fitted weights only. It does not capture rating noise, injuries, lineups or anything else the model does not see.",
    "The model does not use player availability, so injury and lineup news is not double-counted, and it is not reflected either.",
  ];
  return {
    available: true,
    version: `${MODEL_NAME}@${trainSeasons[0]}-${validationSeason}`,
    name: MODEL_NAME,
    sportKey: input.sportKey,
    config: { label: cfg.label, family: cfg.family },
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
    featuresUsed: used,
    homeWinRateTrain: homeRate,
    gridSearched: searched,
    margin: marginModel,
    total: totalModel,
    lineBlend,
    notes,
  };
}

export function featureLabel(f: string): string {
  switch (f) {
    case "home_advantage":
      return "Home advantage";
    case "elo_diff_per_100":
      return "Rating difference (per 100 Elo)";
    case "rest_diff_days":
      return "Rest-day difference";
    case "back_to_back_diff":
      return "Back-to-back difference";
    case "elo_diff_best_of_5":
      return "Rating difference × best of five";
    default:
      return f;
  }
}

/** Rating state at a moment: run the fitted params through every game completed before it. */
export function ratingsAt(games: GameRow[], params: EloParams, forecastSeason: string, sportKey = "baseball_mlb"): EloState {
  const cfg = sportConfig(sportKey);
  const sorted = [...games].sort((a, b) => a.start_time.localeCompare(b.start_time) || a.id.localeCompare(b.id));
  const { state } = runElo(sorted, params, undefined, cfg);
  // Apply the between-season regression if the forecast season has not started in the data yet.
  if (state.season !== null && state.season !== forecastSeason) {
    for (const [team, r] of state.ratings) state.ratings.set(team, BASE + params.carry * (r - BASE));
    for (const [k, r] of state.surface) state.surface.set(k, BASE + params.carry * (r - BASE));
    if (Number.isFinite(state.leagueAvg)) {
      for (const m of [state.offense, state.defense]) for (const [team, v] of m) m.set(team, state.leagueAvg + 0.5 * (v - state.leagueAvg));
    }
    state.season = forecastSeason;
    state.games = new Map();
  }
  return state;
}

export interface PredictOptions {
  neutral: boolean;
  restDiff: number;
  b2bDiff?: number;
  bestOf?: number;
  surface?: string | null;
}

export interface ModelPrediction {
  pHome: number;
  low: number;
  high: number;
  features: { name: string; label: string; value: number; weight: number; contribution: number }[];
  eloHome: number;
  eloAway: number;
  gamesHomeThisSeason: number;
  gamesAwayThisSeason: number;
  /** Expected home margin and total points (team sports with a margin model). */
  expectedMargin: number | null;
  expectedTotal: number | null;
}

export function predictGame(fit: ModelFit, state: EloState, homeId: string, awayId: string, opts: PredictOptions | boolean, legacyRest = 0): ModelPrediction {
  const o: PredictOptions = typeof opts === "boolean" ? { neutral: opts, restDiff: legacyRest } : opts;
  const cfg = sportConfig(fit.sportKey);
  const w = fit.params.surfaceWeight ?? 0;
  const rh = cfg.tennis ? blendedRating(state, homeId, o.surface, w) : state.ratings.get(homeId) ?? BASE;
  const ra = cfg.tennis ? blendedRating(state, awayId, o.surface, w) : state.ratings.get(awayId) ?? BASE;
  const eloDiff = (rh - ra) / 100;
  const home = cfg.homeFeature && !o.neutral ? 1 : 0;
  const bo5 = (o.bestOf ?? 3) >= 5 ? 1 : 0;
  const x = [home, eloDiff, clampRest(o.restDiff), o.b2bDiff ?? 0, eloDiff * bo5];
  const r = predictWithInterval(fit.beta, fit.cov, x);
  let expectedMargin: number | null = null;
  let expectedTotal: number | null = null;
  if (fit.margin) expectedMargin = linearPredictor(fit.margin.beta, [home, eloDiff]);
  if (fit.total && Number.isFinite(state.leagueAvg)) {
    const avg = state.leagueAvg;
    const tf = ((state.offense.get(homeId) ?? avg) + (state.defense.get(awayId) ?? avg)) / 2 + ((state.offense.get(awayId) ?? avg) + (state.defense.get(homeId) ?? avg)) / 2;
    expectedTotal = linearPredictor(fit.total.beta, [1, tf]);
  }
  return {
    pHome: r.p,
    low: r.low,
    high: r.high,
    // Only inputs that exist for this sport (e.g. no home advantage in tennis, no best-of-five in basketball).
    features: FEATURES.map((name, i) => ({ name, label: featureLabel(name), value: x[i], weight: fit.beta[i], contribution: x[i] * fit.beta[i] })).filter(
      (f) => f.name === "elo_diff_per_100" || (f.name === "home_advantage" && cfg.homeFeature) || cfg.optional.includes(f.name as FeatureName),
    ),
    eloHome: rh,
    eloAway: ra,
    gamesHomeThisSeason: state.games.get(homeId) ?? 0,
    gamesAwayThisSeason: state.games.get(awayId) ?? 0,
    expectedMargin,
    expectedTotal,
  };
}

/** Spread / total probabilities from the fitted distributions (null when the sport has no margin model). */
export function spreadProbabilities(fit: ModelFit, pred: ModelPrediction, homeLine: number): { home: { win: number; push: number; loss: number }; away: { win: number; push: number; loss: number } } | null {
  if (!fit.margin || pred.expectedMargin == null) return null;
  const dist = discreteDistribution(pred.expectedMargin, fit.margin, MARGIN_RANGE);
  return { home: lineProbabilities(dist, homeLine, "plus"), away: lineProbabilities(dist, homeLine, "minus") };
}

export function totalProbabilities(fit: ModelFit, pred: ModelPrediction, line: number): { over: { win: number; push: number; loss: number }; under: { win: number; push: number; loss: number } } | null {
  if (!fit.total || pred.expectedTotal == null) return null;
  const dist = discreteDistribution(pred.expectedTotal, fit.total, TOTAL_RANGE);
  return { over: lineProbabilities(dist, -line, "plus"), under: lineProbabilities(dist, -line, "minus") };
}
