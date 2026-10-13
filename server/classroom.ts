// Saved forecasts (immutable), classroom sessions, points-only experiments and scoring.

import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import { json } from "./db";
import type { Dataset, EventRecord, Repo } from "./repo";
import { eventAsOf } from "./repo";
import type { GameAnalysis } from "./analysis";
import { CONTRACTS, type ContractKey, type OutcomeKey } from "../shared/contracts";
import { realisedOutcome, settle, type EventResult, type Settlement } from "../shared/settlement";
import { brier, brierMulti, logLoss, logLossMulti, mean } from "../shared/evaluation";
import { settledNetPoints } from "../shared/odds";

export interface ForecastRow {
  id: string;
  dataset: Dataset;
  session_id: string | null;
  kind: "system" | "student" | "abstention";
  author: string;
  event_id: string;
  contract: ContractKey;
  line: number | null;
  outcome_probs: string | null;
  pick: string | null;
  model_version: string | null;
  info_as_of: string;
  created_at: string;
  event_start_snapshot: string;
  quoted_price: number | null;
  quoted_book: string | null;
  quote_retrieved_at: string | null;
  input_snapshot: string;
  abstain_reason: string | null;
  run_id: string | null;
}

export class ClassroomError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const RESCHEDULE_HOURS = 12;

/** A forecast is a replay forecast when its game had already started by the real (dataset) clock. */
export function isReplayForecast(eventStart: string, clock: string): boolean {
  return Date.parse(eventStart) <= Date.parse(clock);
}

export function snapshotOf(a: GameAnalysis) {
  return {
    event: { id: a.event.id, home: a.event.home_name, away: a.event.away_name, start: a.event.start_time, league: a.event.league, sport: a.event.sport_key },
    asOf: a.asOf,
    contract: a.contract,
    model: { available: a.model.available, version: a.model.version, probs: a.model.probs, interval80: a.model.interval80, reason: a.model.reason },
    market: a.market.reference ? { probs: a.market.reference.probs, nBooks: a.market.reference.nBooks, method: a.market.reference.method } : null,
    combined: a.combined.available ? a.combined.probs : null,
    bestPrice: a.market.bestPrice,
    books: a.market.books.map((b) => ({ book: b.book_title, status: b.status, outcomes: Object.fromEntries(Object.entries(b.outcomes).map(([o, q]) => [o, { decimal: q!.decimal, source_time: q!.source_time, retrieved_at: q!.retrieved_at }])) })),
    completeness: a.completeness.items.map((i) => ({ key: i.key, status: i.status })),
    verdict: a.overallVerdict,
    sources: a.sources.map((s) => ({ id: s.id, title: s.title, url: s.url, time: s.time })),
  };
}

export class Classroom {
  constructor(
    private db: Db,
    private repo: Repo,
  ) {}

  // ---------------- sessions ----------------
  ensureDefaultSession(dataset: Dataset, at: string): string {
    const s = this.db.get<{ id: string }>("SELECT id FROM sessions WHERE dataset = ? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1", [dataset]);
    if (s) return s.id;
    return this.createSession(dataset, dataset === "demo" ? "Demo classroom" : "Live classroom", at);
  }

  createSession(dataset: Dataset, name: string, at: string): string {
    const id = randomUUID();
    this.db.run("INSERT INTO sessions(id, dataset, name, created_at, results_hidden) VALUES (?, ?, ?, ?, 0)", [id, dataset, cleanText(name, 80) || "Session", at]);
    return id;
  }

  /** Start a new session; the old one is archived (its forecasts are kept, never deleted). */
  restartSession(dataset: Dataset, name: string, at: string): string {
    this.db.run("UPDATE sessions SET archived_at = ? WHERE dataset = ? AND archived_at IS NULL", [at, dataset]);
    return this.createSession(dataset, name, at);
  }

  sessions(dataset: Dataset) {
    return this.db.all(
      `SELECT s.*, (SELECT COUNT(*) FROM forecasts f WHERE f.session_id = s.id) AS forecast_count
       FROM sessions s WHERE dataset = ? ORDER BY created_at DESC LIMIT 50`,
      [dataset],
    );
  }

  session(id: string) {
    return this.db.get<{ id: string; dataset: Dataset; name: string; results_hidden: number; archived_at: string | null; created_at: string }>("SELECT * FROM sessions WHERE id = ?", [id]) ?? null;
  }

  setResultsHidden(id: string, hidden: boolean): void {
    if (!this.session(id)) throw new ClassroomError("Unknown session", 404);
    this.db.run("UPDATE sessions SET results_hidden = ? WHERE id = ?", [hidden ? 1 : 0, id]);
  }

  // ---------------- forecasts ----------------
  saveStudentForecast(input: {
    dataset: Dataset;
    sessionId: string;
    author: string;
    analysis: GameAnalysis;
    probs: Partial<Record<OutcomeKey, number>>;
    createdAt: string;
    /** The dataset's real clock (demo clock or wall clock), as opposed to the analysis information time. */
    clock: string;
    notes?: string;
  }): ForecastRow {
    const a = input.analysis;
    const sess = this.session(input.sessionId);
    if (!sess || sess.dataset !== input.dataset) throw new ClassroomError("Unknown session for this dataset", 404);
    if (sess.archived_at) throw new ClassroomError("This session is archived; start or select an active session.", 409);
    const author = cleanText(input.author, 40);
    if (!author) throw new ClassroomError("Enter a name or nickname for the forecast.");
    if (a.status.started) throw new ClassroomError("Forecasts must be made before the scheduled start (as of the current information time).", 409);
    if (a.status.voided) throw new ClassroomError("This game is postponed or cancelled.", 409);
    const spec = CONTRACTS[a.contract];
    const probs: Partial<Record<OutcomeKey, number>> = {};
    for (const o of spec.outcomes) {
      const p = input.probs[o];
      if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) throw new ClassroomError(`Probability for ${o} must be between 0 and 1.`);
      probs[o] = p;
    }
    const total = spec.outcomes.reduce((s, o) => s + probs[o]!, 0);
    if (Math.abs(total - 1) > 0.001) throw new ClassroomError(`Probabilities must add up to 100% (they add up to ${(total * 100).toFixed(1)}%).`);
    const pick = spec.outcomes.reduce((x, y) => (probs[y]! > probs[x]! ? y : x));
    return this.insert({
      dataset: input.dataset,
      session_id: input.sessionId,
      kind: "student",
      author,
      event_id: a.event.id,
      contract: a.contract,
      line: null,
      outcome_probs: JSON.stringify(probs),
      pick,
      model_version: a.model.version,
      info_as_of: a.asOf,
      created_at: input.createdAt,
      event_start_snapshot: a.event.start_time,
      quoted_price: a.market.bestPrice[pick]?.decimal ?? null,
      quoted_book: a.market.bestPrice[pick]?.book_title ?? null,
      quote_retrieved_at: a.market.bestPrice[pick]?.source_time ?? null,
      // A replay forecast is made on a game that has already started by the real clock. It is kept and
      // scored, but separately, because the outcome could have been looked up.
      input_snapshot: JSON.stringify({ ...snapshotOf(a), notes: cleanText(input.notes ?? "", 500), replay: isReplayForecast(a.event.start_time, input.clock) }),
      abstain_reason: null,
      run_id: null,
    });
  }

  /** Record the system's estimate (or an abstention) for every eligible game in an Analyze Today run. */
  recordSystemSnapshot(dataset: Dataset, analyses: GameAnalysis[], createdAt: string, runId: string): { recorded: number; abstentions: number; skipped: number } {
    let recorded = 0;
    let abstentions = 0;
    let skipped = 0;
    this.db.tx(() => {
      for (const a of analyses) {
        if (a.status.started || a.status.voided) {
          skipped++;
          continue;
        }
        // At most one system record per game per hour of information time.
        const recent = this.db.get(
          "SELECT 1 FROM forecasts WHERE event_id = ? AND kind IN ('system','abstention') AND dataset = ? AND ABS(julianday(info_as_of) - julianday(?)) < (1.0/24)",
          [a.event.id, dataset, a.asOf],
        );
        if (recent) {
          skipped++;
          continue;
        }
        const est = a.primary.probs;
        const abstain = !est;
        const pick = a.primary.mostLikely;
        this.insert({
          dataset,
          session_id: null,
          kind: abstain ? "abstention" : "system",
          author: "system",
          event_id: a.event.id,
          contract: a.contract,
          line: null,
          outcome_probs: abstain ? null : JSON.stringify({ model: a.model.probs, market: a.market.reference?.probs ?? null, combined: a.combined.probs, primary: a.primary.source }),
          pick: pick ?? null,
          model_version: a.model.version,
          info_as_of: a.asOf,
          created_at: createdAt,
          event_start_snapshot: a.event.start_time,
          quoted_price: pick ? a.market.bestPrice[pick]?.decimal ?? null : null,
          quoted_book: pick ? a.market.bestPrice[pick]?.book_title ?? null : null,
          quote_retrieved_at: pick ? a.market.bestPrice[pick]?.source_time ?? null : null,
          input_snapshot: JSON.stringify(snapshotOf(a)),
          abstain_reason: abstain ? "No independent model and no current market reference." : null,
          run_id: runId,
        });
        if (abstain) abstentions++;
        else recorded++;
      }
    });
    return { recorded, abstentions, skipped };
  }

  private insert(f: Omit<ForecastRow, "id">): ForecastRow {
    const row: ForecastRow = { id: randomUUID(), ...f };
    this.db.run(
      `INSERT INTO forecasts(id, dataset, session_id, kind, author, event_id, contract, line, outcome_probs, pick, model_version, info_as_of, created_at,
         event_start_snapshot, quoted_price, quoted_book, quote_retrieved_at, input_snapshot, abstain_reason, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.dataset, row.session_id, row.kind, row.author, row.event_id, row.contract, row.line, row.outcome_probs, row.pick, row.model_version, row.info_as_of, row.created_at, row.event_start_snapshot, row.quoted_price, row.quoted_book, row.quote_retrieved_at, row.input_snapshot, row.abstain_reason, row.run_id],
    );
    return row;
  }

  forecast(id: string): ForecastRow | null {
    return this.db.get<ForecastRow>("SELECT * FROM forecasts WHERE id = ?", [id]) ?? null;
  }

  // ---------------- settlement ----------------
  /** Settle a forecast's pick using results known at `resultsAsOf`. Rescheduled games (start moved > 12h) are void. */
  settlementFor(f: ForecastRow, resultsAsOf: string, outcome?: OutcomeKey): { settlement: Settlement; reason: string; event: EventRecord | null; realised: OutcomeKey | null } {
    const raw = this.repo.event(f.event_id);
    if (!raw) return { settlement: "unsupported", reason: "Event no longer exists in the database.", event: null, realised: null };
    const e = eventAsOf(raw, resultsAsOf);
    const extra = json<{ resumed?: boolean }>(raw.extra, {});
    const moved = Math.abs(Date.parse(raw.start_time) - Date.parse(f.event_start_snapshot)) > RESCHEDULE_HOURS * 3600000;
    if (moved && !extra.resumed) return { settlement: "void", reason: "Game was rescheduled to a different date: treated as void.", event: e, realised: null };
    const r: EventResult = {
      status: e.status,
      homeScore: e.home_score,
      awayScore: e.away_score,
      regulationHome: e.regulation_home,
      regulationAway: e.regulation_away,
      finalIsRegulation: !!e.final_is_regulation,
    };
    const realised = realisedOutcome(f.contract, r);
    const o = outcome ?? (f.pick as OutcomeKey | null);
    if (!o) return { settlement: r.status === "final" ? "unsupported" : "pending", reason: "No pick recorded.", event: e, realised };
    const s = settle(f.contract, o, f.line, r);
    return { ...s, event: e, realised };
  }

  /** Forecasts for a session with results (unless hidden). */
  sessionForecasts(sessionId: string, resultsAsOf: string, revealResults: boolean) {
    const rows = this.db.all<ForecastRow>("SELECT * FROM forecasts WHERE session_id = ? ORDER BY created_at DESC LIMIT 1000", [sessionId]);
    return rows.map((f) => {
      const snap = json<any>(f.input_snapshot, {});
      const st = revealResults ? this.settlementFor(f, resultsAsOf) : null;
      const probs = json<Partial<Record<OutcomeKey, number>>>(f.outcome_probs, {});
      let scores: { brier: number; logLoss: number; modelBrier: number | null; marketBrier: number | null } | null = null;
      if (st?.realised) {
        scores = scoreProbs(f.contract, probs, st.realised, snap.model?.probs ?? null, snap.market?.probs ?? null);
      }
      return {
        id: f.id,
        author: f.author,
        kind: f.kind,
        event_id: f.event_id,
        game: `${snap.event?.away ?? "?"} at ${snap.event?.home ?? "?"}`,
        start: f.event_start_snapshot,
        contract: f.contract,
        probs,
        pick: f.pick,
        info_as_of: f.info_as_of,
        created_at: f.created_at,
        model_version: f.model_version,
        model_probs: snap.model?.probs ?? null,
        market_probs: snap.market?.probs ?? null,
        quoted_price: f.quoted_price,
        quoted_book: f.quoted_book,
        result: st ? { settlement: st.settlement, reason: st.reason, realised: st.realised, score: st.event?.status === "final" ? `${st.event.home_score}-${st.event.away_score}` : null } : null,
        scores,
        replay: !!snap.replay,
      };
    });
  }

  // ---------------- experiments ----------------
  createExperiment(dataset: Dataset, sessionId: string, name: string, author: string, at: string): string {
    const sess = this.session(sessionId);
    if (!sess || sess.dataset !== dataset) throw new ClassroomError("Unknown session", 404);
    const a = cleanText(author, 40);
    if (!a) throw new ClassroomError("Enter a name or nickname.");
    const id = randomUUID();
    this.db.run("INSERT INTO experiments(id, dataset, session_id, name, author, created_at, starting_points) VALUES (?, ?, ?, ?, ?, ?, 100)", [id, dataset, sessionId, cleanText(name, 80) || "Experiment", a, at]);
    return id;
  }

  experiments(sessionId: string) {
    return this.db.all("SELECT * FROM experiments WHERE session_id = ? ORDER BY created_at DESC", [sessionId]);
  }

  /** Throws unless simulation points may be placed on this forecast (used before saving, too). */
  checkEntryAllowed(experimentId: string, author: string, eventStart: string, clock: string): void {
    const exp = this.db.get<{ id: string; author: string }>("SELECT id, author FROM experiments WHERE id = ?", [experimentId]);
    if (!exp) throw new ClassroomError("Unknown experiment", 404);
    if (exp.author !== cleanText(author, 40)) throw new ClassroomError("Points can only be added to your own experiment (the forecast author must match the experiment author).", 403);
    if (isReplayForecast(eventStart, clock)) throw new ClassroomError("Points experiments only accept forecasts made before the game starts by the real clock (not replays of finished games).", 409);
  }

  addEntry(experimentId: string, forecastId: string, outcome: OutcomeKey, stake: number, at: string, clock: string): string {
    const exp = this.db.get<{ id: string; session_id: string; author: string }>("SELECT * FROM experiments WHERE id = ?", [experimentId]);
    if (!exp) throw new ClassroomError("Unknown experiment", 404);
    const f = this.forecast(forecastId);
    if (!f || f.session_id !== exp.session_id) throw new ClassroomError("The forecast must belong to the same session.", 400);
    const ev = this.repo.event(f.event_id);
    this.checkEntryAllowed(experimentId, f.author, ev?.start_time ?? f.event_start_snapshot, clock);
    if (json<any>(f.input_snapshot, {}).replay) throw new ClassroomError("Replay forecasts cannot be used in points experiments.", 409);
    if (!Number.isFinite(stake) || stake <= 0 || stake > 10) throw new ClassroomError("Stake must be between 0 and 10 simulation points.");
    if (!CONTRACTS[f.contract].outcomes.includes(outcome)) throw new ClassroomError("Invalid outcome for this contract.");
    const snap = json<any>(f.input_snapshot, {});
    const bp = snap.bestPrice?.[outcome];
    if (!bp?.decimal) throw new ClassroomError("No current quoted price was available for that outcome when the forecast was saved.", 409);
    const dup = this.db.get("SELECT 1 FROM experiment_entries WHERE experiment_id = ? AND forecast_id = ?", [experimentId, forecastId]);
    if (dup) throw new ClassroomError("This forecast already has an entry in the experiment.", 409);
    const id = randomUUID();
    this.db.run("INSERT INTO experiment_entries(id, experiment_id, forecast_id, outcome, stake, price_decimal, book, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      id, experimentId, forecastId, outcome, stake, bp.decimal, bp.book_title ?? "", at,
    ]);
    return id;
  }

  experimentReport(experimentId: string, resultsAsOf: string, reveal: boolean) {
    const exp = this.db.get<{ id: string; name: string; author: string; starting_points: number; created_at: string; session_id: string }>("SELECT * FROM experiments WHERE id = ?", [experimentId]);
    if (!exp) throw new ClassroomError("Unknown experiment", 404);
    const entries = this.db.all<{ id: string; forecast_id: string; outcome: OutcomeKey; stake: number; price_decimal: number; book: string; created_at: string }>(
      "SELECT * FROM experiment_entries WHERE experiment_id = ? ORDER BY created_at",
      [experimentId],
    );
    let net = 0;
    let settled = 0;
    const rows = entries.map((en) => {
      const f = this.forecast(en.forecast_id)!;
      const snap = json<any>(f.input_snapshot, {});
      const st = reveal ? this.settlementFor(f, resultsAsOf, en.outcome) : null;
      let points: number | null = null;
      if (st && ["win", "loss", "push", "void"].includes(st.settlement)) {
        points = settledNetPoints(st.settlement as "win" | "loss" | "push" | "void", en.stake, en.price_decimal);
        net += points;
        settled++;
      }
      return { ...en, game: `${snap.event?.away ?? "?"} at ${snap.event?.home ?? "?"}`, start: f.event_start_snapshot, probs: json(f.outcome_probs, {}), settlement: st?.settlement ?? null, reason: st?.reason ?? null, points };
    });
    return {
      experiment: exp,
      entries: rows,
      summary: {
        entries: entries.length,
        settled,
        netPoints: reveal ? net : null,
        balance: reveal ? exp.starting_points + net : null,
        note: "Simulation points only. A handful of results says almost nothing about forecast quality: variance dominates small samples. Judge forecasts with the Brier score and calibration instead.",
      },
    };
  }

  /** Per-author scoreboard (Brier / log loss) plus model and market on the same games. */
  scoreboard(sessionId: string, resultsAsOf: string) {
    const list = this.sessionForecasts(sessionId, resultsAsOf, true).filter((f) => f.kind === "student");
    // Live and replay forecasts are scored separately: replay outcomes could have been looked up.
    const by = new Map<string, typeof list>();
    for (const f of list) {
      const k = `${f.replay ? "1" : "0"}|${f.author}`;
      by.set(k, [...(by.get(k) ?? []), f]);
    }
    return [...by.entries()].map(([key, fs]) => {
      const author = key.slice(2);
      const replay = key.startsWith("1|");
      const scored = fs.filter((f) => f.scores);
      const modelScored = scored.filter((f) => f.scores!.modelBrier != null);
      const marketScored = scored.filter((f) => f.scores!.marketBrier != null);
      return {
        author,
        replay,
        forecasts: fs.length,
        scored: scored.length,
        brier: scored.length ? mean(scored.map((f) => f.scores!.brier)) : null,
        logLoss: scored.length ? mean(scored.map((f) => f.scores!.logLoss)) : null,
        modelBrierSameGames: modelScored.length ? mean(modelScored.map((f) => f.scores!.modelBrier!)) : null,
        marketBrierSameGames: marketScored.length ? mean(marketScored.map((f) => f.scores!.marketBrier!)) : null,
        modelGames: modelScored.length,
        marketGames: marketScored.length,
      };
    });
  }

  csvForecasts(dataset: Dataset, sessionId: string | null, resultsAsOf: string, reveal: boolean): string {
    const rows = sessionId
      ? this.db.all<ForecastRow>("SELECT * FROM forecasts WHERE session_id = ? ORDER BY created_at", [sessionId])
      : this.db.all<ForecastRow>("SELECT * FROM forecasts WHERE dataset = ? ORDER BY created_at", [dataset]);
    const header = ["forecast_id", "kind", "author", "event_id", "game", "event_start", "contract", "probabilities", "pick", "model_version", "info_as_of", "created_at", "quoted_price_decimal", "quoted_book", "quote_source_time", "settlement", "settlement_reason", "abstain_reason"];
    const lines = [header.join(",")];
    for (const f of rows) {
      const snap = json<any>(f.input_snapshot, {});
      const st = reveal ? this.settlementFor(f, resultsAsOf) : null;
      lines.push(
        [
          f.id, f.kind, f.author, f.event_id, `${snap.event?.away ?? ""} at ${snap.event?.home ?? ""}`, f.event_start_snapshot, f.contract, f.outcome_probs ?? "", f.pick ?? "",
          f.model_version ?? "", f.info_as_of, f.created_at, f.quoted_price ?? "", f.quoted_book ?? "", f.quote_retrieved_at ?? "", st?.settlement ?? (reveal ? "" : "hidden"), st?.reason ?? "", f.abstain_reason ?? "",
        ]
          .map(csvCell)
          .join(","),
      );
    }
    return lines.join("\r\n") + "\r\n";
  }
}

export function scoreProbs(
  contract: ContractKey,
  probs: Partial<Record<OutcomeKey, number>>,
  realised: OutcomeKey,
  modelProbs: Partial<Record<OutcomeKey, number>> | null,
  marketProbs: Partial<Record<OutcomeKey, number>> | null,
) {
  const outcomes = CONTRACTS[contract].outcomes;
  const idx = outcomes.indexOf(realised);
  const vec = (p: Partial<Record<OutcomeKey, number>>) => outcomes.map((o) => p[o] ?? 0);
  if (outcomes.length === 2) {
    const y: 0 | 1 = realised === outcomes[0] ? 1 : 0;
    const b = (p: Partial<Record<OutcomeKey, number>> | null) => (p && p[outcomes[0]] != null ? brier(p[outcomes[0]]!, y) : null);
    return { brier: b(probs)!, logLoss: logLoss(probs[outcomes[0]]!, y), modelBrier: b(modelProbs), marketBrier: b(marketProbs) };
  }
  return {
    brier: brierMulti(vec(probs), idx),
    logLoss: logLossMulti(vec(probs), idx),
    modelBrier: modelProbs ? brierMulti(vec(modelProbs), idx) : null,
    marketBrier: marketProbs ? brierMulti(vec(marketProbs), idx) : null,
  };
}

/** Strip control characters and trim; plain text only. */
export function cleanText(s: string, max: number): string {
  return String(s ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** CSV cell with formula-injection protection for spreadsheet apps. */
export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}
