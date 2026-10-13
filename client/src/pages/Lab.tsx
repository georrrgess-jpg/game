import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, getPin, qs, setPin, type Board, type BoardItem, type Outcome } from "../api";
import { useApi, useApp } from "../state";
import { fmtDateTime, fmtTime, formatDecimal, formatPct, formatPoints, localDate, outcomeLabel, atWord } from "../format";
import { Callout, Empty, ErrorBox, FictionalNote, Loading, Stat, Tabs } from "../components/ui";
import { IconDownload, IconEye, IconEyeOff } from "../components/icons";
import { mulberry32 } from "../../../shared/rng";
import { americanToDecimal, parseAmerican } from "../../../shared/odds";

type LabTab = "predict" | "results" | "notebook" | "learn" | "instructor";

interface SessionsResp {
  active: string;
  sessions: { id: string; name: string; created_at: string; archived_at: string | null; forecast_count: number }[];
  resultsHidden: boolean;
}

const STUDENT_KEY = "overround.student";

export default function LabPage() {
  const { dataset } = useApp();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<LabTab>(params.get("event") ? "predict" : "predict");
  const { data: sessions, error, reload } = useApi<SessionsResp>(`/api/sessions${qs({ dataset })}`);
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Classroom Lab</div>
          <h1>Forecast first, then look</h1>
          <p>
            Make probability forecasts before results are known, save them with immutable timestamps, and compare against the model and the market using proper scoring rules. Points are simulation points only.
          </p>
        </div>
        {sessions && (
          <div className="small text-2">
            Session: <strong>{sessions.sessions.find((s) => s.id === sessions.active)?.name}</strong>
            {sessions.resultsHidden && <span className="chip chip-warn" style={{ marginLeft: 8 }}>Results hidden by instructor</span>}
          </div>
        )}
      </div>
      <FictionalNote />
      {error && <ErrorBox error={error} onRetry={reload} />}
      <Tabs
        label="Lab sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "predict", label: "Make forecasts" },
          { id: "results", label: "Results & scoring" },
          { id: "notebook", label: "Points notebook" },
          { id: "learn", label: "Explainers" },
          { id: "instructor", label: "Instructor" },
        ]}
      />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {sessions && tab === "predict" && <PredictPanel sessionId={sessions.active} focusEvent={params.get("event")} />}
        {sessions && tab === "results" && <ResultsPanel sessionId={sessions.active} hidden={sessions.resultsHidden} />}
        {sessions && tab === "notebook" && <NotebookPanel sessionId={sessions.active} hidden={sessions.resultsHidden} />}
        {tab === "learn" && <ExplainersPanel />}
        {tab === "instructor" && <InstructorPanel sessions={sessions} reload={reload} />}
      </div>
    </div>
  );
}

function useStudentName(): [string, (s: string) => void] {
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(STUDENT_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const set = (s: string) => {
    setName(s);
    try {
      localStorage.setItem(STUDENT_KEY, s);
    } catch {
      /* ignore */
    }
  };
  return [name, set];
}

// ---------------- predict ----------------
function PredictPanel({ sessionId, focusEvent }: { sessionId: string; focusEvent: string | null }) {
  const { dataset, asOfParam, clock, zone, mode } = useApp();
  const [name, setName] = useStudentName();
  const [blind, setBlind] = useState(true);
  const [experimentId, setExperimentId] = useState("");
  const day = localDate(asOfParam ?? clock, zone);
  const { data: board, error, loading, reload } = useApi<Board>(`/api/board${qs({ dataset, asOf: asOfParam, date: day })}`);
  const { data: exps } = useApi<{ experiments: { id: string; name: string; author: string }[] }>(`/api/sessions/${sessionId}/experiments`);
  const open = board?.items.filter((i) => !i.started && !i.voided) ?? [];
  const closed = board?.items.filter((i) => i.started || i.voided) ?? [];
  const myExps = exps?.experiments.filter((e) => !name || e.author === name) ?? [];

  useEffect(() => {
    if (focusEvent) setTimeout(() => document.getElementById(`predict-${focusEvent}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 300);
  }, [focusEvent, board]);

  return (
    <div className="stack">
      <div className="card row" style={{ alignItems: "flex-end" }}>
        <label className="field" style={{ minWidth: 220 }}>
          Your name or nickname
          <input type="text" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Team Falcon" autoComplete="nickname" />
        </label>
        <label className="field">
          Points experiment (optional)
          <select value={experimentId} onChange={(e) => setExperimentId(e.target.value)}>
            <option value="">No points, just probabilities</option>
            {myExps.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} ({e.author})
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
          Hide model and market while I forecast (avoid anchoring)
        </label>
      </div>
      <Callout kind="info">
        Information time: <strong>{fmtDateTime(asOfParam ?? clock, zone)}</strong>
        {mode === "replay" ? " (historical replay; results stay hidden until you reveal them)." : "."} Forecasts are only accepted before a game starts, and each one stores the prices, model version and inputs available at that moment.
      </Callout>
      {loading && !board && <Loading />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {board && !open.length && (
        <Empty title="No games open for forecasting at this time">
          {closed.length ? "Every game today has started or been called off. " : ""}Use "Replay a past moment" in the top bar, or {dataset === "demo" ? "ask the instructor to advance the demo clock." : "wait for the next slate."}
        </Empty>
      )}
      <div className="stack-sm" style={{ gap: 12 }}>
        {open.map((i) => (
          <PredictCard key={i.eventId} item={i} sessionId={sessionId} author={name} blind={blind} experimentId={experimentId} focused={focusEvent === i.eventId} />
        ))}
      </div>
      {closed.length > 0 && <p className="subtle small">{closed.length} game(s) today have started or are void and are closed for forecasts.</p>}
    </div>
  );
}

function PredictCard({ item, sessionId, author, blind, experimentId, focused }: { item: BoardItem; sessionId: string; author: string; blind: boolean; experimentId: string; focused: boolean }) {
  const { dataset, asOfParam, zone, toast, bumpData } = useApp();
  const three = item.outcomes.includes("draw");
  const [home, setHome] = useState(50);
  const [draw, setDraw] = useState(26);
  const away = three ? 100 - home - draw : 100 - home;
  const [stakeOutcome, setStakeOutcome] = useState<Outcome>("home");
  const [stake, setStake] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = away >= 0 && home >= 0 && (!three || draw >= 0);
  const save = async () => {
    if (!author.trim()) return toast("Enter your name or nickname first.", "error");
    if (!valid) return toast("Probabilities must add up to 100%.", "error");
    setBusy(true);
    try {
      const probs: Partial<Record<Outcome, number>> = three ? { home: home / 100, draw: draw / 100, away: away / 100 } : { home: home / 100, away: away / 100 };
      const r = await api.post<{ forecast: { id: string; created_at: string; quoted_price: number | null } }>("/api/forecasts", {
        dataset,
        sessionId,
        eventId: item.eventId,
        asOf: asOfParam,
        author: author.trim(),
        probs,
        stake: experimentId && stake > 0 ? { experimentId, outcome: stakeOutcome, points: stake } : undefined,
      });
      setSaved(r.forecast.created_at);
      toast(`Forecast saved for ${item.away} at ${item.home}.`);
      bumpData();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <article id={`predict-${item.eventId}`} className="card" style={focused ? { borderColor: "var(--accent)" } : undefined} aria-labelledby={`p-${item.eventId}`}>
      <div className="row-between">
        <h2 id={`p-${item.eventId}`} style={{ margin: 0, fontSize: "1rem" }}>
          {item.away} {atWord(item.sport)} {item.home}
        </h2>
        <span className="subtle small">
          {fmtTime(item.start, zone, { weekday: "short", hour: "numeric", minute: "2-digit" })} · {item.contractShort}
        </span>
      </div>
      <div className="grid grid-2" style={{ marginTop: 10 }}>
        <div className="stack-sm">
          <label className="field">
            {item.home} wins: <span className="num">{home}%</span>
            <input type="range" min={1} max={three ? 97 - draw : 99} value={home} onChange={(e) => setHome(Number(e.target.value))} />
          </label>
          {three && (
            <label className="field">
              Draw: <span className="num">{draw}%</span>
              <input type="range" min={1} max={98 - home} value={draw} onChange={(e) => setDraw(Number(e.target.value))} />
            </label>
          )}
          <div className="small text-2">
            {item.away} wins: <span className="num">{away}%</span>
          </div>
          {experimentId && (
            <div className="row">
              <label className="field">
                Simulation points on
                <select value={stakeOutcome} onChange={(e) => setStakeOutcome(e.target.value as Outcome)}>
                  {item.outcomes.map((o) => (
                    <option key={o} value={o}>
                      {outcomeLabel(o, item.outcomeNames)} {item.bestPrice[o] ? `@ ${formatDecimal(item.bestPrice[o]!.decimal)}` : "(no current price)"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Points (0–10)
                <input type="number" min={0} max={10} step={1} value={stake} onChange={(e) => setStake(Math.max(0, Math.min(10, Number(e.target.value) || 0)))} style={{ width: 80 }} />
              </label>
            </div>
          )}
        </div>
        <div className="stack-sm small">
          {blind && !saved ? (
            <p className="subtle">
              <IconEyeOff style={{ width: 14, height: 14, verticalAlign: "-2px" }} /> Model and market hidden until you save.
            </p>
          ) : (
            <>
              <div>
                <IconEye style={{ width: 14, height: 14, verticalAlign: "-2px" }} /> Market reference:{" "}
                {item.market ? item.outcomes.map((o) => `${outcomeLabel(o, item.outcomeNames)} ${formatPct(item.market!.probs[o])}`).join(" · ") : "none current"}
              </div>
              <div>Model: {item.model ? item.outcomes.map((o) => `${outcomeLabel(o, item.outcomeNames)} ${formatPct(item.model!.probs[o])}`).join(" · ") : item.modelUnavailable}</div>
            </>
          )}
        </div>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn btn-primary" onClick={save} disabled={busy || !!saved || !valid}>
          {saved ? "Saved" : busy ? "Saving…" : "Save forecast"}
        </button>
        {saved && <span className="subtle small">Saved {fmtDateTime(saved, zone)}. Forecasts cannot be edited or deleted.</span>}
        <Link className="btn btn-ghost btn-sm" to={`/games/${encodeURIComponent(item.eventId)}`}>
          Research this game
        </Link>
      </div>
    </article>
  );
}

// ---------------- results ----------------
interface ForecastsResp {
  revealed: boolean;
  hiddenByInstructor: boolean;
  resultsAsOf: string;
  forecasts: {
    id: string;
    author: string;
    kind: string;
    game: string;
    start: string;
    probs: Partial<Record<Outcome, number>>;
    pick: string | null;
    info_as_of: string;
    created_at: string;
    model_probs: Partial<Record<Outcome, number>> | null;
    market_probs: Partial<Record<Outcome, number>> | null;
    result: { settlement: string; reason: string; realised: string | null; score: string | null } | null;
    scores: { brier: number; logLoss: number; modelBrier: number | null; marketBrier: number | null } | null;
    replay: boolean;
  }[];
  scoreboard: { author: string; replay: boolean; forecasts: number; scored: number; brier: number | null; logLoss: number | null; modelBrierSameGames: number | null; marketBrierSameGames: number | null; modelGames: number; marketGames: number }[] | null;
}

function ResultsPanel({ sessionId, hidden }: { sessionId: string; hidden: boolean }) {
  const { zone } = useApp();
  const [reveal, setReveal] = useState(false);
  const { data, error, loading, reload } = useApi<ForecastsResp>(`/api/sessions/${sessionId}/forecasts${qs({ reveal: reveal ? 1 : 0 })}`);
  const fmtP = (p: Partial<Record<Outcome, number>> | null) => (p ? Object.entries(p).map(([o, v]) => `${o} ${formatPct(v)}`).join(" · ") : "—");
  return (
    <div className="stack">
      <div className="row">
        <button className="btn btn-primary" onClick={() => setReveal(true)} disabled={reveal || hidden}>
          <IconEye /> Reveal results
        </button>
        {reveal && (
          <button className="btn" onClick={() => setReveal(false)}>
            <IconEyeOff /> Hide again
          </button>
        )}
        <a className="btn" href={`/api/sessions/${sessionId}/forecasts.csv${qs({ reveal: reveal ? 1 : 0 })}`} download>
          <IconDownload /> Export CSV
        </a>
        {hidden && <span className="chip chip-warn">The instructor has hidden results</span>}
      </div>
      <Callout kind="info">
        Lower Brier score is better (0 is perfect; always saying 50% scores 0.25 on 2-way games). Scores use only games with an official result. Postponed, cancelled and rescheduled games are void and excluded. With few games, differences are mostly luck.
      </Callout>
      {loading && !data && <Loading />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data?.scoreboard && data.scoreboard.length > 0 && (
        <div className="card">
          <h2>Scoreboard (Brier score, lower is better)</h2>
          <p className="subtle small">
            Replay forecasts (made on games that had already been played) are scored on separate rows: their outcomes could have been looked up, so they are for practice, not competition. They cannot be used in points experiments.
          </p>
          <div className="table-wrap" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Forecaster</th>
                  <th scope="col" className="r">Forecasts</th>
                  <th scope="col" className="r">Scored</th>
                  <th scope="col" className="r">Brier</th>
                  <th scope="col" className="r">Log loss</th>
                  <th scope="col" className="r">Model, same games</th>
                  <th scope="col" className="r">Market, same games</th>
                </tr>
              </thead>
              <tbody>
                {data.scoreboard.map((s) => (
                  <tr key={`${s.replay}-${s.author}`}>
                    <td>
                      {s.author} {s.replay && <span className="chip chip-warn">replay</span>}
                    </td>
                    <td className="r num">{s.forecasts}</td>
                    <td className="r num">{s.scored}</td>
                    <td className="r num">{s.brier?.toFixed(3) ?? "—"}</td>
                    <td className="r num">{s.logLoss?.toFixed(3) ?? "—"}</td>
                    <td className="r num">
                      {s.modelBrierSameGames?.toFixed(3) ?? "—"} <span className="subtle">({s.modelGames})</span>
                    </td>
                    <td className="r num">
                      {s.marketBrierSameGames?.toFixed(3) ?? "—"} <span className="subtle">({s.marketGames})</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {data && !data.forecasts.length && <Empty title="No forecasts in this session yet">Make some on the "Make forecasts" tab.</Empty>}
      {data && data.forecasts.length > 0 && (
        <div className="table-wrap" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">Forecaster</th>
                <th scope="col">Game</th>
                <th scope="col">Forecast</th>
                <th scope="col">Model / market then</th>
                <th scope="col">Saved</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {data.forecasts.map((f) => (
                <tr key={f.id}>
                  <td>
                    {f.author} {f.replay && <span className="chip chip-warn">replay</span>}
                  </td>
                  <td>
                    {f.game}
                    <div className="subtle small">{fmtDateTime(f.start, zone)}</div>
                  </td>
                  <td className="num small">{fmtP(f.probs)}</td>
                  <td className="num small">
                    {fmtP(f.model_probs)}
                    <div className="subtle">{fmtP(f.market_probs)}</div>
                  </td>
                  <td className="small">
                    {fmtDateTime(f.created_at, zone)}
                    <div className="subtle">info as of {fmtDateTime(f.info_as_of, zone)}</div>
                  </td>
                  <td className="small">
                    {f.result ? (
                      <>
                        <span className={`chip ${f.result.settlement === "win" ? "chip-good" : f.result.settlement === "loss" ? "chip-danger" : "chip-muted"}`}>
                          {f.result.settlement === "win" ? "pick correct" : f.result.settlement === "loss" ? "pick wrong" : f.result.settlement}
                        </span>
                        {f.result.score && <span className="num"> {f.result.score}</span>}
                        {f.scores && <div className="subtle">Brier {f.scores.brier.toFixed(3)}</div>}
                        {!f.scores && <div className="subtle">{f.result.reason}</div>}
                      </>
                    ) : (
                      <span className="subtle">hidden</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------- notebook ----------------
function NotebookPanel({ sessionId, hidden }: { sessionId: string; hidden: boolean }) {
  const { dataset, toast, bumpData } = useApp();
  const [name, setName] = useStudentName();
  const [expName, setExpName] = useState("My experiment");
  const [selected, setSelected] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const { data: exps, reload } = useApi<{ experiments: { id: string; name: string; author: string; created_at: string }[] }>(`/api/sessions/${sessionId}/experiments`);
  const { data: report, error } = useApi<any>(selected ? `/api/experiments/${selected}${qs({ reveal: reveal ? 1 : 0 })}` : null);
  const create = async () => {
    try {
      const r = await api.post<{ id: string }>("/api/experiments", { dataset, sessionId, name: expName, author: name });
      setSelected(r.id);
      reload();
      bumpData();
      toast("Experiment created. Choose it on the Make forecasts tab to add points.");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <div className="stack">
      <Callout kind="warn" title="Simulation points only.">
        Each experiment starts with 100 points. Points go on an outcome at the highest quoted price saved with the forecast, only for your own forecasts made before the game starts (never for replays of finished games). Point totals are a noisy teaching tool: a few results say almost nothing about forecast skill. Use the Brier score and calibration to judge forecasts.
      </Callout>
      <div className="card row" style={{ alignItems: "flex-end" }}>
        <label className="field">
          Your name
          <input type="text" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          Experiment name
          <input type="text" value={expName} maxLength={80} onChange={(e) => setExpName(e.target.value)} />
        </label>
        <button className="btn btn-primary" onClick={create} disabled={!name.trim() || !expName.trim()}>
          Create experiment
        </button>
      </div>
      {exps && !exps.experiments.length && <Empty title="No experiments yet" />}
      {exps && exps.experiments.length > 0 && (
        <div className="row">
          {exps.experiments.map((e) => (
            <button key={e.id} className={`btn ${selected === e.id ? "btn-primary" : ""}`} onClick={() => setSelected(e.id)} aria-pressed={selected === e.id}>
              {e.name} · {e.author}
            </button>
          ))}
        </div>
      )}
      {error && <ErrorBox error={error} />}
      {report && (
        <div className="card">
          <div className="row-between">
            <h2>{report.experiment.name}</h2>
            <div className="row">
              <button className="btn btn-sm" onClick={() => setReveal((r) => !r)} disabled={hidden && !reveal}>
                {reveal ? <IconEyeOff /> : <IconEye />} {reveal ? "Hide results" : "Reveal results"}
              </button>
              <a className="btn btn-sm" href={`/api/experiments/${selected}/csv${qs({ reveal: reveal ? 1 : 0 })}`} download>
                <IconDownload /> CSV
              </a>
            </div>
          </div>
          <div className="grid grid-4" style={{ margin: "10px 0" }}>
            <Stat label="Entries" value={report.summary.entries} />
            <Stat label="Settled" value={report.revealed ? report.summary.settled : "hidden"} />
            <Stat label="Net points" value={report.revealed ? formatPoints(report.summary.netPoints) : "hidden"} />
            <Stat label="Balance" value={report.revealed ? report.summary.balance.toFixed(2) : "hidden"} />
          </div>
          <p className="subtle small">{report.summary.note}</p>
          {report.entries.length ? (
            <div className="table-wrap" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Game</th>
                    <th scope="col">Outcome</th>
                    <th scope="col" className="r">Points</th>
                    <th scope="col" className="r">Price</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {report.entries.map((e: any) => (
                    <tr key={e.id}>
                      <td>{e.game}</td>
                      <td>{e.outcome}</td>
                      <td className="r num">{e.stake}</td>
                      <td className="r num">
                        {formatDecimal(e.price_decimal)} <span className="subtle">{e.book}</span>
                      </td>
                      <td className="small">
                        {e.settlement ? (
                          <>
                            {e.settlement} {e.points != null && <span className="num">({formatPoints(e.points)})</span>}
                            <div className="subtle">{e.reason}</div>
                          </>
                        ) : (
                          <span className="subtle">{report.revealed ? "pending" : "hidden"}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="subtle">No entries yet. On the Make forecasts tab, choose this experiment and give a forecast some points.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------- explainers ----------------
function ExplainersPanel() {
  return (
    <div className="stack">
      <div className="grid grid-2">
        <div className="card">
          <h2>Probability vs confidence</h2>
          <p className="text-2">
            A forecast of 70% says the outcome should happen in about 7 of 10 similar situations. It is not "70% sure the forecast is right". A good 70% forecaster is wrong 3 times in 10, and that is fine.
          </p>
          <p className="text-2">Judge forecasts in bulk, with scoring rules, never by single results.</p>
        </div>
        <div className="card">
          <h2>Odds, implied probability and margin</h2>
          <p className="text-2">
            American odds A convert to decimal odds d: if A &gt; 0, d = 1 + A/100; if A &lt; 0, d = 1 + 100/|A|. The raw implied probability is 1/d. Across one book's outcomes these add to more than 100%. The excess is the bookmaker's margin. Removing it proportionally (p = q / sum of q) gives an approximate market view.
          </p>
          <OddsConverter />
        </div>
        <div className="card">
          <h2>Calibration</h2>
          <p className="text-2">
            Group forecasts by stated probability. Among all the "60%" forecasts, about 60% of outcomes should happen. The calibration chart on the Model Report plots this. Points on the diagonal are well calibrated, and the vertical whiskers show how much luck small groups contain.
          </p>
          <p className="text-2">
            The <strong>Brier score</strong> averages (forecast − outcome)²: 0 is perfect, and always saying 50% scores 0.25 on two-way games. <strong>Log loss</strong> punishes confident misses much harder.
          </p>
        </div>
        <div className="card">
          <h2>Expected value with pushes</h2>
          <p className="text-2">
            For a 1-point simulation stake at decimal price d with win probability p and no push: expected net points = p·(d−1) − (1−p) = p·d − 1. Break-even is p = 1/d. If a push (refund) is possible, expected net points = p<sub>win</sub>·(d−1) − p<sub>loss</sub>. A void game returns the stake.
          </p>
        </div>
      </div>
      <VarianceSimulator />
    </div>
  );
}

function OddsConverter() {
  const [v, setV] = useState("+150");
  const p = parseAmerican(v);
  const d = p.ok ? americanToDecimal(p.value) : null;
  return (
    <div className="row" style={{ alignItems: "flex-end" }}>
      <label className="field">
        American odds
        <input type="text" value={v} onChange={(e) => setV(e.target.value)} style={{ width: 110 }} aria-describedby="conv-out" />
      </label>
      <span id="conv-out" className="small" aria-live="polite">
        {p.ok && d ? (
          <>
            Decimal <strong className="num">{d.toFixed(3)}</strong> · raw implied <strong className="num">{formatPct(1 / d, 1)}</strong>
          </>
        ) : (
          <span style={{ color: "var(--danger)" }}>{(p as { error: string }).error}</span>
        )}
      </span>
    </div>
  );
}

function VarianceSimulator() {
  const [p, setP] = useState(55);
  const [d, setD] = useState("1.91");
  const [n, setN] = useState(50);
  const [seed, setSeed] = useState(1);
  const dec = Number(d);
  const validD = Number.isFinite(dec) && dec > 1 && dec < 100;
  const sim = useMemo(() => {
    if (!validD) return null;
    const rand = mulberry32(seed * 7919 + n * 31 + p);
    const trials = 2000;
    const totals: number[] = [];
    for (let t = 0; t < trials; t++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += rand() < p / 100 ? dec - 1 : -1;
      totals.push(s);
    }
    totals.sort((a, b) => a - b);
    const mean = totals.reduce((a, b) => a + b, 0) / trials;
    const lossShare = totals.filter((x) => x < 0).length / trials;
    const lo = totals[0];
    const hi = totals[trials - 1];
    const nb = 24;
    const width = (hi - lo) / nb || 1;
    const bins = Array.from({ length: nb }, (_, i) => ({ from: lo + i * width, count: 0 }));
    for (const x of totals) bins[Math.min(nb - 1, Math.floor((x - lo) / width))].count++;
    return { mean, lossShare, bins, p5: totals[Math.floor(trials * 0.05)], p95: totals[Math.floor(trials * 0.95)], expected: n * ((p / 100) * dec - 1) };
  }, [p, dec, n, seed, validD]);
  const maxCount = sim ? Math.max(...sim.bins.map((b) => b.count)) : 1;
  return (
    <div className="card">
      <h2>Variance simulator</h2>
      <p className="text-2">
        Even with a known true probability, results over a few dozen games swing widely. This simulates 2,000 seasons of 1-point stakes with the inputs below (seeded, so it is reproducible).
      </p>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label className="field" style={{ minWidth: 200 }}>
          True win probability: {p}%
          <input type="range" min={5} max={95} value={p} onChange={(e) => setP(Number(e.target.value))} />
        </label>
        <label className="field">
          Decimal price
          <input type="text" inputMode="decimal" value={d} onChange={(e) => setD(e.target.value)} style={{ width: 90 }} />
        </label>
        <label className="field" style={{ minWidth: 200 }}>
          Stakes per season: {n}
          <input type="range" min={5} max={500} step={5} value={n} onChange={(e) => setN(Number(e.target.value))} />
        </label>
        <button className="btn btn-sm" onClick={() => setSeed((s) => s + 1)}>
          Re-run with a new seed
        </button>
      </div>
      {!validD && <p style={{ color: "var(--danger)" }}>Enter a decimal price above 1.00.</p>}
      {sim && (
        <>
          <div className="grid grid-4" style={{ margin: "12px 0" }}>
            <Stat label="Expected net points" value={formatPoints(sim.expected, 1)} sub="n × (p·d − 1)" />
            <Stat label="Simulated average" value={formatPoints(sim.mean, 1)} />
            <Stat label="Seasons ending below zero" value={formatPct(sim.lossShare)} />
            <Stat label="Middle 90% of seasons" value={`${formatPoints(sim.p5, 0)} to ${formatPoints(sim.p95, 0)}`} />
          </div>
          <svg className="chart" viewBox="0 0 640 160" role="img" aria-label={`Histogram of simulated season totals. ${formatPct(sim.lossShare)} of seasons end below zero.`}>
            {sim.bins.map((b, i) => {
              const h = (b.count / maxCount) * 130;
              const w = 640 / sim.bins.length;
              return (
                <rect key={i} x={i * w + 1} y={140 - h} width={Math.max(1, w - 2)} height={h} rx={3} fill={b.from + (sim.bins[1]?.from - sim.bins[0]?.from || 0) / 2 < 0 ? "var(--series-2)" : "var(--series-1)"}>
                  <title>
                    {b.from.toFixed(1)}: {b.count} seasons
                  </title>
                </rect>
              );
            })}
            <line x1={0} x2={640} y1={140} y2={140} className="grid-line" />
            <text x={0} y={156}>
              {formatPoints(sim.bins[0].from, 0)}
            </text>
            <text x={640} y={156} textAnchor="end">
              {formatPoints(sim.bins[sim.bins.length - 1].from, 0)}
            </text>
          </svg>
          <div className="legend">
            <span>
              <span className="swatch" style={{ background: "var(--series-2)" }} /> Seasons below zero
            </span>
            <span>
              <span className="swatch" style={{ background: "var(--series-1)" }} /> Seasons at or above zero
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------- instructor ----------------
function InstructorPanel({ sessions, reload }: { sessions: SessionsResp | null; reload: () => void }) {
  const { dataset, status, toast, bumpData, refreshStatus, zone } = useApp();
  const [pin, setPinState] = useState(getPin());
  const [sessionName, setSessionName] = useState("");
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      bumpData();
      reload();
      await refreshStatus();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <div className="stack">
      {!status?.instructorPinConfigured && (
        <Callout kind="warn" title="No instructor PIN is configured.">
          Anyone using this app can use these controls. Set INSTRUCTOR_PIN in the server's .env file and restart to protect them.
        </Callout>
      )}
      {status?.instructorPinConfigured && (
        <div className="card row" style={{ alignItems: "flex-end" }}>
          <label className="field">
            Instructor PIN (kept for this browser tab only)
            <input type="password" value={pin} onChange={(e) => setPinState(e.target.value)} autoComplete="off" />
          </label>
          <button
            className="btn"
            onClick={() => {
              setPin(pin);
              toast("PIN stored for this tab.");
            }}
          >
            Use PIN
          </button>
        </div>
      )}
      <div className="grid grid-2">
        <div className="card">
          <h2>Results visibility</h2>
          <p className="text-2 small">Hide final scores everywhere in the app (boards, games, reveals) so students forecast without seeing outcomes.</p>
          <div className="row">
            <button className="btn" onClick={() => act(() => api.post("/api/classroom/results-hidden", { hidden: !status?.resultsHidden }), status?.resultsHidden ? "Results visible again." : "Results hidden.")}>
              {status?.resultsHidden ? <IconEye /> : <IconEyeOff />} {status?.resultsHidden ? "Show results" : "Hide results"}
            </button>
            <span className={`chip ${status?.resultsHidden ? "chip-warn" : "chip-good"}`}>{status?.resultsHidden ? "Hidden" : "Visible"}</span>
          </div>
        </div>
        <div className="card">
          <h2>Sessions</h2>
          <p className="text-2 small">Starting a new session archives the current one. Forecasts are immutable and are kept for the record; they are never deleted.</p>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label className="field">
              New session name
              <input type="text" value={sessionName} maxLength={80} onChange={(e) => setSessionName(e.target.value)} placeholder="e.g. Period 3 · Week 2" />
            </label>
            <button className="btn" disabled={!sessionName.trim()} onClick={() => act(() => api.post("/api/sessions", { dataset, name: sessionName.trim() }), "New session started.")}>
              Start new session
            </button>
          </div>
          {sessions && (
            <ul className="list-plain small" style={{ marginTop: 10 }}>
              {sessions.sessions.slice(0, 6).map((s) => (
                <li key={s.id}>
                  {s.id === sessions.active ? <span className="chip chip-good">active</span> : <span className="chip">archived</span>} {s.name} · {s.forecast_count} forecast(s) · {fmtDateTime(s.created_at, zone)}
                </li>
              ))}
            </ul>
          )}
        </div>
        {dataset === "demo" && (
          <div className="card">
            <h2>Demo clock</h2>
            <p className="text-2 small">
              The fictional world has its own clock. Advance it a day to reveal yesterday's results and open a new slate. The demo starts at {status ? fmtDateTime(status.demoStart, zone) : "…"}.
            </p>
            <p>
              Now: <strong>{status ? fmtDateTime(status.demoClock, zone) : "…"}</strong>
            </p>
            <div className="row">
              <button className="btn" onClick={() => act(() => api.post("/api/demo/clock", { action: "back_day" }), "Demo clock moved back one day.")}>
                ← Back a day
              </button>
              <button className="btn btn-primary" onClick={() => act(() => api.post("/api/demo/clock", { action: "advance_day" }), "Demo clock advanced one day.")}>
                Advance a day →
              </button>
              <button className="btn btn-ghost" onClick={() => act(() => api.post("/api/demo/clock", { action: "reset" }), "Demo clock reset.")}>
                Reset demo clock
              </button>
            </div>
          </div>
        )}
        <div className="card">
          <h2>Historical replay</h2>
          <p className="text-2 small">
            Use <strong>Replay a past moment</strong> in the top bar to freeze information at any earlier time. That browser then shows only that moment, with later quotes, injuries, news, results and model refits excluded. Students forecast, then reveal results on the Results tab.
          </p>
        </div>
      </div>
    </div>
  );
}
