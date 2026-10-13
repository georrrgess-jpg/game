// Deterministic generator for the clearly labelled, entirely FICTIONAL demo world.
// Two invented leagues (no real teams, players, books or news outlets):
//   - Continental Baseball Circuit: 2-way moneylines, with an independent model.
//   - Meridian Football League: 3-way (home/draw/away) results, market-reference only.
// "Books" price games from a noisy view of the simulated truth that reacts to injury
// news, so the demo can honestly show a market that is hard to beat.

import { DateTime } from "luxon";
import type { Repo, QuoteRecord, InjuryRecord, LineupRecord, NewsRecord, WeatherRecord, Dataset } from "./repo";
import { americanToDecimal, decimalToAmerican, sigmoid } from "../shared/odds";
import { contractId } from "../shared/contracts";
import { hashString, mulberry32, normal, poisson } from "../shared/rng";
import { dedupeKey } from "./news";

export const DEMO_VERSION = "demo-world-6";
export const DEMO_SEED = 20260616;
const DS: Dataset = "demo";
const BB = "demo_baseball";
const FB = "demo_soccer";
export const DEMO_BASEBALL_LEAGUE = "Continental Baseball Circuit (fictional)";
export const DEMO_SOCCER_LEAGUE = "Meridian Football League (fictional)";
export const DEMO_NEWS_HOST = "https://demo.overround.invalid";

const BASEBALL_TEAMS = [
  { abbr: "HBV", city: "Harborview", nick: "Gulls", tz: "America/New_York", indoor: false },
  { abbr: "RMC", city: "Red Mesa", nick: "Coyotes", tz: "America/Denver", indoor: false },
  { abbr: "PHL", city: "Pine Hollow", nick: "Lumberjacks", tz: "America/Chicago", indoor: false },
  { abbr: "SLH", city: "Silver Lake", nick: "Herons", tz: "America/Chicago", indoor: false },
  { abbr: "GFM", city: "Granite Falls", nick: "Miners", tz: "America/Denver", indoor: true },
  { abbr: "CBP", city: "Cedar Bay", nick: "Pelicans", tz: "America/New_York", indoor: false },
  { abbr: "IRF", city: "Ironton", nick: "Foundry", tz: "America/New_York", indoor: false },
  { abbr: "WBC", city: "Westbrook", nick: "Comets", tz: "America/Los_Angeles", indoor: false },
  { abbr: "MGH", city: "Marigold", nick: "Hornets", tz: "America/Chicago", indoor: false },
  { abbr: "NFO", city: "Northfield", nick: "Owls", tz: "America/New_York", indoor: false },
  { abbr: "SPF", city: "Sunport", nick: "Flamingos", tz: "America/Los_Angeles", indoor: false },
  { abbr: "KPF", city: "Kestrel Point", nick: "Falcons", tz: "America/Los_Angeles", indoor: false },
];

const SOCCER_CLUBS = [
  { abbr: "ASH", name: "Ashford Rovers" },
  { abbr: "BRW", name: "Brightwater Athletic" },
  { abbr: "CAL", name: "Calder Town" },
  { abbr: "DUN", name: "Dunmore United" },
  { abbr: "EGC", name: "Eastgate City" },
  { abbr: "FEN", name: "Fenwick Wanderers" },
  { abbr: "GLN", name: "Glenmoor FC" },
  { abbr: "HOL", name: "Holloway Albion" },
  { abbr: "IVY", name: "Ivybridge Rangers" },
  { abbr: "JUN", name: "Juniper Vale" },
];

export const DEMO_BOOKS = [
  { key: "demo_northgate", title: "Northgate (demo book)", margin: 0.038, noise: 0.05, skip: 0.03, lag: 0 },
  { key: "demo_lakeshore", title: "Lakeshore (demo book)", margin: 0.045, noise: 0.06, skip: 0.05, lag: 0 },
  { key: "demo_summit", title: "Summit (demo book)", margin: 0.052, noise: 0.07, skip: 0.06, lag: 0 },
  { key: "demo_bayview", title: "Bayview (demo book)", margin: 0.065, noise: 0.08, skip: 0.08, lag: 0.35 },
];

const FIRST = ["Marco", "Eli", "Tomas", "Jalen", "Ruben", "Owen", "Dario", "Kofi", "Luis", "Mateo", "Noah", "Ivan", "Samir", "Theo", "Hugo", "Felix", "Andre", "Kenji", "Rafael", "Milo", "Caleb", "Jonah", "Emil", "Pablo", "Victor", "Arlo", "Dmitri", "Nico", "Silas", "Bram"];
const LAST = ["Reyes", "Okafor", "Lindqvist", "Marsh", "Delacroix", "Hart", "Navarro", "Achterberg", "Quill", "Brandt", "Castellano", "Ferro", "Gallo", "Ibarra", "Jansen", "Kowal", "Laurent", "Moreau", "Nakamura", "Oduya", "Petrov", "Rocha", "Sorensen", "Tavares", "Ueda", "Valdez", "Whitlock", "Yilmaz", "Zane", "Abernathy", "Birch", "Corwin"];
const POSITIONS = ["C", "1B", "2B", "SS", "3B", "LF", "CF", "RF", "DH"];
const BODY = ["hamstring strain", "oblique strain", "wrist soreness", "ankle sprain", "shoulder inflammation", "back tightness"];

type Rand = () => number;

function toUtc(localDate: string, time: string, zone: string): string {
  return DateTime.fromISO(`${localDate}T${time}`, { zone }).toUTC().toISO({ suppressMilliseconds: true })!;
}
const plusMin = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
const days = (from: string, to: string) => {
  const out: string[] = [];
  let d = DateTime.fromISO(from, { zone: "UTC" });
  const end = DateTime.fromISO(to, { zone: "UTC" });
  while (d <= end) {
    out.push(d.toISODate()!);
    d = d.plus({ days: 1 });
  }
  return out;
};
const weekday = (date: string) => DateTime.fromISO(date, { zone: "UTC" }).weekday; // 1 = Monday

function toAmericanRounded(p: number): number {
  // Price p (already including margin) as American odds rounded to the nearest 5.
  const d = 1 / Math.min(0.97, Math.max(0.03, p));
  let a = decimalToAmerican(d);
  a = Math.round(a / 5) * 5;
  if (a > -100 && a < 100) a = a >= 0 ? 100 : -100;
  return a;
}

/** Simulated retrieval schedule: fixed daily polls (UTC) plus two pre-game polls, from the opening line to the start. */
const POLL_TIMES_UTC = ["00:30", "02:30", "04:30", "10:30", "12:30", "14:30", "16:30", "18:30", "20:30", "22:30"];
/** Dense polling (every ~2 hours while people are awake) for the current season; three snapshots for past seasons. */
export function demoSnapshotTimes(start: string, openMinutesBefore: number, cutoff: string | null, dense = true): string[] {
  const open = plusMin(start, -openMinutesBefore);
  const out = new Set<string>([open, plusMin(start, -75), plusMin(start, -20)]);
  if (!dense) return [...out].filter((t) => !cutoff || t < cutoff).sort();
  let day = DateTime.fromISO(open, { zone: "utc" }).startOf("day");
  const end = DateTime.fromISO(start, { zone: "utc" });
  while (day <= end) {
    for (const hm of POLL_TIMES_UTC) {
      const t = DateTime.fromISO(`${day.toISODate()}T${hm}:00`, { zone: "utc" }).toISO({ suppressMilliseconds: true })!;
      if (t > open && t < plusMin(start, -20)) out.add(t);
    }
    day = day.plus({ days: 1 });
  }
  return [...out].filter((t) => !cutoff || t < cutoff).sort();
}

interface BookSnapshotInput {
  rand: Rand;
  eventId: string;
  contract: "moneyline_2way_full_game" | "moneyline_3way_regulation";
  outcomes: ("home" | "away" | "draw")[];
  fairAt: (t: string) => number[]; // market's fair view at time t
  snapshots: string[];
}

function bookQuotes(inp: BookSnapshotInput): QuoteRecord[] {
  const out: QuoteRecord[] = [];
  for (const book of DEMO_BOOKS) {
    if (inp.rand() < book.skip) continue; // this book does not offer the market for this game
    const bookBias = normal(inp.rand, 0, book.noise);
    let lastSource: string | null = null;
    let lastFair: number[] | null = null;
    let dropped = false;
    inp.snapshots.forEach((t, idx) => {
      // A lagging book sometimes drops out of the feed: its last quote is never re-confirmed and goes stale.
      if (!dropped && idx >= 2 && idx < inp.snapshots.length - 1 && inp.rand() < book.lag / 3) dropped = true;
      if (dropped) return;
      const fair = inp.fairAt(t);
      // Books often leave a price unchanged between polls: keep the source time when nothing moved.
      const unchanged = lastFair !== null && Math.abs(fair[0] - lastFair[0]) < 0.004;
      lastFair = fair;
      let probs: number[];
      if (fair.length === 2) {
        const pH = sigmoid(Math.log(fair[0] / fair[1]) + bookBias + normal(inp.rand, 0, 0.02));
        probs = [pH, 1 - pH];
      } else {
        const tilt = Math.exp(bookBias);
        const raw = [fair[0] * tilt, fair[1], fair[2] / tilt];
        const s = raw.reduce((a, b) => a + b, 0);
        probs = raw.map((x) => x / s);
      }
      const sourceTime = unchanged && lastSource ? lastSource : plusMin(t, -Math.floor(inp.rand() * 4));
      lastSource = sourceTime;
      inp.outcomes.forEach((o, i) => {
        const american = toAmericanRounded(probs[i] * (1 + book.margin));
        out.push({
          dataset: DS,
          event_id: inp.eventId,
          provider: "demo",
          book_key: book.key,
          book_title: book.title,
          contract: inp.contract,
          contract_id: contractId(inp.contract, null),
          provider_market: inp.contract === "moneyline_3way_regulation" ? "h2h (3-way)" : "h2h",
          line: null,
          outcome: o,
          price_decimal: americanToDecimal(american),
          source_time: sourceTime,
          retrieved_at: t,
          known_at: t,
        });
      });
    });
  }
  return out;
}

interface InjurySpell {
  teamIdx: number;
  player: string;
  playerId: string;
  start: string; // local date
  end: string; // local date (returns)
  part: string;
  value: number;
}

export function generateDemoWorld(repo: Repo): { events: number; quotes: number } {
  const rand = mulberry32(DEMO_SEED);
  let quoteCount = 0;
  let eventCount = 0;
  const db = repo.db;

  db.tx(() => {
    // ---------- participants & players ----------
    const bbIds = BASEBALL_TEAMS.map((t) => `demo-bb:${t.abbr}`);
    BASEBALL_TEAMS.forEach((t, i) => {
      repo.upsertParticipant({
        id: bbIds[i],
        dataset: DS,
        sport_key: BB,
        name: `${t.city} ${t.nick}`,
        short_name: t.nick,
        abbreviation: t.abbr,
        aliases: [t.city, `${t.city} ${t.nick} (fictional)`],
        meta: { fictional: true, tz: t.tz, indoor: t.indoor },
      });
    });
    const fbIds = SOCCER_CLUBS.map((c) => `demo-fb:${c.abbr}`);
    SOCCER_CLUBS.forEach((c, i) =>
      repo.upsertParticipant({ id: fbIds[i], dataset: DS, sport_key: FB, name: c.name, short_name: c.name.split(" ")[0], abbreviation: c.abbr, aliases: [], meta: { fictional: true } }),
    );

    const rosters: { batters: { id: string; name: string; pos: string }[]; pitchers: { id: string; name: string; q: number }[]; star: number; starValue: number }[] = [];
    const usedNames = new Set<string>();
    const nameFor = (r: Rand) => {
      for (;;) {
        const n = `${FIRST[Math.floor(r() * FIRST.length)]} ${LAST[Math.floor(r() * LAST.length)]}`;
        if (!usedNames.has(n)) {
          usedNames.add(n);
          return n;
        }
      }
    };
    BASEBALL_TEAMS.forEach((t, ti) => {
      const batters = POSITIONS.map((pos, j) => ({ id: `demo-p:${t.abbr}:b${j}`, name: nameFor(rand), pos }));
      const pitchers = Array.from({ length: 5 }, (_, j) => ({ id: `demo-p:${t.abbr}:sp${j}`, name: nameFor(rand), q: normal(rand, 0, 0.16) }));
      rosters.push({ batters, pitchers, star: 2 + (ti % 5), starValue: 0.14 + rand() * 0.14 });
      for (const b of batters) db.run("INSERT OR REPLACE INTO players(id, dataset, participant_id, name, position, role) VALUES (?, ?, ?, ?, ?, ?)", [b.id, DS, bbIds[ti], b.name, b.pos, "batter"]);
      for (const p of pitchers) db.run("INSERT OR REPLACE INTO players(id, dataset, participant_id, name, position, role) VALUES (?, ?, ?, ?, ?, ?)", [p.id, DS, bbIds[ti], p.name, "SP", "starting pitcher"]);
    });

    // ---------- baseball seasons ----------
    let strength = BASEBALL_TEAMS.map(() => normal(rand, 0, 0.42));
    let scriptedPpd: { home: number; away: number } | null = null;
    const HOME_ADV = 0.16;
    const allQuotes: QuoteRecord[] = [];
    const injuries: InjuryRecord[] = [];
    const lineups: LineupRecord[] = [];
    const news: NewsRecord[] = [];
    const weather: WeatherRecord[] = [];

    for (const season of ["2024", "2025", "2026"]) {
      strength = strength.map((s) => 0.8 * s + normal(rand, 0, 0.16));
      const rot = BASEBALL_TEAMS.map(() => Math.floor(rand() * 5));
      const seasonDays = days(`${season}-04-02`, `${season}-09-27`).filter((d) => weekday(d) !== 1); // Mondays off
      const spells: InjurySpell[] = [];
      const injuredOn = (ti: number, date: string) => spells.find((s) => s.teamIdx === ti && date >= s.start && date < s.end);
      const makeups: { home: number; away: number; fromId: string; announced: string }[] = [];
      let pairing: number[] = [];
      let gameNo = 0;
      const lateSeasonCancel = `${season}-09-1${season === "2026" ? 5 : 8}`;

      seasonDays.forEach((date, di) => {
        // Daily drift and injury process.
        strength = strength.map((s) => s + normal(rand, 0, 0.006));
        BASEBALL_TEAMS.forEach((t, ti) => {
          const forced = season === "2026" && date === "2026-06-14" && ti === 0; // ensure a current injury on the demo day
          if (!injuredOn(ti, date) && (forced || rand() < 0.011)) {
            const len = forced ? 12 : 6 + Math.floor(rand() * 15);
            const star = rosters[ti].batters[rosters[ti].star];
            spells.push({
              teamIdx: ti,
              player: star.name,
              playerId: star.id,
              start: date,
              end: DateTime.fromISO(date).plus({ days: len }).toISODate()!,
              part: BODY[Math.floor(rand() * BODY.length)],
              value: rosters[ti].starValue,
            });
          }
        });
        if (di % 3 === 0) {
          pairing = BASEBALL_TEAMS.map((_, i) => i);
          for (let i = pairing.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [pairing[i], pairing[j]] = [pairing[j], pairing[i]];
          }
          for (let p = 0; p < pairing.length; p += 2) if (rand() < 0.5) [pairing[p], pairing[p + 1]] = [pairing[p + 1], pairing[p]];
        }
        const dayGames: { home: number; away: number; gn: number; rescheduledFrom: string | null; announced: string | null }[] = [];
        for (let p = 0; p < pairing.length; p += 2) dayGames.push({ home: pairing[p], away: pairing[p + 1], gn: 1, rescheduledFrom: null, announced: null });
        // Make-ups become doubleheaders when the same pair plays today.
        for (let m = makeups.length - 1; m >= 0; m--) {
          const mk = makeups[m];
          if (dayGames.some((g) => g.home === mk.home && g.away === mk.away)) {
            dayGames.push({ home: mk.home, away: mk.away, gn: 2, rescheduledFrom: mk.fromId, announced: mk.announced });
            makeups.splice(m, 1);
          }
        }
        const isLastSeries = di >= seasonDays.length - 3;
        dayGames.forEach((g) => {
          const ht = BASEBALL_TEAMS[g.home];
          const at = BASEBALL_TEAMS[g.away];
          const wd = weekday(date);
          const seriesDay = di % 3;
          let localTime = wd === 7 ? "13:10" : wd === 6 ? "16:05" : seriesDay === 2 ? "13:05" : "19:05";
          if (ht.tz === "America/Los_Angeles" && wd !== 7 && seriesDay !== 2) localTime = "19:10";
          // Doubleheader: game 1 in the early afternoon, game 2 in the evening.
          const isDoubleheader = dayGames.some((x) => x.home === g.home && x.away === g.away && x.gn === 2);
          if (isDoubleheader) localTime = g.gn === 1 ? "13:05" : "18:10";
          const start = toUtc(date, localTime, ht.tz);
          const id = `demo-bb-${date}-${ht.abbr}-${at.abbr}-${g.gn}`;
          gameNo++;
          const ph = rosters[g.home].pitchers[rot[g.home] % 5];
          const pa = rosters[g.away].pitchers[rot[g.away] % 5];
          rot[g.home]++;
          rot[g.away]++;
          const injH = injuredOn(g.home, date);
          const injA = injuredOn(g.away, date);
          const trueLogit = HOME_ADV + strength[g.home] - strength[g.away] + ph.q - pa.q - (injH?.value ?? 0) + (injA?.value ?? 0);
          const pTrue = sigmoid(trueLogit);

          // Postponements (outdoor venues only); forced one on the demo day.
          const forcedPpd =
            season === "2026" && date === "2026-06-16" && g.gn === 1 &&
            g === dayGames.find((x) => x.gn === 1 && !BASEBALL_TEAMS[x.home].indoor && ![0, 9].includes(x.home) && ![0, 9].includes(x.away));
          if (forcedPpd) scriptedPpd = { home: g.home, away: g.away };
          const isCancelled = date === lateSeasonCancel && g.home === dayGames[0].home && g.gn === 1;
          const postponed = forcedPpd || (!ht.indoor && g.gn === 1 && rand() < 0.015) || isCancelled;
          const statusAt = postponed ? (forcedPpd ? "2026-06-16T14:00:00Z" : plusMin(start, -150)) : null;
          let status: "final" | "postponed" | "cancelled" = "final";
          let hs: number | null = null;
          let as: number | null = null;
          let extraInnings = false;
          if (postponed) {
            status = isCancelled || isLastSeries ? "cancelled" : "postponed";
            if (status === "postponed") makeups.push({ home: g.home, away: g.away, fromId: id, announced: statusAt! });
          } else {
            const homeWins = rand() < pTrue;
            const loser = poisson(rand, 3.1);
            const winner = loser + 1 + poisson(rand, 1.7);
            extraInnings = winner - loser === 1 && rand() < 0.22;
            hs = homeWins ? winner : loser;
            as = homeWins ? loser : winner;
          }
          const finalAt = status === "final" ? plusMin(start, extraInnings ? 215 : 185) : null;
          const knownAt = g.rescheduledFrom && g.announced ? g.announced : plusMin(start, -60 * 24 * 30);
          repo.upsertEvent({
            id,
            dataset: DS,
            sport_key: BB,
            league: DEMO_BASEBALL_LEAGUE,
            season,
            home_id: bbIds[g.home],
            away_id: bbIds[g.away],
            start_time: start,
            status,
            status_at: status === "final" ? finalAt : statusAt,
            final_at: finalAt,
            home_score: hs,
            away_score: as,
            regulation_home: null,
            regulation_away: null,
            final_is_regulation: 0,
            neutral_site: 0,
            venue_name: `${ht.city} Park (fictional)`,
            venue_lat: null,
            venue_lon: null,
            venue_tz: ht.tz,
            indoor: ht.indoor ? 1 : 0,
            rescheduled_from: g.rescheduledFrom,
            game_number: g.gn,
            source: "demo",
            source_updated_at: finalAt ?? statusAt ?? knownAt,
            retrieved_at: finalAt ?? statusAt ?? knownAt,
            known_at: knownAt,
            extra: { fictional: true, extraInnings, probableHome: ph.name, probableAway: pa.name },
          });
          eventCount++;

          // Market view: knows pitchers and injury news once announced (10:00 local on the first day).
          const knowsInjury = (sp: InjurySpell | undefined, t: string) => (sp ? t >= toUtc(sp.start, "10:00", BASEBALL_TEAMS[sp.teamIdx].tz) : false);
          const gameNoise = normal(rand, 0, 0.17);
          const fairAt = (t: string) => {
            const progress = Math.max(0, Math.min(1, 1 - (Date.parse(start) - Date.parse(t)) / (26 * 3600000)));
            const L =
              HOME_ADV + strength[g.home] - strength[g.away] + ph.q - pa.q -
              (knowsInjury(injH, t) ? injH!.value : 0) + (knowsInjury(injA, t) ? injA!.value : 0) +
              gameNoise * (1 - 0.35 * progress);
            const p = sigmoid(L);
            return [p, 1 - p];
          };
          const snaps = demoSnapshotTimes(start, 26 * 60, statusAt, season === "2026");
          const qs = bookQuotes({ rand, eventId: id, contract: "moneyline_2way_full_game", outcomes: ["home", "away"], fairAt, snapshots: snaps });
          allQuotes.push(...qs);

          if (season === "2026") {
            // Lineups: probable starters 48h out, confirmed lineups 3h before first pitch.
            for (const [ti, sp, inj] of [
              [g.home, ph, injH],
              [g.away, pa, injA],
            ] as const) {
              const team = BASEBALL_TEAMS[ti];
              lineups.push({
                dataset: DS, event_id: id, participant_id: bbIds[ti], status: "probable", starter: sp.name, starter_status: "probable",
                players: "[]", source: "League probable pitchers (demo)", source_url: `${DEMO_NEWS_HOST}/probables/${date}`,
                source_time: plusMin(start, -48 * 60), retrieved_at: plusMin(start, -48 * 60 + 5),
              });
              if (!postponed) {
                const bats = rosters[ti].batters.filter((b) => !(inj && b.id === inj.playerId)).map((b) => ({ name: b.name, position: b.pos }));
                lineups.push({
                  dataset: DS, event_id: id, participant_id: bbIds[ti], status: "confirmed", starter: sp.name, starter_status: "confirmed",
                  players: JSON.stringify(bats), source: `${team.city} ${team.nick} official lineup (demo)`, source_url: `${DEMO_NEWS_HOST}/lineups/${id}/${team.abbr}`,
                  source_time: plusMin(start, -180), retrieved_at: plusMin(start, -175),
                });
              }
            }
            if (!ht.indoor) {
              const precip = forcedPpd || postponed ? 85 + Math.floor(rand() * 10) : Math.max(0, Math.round(normal(rand, 15, 15)));
              for (const lead of [-24 * 60, -180]) {
                weather.push({
                  dataset: DS, event_id: id, forecast_for: start, temperature_c: Math.round(normal(rand, 24, 5)), precip_probability: Math.min(100, precip),
                  wind_kph: Math.round(5 + rand() * 25), source: "Demo weather (fictional)", source_url: null, source_time: plusMin(start, lead - 30), retrieved_at: plusMin(start, lead),
                });
              }
            }
          }
        });
      });

      if (season === "2026") {
        for (const sp of spells) {
          const team = BASEBALL_TEAMS[sp.teamIdx];
          const announce = toUtc(sp.start, "10:00", team.tz);
          const ret = toUtc(sp.end, "10:00", team.tz);
          const pid = bbIds[sp.teamIdx];
          injuries.push({
            dataset: DS, sport_key: BB, participant_id: pid, player_id: sp.playerId, player_name: sp.player, status: "injured_list",
            detail: `10-day injured list (${sp.part})`, source: "League transactions (demo)", source_url: `${DEMO_NEWS_HOST}/transactions/${sp.playerId}/${sp.start}`,
            confirmation: "official", source_time: announce, retrieved_at: plusMin(announce, 6),
          });
          injuries.push({
            dataset: DS, sport_key: BB, participant_id: pid, player_id: sp.playerId, player_name: sp.player, status: "active",
            detail: "Activated from the injured list", source: "League transactions (demo)", source_url: `${DEMO_NEWS_HOST}/transactions/${sp.playerId}/${sp.end}`,
            confirmation: "official", source_time: ret, retrieved_at: plusMin(ret, 6),
          });
          const t1 = `${team.city} ${team.nick} place ${sp.player} on 10-day injured list with ${sp.part}`;
          const t2 = `${team.nick}' ${sp.player} placed on 10-day injured list (${sp.part}), team says`;
          news.push(newsItem(BB, [pid], t1, "League Office (demo)", "official", "official", announce, `il-${sp.playerId}-${sp.start}`));
          news.push(newsItem(BB, [pid], t2, "Demo Sports Wire", "media", "report", plusMin(announce, 25), `wire-il-${sp.playerId}-${sp.start}`));
          news.push(newsItem(BB, [pid], `${team.city} ${team.nick} activate ${sp.player} from injured list`, "League Office (demo)", "official", "official", ret, `act-${sp.playerId}-${sp.end}`));
        }
        // Speculation that never materialised, for teaching source quality.
        for (let i = 0; i < 18; i++) {
          const ti = Math.floor(rand() * 12);
          const d = seasonDays[Math.floor(rand() * seasonDays.length)];
          const b = rosters[ti].batters[Math.floor(rand() * 9)];
          const team = BASEBALL_TEAMS[ti];
          news.push(newsItem(BB, [bbIds[ti]], `Rumor: ${b.name} could miss time after leaving practice early`, "Bleacher Chatter blog (demo)", "unverified", "speculation", toUtc(d, "09:15", team.tz), `rumor-${i}-${d}`));
        }
        // Scripted demo-day story: day-to-day status with conflicting reports.
        const ti = 9; // Northfield Owls
        const team = BASEBALL_TEAMS[ti];
        const player = rosters[ti].batters[4];
        const pid = bbIds[ti];
        injuries.push({
          dataset: DS, sport_key: BB, participant_id: pid, player_id: player.id, player_name: player.name, status: "day_to_day",
          detail: "Day-to-day (wrist soreness); not placed on the injured list", source: "Northfield Owls media notes (demo)", source_url: `${DEMO_NEWS_HOST}/owls/notes/2026-06-16`,
          confirmation: "official", source_time: "2026-06-16T13:05:00Z", retrieved_at: "2026-06-16T13:10:00Z",
        });
        news.push(newsItem(BB, [pid], `${player.name} expected to play tonight despite wrist soreness, manager says`, "Demo Sports Wire", "media", "report", "2026-06-16T13:40:00Z", "owls-dtd-wire"));
        news.push(newsItem(BB, [pid], `${player.name} ruled out tonight, sources say`, "Bleacher Chatter blog (demo)", "unverified", "speculation", "2026-06-16T14:20:00Z", "owls-dtd-blog"));
        const ppd = scriptedPpd as { home: number; away: number } | null; // assigned inside the day loop
        if (ppd) {
          const h = BASEBALL_TEAMS[ppd.home];
          const a = BASEBALL_TEAMS[ppd.away];
          news.push(newsItem(BB, [bbIds[ppd.home], bbIds[ppd.away]], `${a.nick} at ${h.nick} postponed because of rain; make-up date to be announced`, "League Office (demo)", "official", "official", "2026-06-16T14:05:00Z", "ppd-0616"));
        }
      }
    }

    // ---------- soccer seasons (3-way, no independent model) ----------
    let fbStrength = SOCCER_CLUBS.map(() => normal(rand, 0, 0.35));
    for (const season of ["2024", "2025", "2026"]) {
      fbStrength = fbStrength.map((s) => 0.65 * s + normal(rand, 0, 0.2));
      const slots = days(`${season}-03-07`, `${season}-11-28`).filter((d) => {
        const wd = weekday(d);
        const wk = Math.floor(DateTime.fromISO(d).ordinal / 7);
        return wd === 6 || (wd === 2 && wk % 2 === 0);
      });
      const n = SOCCER_CLUBS.length;
      const rounds: [number, number][][] = [];
      const order = Array.from({ length: n }, (_, i) => i);
      for (let cycle = 0; cycle < 4; cycle++) {
        const arr = [...order];
        for (let r = 0; r < n - 1; r++) {
          const pairs: [number, number][] = [];
          for (let i = 0; i < n / 2; i++) {
            const a = arr[i];
            const b = arr[n - 1 - i];
            pairs.push((r + cycle) % 2 === 0 ? [a, b] : [b, a]);
          }
          rounds.push(pairs);
          arr.splice(1, 0, arr.pop()!);
        }
      }
      rounds.slice(0, slots.length).forEach((pairs, ri) => {
        const date = slots[ri];
        const isTue = weekday(date) === 2;
        pairs.forEach(([h, a]) => {
          fbStrength = fbStrength.map((s) => s + normal(rand, 0, 0.004));
          const start = toUtc(date, isTue ? "19:45" : "15:00", "Europe/London");
          const id = `demo-fb-${date}-${SOCCER_CLUBS[h].abbr}-${SOCCER_CLUBS[a].abbr}`;
          const diff = fbStrength[h] - fbStrength[a];
          const lh = 1.38 * Math.exp(0.5 * diff + 0.12);
          const la = 1.12 * Math.exp(-0.5 * diff);
          const hs = poisson(rand, lh);
          const as = poisson(rand, la);
          const finalAt = plusMin(start, 115);
          repo.upsertEvent({
            id, dataset: DS, sport_key: FB, league: DEMO_SOCCER_LEAGUE, season, home_id: fbIds[h], away_id: fbIds[a], start_time: start,
            status: "final", status_at: finalAt, final_at: finalAt, home_score: hs, away_score: as, regulation_home: hs, regulation_away: as,
            final_is_regulation: 1, neutral_site: 0, venue_name: `${SOCCER_CLUBS[h].name} Ground (fictional)`, venue_lat: null, venue_lon: null,
            venue_tz: "Europe/London", indoor: 0, rescheduled_from: null, game_number: 1, source: "demo", source_updated_at: finalAt,
            retrieved_at: finalAt, known_at: plusMin(start, -60 * 24 * 60), extra: { fictional: true },
          });
          eventCount++;
          const noise = normal(rand, 0, 0.15);
          const fairAt = (_t: string) => poisson3way(1.38 * Math.exp(0.5 * (diff + noise) + 0.12), 1.12 * Math.exp(-0.5 * (diff + noise)));
          const snaps = demoSnapshotTimes(start, 48 * 60, null, season === "2026");
          allQuotes.push(...bookQuotes({ rand, eventId: id, contract: "moneyline_3way_regulation", outcomes: ["home", "draw", "away"], fairAt, snapshots: snaps }));
          if (season === "2026") {
            for (const ti of [h, a]) {
              lineups.push({
                dataset: DS, event_id: id, participant_id: fbIds[ti], status: "confirmed", starter: null, starter_status: null, players: "[]",
                source: `${SOCCER_CLUBS[ti].name} team sheet (demo)`, source_url: `${DEMO_NEWS_HOST}/teamsheets/${id}`, source_time: plusMin(start, -60), retrieved_at: plusMin(start, -58),
              });
            }
            weather.push({
              dataset: DS, event_id: id, forecast_for: start, temperature_c: Math.round(normal(rand, 17, 5)), precip_probability: Math.round(rand() * 70),
              wind_kph: Math.round(5 + rand() * 30), source: "Demo weather (fictional)", source_url: null, source_time: plusMin(start, -24 * 60 - 30), retrieved_at: plusMin(start, -24 * 60),
            });
          }
        });
      });
    }

    quoteCount = repo.insertQuotes(allQuotes, { skipDedupe: true });
    repo.insertInjuries(injuries);
    repo.insertLineups(lineups);
    // Mark duplicates (same story re-reported) deterministically.
    const sortedNews = news.sort((a, b) => (a.published_at ?? "").localeCompare(b.published_at ?? ""));
    repo.insertNews(sortedNews);
    repo.insertWeather(weather);
    db.run("INSERT INTO meta(key, value) VALUES ('demo_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [DEMO_VERSION]);
  });
  db.checkpoint();
  return { events: eventCount, quotes: quoteCount };
}

function newsItem(
  sport: string,
  teams: string[],
  title: string,
  source: string,
  tier: NewsRecord["source_tier"],
  claim: NewsRecord["claim_type"],
  published: string,
  slug: string,
): NewsRecord {
  return {
    dataset: DS,
    sport_key: sport,
    participant_ids: JSON.stringify(teams),
    title,
    summary: "Fictional demo item. No real people or events.",
    url: `${DEMO_NEWS_HOST}/news/${slug}-${hashString(title).toString(36)}`,
    source_name: source,
    source_tier: tier,
    claim_type: claim,
    published_at: published,
    retrieved_at: plusMin(published, 4),
    dedupe_key: dedupeKey(title),
    duplicate_of: null,
  };
}

/** Home/draw/away probabilities for independent Poisson goal counts. */
export function poisson3way(lh: number, la: number): number[] {
  const pmf = (l: number, k: number) => {
    let f = 1;
    for (let i = 2; i <= k; i++) f *= i;
    return (Math.exp(-l) * l ** k) / f;
  };
  let h = 0;
  let d = 0;
  let a = 0;
  for (let i = 0; i <= 12; i++)
    for (let j = 0; j <= 12; j++) {
      const p = pmf(lh, i) * pmf(la, j);
      if (i > j) h += p;
      else if (i === j) d += p;
      else a += p;
    }
  const s = h + d + a;
  return [h / s, d / s, a / s];
}

export function demoNeedsGeneration(repo: Repo): boolean {
  const v = repo.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'demo_version'");
  return v?.value !== DEMO_VERSION;
}

/** Remove regenerable demo data (forecasts and experiment entries are immutable and kept). */
export function clearDemoWorld(repo: Repo): void {
  const db = repo.db;
  db.tx(() => {
    for (const t of ["quotes", "injuries", "lineups", "news", "weather", "events", "participants", "participant_aliases", "players"]) {
      db.run(`DELETE FROM ${t} WHERE dataset = 'demo'`);
    }
  });
}
