// Thin API client. Every mutating request carries the client header the server requires
// (CSRF protection) and, when entered, the instructor PIN (kept only in session storage).

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: string[],
  ) {
    super(message);
  }
}

const PIN_KEY = "overround.instructorPin";

export function getPin(): string {
  try {
    return sessionStorage.getItem(PIN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setPin(pin: string): void {
  try {
    if (pin) sessionStorage.setItem(PIN_KEY, pin);
    else sessionStorage.removeItem(PIN_KEY);
  } catch {
    /* storage unavailable */
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") {
    headers["x-overround-client"] = "1";
    headers["Content-Type"] = "application/json";
    const pin = getPin();
    if (pin) headers["x-instructor-pin"] = pin;
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body) });
  } catch {
    throw new ApiError("Cannot reach the Overround Lab server. Is it still running? (Start it with npm start.)", 0);
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = data?.error ?? `Request failed (HTTP ${res.status})`;
    throw new ApiError(msg, res.status, data?.details);
  }
  return data as T;
}

export const api = {
  get: <T,>(url: string) => request<T>("GET", url),
  post: <T,>(url: string, body?: unknown) => request<T>("POST", url, body),
  put: <T,>(url: string, body?: unknown) => request<T>("PUT", url, body),
};

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

// ---------------- shared response types ----------------
export type Outcome = "home" | "away" | "draw" | "over" | "under";
export type Probs = Partial<Record<Outcome, number>>;
export type Dataset = "demo" | "live";
export type Mode = "demo" | "replay" | "live";

export interface CompletenessItem {
  key: string;
  label: string;
  status: "ok" | "partial" | "missing" | "stale" | "unknown" | "not_applicable";
  detail: string;
}

export interface BestPrice {
  decimal: number;
  american: number;
  book_title: string;
  book_key: string;
  source_time: string;
  retrieved_at: string;
  label: string;
}

export interface Discrepancy {
  diff: number;
  verdict: "research_lead" | "no_credible_difference" | "insufficient_evidence";
  reason: string;
}

export interface BoardItem {
  eventId: string;
  sport: string;
  league: string;
  start: string;
  status: string;
  started: boolean;
  voided: boolean;
  resultKnown: boolean;
  resultHidden?: boolean;
  score: string | null;
  home: string;
  away: string;
  homeAbbr: string | null;
  awayAbbr: string | null;
  contract: string;
  contractShort: string;
  outcomes: Outcome[];
  outcomeNames: Partial<Record<Outcome, string>>;
  primary: { source: "model" | "market" | "none"; probs: Probs | null; mostLikely: Outcome | null };
  market: { probs: Probs; nBooks: number; range: Partial<Record<Outcome, [number, number]>> } | null;
  marketUnavailable: string | null;
  model: { probs: Probs; interval80: Partial<Record<Outcome, [number, number]>>; version: string } | null;
  modelUnavailable: string | null;
  combined: Probs | null;
  discrepancy: Partial<Record<Outcome, Discrepancy>> | null;
  verdict: { verdict: Discrepancy["verdict"]; text: string };
  bestPrice: Partial<Record<Outcome, BestPrice>>;
  booksTotal: number;
  booksCurrent: number;
  newestQuote: string | null;
  completeness: { items: CompletenessItem[]; available: number; applicable: number };
  evidence: { injuries: number; conflicts: number; news: number; lineups: string; weather: string | null };
  uncertainty: string;
  asOf: string;
  fictional: boolean;
}

export interface Board {
  date: string;
  zone: string;
  window: { startUtc: string; endUtc: string; hours: number };
  asOf: string;
  mode: Mode;
  dataset: Dataset;
  coverage: { events: number; withCurrentMarket: number; withModel: number; voided: number; started: number; books: string[]; sports: string[]; researchLeads: number };
  notes: string[];
  items: BoardItem[];
}

export interface StepResult {
  step: string;
  provider: string;
  ok: boolean;
  skipped: boolean;
  detail: string;
}

export interface BookQuoteView {
  book_key: string;
  book_title: string;
  outcomes: Partial<Record<Outcome, { decimal: number; american: number; rawImplied: number; source_time: string; retrieved_at: string }>>;
  complete: boolean;
  comparable: boolean;
  fresh: boolean;
  status: "current" | "stale" | "incomplete" | "after_start" | "mismatched_times";
  newestSource: string | null;
  lastConfirmed: string | null;
  ageMinutes: number | null;
  overround: number | null;
  noVig: Probs | null;
}

export interface MarketView {
  contract: string;
  contractId: string;
  line: number | null;
  label: string;
  outcomes: Outcome[];
  books: BookQuoteView[];
  reference: { probs: Probs; nBooks: number; range: Partial<Record<Outcome, [number, number]>>; method: string } | null;
  referenceUnavailableReason: string | null;
  bestPrice: Partial<Record<Outcome, BestPrice>>;
}

export interface SourceRef {
  id: string;
  kind: string;
  title: string;
  url: string | null;
  source: string;
  time: string | null;
  tier: string;
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

export interface Analysis {
  event: {
    id: string;
    sport_key: string;
    league: string;
    season: string | null;
    start_time: string;
    status: string;
    home_score: number | null;
    away_score: number | null;
    home_name: string;
    away_name: string;
    home_abbr: string | null;
    away_abbr: string | null;
    venue_name: string | null;
    venue_tz: string | null;
    indoor: number;
    rescheduled_from: string | null;
    game_number: number;
    source: string;
    retrieved_at: string;
  };
  asOf: string;
  infoAsOf: string;
  mode: Mode;
  dataset: Dataset;
  fictional: boolean;
  resultHidden?: boolean;
  contract: string;
  market: MarketView;
  otherMarkets: MarketView[];
  model: {
    available: boolean;
    reason: string | null;
    version: string | null;
    probs: Probs | null;
    interval80: Partial<Record<Outcome, [number, number]>> | null;
    prediction: ModelPrediction | null;
    restDiff: number | null;
    trainedThrough: string | null;
    validation: any;
    notes: string[];
  };
  combined: { available: boolean; probs: Probs | null; label: string; reason: string | null; weights: { model: number; market: number } | null };
  primary: BoardItem["primary"];
  discrepancy: BoardItem["discrepancy"];
  overallVerdict: BoardItem["verdict"];
  expectedPoints: Partial<Record<Outcome, { atPrice: number; book: string; ev: number; breakEven: number }>> | null;
  completeness: BoardItem["completeness"];
  evidence: {
    injuries: { player_name: string; team_name: string; status: string; detail: string | null; source: string; source_url: string | null; confirmation: string; source_time: string | null; retrieved_at: string }[];
    lineups: { team_name: string; status: string; starter: string | null; starter_status: string | null; source: string; source_url: string | null; source_time: string | null; retrieved_at: string; playersParsed: { name: string; position?: string }[] }[];
    news: { id: number; title: string; url: string; source_name: string; source_tier: string; claim_type: string; published_at: string | null; retrieved_at: string; duplicateCount: number; isDuplicate: boolean }[];
    weather: { temperature_c: number | null; precip_probability: number | null; wind_kph: number | null; source: string; source_url: string | null; retrieved_at: string; forecast_for: string; relevant: boolean } | null;
    weatherRelevant: boolean;
    conflicts: { player: string; statements: { title: string; url: string; source: string; tier: string; claim: string; published_at: string | null; stance: string }[]; injuryStatuses: { status: string; source: string }[] }[];
  };
  sources: SourceRef[];
  uncertainty: string;
  explanation: { estimate: string; facts: string[]; assumptions: string[]; missing: string[]; changes: string[] };
  status: { started: boolean; resultKnown: boolean; voided: boolean };
}

export interface Status {
  version: string;
  dataset: Dataset;
  clock: string;
  realNow: string;
  demoClock: string;
  demoStart: string;
  timezone: string;
  resultsHidden: boolean;
  instructorPinConfigured: boolean;
  host: string;
  scheduler: SchedulerSummary;
  providers: { id: string; name: string; enabled: boolean; health: string }[];
  ai: { configured: boolean; enabled: boolean; usedToday: number; cap: number; model: string };
  liveEvents: number;
}

export interface SchedulerSummary {
  paused: boolean;
  processStartedAt: string;
  timezone: string;
  note: string;
  jobs: { name: string; label: string; last_run_at: string | null; last_success_at: string | null; last_result: string | null; next_run_at: string | null; running: boolean; intervalMinutes: number | null }[];
}
