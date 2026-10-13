// Three more invented leagues for the fictional demo world (no real teams, players or events):
//   - Lakeside Basketball Association: moneylines, point spreads and totals; back-to-back fatigue.
//   - Frontier Football League: touchdown/field-goal scoring, so margins of 3 and 7 are common
//     ("key numbers"), integer lines that can push, moneylines, spreads and totals.
//   - Coastal Tennis Tour: individual players, hard/clay/grass surfaces, best-of-five majors,
//     knockout draws whose later rounds only become known once earlier rounds finish.
// Each league has its own random stream, so adding or changing one never changes another.

import type { QuoteRecord, Repo, WeatherRecord } from "./repo";
import { sigmoid } from "../shared/odds";
import { mulberry32, normal, poisson } from "../shared/rng";
import {
  DS,
  addDays,
  bookQuotes,
  days,
  discreteNormal,
  demoSnapshotTimes,
  lineQuotes,
  lineSplit,
  plusMin,
  roundHalf,
  toUtc,
  weekday,
  type Rand,
} from "./demo-common";

export const DEMO_SPORT_LEAGUES = {
  demo_basketball: "Lakeside Basketball Association (fictional)",
  demo_football: "Frontier Football League (fictional)",
  demo_tennis: "Coastal Tennis Tour (fictional)",
};

/** Dense (every ~2 h) quote polling only in a window around the demo date; three snapshots elsewhere. */
const DENSE_FROM = "2026-06-01";
const DENSE_TO = "2026-07-20";
const isDense = (date: string) => date >= DENSE_FROM && date <= DENSE_TO;

interface Sink {
  quotes: QuoteRecord[];
  weather: WeatherRecord[];
  events: number;
}

const normCdf = (z: number) => {
  // Abramowitz–Stegun 7.1.26 via erf
  const t = 1 / (1 + 0.3275911 * Math.abs(z / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-((z / Math.SQRT2) ** 2));
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
};

function shuffle<T>(rand: Rand, arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// =====================================================================================
// Basketball
// =====================================================================================
const BK = "demo_basketball";
const BASKETBALL_TEAMS = [
  { abbr: "AUR", name: "Aurora Lynx", tz: "America/New_York" },
  { abbr: "BRK", name: "Briarcliff Ravens", tz: "America/New_York" },
  { abbr: "CDV", name: "Cedarvale Stags", tz: "America/Chicago" },
  { abbr: "DLT", name: "Delta Harbor Cranes", tz: "America/Chicago" },
  { abbr: "EMB", name: "Emberton Foxes", tz: "America/Denver" },
  { abbr: "FRS", name: "Frostburg Wolves", tz: "America/Denver" },
  { abbr: "GLD", name: "Goldcrest Monarchs", tz: "America/Los_Angeles" },
  { abbr: "HZN", name: "Horizon Bay Orcas", tz: "America/Los_Angeles" },
  { abbr: "IRN", name: "Ironwood Bison", tz: "America/Chicago" },
  { abbr: "JSP", name: "Jasper City Hawks", tz: "America/New_York" },
  { abbr: "KNG", name: "Kingsport Mariners", tz: "America/New_York" },
  { abbr: "LMR", name: "Lumen Ridge Panthers", tz: "America/Los_Angeles" },
];
const BK_SIGMA_MARGIN = 12;
const BK_SIGMA_TOTAL = 17;
const BK_HCA = 2.8;
const BK_B2B = 2.5;

function basketball(repo: Repo, sink: Sink): void {
  const rand = mulberry32(20260616 + 101);
  const ids = BASKETBALL_TEAMS.map((t) => `demo-bk:${t.abbr}`);
  BASKETBALL_TEAMS.forEach((t, i) =>
    repo.upsertParticipant({ id: ids[i], dataset: DS, sport_key: BK, name: t.name, short_name: t.name.split(" ").slice(-1)[0], abbreviation: t.abbr, aliases: [], meta: { fictional: true, tz: t.tz } }),
  );
  let strength = BASKETBALL_TEAMS.map(() => normal(rand, 0, 5.5));
  let pace = BASKETBALL_TEAMS.map(() => normal(rand, 0, 4));
  for (const season of ["2024", "2025", "2026"]) {
    strength = strength.map((s) => 0.7 * s + normal(rand, 0, 3));
    pace = pace.map((p) => 0.6 * p + normal(rand, 0, 2.5));
    const lastPlayed = new Map<number, string>();
    for (const date of days(`${season}-04-03`, `${season}-09-20`)) {
      strength = strength.map((s) => s + normal(rand, 0, 0.12));
      const wd = weekday(date);
      const nGames = wd >= 5 ? 3 : 2;
      const order = shuffle(rand, BASKETBALL_TEAMS.map((_, i) => i));
      for (let g = 0; g < nGames; g++) {
        const h = order[2 * g];
        const a = order[2 * g + 1];
        const ht = BASKETBALL_TEAMS[h];
        const start = toUtc(date, g === 0 && wd >= 6 ? "15:30" : "19:30", ht.tz);
        const id = `demo-bk-${date}-${ht.abbr}-${BASKETBALL_TEAMS[a].abbr}`;
        const b2b = (i: number) => (lastPlayed.get(i) === addDays(date, -1) ? 1 : 0);
        const mu = BK_HCA + strength[h] - strength[a] - BK_B2B * b2b(h) + BK_B2B * b2b(a);
        const muT = 222 + pace[h] + pace[a];
        lastPlayed.set(h, date);
        lastPlayed.set(a, date);
        let margin = Math.round(normal(rand, mu, BK_SIGMA_MARGIN));
        let overtime = false;
        if (margin === 0) {
          overtime = true;
          margin = (rand() < sigmoid(mu / 6) ? 1 : -1) * (1 + Math.floor(rand() * 8));
        }
        const total = Math.max(150, Math.round(normal(rand, muT + (overtime ? 10 : 0), BK_SIGMA_TOTAL)));
        let awayScore = Math.round((total - margin) / 2);
        let homeScore = awayScore + margin;
        if (homeScore < 60 || awayScore < 60) {
          homeScore = Math.max(60, homeScore);
          awayScore = homeScore - margin;
        }
        const finalAt = plusMin(start, overtime ? 160 : 145);
        repo.upsertEvent({
          id, dataset: DS, sport_key: BK, league: DEMO_SPORT_LEAGUES[BK], season, home_id: ids[h], away_id: ids[a], start_time: start,
          status: "final", status_at: finalAt, final_at: finalAt, home_score: homeScore, away_score: awayScore, regulation_home: null, regulation_away: null,
          final_is_regulation: 0, neutral_site: 0, venue_name: `${ht.name} Arena (fictional)`, venue_lat: null, venue_lon: null, venue_tz: ht.tz, indoor: 1,
          rescheduled_from: null, game_number: 1, source: "demo", source_updated_at: finalAt, retrieved_at: finalAt, known_at: plusMin(start, -60 * 24 * 30),
          extra: { fictional: true, overtime },
        });
        sink.events++;
        // Market view: noisy but unbiased; the noise shrinks as the start approaches.
        const noise = normal(rand, 0, 1.6);
        const noiseT = normal(rand, 0, 4);
        const progress = (t: string) => Math.max(0, Math.min(1, 1 - (Date.parse(start) - Date.parse(t)) / (26 * 3600000)));
        const viewAt = (t: string) => mu + noise * (1 - 0.4 * progress(t));
        const viewT = (t: string) => muT + noiseT * (1 - 0.4 * progress(t));
        const snaps = demoSnapshotTimes(start, isDense(date) ? 26 * 60 : 75, null, isDense(date));
        const pWin = (v: number) => normCdf(v / BK_SIGMA_MARGIN);
        sink.quotes.push(
          ...bookQuotes({ rand, eventId: id, contract: "moneyline_2way_full_game", outcomes: ["home", "away"], fairAt: (t) => [pWin(viewAt(t)), 1 - pWin(viewAt(t))], snapshots: snaps }),
          ...lineQuotes({
            rand, eventId: id, contract: "spread_full_game", snapshots: snaps, viewAt, noisePoints: 0.2,
            lineFor: (v) => {
              const l = roundHalf(-v);
              return Number.isInteger(l) ? l + (v > 0 ? -0.5 : 0.5) : l; // basketball books hang half-point spreads
            },
            probs: (v, line) => lineSplit(discreteNormal(v, BK_SIGMA_MARGIN, -70, 70, true), line),
          }),
          ...lineQuotes({
            rand, eventId: id, contract: "total_full_game", snapshots: snaps, viewAt: viewT, noisePoints: 0.35,
            lineFor: (v) => Math.floor(v) + 0.5,
            probs: (v, line) => lineSplit(discreteNormal(v, BK_SIGMA_TOTAL, 140, 320), -line),
          }),
        );
      }
    }
  }
}

// =====================================================================================
// Football (touchdowns and field goals)
// =====================================================================================
const FT = "demo_football";
const FOOTBALL_TEAMS = [
  { abbr: "ALT", name: "Alder Point Timberwolves", tz: "America/New_York", dome: false },
  { abbr: "BLK", name: "Blackrock Rams", tz: "America/Chicago", dome: false },
  { abbr: "CPR", name: "Copper Ridge Outlaws", tz: "America/Denver", dome: false },
  { abbr: "DNE", name: "Dunes City Scorpions", tz: "America/Phoenix", dome: true },
  { abbr: "ELM", name: "Elm Harbor Anchors", tz: "America/New_York", dome: false },
  { abbr: "FRG", name: "Forgeton Steelhawks", tz: "America/New_York", dome: false },
  { abbr: "GRN", name: "Greenvale Gators", tz: "America/Chicago", dome: true },
  { abbr: "HLD", name: "Highland Thunder", tz: "America/Denver", dome: false },
  { abbr: "ISL", name: "Island Bay Marlins", tz: "America/Los_Angeles", dome: false },
  { abbr: "JNC", name: "Junction Rail Kings", tz: "America/Chicago", dome: false },
  { abbr: "KST", name: "Keystone Sentinels", tz: "America/New_York", dome: true },
  { abbr: "LKV", name: "Lake Verde Herons", tz: "America/Los_Angeles", dome: false },
  { abbr: "MSA", name: "Mesa Alta Roadrunners", tz: "America/Phoenix", dome: false },
  { abbr: "NRD", name: "Nordhaven Vikings", tz: "America/Chicago", dome: false },
  { abbr: "OKR", name: "Oak River Bulldogs", tz: "America/New_York", dome: false },
  { abbr: "PRM", name: "Prairie Mustangs", tz: "America/Denver", dome: false },
];
const FT_HCA = 2.0;
const FT_BASE = 22;
const TD_VALUE: [number, number][] = [
  [6, 0.06],
  [7, 0.9],
  [8, 0.04],
];

const poissonPmf = (l: number, k: number) => {
  let f = 1;
  for (let i = 2; i <= k; i++) f *= i;
  return (Math.exp(-l) * l ** k) / f;
};

/** Points distribution for one team: 70% of expected points from touchdowns, 30% from field goals. */
function teamPointsPmf(expected: number): number[] {
  const lTd = (0.7 * Math.max(3, expected)) / 6.98;
  const lFg = (0.3 * Math.max(3, expected)) / 3;
  const MAX = 90;
  let td = new Array(MAX + 1).fill(0);
  td[0] = 1;
  const out = new Array(MAX + 1).fill(0);
  const fg = Array.from({ length: 11 }, (_, k) => poissonPmf(lFg, k));
  for (let k = 0; k <= 10; k++) {
    const pk = poissonPmf(lTd, k);
    for (let x = 0; x <= MAX; x++) {
      if (!td[x]) continue;
      for (let f = 0; f <= 10 && x + 3 * f <= MAX; f++) out[x + 3 * f] += pk * td[x] * fg[f];
    }
    // add one more touchdown
    const next = new Array(MAX + 1).fill(0);
    for (let x = 0; x <= MAX; x++) {
      if (!td[x]) continue;
      for (const [v, p] of TD_VALUE) if (x + v <= MAX) next[x + v] += td[x] * p;
    }
    td = next;
  }
  const s = out.reduce((a, b) => a + b, 0);
  return out.map((x) => x / s);
}

const pmfCache = new Map<string, { margin: Map<number, number>; total: Map<number, number> }>();
/** Margin and total distributions after overtime (a regulation tie becomes ±3 or ±6, or stays a tie). */
function footballDists(mu: number, muTotal: number) {
  // Inputs are rounded to 0.1 points so the cache is an exact function of its key (keeps generation deterministic).
  const eh = Math.round(((muTotal + mu) / 2) * 10) / 10;
  const ea = Math.round(((muTotal - mu) / 2) * 10) / 10;
  mu = eh - ea;
  const key = `${eh}|${ea}`;
  const hit = pmfCache.get(key);
  if (hit) return hit;
  const ph = teamPointsPmf(eh);
  const pa = teamPointsPmf(ea);
  const margin = new Map<number, number>();
  const total = new Map<number, number>();
  const pHomeOt = sigmoid(mu / 7);
  for (let i = 0; i < ph.length; i++) {
    if (ph[i] < 1e-9) continue;
    for (let j = 0; j < pa.length; j++) {
      const p = ph[i] * pa[j];
      if (p < 1e-12) continue;
      if (i === j) {
        for (const [d, w] of [
          [3, 0.6],
          [6, 0.35],
        ] as const) {
          margin.set(d, (margin.get(d) ?? 0) + p * w * pHomeOt);
          margin.set(-d, (margin.get(-d) ?? 0) + p * w * (1 - pHomeOt));
          total.set(i + j + d, (total.get(i + j + d) ?? 0) + p * w);
        }
        margin.set(0, (margin.get(0) ?? 0) + p * 0.05);
        total.set(i + j, (total.get(i + j) ?? 0) + p * 0.05);
      } else {
        margin.set(i - j, (margin.get(i - j) ?? 0) + p);
        total.set(i + j, (total.get(i + j) ?? 0) + p);
      }
    }
  }
  const r = { margin, total };
  if (pmfCache.size > 5000) pmfCache.clear();
  pmfCache.set(key, r);
  return r;
}

function sampleTeamPoints(rand: Rand, expected: number): number {
  const td = poisson(rand, (0.7 * Math.max(3, expected)) / 6.98);
  const fg = poisson(rand, (0.3 * Math.max(3, expected)) / 3);
  let pts = 3 * fg;
  for (let k = 0; k < td; k++) {
    const u = rand();
    pts += u < TD_VALUE[0][1] ? 6 : u < TD_VALUE[0][1] + TD_VALUE[1][1] ? 7 : 8;
  }
  return pts;
}

function football(repo: Repo, sink: Sink): void {
  const rand = mulberry32(20260616 + 202);
  const ids = FOOTBALL_TEAMS.map((t) => `demo-ft:${t.abbr}`);
  FOOTBALL_TEAMS.forEach((t, i) =>
    repo.upsertParticipant({ id: ids[i], dataset: DS, sport_key: FT, name: t.name, short_name: t.name.split(" ").slice(-1)[0], abbreviation: t.abbr, aliases: [], meta: { fictional: true, tz: t.tz, dome: t.dome } }),
  );
  let strength = FOOTBALL_TEAMS.map(() => normal(rand, 0, 6));
  let offense = FOOTBALL_TEAMS.map(() => normal(rand, 0, 2.5));
  for (const season of ["2023", "2024", "2025", "2026"]) {
    strength = strength.map((s) => 0.65 * s + normal(rand, 0, 4.5));
    offense = offense.map((o) => 0.6 * o + normal(rand, 0, 2));
    // Weeks start on the first Tuesday of April; 2 games on Tuesday evening, 6 on Saturday.
    let tue = `${season}-04-01`;
    while (weekday(tue) !== 2) tue = addDays(tue, 1);
    for (let week = 0; week < 20; week++) {
      const tuesday = addDays(tue, 7 * week);
      const saturday = addDays(tuesday, 4);
      strength = strength.map((s) => s + normal(rand, 0, 0.4));
      const order = shuffle(rand, FOOTBALL_TEAMS.map((_, i) => i));
      for (let g = 0; g < 8; g++) {
        const h = order[2 * g];
        const a = order[2 * g + 1];
        const ht = FOOTBALL_TEAMS[h];
        const date = g < 2 ? tuesday : saturday;
        const local = g < 2 ? "20:15" : g < 5 ? "13:00" : "16:25";
        const start = toUtc(date, local, ht.tz);
        const id = `demo-ft-${date}-${ht.abbr}-${FOOTBALL_TEAMS[a].abbr}`;
        const mu = FT_HCA + strength[h] - strength[a];
        const muT = 2 * FT_BASE + offense[h] + offense[a];
        let hs = sampleTeamPoints(rand, (muT + mu) / 2);
        let as = sampleTeamPoints(rand, (muT - mu) / 2);
        let overtime = false;
        if (hs === as) {
          overtime = true;
          const u = rand();
          if (u < 0.95) {
            const d = u < 0.6 ? 3 : 6;
            if (rand() < sigmoid(mu / 7)) hs += d;
            else as += d;
          }
        }
        const finalAt = plusMin(start, overtime ? 215 : 195);
        repo.upsertEvent({
          id, dataset: DS, sport_key: FT, league: DEMO_SPORT_LEAGUES[FT], season, home_id: ids[h], away_id: ids[a], start_time: start,
          status: "final", status_at: finalAt, final_at: finalAt, home_score: hs, away_score: as, regulation_home: null, regulation_away: null,
          final_is_regulation: 0, neutral_site: 0, venue_name: `${ht.name} Stadium (fictional)`, venue_lat: null, venue_lon: null, venue_tz: ht.tz, indoor: ht.dome ? 1 : 0,
          rescheduled_from: null, game_number: 1, source: "demo", source_updated_at: finalAt, retrieved_at: finalAt, known_at: plusMin(start, -60 * 24 * 60),
          extra: { fictional: true, overtime, week: week + 1 },
        });
        sink.events++;
        const noise = normal(rand, 0, 1.2);
        const noiseT = normal(rand, 0, 2.5);
        const progress = (t: string) => Math.max(0, Math.min(1, 1 - (Date.parse(start) - Date.parse(t)) / (5 * 24 * 3600000)));
        const viewAt = (t: string) => mu + noise * (1 - 0.4 * progress(t));
        const viewT = (t: string) => muT + noiseT * (1 - 0.4 * progress(t));
        const snaps = demoSnapshotTimes(start, isDense(date) ? 3 * 24 * 60 : 75, null, isDense(date));
        const fair = (t: string) => {
          const d = footballDists(viewAt(t), viewT(t)).margin;
          let pw = 0;
          let pl = 0;
          for (const [m, p] of d) {
            if (m > 0) pw += p;
            else if (m < 0) pl += p;
          }
          return [pw / (pw + pl), pl / (pw + pl)]; // a tie voids a 2-way moneyline
        };
        sink.quotes.push(
          ...bookQuotes({ rand, eventId: id, contract: "moneyline_2way_full_game", outcomes: ["home", "away"], fairAt: fair, snapshots: snaps }),
          ...lineQuotes({
            rand, eventId: id, contract: "spread_full_game", snapshots: snaps, viewAt, noisePoints: 0.2,
            lineFor: (v) => roundHalf(-v), // football books hang whole numbers too (−3, −7), which can push
            probs: (v, line) => lineSplit(footballDists(v, muT).margin, line),
          }),
          ...lineQuotes({
            rand, eventId: id, contract: "total_full_game", snapshots: snaps, viewAt: viewT, noisePoints: 0.3,
            lineFor: (v) => roundHalf(v),
            probs: (v, line) => lineSplit(footballDists(mu, v).total, -line),
          }),
        );
        if (season === "2026" && !ht.dome) {
          sink.weather.push({
            dataset: DS, event_id: id, forecast_for: start, temperature_c: Math.round(normal(rand, 22, 6)), precip_probability: Math.round(rand() * 60),
            wind_kph: Math.round(5 + rand() * 30), source: "Demo weather (fictional)", source_url: null, source_time: plusMin(start, -24 * 60 - 30), retrieved_at: plusMin(start, -24 * 60),
          });
        }
      }
    }
  }
}

// =====================================================================================
// Tennis
// =====================================================================================
const TN = "demo_tennis";
const TN_FIRST = ["Alba", "Bruno", "Celia", "Dane", "Esme", "Florin", "Greta", "Henrik", "Ines", "Joaquin", "Katya", "Lior", "Maren", "Nils", "Odile", "Pavel", "Quinn", "Rosa", "Stellan", "Tamsin"];
const TN_LAST = ["Aldana", "Brekke", "Castro", "Dufresne", "Ekwueme", "Falk", "Gerritsen", "Halloran", "Ivanova", "Jaramillo", "Kask", "Lemaire", "Mbeki", "Novak", "Orsini", "Paltrow", "Quiroga", "Rasmussen", "Szabo", "Thorne", "Urquhart", "Vidal"];
const TOURNAMENT_CITIES = [
  { name: "Port Aster", tz: "Australia/Sydney" },
  { name: "Valmorra", tz: "Europe/Madrid" },
  { name: "Kestrel Bay", tz: "America/New_York" },
  { name: "Norhaven", tz: "Europe/London" },
  { name: "Solenne", tz: "Europe/Paris" },
  { name: "Gilded Coast", tz: "America/Los_Angeles" },
  { name: "Ravensholm", tz: "Europe/Berlin" },
  { name: "Lotus Harbour", tz: "Asia/Tokyo" },
];
type Surface = "hard" | "clay" | "grass";
const surfaceOn = (date: string): Surface => {
  const md = date.slice(5);
  if (md >= "04-01" && md < "06-08") return "clay";
  if (md >= "06-08" && md < "07-13") return "grass";
  return "hard";
};
/** The four "majors" are best of five sets. */
const MAJOR_WEEKS = ["01-20", "05-26", "06-30", "08-25"];

function tennis(repo: Repo, sink: Sink): void {
  const rand = mulberry32(20260616 + 303);
  const N = 40;
  const used = new Set<string>();
  const players = Array.from({ length: N }, (_, i) => {
    let name = "";
    do name = `${TN_FIRST[Math.floor(rand() * TN_FIRST.length)]} ${TN_LAST[Math.floor(rand() * TN_LAST.length)]}`;
    while (used.has(name));
    used.add(name);
    return { id: `demo-tn:p${String(i + 1).padStart(2, "0")}`, name };
  });
  players.forEach((p) => {
    const last = p.name.split(" ").slice(-1)[0];
    repo.upsertParticipant({ id: p.id, dataset: DS, sport_key: TN, name: p.name, short_name: last, abbreviation: last.slice(0, 3).toUpperCase(), aliases: [], meta: { fictional: true, player: true } });
  });
  let skill = players.map(() => normal(rand, 0, 0.6));
  const surf: Record<Surface, number[]> = { hard: players.map(() => normal(rand, 0, 0.22)), clay: players.map(() => normal(rand, 0, 0.3)), grass: players.map(() => normal(rand, 0, 0.3)) };

  for (const season of ["2024", "2025", "2026"]) {
    skill = skill.map((s) => 0.85 * s + normal(rand, 0, 0.25));
    let monday = `${season}-01-08`;
    while (weekday(monday) !== 1) monday = addDays(monday, 1);
    let week = 0;
    while (monday <= `${season}-11-10`) {
      const surface = surfaceOn(addDays(monday, 2));
      const major = MAJOR_WEEKS.some((w) => {
        const d = `${season}-${w}`;
        return d >= monday && d < addDays(monday, 7);
      });
      const bestOf = major ? 5 : 3;
      const city = TOURNAMENT_CITIES[week % TOURNAMENT_CITIES.length];
      const tournament = `${city.name} ${major ? "Major" : "Open"}`;
      skill = skill.map((s) => s + normal(rand, 0, 0.03));
      // 16-player draw: entrants weighted towards stronger players.
      const ranked = players.map((_, i) => i).sort((x, y) => skill[y] + normal(rand, 0, 0.6) - (skill[x] + normal(rand, 0, 0.6)));
      let alive = shuffle(rand, ranked.slice(0, 16));
      const drawAnnounced = toUtc(addDays(monday, -2), "12:00", city.tz);
      const finalAtOf = new Map<number, string>();
      const rounds: { name: string; dayOffsets: number[] }[] = [
        { name: "R16", dayOffsets: [0, 1] },
        { name: "QF", dayOffsets: [3] },
        { name: "SF", dayOffsets: [5] },
        { name: "F", dayOffsets: [6] },
      ];
      for (const round of rounds) {
        const next: number[] = [];
        const nMatches = alive.length / 2;
        for (let m = 0; m < nMatches; m++) {
          const p1 = alive[2 * m];
          const p2 = alive[2 * m + 1];
          const dayOffset = round.dayOffsets[Math.min(round.dayOffsets.length - 1, Math.floor((m * round.dayOffsets.length) / nMatches))];
          const date = addDays(monday, dayOffset);
          const slot = ["11:00", "13:00", "15:00", "17:00", "19:00"][m % 5];
          const start = toUtc(date, round.name === "F" ? "15:00" : slot, city.tz);
          // Home/away are only labels in tennis: the alphabetically first name is listed first.
          const [h, a] = players[p1].name.localeCompare(players[p2].name) <= 0 ? [p1, p2] : [p2, p1];
          const L = 1.0 * (skill[h] + surf[surface][h] - skill[a] - surf[surface][a]) * (bestOf === 5 ? 1.3 : 1);
          const homeWins = rand() < sigmoid(L);
          const winner = homeWins ? h : a;
          next.push(winner);
          const need = bestOf === 5 ? 3 : 2;
          const loserSets = Math.min(need - 1, Math.floor(rand() * need));
          const hs = homeWins ? need : loserSets;
          const as = homeWins ? loserSets : need;
          const duration = (hs + as) * 45 + Math.floor(rand() * 30);
          const finalAt = plusMin(start, duration);
          // A match is known once both players have won their previous match (or when the draw is published).
          const prev = [finalAtOf.get(p1), finalAtOf.get(p2)].filter((x): x is string => !!x).sort();
          const knownAt = round.name === "R16" ? drawAnnounced : prev[prev.length - 1] ?? drawAnnounced;
          finalAtOf.set(winner, finalAt);
          const id = `demo-tn-${date}-w${week + 1}-${round.name}-${m + 1}`;
          repo.upsertEvent({
            id, dataset: DS, sport_key: TN, league: DEMO_SPORT_LEAGUES[TN], season, home_id: players[h].id, away_id: players[a].id, start_time: start,
            status: "final", status_at: finalAt, final_at: finalAt, home_score: hs, away_score: as, regulation_home: null, regulation_away: null,
            final_is_regulation: 0, neutral_site: 1, venue_name: `${tournament} (fictional), ${surface} court`, venue_lat: null, venue_lon: null, venue_tz: city.tz, indoor: 0,
            rescheduled_from: null, game_number: 1, source: "demo", source_updated_at: finalAt, retrieved_at: finalAt, known_at: knownAt,
            extra: { fictional: true, surface, bestOf, tournament, round: round.name, scoreUnit: "sets" },
          });
          sink.events++;
          const noise = normal(rand, 0, 0.18);
          const openBefore = Math.max(60, Math.min(26 * 60, Math.floor((Date.parse(start) - Date.parse(knownAt)) / 60000) - 15));
          const snaps = demoSnapshotTimes(start, isDense(date) ? openBefore : Math.min(openBefore, 75), null, isDense(date));
          const fairAt = (t: string) => {
            const progress = Math.max(0, Math.min(1, 1 - (Date.parse(start) - Date.parse(t)) / (26 * 3600000)));
            const p = sigmoid(L + noise * (1 - 0.35 * progress));
            return [p, 1 - p];
          };
          sink.quotes.push(...bookQuotes({ rand, eventId: id, contract: "moneyline_2way_full_game", outcomes: ["home", "away"], fairAt, snapshots: snaps }));
          if (season === "2026") {
            sink.weather.push({
              dataset: DS, event_id: id, forecast_for: start, temperature_c: Math.round(normal(rand, 23, 5)), precip_probability: Math.round(rand() * 40),
              wind_kph: Math.round(3 + rand() * 25), source: "Demo weather (fictional)", source_url: null, source_time: plusMin(start, -12 * 60 - 30), retrieved_at: plusMin(start, -12 * 60),
            });
          }
        }
        alive = next;
      }
      monday = addDays(monday, 7);
      week++;
    }
  }
}

/** Generate the basketball, football and tennis leagues. Quotes and weather are returned for bulk insertion. */
export function generateDemoSports(repo: Repo): Sink {
  const sink: Sink = { quotes: [], weather: [], events: 0 };
  basketball(repo, sink);
  football(repo, sink);
  tennis(repo, sink);
  return sink;
}

export const _test = { footballDists, teamPointsPmf, surfaceOn };
