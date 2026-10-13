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
  modelSupported: boolean; // whether the implemented statistical model can price this contract
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
    modelSupported: false,
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
    modelSupported: false,
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
export type SportFamily = "baseball" | "soccer" | "basketball" | "american_football" | "ice_hockey" | "other";

export function sportFamily(sportKey: string): SportFamily {
  if (sportKey.startsWith("baseball") || sportKey === "demo_baseball") return "baseball";
  if (sportKey.startsWith("soccer") || sportKey === "demo_soccer") return "soccer";
  if (sportKey.startsWith("basketball")) return "basketball";
  if (sportKey.startsWith("americanfootball")) return "american_football";
  if (sportKey.startsWith("icehockey")) return "ice_hockey";
  return "other";
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
    case "spreads":
      return "spread_full_game";
    case "totals":
      return "total_full_game";
    default:
      return null;
  }
}

/** Is the sport's weather relevant to the game (outdoor sports)? */
export function weatherRelevant(sportKey: string): boolean {
  const fam = sportFamily(sportKey);
  return fam === "baseball" || fam === "soccer" || fam === "american_football";
}
