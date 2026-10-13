import { useState } from "react";
import { Link } from "react-router-dom";
import { qs } from "../api";
import { useApi, useApp } from "../state";
import { fmtDate, fmtTime, formatAmerican, formatDecimal, formatPct, localDate, shiftDate, sportLabel, atWord } from "../format";
import { Empty, ErrorBox, FictionalNote, Loading } from "../components/ui";

interface Price {
  decimal: number;
  american: number;
}
interface AvgOutcome {
  outcome: string;
  selection: string;
  books: number;
  average: Price | null;
  best: (Price & { book: string }) | null;
  worst: (Price & { book: string }) | null;
  fair: (Price & { probability: number }) | null;
}
interface AvgMarket {
  contract: string;
  contractShort: string;
  line: number | null;
  averageLine: number | null;
  lineRange: [number, number] | null;
  linesOffered: { line: number; books: number }[];
  hold: number | null;
  outcomes: AvgOutcome[];
}
interface AvgGame {
  eventId: string;
  sport: string;
  league: string;
  start: string;
  home: string;
  away: string;
  started: boolean;
  voided: boolean;
  infoAsOf: string;
  markets: AvgMarket[];
}
interface LinesResp {
  date: string;
  asOf: string;
  games: AvgGame[];
  method: string;
}

const lineText = (m: AvgMarket) => {
  if (m.line == null) return null;
  const sign = (x: number) => (m.contract === "spread_full_game" ? `${x > 0 ? "+" : ""}${x}` : `${x}`);
  return `${m.contract === "spread_full_game" ? "Home line" : "Line"} ${sign(m.line)}${m.averageLine != null ? ` · average across books ${sign(Math.round(m.averageLine * 10) / 10)}` : ""}${
    m.lineRange && m.lineRange[0] !== m.lineRange[1] ? ` (range ${sign(m.lineRange[0])} to ${sign(m.lineRange[1])})` : ""
  }`;
};

function MarketTable({ m }: { m: AvgMarket }) {
  const priced = m.outcomes.some((o) => o.books > 0);
  return (
    <div className="stack-sm">
      <div className="row-between">
        <strong>{m.contractShort}</strong>
        <span className="small subtle">{[lineText(m), m.hold != null ? `average margin ${formatPct(m.hold, 1)}` : null].filter(Boolean).join(" · ")}</span>
      </div>
      {priced ? (
        <div className="table-wrap" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">Selection</th>
                <th scope="col" className="r">Average price</th>
                <th scope="col" className="r">Best</th>
                <th scope="col" className="r">Worst</th>
                <th scope="col" className="r">Fair (no margin)</th>
                <th scope="col" className="r">Books</th>
              </tr>
            </thead>
            <tbody>
              {m.outcomes.map((o) => (
                <tr key={o.outcome}>
                  <td>{o.selection}</td>
                  <td className="r num">
                    <strong>{formatAmerican(o.average?.american)}</strong> <span className="subtle">({formatDecimal(o.average?.decimal)})</span>
                  </td>
                  <td className="r num">
                    {formatAmerican(o.best?.american)}
                    {o.best && <div className="small subtle">{o.best.book}</div>}
                  </td>
                  <td className="r num">
                    {formatAmerican(o.worst?.american)}
                    {o.worst && <div className="small subtle">{o.worst.book}</div>}
                  </td>
                  <td className="r num">
                    {formatAmerican(o.fair?.american)}
                    {o.fair && <div className="small subtle">{formatPct(o.fair.probability, 1)}</div>}
                  </td>
                  <td className="r num">{o.books}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="small subtle">No current quotes for this market.</p>
      )}
      {m.linesOffered.length > 1 && (
        <p className="small subtle">
          Lines offered: {m.linesOffered.map((l) => `${m.contract === "spread_full_game" && l.line > 0 ? "+" : ""}${l.line} (${l.books} book${l.books === 1 ? "" : "s"})`).join(", ")}. Different lines are different contracts, so only the most-quoted line is averaged above.
        </p>
      )}
    </div>
  );
}

export default function LinesPage() {
  const { dataset, asOfParam, zone, clock, mode } = useApp();
  const baseDate = localDate(asOfParam ?? clock, zone);
  const [date, setDate] = useState<string | null>(null);
  const [sport, setSport] = useState("");
  const [hideStarted, setHideStarted] = useState(true);
  const day = date ?? baseDate;
  const { data, error, loading, reload } = useApi<LinesResp>(`/api/average-lines${qs({ dataset, asOf: asOfParam, date: day })}`);
  const sports = [...new Set(data?.games.map((g) => g.sport) ?? [])];
  const games = (data?.games ?? []).filter((g) => (!sport || g.sport === sport) && (!hideStarted || (!g.started && !g.voided)));

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Average Lines</div>
          <h1>{fmtDate(day)}</h1>
          <p>The average moneyline, spread and total for every game, next to the best and worst quoted price and the margin-free fair price. Averages are taken on the probability scale, which is the correct way to average odds.</p>
        </div>
      </div>
      <FictionalNote />
      <div className="row no-print" role="group" aria-label="Choose day and filters">
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
        <label className="row small" style={{ gap: 6, marginLeft: "auto" }}>
          <input type="checkbox" checked={hideStarted} onChange={(e) => setHideStarted(e.target.checked)} /> Upcoming only
        </label>
        {sports.length > 1 && (
          <select value={sport} onChange={(e) => setSport(e.target.value)} aria-label="Sport">
            <option value="">All sports</option>
            {sports.map((s) => (
              <option key={s} value={s}>
                {sportLabel(s)}
              </option>
            ))}
          </select>
        )}
      </div>
      {loading && !data && <Loading rows={4} />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && !games.length && <Empty title="No games to show">No {hideStarted ? "upcoming " : ""}games with quotes for this day and filter.</Empty>}
      {games.map((g) => (
        <article key={g.eventId} className="card" aria-labelledby={`h-${g.eventId}`}>
          <div className="row-between">
            <div>
              <h2 id={`h-${g.eventId}`} style={{ marginBottom: 2 }}>
                <Link to={`/games/${encodeURIComponent(g.eventId)}`}>
                  {g.away} {atWord(g.sport)} {g.home}
                </Link>
              </h2>
              <div className="small subtle">
                {sportLabel(g.sport)} · {g.league} · {fmtTime(g.start, zone)}
                {g.started && " · started (prices frozen at the start)"}
                {g.voided && " · void"}
              </div>
            </div>
          </div>
          <div className="stack" style={{ marginTop: 10 }}>
            {g.markets.map((m) => (
              <MarketTable key={`${m.contract}-${m.line}`} m={m} />
            ))}
          </div>
        </article>
      ))}
      {data && <p className="small subtle">{data.method}</p>}
    </div>
  );
}
