// Market contracts. Two quotes are comparable only when they describe the SAME contract:
// same event, same contract key, same line. Regulation-only, overtime-inclusive,
// draw-no-bet, handicap lines and different totals are different contracts.

export type ContractKey =
  | "moneyline_2way_full_game" // home/away, settles on the final result including extra innings / overtime
  | "moneyline_3way_regulation" // home/draw/away, settles on the regulation-time result
  | "spread_full_game" // home/away against a handicap line (home perspective), full game incl. overtime
  | "total_full_game"; // over/under a points line, full game incl. overtime

export type OutcomeKey = "home" | "away" | "draw" | "over" | "under";

export interface ContractSpec {
  key: ContractKey;
  label: string;
  short: string;
  outcomes: OutcomeKey[];
  hasLine: boolean;
  pushPossible: boolean;
  settlement: string;
  /** Whether the implemented statistical model can price this contract (spreads/totals: team sports with scores). */
  modelSupported: boolean;
}

export const CONTRACTS: Record<ContractKey, ContractSpec> = {
  moneyline_2way_full_game: {
    key: "moneyline_2way_full_game",
    label: "Moneyline (2-way, full game incl. extra time)",
    short: "Moneyline 2-way",
    outcomes: ["home", "away"],
    hasLine: false,
    pushPossible: false,
    settlement:
      "Settles on the official final result including extra innings or overtime. Postponed or cancelled games are void (points returned). An official tie is treated as void.",
    modelSupported: true,
  },
  moneyline_3way_regulation: {
    key: "moneyline_3way_regulation",
    label: "Match result (3-way, regulation time)",
    short: "3-way result",
    outcomes: ["home", "draw", "away"],
    hasLine: false,
    pushPossible: false,
    settlement:
      "Settles on the regulation-time result (soccer: 90 minutes plus stoppage time). Extra time and penalties do not count. The draw is a full outcome, not a refund.",
    modelSupported: false,
  },
  spread_full_game: {
    key: "spread_full_game",
    label: "Spread / handicap (full game)",
    short: "Spread",
    outcomes: ["home", "away"],
    hasLine: true,
    pushPossible: true,
    settlement:
      "Home score plus the home line versus away score. A tie on the line is a push (points returned). Different lines are different contracts.",
    modelSupported: true,
  },
  total_full_game: {
    key: "total_full_game",
    label: "Total points (full game)",
    short: "Total",
    outcomes: ["over", "under"],
    hasLine: true,
    pushPossible: true,
    settlement:
      "Combined score versus the line. Exactly on the line is a push. Different totals are different contracts.",
    modelSupported: true,
  },
};

export function isContractKey(x: unknown): x is ContractKey {
  return typeof x === "string" && x in CONTRACTS;
}

/** Identity used to decide whether two quotes are the same contract. */
export function contractId(key: ContractKey, line: number | null | undefined): string {
  const spec = CONTRACTS[key];
  if (spec.hasLine) {
    if (line == null || !Number.isFinite(line)) throw new RangeError(`${spec.short} requires a line`);
    return `${key}@${Number(line).toFixed(1)}`;
  }
  return key;
}

export function sameContract(
  a: { contract: ContractKey; line?: number | null },
  b: { contract: ContractKey; line?: number | null },
): boolean {
  if (a.contract !== b.contract) return false;
  if (!CONTRACTS[a.contract].hasLine) return true;
  return a.line != null && b.line != null && Math.abs(a.line - b.line) < 1e-9;
}

/** Sport families used for contract mapping and model support. */
export type SportFamily = "baseball" | "soccer" | "basketball" | "american_football" | "ice_hockey" | "tennis" | "other";

export function sportFamily(sportKey: string): SportFamily {
  if (sportKey.startsWith("baseball") || sportKey === "demo_baseball") return "baseball";
  if (sportKey.startsWith("soccer") || sportKey === "demo_soccer") return "soccer";
  if (sportKey.startsWith("basketball") || sportKey === "demo_basketball") return "basketball";
  if (sportKey.startsWith("americanfootball") || sportKey === "demo_football") return "american_football";
  if (sportKey.startsWith("icehockey")) return "ice_hockey";
  if (sportKey.startsWith("tennis") || sportKey === "demo_tennis") return "tennis";
  return "other";
}

/** The headline contract for a sport: 3-way regulation result for soccer, 2-way moneyline otherwise. */
export function primaryContract(sportKey: string): ContractKey {
  return sportFamily(sportKey) === "soccer" ? "moneyline_3way_regulation" : "moneyline_2way_full_game";
}

/** Sports with an independent statistical model (2-way moneyline plus, for team sports, spreads and totals). */
export function modelSupportedSport(sportKey: string): boolean {
  const f = sportFamily(sportKey);
  return f === "baseball" || f === "basketball" || f === "american_football" || f === "tennis";
}

/**
 * The key a model and its participants live under. Odds providers list each tennis tournament
 * as its own sport (tennis_atp_wimbledon, ...); players and ratings are shared across a tour.
 */
export function modelKeyFor(sportKey: string): string {
  if (sportKey.startsWith("tennis_atp")) return "tennis_atp";
  if (sportKey.startsWith("tennis_wta")) return "tennis_wta";
  return sportKey;
}

/**
 * Season label for a game. Leagues whose season crosses New Year (NBA, NFL, NHL, European
 * soccer) use the starting year, so a January NFL playoff game belongs to the previous season.
 */
export function seasonOf(sportKey: string, startIso: string): string {
  const year = Number(startIso.slice(0, 4));
  const month = Number(startIso.slice(5, 7));
  if (sportKey.startsWith("demo_")) return String(year); // fictional leagues run within a calendar year
  const fam = sportFamily(sportKey);
  // Basketball (NBA, college, EuroLeague), American football (NFL, college bowls in January), ice hockey and
  // most European soccer run autumn to spring. Summer leagues (WNBA, CFL, MLS, Brazil, Japan...) do not.
  const crossesNewYear =
    (fam === "basketball" && !sportKey.includes("wnba")) ||
    (fam === "american_football" && !sportKey.includes("cfl") && !sportKey.includes("ufl")) ||
    fam === "ice_hockey" ||
    (fam === "soccer" && !/usa_mls|brazil|japan|china|korea|sweden|norway|finland|argentina|chile|league_of_ireland/.test(sportKey));
  if (!crossesNewYear) return String(year);
  // NFL seasons start in September (playoffs to February); NBA/NHL/soccer start Aug-Oct.
  return String(month >= 8 ? year : year - 1);
}

export type Surface = "hard" | "clay" | "grass";

/** Surface inferred from a tournament key/name when the provider does not state it (null = unknown). */
export function tennisSurfaceFromName(name: string): Surface | null {
  const n = name.toLowerCase();
  if (/(french|roland|monte.?carlo|madrid|rome|italian|barcelona|hamburg|buenos|rio|estoril|munich|geneva|lyon|bastad|gstaad|umag|kitzbuhel|clay)/.test(n)) return "clay";
  if (/(wimbledon|queens|queen_s|halle|eastbourne|s.?hertogenbosch|mallorca|stuttgart_grass|grass)/.test(n)) return "grass";
  if (/(australian|aus_open|us_open|indian_wells|miami|cincinnati|canada|toronto|montreal|shanghai|paris_masters|atp_finals|wta_finals|dubai|doha|beijing|tokyo|hard)/.test(n)) return "hard";
  return null;
}

/** Men's Grand Slam singles are best of five sets. */
export function tennisBestOfFromKey(sportKey: string): 3 | 5 {
  return /tennis_atp_(aus_open|australian_open|french_open|wimbledon|us_open)/.test(sportKey) ? 5 : 3;
}

/**
 * Map a provider market key (The Odds API naming) to an internal contract.
 * Returns null for markets we deliberately do not support (lay markets, props, periods, outrights).
 */
export function contractFromOddsApiMarket(sportKey: string, marketKey: string): ContractKey | null {
  const fam = sportFamily(sportKey);
  switch (marketKey) {
    case "h2h":
      // The Odds API documents h2h for soccer as including the draw (1X2, regulation time).
      return fam === "soccer" ? "moneyline_3way_regulation" : "moneyline_2way_full_game";
    case "h2h_3_way":
      return "moneyline_3way_regulation";
    // Tennis handicaps and totals are in games, but results are stored in sets: not supported.
    case "spreads":
      return fam === "tennis" ? null : "spread_full_game";
    case "totals":
      return fam === "tennis" ? null : "total_full_game";
    default:
      return null;
  }
}

/** Is the sport's weather relevant to the game (outdoor sports)? */
export function weatherRelevant(sportKey: string): boolean {
  const fam = sportFamily(sportKey);
  return fam === "baseball" || fam === "soccer" || fam === "american_football" || fam === "tennis";
}
