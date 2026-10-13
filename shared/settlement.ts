import type { ContractKey, OutcomeKey } from "./contracts";

export type EventStatus =
  | "scheduled"
  | "in_progress"
  | "final"
  | "postponed"
  | "cancelled"
  | "suspended"
  | "unknown";

export interface EventResult {
  status: EventStatus;
  homeScore: number | null;
  awayScore: number | null;
  /** Regulation-time scores when the provider reports them separately. */
  regulationHome?: number | null;
  regulationAway?: number | null;
  /** True when the final score is known to be the regulation score (e.g. league soccer with no extra time). */
  finalIsRegulation?: boolean;
}

export type Settlement = "win" | "loss" | "push" | "void" | "pending" | "unsupported";

export interface SettlementResult {
  settlement: Settlement;
  reason: string;
}

/**
 * Explicit settlement rules. Anything that cannot be decided from official data stays
 * "pending" (not yet final) or "unsupported" (missing information), never guessed.
 */
export function settle(
  contract: ContractKey,
  outcome: OutcomeKey,
  line: number | null,
  r: EventResult,
): SettlementResult {
  if (r.status === "postponed") return { settlement: "void", reason: "Event postponed: treated as void, points returned." };
  if (r.status === "cancelled") return { settlement: "void", reason: "Event cancelled: treated as void, points returned." };
  if (r.status !== "final") {
    return { settlement: "pending", reason: r.status === "suspended" ? "Suspended: waits for the official completion." : "No official final result yet." };
  }
  if (r.homeScore == null || r.awayScore == null) {
    return { settlement: "unsupported", reason: "Final status reported without a score." };
  }
  const h = r.homeScore;
  const a = r.awayScore;
  switch (contract) {
    case "moneyline_2way_full_game": {
      if (outcome !== "home" && outcome !== "away") return { settlement: "unsupported", reason: "Invalid outcome for a 2-way moneyline." };
      if (h === a) return { settlement: "void", reason: "Official tie in a 2-way market: treated as void." };
      const homeWon = h > a;
      return { settlement: (outcome === "home") === homeWon ? "win" : "loss", reason: `Final ${h}-${a} (home-away).` };
    }
    case "moneyline_3way_regulation": {
      let rh: number | null | undefined = r.regulationHome;
      let ra: number | null | undefined = r.regulationAway;
      if ((rh == null || ra == null) && r.finalIsRegulation) {
        rh = h;
        ra = a;
      }
      if (rh == null || ra == null) {
        return { settlement: "unsupported", reason: "Regulation-time score not available; a 3-way market cannot be settled on a score that may include extra time." };
      }
      const actual: OutcomeKey = rh > ra ? "home" : rh < ra ? "away" : "draw";
      if (outcome !== "home" && outcome !== "away" && outcome !== "draw") return { settlement: "unsupported", reason: "Invalid outcome for a 3-way market." };
      return { settlement: outcome === actual ? "win" : "loss", reason: `Regulation result ${rh}-${ra} (${actual}).` };
    }
    case "spread_full_game": {
      if (line == null) return { settlement: "unsupported", reason: "Spread without a line." };
      if (outcome !== "home" && outcome !== "away") return { settlement: "unsupported", reason: "Invalid outcome for a spread." };
      // The contract line is always stored from the HOME team's perspective
      // (home -1.5 means the away side is +1.5 on the same contract).
      const homeMargin = h + line - a;
      if (Math.abs(homeMargin) < 1e-9) return { settlement: "push", reason: `Landed exactly on the line (${h}-${a}).` };
      const homeCovers = homeMargin > 0;
      return { settlement: (outcome === "home") === homeCovers ? "win" : "loss", reason: `Final ${h}-${a}, home line ${line}.` };
    }
    case "total_full_game": {
      if (line == null) return { settlement: "unsupported", reason: "Total without a line." };
      const total = h + a;
      if (Math.abs(total - line) < 1e-9) return { settlement: "push", reason: `Total ${total} landed on the line.` };
      if (outcome === "over") return { settlement: total > line ? "win" : "loss", reason: `Total ${total} vs ${line}.` };
      if (outcome === "under") return { settlement: total < line ? "win" : "loss", reason: `Total ${total} vs ${line}.` };
      return { settlement: "unsupported", reason: "Invalid outcome for a total." };
    }
  }
}

/** Realised outcome of the event for probability scoring (null when not scoreable). */
export function realisedOutcome(contract: ContractKey, r: EventResult): OutcomeKey | null {
  if (contract === "moneyline_2way_full_game") {
    const s = settle(contract, "home", null, r);
    if (s.settlement === "win") return "home";
    if (s.settlement === "loss") return "away";
    return null;
  }
  if (contract === "moneyline_3way_regulation") {
    for (const o of ["home", "draw", "away"] as const) {
      if (settle(contract, o, null, r).settlement === "win") return o;
    }
    return null;
  }
  return null;
}
