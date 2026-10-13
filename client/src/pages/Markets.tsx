import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { qs, type Analysis, type Board, type Outcome } from "../api";
import { useApi, useApp } from "../state";
import { fmtTime, formatPct, localDate, atWord } from "../format";
import { Callout, Empty, ErrorBox, FictionalNote, Loading } from "../components/ui";
import { HistoryCard, QuotesTable } from "./Game";
import { americanToDecimal, parseAmerican, proportionalNoVig } from "../../../shared/odds";

export default function MarketsPage() {
  const { dataset, asOfParam, clock, zone } = useApp();
  const day = localDate(asOfParam ?? clock, zone);
  const { data: board, error, loading, reload } = useApi<Board>(`/api/board${qs({ dataset, asOf: asOfParam, date: day })}`);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (board && (!selected || !board.items.some((i) => i.eventId === selected))) setSelected(board.items[0]?.eventId ?? null);
  }, [board, selected]);
  const { data: a, error: aErr } = useApi<Analysis>(selected ? `/api/events/${encodeURIComponent(selected)}/analysis${qs({ dataset, asOf: asOfParam })}` : null);
  const names: Partial<Record<Outcome, string>> = a ? { home: a.event.home_name, away: a.event.away_name, draw: "Draw" } : {};

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Market Explorer</div>
          <h1>Comparable quotes and movement</h1>
          <p>Compare equivalent contracts across connected books, see each book's margin, and watch prices move as information arrives.</p>
        </div>
      </div>
      <FictionalNote />
      <MarginCalculator />
      {loading && !board && <Loading />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {board && !board.items.length && <Empty title="No games today">Pick a different day on the Today page, or replay a past moment.</Empty>}
      {board && board.items.length > 0 && (
        <div className="grid grid-side">
          <nav className="card card-tight" aria-label="Games today" style={{ alignSelf: "start" }}>
            <h2 style={{ fontSize: "1rem" }}>Today's games</h2>
            <ul className="list-plain">
              {board.items.map((i) => (
                <li key={i.eventId}>
                  <button
                    className={`btn ${selected === i.eventId ? "btn-primary" : "btn-ghost"}`}
                    style={{ width: "100%", justifyContent: "space-between", whiteSpace: "normal", textAlign: "left" }}
                    aria-pressed={selected === i.eventId}
                    onClick={() => setSelected(i.eventId)}
                  >
                    <span>
                      {i.awayAbbr ?? i.away} {atWord(i.sport)} {i.homeAbbr ?? i.home}
                      <span className="small" style={{ display: "block", color: "inherit" }}>
                        {fmtTime(i.start, zone)} · {i.booksCurrent}/{i.booksTotal} current
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <div className="stack">
            {aErr && <ErrorBox error={aErr} />}
            {a && (
              <>
                <div className="card">
                  <div className="card-head">
                    <h2>
                      <Link to={`/games/${encodeURIComponent(a.event.id)}`}>
                        {a.event.away_name} {atWord(a.event.sport_key)} {a.event.home_name}
                      </Link>
                    </h2>
                    <span className="chip">{a.market.label}</span>
                  </div>
                  {a.market.books.length ? <QuotesTable market={a.market} names={names} /> : <p className="subtle">No quotes from connected sources.</p>}
                  {a.otherMarkets.map((m) => (
                    <div key={m.contractId} style={{ marginTop: 12 }}>
                      <QuotesTable market={m} names={names} />
                    </div>
                  ))}
                </div>
                <HistoryCard a={a} names={names} />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MarginCalculator() {
  const [prices, setPrices] = useState(["-150", "+130"]);
  const parsed = prices.map((p) => parseAmerican(p));
  const ok = parsed.every((p) => p.ok);
  const decimals = ok ? parsed.map((p) => americanToDecimal((p as { ok: true; value: number }).value)) : [];
  const raw = decimals.map((d) => 1 / d);
  const total = raw.reduce((a, b) => a + b, 0);
  const adj = ok ? proportionalNoVig(decimals) : [];
  return (
    <details className="disclosure">
      <summary>Margin calculator: how a book's overround is removed</summary>
      <div className="disclosure-body stack-sm">
        <p>
          Enter one book's American prices for every outcome of one contract (two for a moneyline, three if a draw is possible). Raw implied probabilities add up to more than 100%; the excess is the margin. Proportional adjustment divides each by the total. That approximates the book's view; it does not measure the truth.
        </p>
        <div className="row">
          {prices.map((p, i) => (
            <label key={i} className="field">
              Outcome {i + 1}
              <input type="text" value={p} onChange={(e) => setPrices(prices.map((x, j) => (j === i ? e.target.value : x)))} style={{ width: 110 }} />
              {!parsed[i].ok && <span style={{ color: "var(--danger)" }}>{(parsed[i] as { error: string }).error}</span>}
            </label>
          ))}
          <button className="btn btn-sm" onClick={() => setPrices(prices.length === 2 ? [...prices, "+250"] : prices.slice(0, 2))}>
            {prices.length === 2 ? "Add a draw (3-way)" : "Back to 2-way"}
          </button>
        </div>
        {ok && (
          <div className="table-wrap" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Outcome</th>
                  <th scope="col" className="r">Decimal</th>
                  <th scope="col" className="r">Raw implied (1/d)</th>
                  <th scope="col" className="r">Margin-adjusted</th>
                </tr>
              </thead>
              <tbody>
                {decimals.map((d, i) => (
                  <tr key={i}>
                    <td>Outcome {i + 1}</td>
                    <td className="r num">{d.toFixed(3)}</td>
                    <td className="r num">{formatPct(raw[i], 1)}</td>
                    <td className="r num">{formatPct(adj[i], 1)}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>Total</strong>
                  </td>
                  <td />
                  <td className="r num">
                    <strong>{formatPct(total, 1)}</strong>
                  </td>
                  <td className="r num">100.0%</td>
                </tr>
              </tbody>
              <caption>Margin (overround) = {formatPct(total - 1, 1)}.</caption>
            </table>
          </div>
        )}
        <Callout kind="info">Never build a "market" from the best price of each outcome at different books: those prices were never offered together, so the result is not a coherent probability set.</Callout>
      </div>
    </details>
  );
}
