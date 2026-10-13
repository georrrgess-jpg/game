import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { qs } from "../api";
import { useApi, useApp } from "../state";
import { fmtDate, fmtTime, localDate, shiftDate, sportLabel, statusLabel } from "../format";
import { Empty, ErrorBox, FictionalNote, Loading } from "../components/ui";

interface EventsResp {
  asOf: string;
  from: string;
  to: string;
  events: { id: string; sport: string; league: string; start: string; localDate: string; status: string; home: string; away: string; score: string | null; resultHidden: boolean; gameNumber: number; rescheduledFrom: string | null }[];
}

export default function GamesPage() {
  const { dataset, asOfParam, clock, zone } = useApp();
  const today = localDate(asOfParam ?? clock, zone);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [from, setFrom] = useState(shiftDate(today, -2));
  const [to, setTo] = useState(shiftDate(today, 5));
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    setFrom(shiftDate(today, -2));
    setTo(shiftDate(today, 5));
  }, [today]);
  const { data, error, loading, reload } = useApi<EventsResp>(`/api/events${qs({ dataset, asOf: asOfParam, q: debounced, from, to })}`);
  const groups = useMemo(() => {
    const m = new Map<string, EventsResp["events"]>();
    for (const e of data?.events ?? []) m.set(e.localDate, [...(m.get(e.localDate) ?? []), e]);
    return [...m.entries()];
  }, [data]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Schedule</div>
          <h1>Games</h1>
          <p>Search for a team or game and open its analysis workspace. Dates are shown in {zone}; a late game can fall on the next local day.</p>
        </div>
      </div>
      <FictionalNote />
      <div className="card card-tight row" style={{ alignItems: "flex-end" }}>
        <label className="field" style={{ flex: "1 1 240px" }}>
          Team or game
          <input type="search" placeholder="e.g. Harborview, Owls, Rovers…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="field">
          From
          <input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </label>
        <label className="field">
          To
          <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </label>
      </div>
      {loading && !data && <Loading />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && !data.events.length && <Empty title="No games found">Try another name or widen the date range. Connected mode only shows games fetched from your providers.</Empty>}
      {groups.map(([d, evs]) => (
        <section key={d} className="stack-sm" aria-labelledby={`d-${d}`}>
          <h2 id={`d-${d}`} style={{ fontSize: "1rem" }}>
            {fmtDate(d)} {d === today && <span className="chip chip-info">today</span>}
          </h2>
          <div className="table-wrap" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col" style={{ width: 110 }}>Start</th>
                  <th scope="col">Game</th>
                  <th scope="col">League</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {evs.map((e) => (
                  <tr key={e.id}>
                    <td className="num">{fmtTime(e.start, zone)}</td>
                    <td>
                      <Link to={`/games/${encodeURIComponent(e.id)}`}>
                        {e.away} at {e.home}
                      </Link>
                      {e.gameNumber > 1 && <span className="chip" style={{ marginLeft: 6 }}>Game {e.gameNumber}</span>}
                      {e.rescheduledFrom && <span className="chip chip-warn" style={{ marginLeft: 6 }}>Make-up / rescheduled</span>}
                    </td>
                    <td className="small text-2">
                      {e.league}
                      <div className="subtle">{sportLabel(e.sport)}</div>
                    </td>
                    <td>
                      <span className={`chip ${e.status === "postponed" || e.status === "cancelled" ? "chip-warn" : ""}`}>
                        {statusLabel[e.status] ?? e.status}
                        {e.score ? ` ${e.score}` : ""}
                        {e.resultHidden ? " (hidden)" : ""}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
