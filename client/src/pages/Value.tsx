import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { qs } from "../api";
import { useApi, useApp } from "../state";
import { fmtDate, fmtTime, formatAmerican, formatDecimal, formatPct, localDate, shiftDate, sportLabel } from "../format";
import { Callout, Empty, ErrorBox, FictionalNote, Loading, Stat, Tabs } from "../components/ui";

type Grade = "A" | "B" | "C" | "D";

interface Candidate {
  eventId: string;
  sport: string;
  league: string;
  start: string;
  matchup: string;
  contract: string;
  contractShort: string;
  line: number | null;
  outcome: string;
  selection: string;
  probability: number;
  push: number;
  estimateSource: "combined" | "market" | "model";
  estimateLabel: string;
  best: { decimal: number; american: number; book: string };
  mainLine: boolean;
  breakEven: number;
  fair: { decimal: number; american: number } | null;
  ev: number;
  consensus: { probability: number; books: number; edge: number } | null;
  grade: Grade | null;
  gradeReason: string | null;
}

interface Arb {
  eventId: string;
  matchup: string;
  start: string;
  contractShort: string;
  line: number | null;
  legs: { outcome: string; selection: string; decimal: number; american: number; book: string; stakeShare: number }[];
  impliedTotal: number;
  guaranteedReturn: number;
}

interface ValueResp {
  date: string;
  asOf: string;
  mode: string;
  games: number;
  candidatesConsidered: number;
  mostLikely: Candidate[];
  discrepancies: Candidate[];
  unproven: Candidate[];
  arbitrage: Arb[];
  grades: Record<Grade, string>;
  thresholds: { minEdge: number; minConsensusBooks: number };
  notes: string[];
}

interface CI {
  mean: number;
  low: number;
  high: number;
}
interface StrategySummary {
  key: string;
  label: string;
  rule: string;
  bets: number;
  wins: number;
  pushes: number;
  hitRate: number | null;
  netPoints: number;
  roi: number | null;
  roiCI: CI | null;
  meanClv: number | null;
  clvCI: CI | null;
  bySport: Record<string, Omit<StrategySummary, "key" | "label" | "rule" | "bySport">>;
}
interface BacktestResp {
  asOf: string;
  seasons: Record<string, string>;
  games: number;
  gamesWithPrices: number;
  timing: string;
  strategies: StrategySummary[];
  notes: string[];
}

type View = "likely" | "value" | "arb" | "unproven" | "record";

const pct1 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}%`);

export function GradeChip({ grade }: { grade: Grade | null }) {
  if (!grade) return <span className="subtle">—</span>;
  const cls = grade === "A" || grade === "B" ? "chip-good" : grade === "C" ? "chip-info" : "chip-hypo";
  const text = grade === "A" ? "A · arbitrage" : grade === "B" ? "B · beats consensus" : grade === "C" ? "C · validated model" : "D · unproven";
  return <span className={`chip ${cls}`}>{text}</span>;
}

function SourceText({ c }: { c: Candidate }) {
  return <span className="small text-2">{c.estimateSource === "combined" ? "Combined" : c.estimateSource === "market" ? "Market consensus" : "Model only"}</span>;
}

function GameCell({ c, zone }: { c: Candidate | Arb; zone: string }) {
  return (
    <>
      <Link to={`/games/${encodeURIComponent(c.eventId)}`}>{c.matchup}</Link>
      <div className="small subtle">
        {"sport" in c ? `${sportLabel(c.sport)} · ` : ""}
        {fmtTime(c.start, zone)}
      </div>
    </>
  );
}

function CandidateTable({ rows, zone, variant }: { rows: Candidate[]; zone: string; variant: "likely" | "value" | "unproven" }) {
  return (
    <div className="table-wrap" tabIndex={0}>
      <table>
        <thead>
          <tr>
            <th scope="col">Selection</th>
            <th scope="col">Game</th>
            <th scope="col">Market</th>
            <th scope="col" className="r">
              {variant === "value" ? "Consensus chance" : "Estimated chance"}
            </th>
            <th scope="col" className="r">Best price</th>
            <th scope="col" className="r">Break-even</th>
            <th scope="col" className="r">{variant === "value" ? "Edge vs consensus" : "Expected net / point"}</th>
            <th scope="col">Grade</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c, i) => (
            <tr key={`${c.eventId}-${c.contract}-${c.line}-${c.outcome}-${i}`}>
              <td>
                <strong>{c.selection}</strong>
                <div>
                  <SourceText c={c} />
                </div>
              </td>
              <td>
                <GameCell c={c} zone={zone} />
              </td>
              <td className="small">{c.contractShort}</td>
              <td className="r num">
                {variant === "value" && c.consensus ? formatPct(c.consensus.probability, 1) : formatPct(c.probability, 1)}
                {c.push > 0.0005 && variant !== "value" && <div className="small subtle">push {formatPct(c.push, 1)}</div>}
              </td>
              <td className="r num">
                {formatAmerican(c.best.american)} <span className="subtle">({formatDecimal(c.best.decimal)})</span>
                <div className="small subtle">{c.best.book}</div>
              </td>
              <td className="r num">{formatPct(c.breakEven, 1)}</td>
              <td className="r num">
                {variant === "value" ? pct1(c.consensus?.edge) : pct1(c.ev)}
                {variant === "value" && <div className="small subtle">our estimate {pct1(c.ev)}</div>}
              </td>
              <td>
                <GradeChip grade={c.grade} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CIText({ ci, pct = true }: { ci: CI | null; pct?: boolean }) {
  if (!ci) return <span className="subtle">too few bets for an interval</span>;
  const f = (x: number) => (pct ? pct1(x) : x.toFixed(3));
  const verdict = ci.low > 0 ? "above zero" : ci.high < 0 ? "below zero" : "includes zero: consistent with luck";
  return (
    <span>
      <span className="num">
        {f(ci.mean)} [{f(ci.low)}, {f(ci.high)}]
      </span>{" "}
      <span className="subtle">({verdict})</span>
    </span>
  );
}

function TrackRecord() {
  const { dataset, asOfParam } = useApp();
  const { data, error, loading, reload } = useApi<BacktestResp>(`/api/value/backtest${qs({ dataset, asOf: asOfParam })}`);
  if (loading && !data) return <Loading rows={3} label="Running the season-to-date backtest…" />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;
  if (!data.gamesWithPrices) return <Empty title="No completed games with prices yet">The backtest needs finished games with historical quotes in the current season.</Empty>;
  return (
    <div className="stack">
      <p className="small text-2">
        {data.timing} Seasons: {Object.entries(data.seasons).map(([s, y]) => `${sportLabel(s)} ${y}`).join(", ")}. {data.gamesWithPrices} of {data.games} completed games had prices.
      </p>
      <div className="grid grid-2">
        {data.strategies.map((s) => (
          <div className="card" key={s.key}>
            <h2>{s.label}</h2>
            <p className="small text-2">{s.rule}</p>
            <div className="grid grid-3" style={{ margin: "10px 0" }}>
              <Stat label="Selections" value={s.bets} sub={s.hitRate != null ? `${formatPct(s.hitRate)} won` : undefined} />
              <Stat label="Return per point" value={pct1(s.roi)} sub={`net ${s.netPoints >= 0 ? "+" : ""}${s.netPoints.toFixed(1)} points`} />
              <Stat label="Closing line value" value={pct1(s.meanClv)} />
            </div>
            <ul className="list-bullets small">
              <li>
                Return, 95% interval: <CIText ci={s.roiCI} />
              </li>
              <li>
                Closing line value, 95% interval: <CIText ci={s.clvCI} />
              </li>
            </ul>
            {Object.keys(s.bySport).length > 0 && (
              <div className="table-wrap" tabIndex={0} style={{ marginTop: 10 }}>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Sport</th>
                      <th scope="col" className="r">Selections</th>
                      <th scope="col" className="r">Return</th>
                      <th scope="col" className="r">CLV</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(s.bySport).map(([sport, x]) => (
                      <tr key={sport}>
                        <td>{sportLabel(sport)}</td>
                        <td className="r num">{x.bets}</td>
                        <td className="r num">{pct1(x.roi)}</td>
                        <td className="r num">{pct1(x.meanClv)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>
      <ul className="list-bullets small text-2">
        {data.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  );
}

export default function ValuePage() {
  const { dataset, asOfParam, zone, clock, mode } = useApp();
  const baseDate = localDate(asOfParam ?? clock, zone);
  const [date, setDate] = useState<string | null>(null);
  const day = date ?? baseDate;
  const [view, setView] = useState<View>("likely");
  const [sport, setSport] = useState("");
  const { data, error, loading, reload } = useApi<ValueResp>(`/api/value${qs({ dataset, asOf: asOfParam, date: day })}`);
  const filt = useMemo(() => {
    const f = <T extends { sport?: string; eventId: string }>(xs: T[]) => (sport ? xs.filter((x) => x.sport === sport) : xs);
    return data ? { likely: f(data.mostLikely), value: f(data.discrepancies), unproven: f(data.unproven), arb: data.arbitrage } : null;
  }, [data, sport]);
  const sports = [...new Set(data?.mostLikely.map((c) => c.sport) ?? [])];

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Value Finder</div>
          <h1>{fmtDate(day)}</h1>
          <p>
            Ranks today's outcomes by how likely they are, then separately looks for prices that beat the market's own margin-free consensus. Likely and profitable are different questions, and an empty list is a normal answer. Simulation points only.
          </p>
        </div>
      </div>
      <FictionalNote />

      <div className="row no-print" role="group" aria-label="Choose day and sport">
        <button className="btn btn-sm" onClick={() => setDate(shiftDate(day, -1))}>
          ← Previous day
        </button>
        <input type="date" aria-label="Day" value={day} onChange={(e) => e.target.value && setDate(e.target.value)} />
        <button className="btn btn-sm" onClick={() => setDate(shiftDate(day, 1))}>
          Next day →
        </button>
        {date && (
          <button className="btn btn-sm btn-ghost" onClick={() => setDate(null)}>
            Back to {mode === "replay" ? "replay day" : "today"}
          </button>
        )}
        {sports.length > 1 && (
          <span style={{ marginLeft: "auto" }}>
            <select value={sport} onChange={(e) => setSport(e.target.value)} aria-label="Sport">
              <option value="">All sports</option>
              {sports.map((s) => (
                <option key={s} value={s}>
                  {sportLabel(s)}
                </option>
              ))}
            </select>
          </span>
        )}
      </div>

      {loading && !data && <Loading rows={4} label="Analysing today's games…" />}
      {error && <ErrorBox error={error} onRetry={reload} />}

      {data && filt && (
        <>
          <div className="grid grid-4">
            <Stat label="Upcoming games" value={data.games} />
            <Stat label="Outcomes priced" value={data.candidatesConsidered} />
            <Stat label="Prices beating the consensus" value={data.discrepancies.length} />
            <Stat label="Arbitrage sets" value={data.arbitrage.length} />
          </div>

          <Tabs<View>
            label="Value Finder views"
            value={view}
            onChange={setView}
            tabs={[
              { id: "likely", label: "Most likely" },
              { id: "value", label: "Price discrepancies" },
              { id: "arb", label: "Arbitrage" },
              { id: "unproven", label: "Unproven model ideas" },
              { id: "record", label: "Track record" },
            ]}
          />

          <div role="tabpanel" id={`panel-${view}`} aria-labelledby={`tab-${view}`}>
          {view === "likely" && (
            <div className="card">
              <h2>Highest estimated chance of winning</h2>
              <p className="small text-2">
                Best available estimate for each selection (combined model + market where validated, otherwise the market consensus). A high chance at a short price is usually still a losing proposition: compare the chance with the break-even column.
              </p>
              {filt.likely.length ? <CandidateTable rows={filt.likely} zone={zone} variant="likely" /> : <Empty title="No upcoming priced games">Nothing to rank for this day.</Empty>}
            </div>
          )}

          {view === "value" && (
            <div className="card">
              <h2>Prices that beat the consensus</h2>
              <p className="small text-2">
                {data.grades.B} {data.grades.C}
              </p>
              {filt.value.length ? (
                <>
                  <CandidateTable rows={filt.value} zone={zone} variant="value" />
                  <ul className="list-plain small" style={{ marginTop: 10 }}>
                    {filt.value.map((c, i) => (
                      <li key={i}>
                        <strong>{c.selection}:</strong> <span className="text-2">{c.gradeReason}</span>
                        {c.ev < 0 && <span className="subtle"> Our own estimate disagrees (expected {pct1(c.ev)}), so treat this as a pricing difference between books, not a forecast.</span>}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <Empty title="No price beats the consensus">That is the usual answer in an efficient market. The finder never fills a quota.</Empty>
              )}
            </div>
          )}

          {view === "arb" && (
            <div className="card">
              <h2>Arbitrage</h2>
              <p className="small text-2">{data.grades.A} In practice prices move within seconds, books cap stakes and void obvious errors, so most arbitrage you see in data is gone or unusable.</p>
              {data.arbitrage.length ? (
                <div className="stack-sm">
                  {data.arbitrage.map((a, i) => (
                    <div key={i} className="card card-tight">
                      <div className="row-between">
                        <div>
                          <GameCell c={a} zone={zone} />
                        </div>
                        <span className="chip chip-good">Prices imply {pct1(a.guaranteedReturn)} if all legs are placed together</span>
                      </div>
                      <div className="table-wrap" tabIndex={0} style={{ marginTop: 8 }}>
                        <table>
                          <thead>
                            <tr>
                              <th scope="col">Leg</th>
                              <th scope="col" className="r">Price</th>
                              <th scope="col">Book</th>
                              <th scope="col" className="r">Share of points</th>
                            </tr>
                          </thead>
                          <tbody>
                            {a.legs.map((l) => (
                              <tr key={l.outcome}>
                                <td>{l.selection}</td>
                                <td className="r num">
                                  {formatAmerican(l.american)} ({formatDecimal(l.decimal)})
                                </td>
                                <td>{l.book}</td>
                                <td className="r num">{formatPct(l.stakeShare, 1)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="small subtle" style={{ marginTop: 6 }}>
                        Sum of implied probabilities {formatPct(a.impliedTotal, 2)} (below 100%). Splitting points by these shares pays the same on every outcome.
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty title="No arbitrage">No combination of the quoted prices covers every outcome for a profit.</Empty>
              )}
            </div>
          )}

          {view === "unproven" && (
            <div className="card">
              <h2>Unproven model ideas</h2>
              <Callout kind="hypo" title="Hypotheses, not edges.">
                {data.grades.D} The Model Report shows how the model has done against the market; when the market has the lower log loss, these differences are more likely model error than opportunity.
              </Callout>
              {filt.unproven.length ? (
                <div style={{ marginTop: 10 }}>
                  <CandidateTable rows={filt.unproven} zone={zone} variant="unproven" />
                </div>
              ) : (
                <Empty title="None today">The model sees no positive expected value at the quoted prices.</Empty>
              )}
            </div>
          )}

          {view === "record" && <TrackRecord />}
          </div>

          <ul className="list-bullets small text-2">
            {data.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
            <li>
              Grades: A {data.grades.A} B {data.grades.B} C {data.grades.C} D {data.grades.D}
            </li>
          </ul>
        </>
      )}
    </div>
  );
}
