import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { qs } from "../api";
import { useApi, useApp } from "../state";
import { ago, fmtDate, fmtTime, localDate, shiftDate } from "../format";
import { Callout, Empty, ErrorBox, ExtLink, FictionalNote, Loading, Tabs } from "../components/ui";

interface EvidenceResp {
  date: string;
  asOf: string;
  news: { id: number; title: string; url: string; source: string; tier: string; claim: string; published_at: string | null; retrieved_at: string; teams: string[]; duplicateOf: number | null }[];
  injuries: { player_name: string; team: string; status: string; detail: string | null; source: string; source_url: string | null; confirmation: string; source_time: string | null; retrieved_at: string }[];
  injuriesChecked: { sport: string; checked: boolean }[];
  conflicts: { player: string; team: string; statements: { title: string; url: string; source: string; claim: string; published_at: string | null; stance: string }[]; injuryStatuses: { status: string; source: string }[] }[];
  lineups: {
    eventId: string;
    start: string;
    status: string;
    home: string;
    away: string;
    homeLineup: { status: string; starter: string | null; source: string; url: string | null; retrieved_at: string } | null;
    awayLineup: { status: string; starter: string | null; source: string; url: string | null; retrieved_at: string } | null;
  }[];
  classificationNote: string;
}

type Tab = "news" | "injuries" | "lineups" | "conflicts";

export default function EvidencePage() {
  const { dataset, asOfParam, clock, zone } = useApp();
  const base = localDate(asOfParam ?? clock, zone);
  const [date, setDate] = useState<string | null>(null);
  const day = date ?? base;
  const [scope, setScope] = useState<"today" | "all">("today");
  const [tab, setTab] = useState<Tab>("news");
  const [tier, setTier] = useState("");
  const [claim, setClaim] = useState("");
  const [showDupes, setShowDupes] = useState(false);
  const { data, error, loading, reload } = useApi<EvidenceResp>(`/api/evidence${qs({ dataset, asOf: asOfParam, date: day, scope })}`);
  const news = useMemo(
    () => (data?.news ?? []).filter((n) => (!tier || n.tier === tier) && (!claim || n.claim === claim) && (showDupes || n.duplicateOf == null)),
    [data, tier, claim, showDupes],
  );
  const dupCount = data?.news.filter((n) => n.duplicateOf != null).length ?? 0;
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Evidence</div>
          <h1>News, injuries and lineups</h1>
          <p>
            Source-linked records with publication and retrieval times. Official sources are preferred, duplicates are grouped, and contradictions are flagged rather than resolved by guessing. Unknown stays unknown.
          </p>
        </div>
        <div className="row">
          <button className="btn btn-sm" onClick={() => setDate(shiftDate(day, -1))}>
            ← Prev
          </button>
          <span className="small">{fmtDate(day)}</span>
          <button className="btn btn-sm" onClick={() => setDate(shiftDate(day, 1))}>
            Next →
          </button>
        </div>
      </div>
      <FictionalNote />
      <Tabs
        label="Evidence type"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "news", label: `News${data ? ` (${data.news.length - dupCount})` : ""}` },
          { id: "injuries", label: `Injuries${data ? ` (${data.injuries.length})` : ""}` },
          { id: "lineups", label: "Lineups & starters" },
          { id: "conflicts", label: `Conflicts${data ? ` (${data.conflicts.length})` : ""}` },
        ]}
      />
      {loading && !data && <Loading />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && (
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === "news" && (
            <div className="stack-sm">
              <div className="row card card-tight">
                <div className="segmented" role="group" aria-label="News scope">
                  <button aria-pressed={scope === "today"} onClick={() => setScope("today")}>
                    Teams playing this day
                  </button>
                  <button aria-pressed={scope === "all"} onClick={() => setScope("all")}>
                    All retrieved
                  </button>
                </div>
                <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  Source tier
                  <select value={tier} onChange={(e) => setTier(e.target.value)}>
                    <option value="">All</option>
                    <option value="official">Official</option>
                    <option value="media">Media</option>
                    <option value="unverified">Unverified</option>
                  </select>
                </label>
                <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  Claim
                  <select value={claim} onChange={(e) => setClaim(e.target.value)}>
                    <option value="">All</option>
                    <option value="official">Official announcement</option>
                    <option value="report">Report</option>
                    <option value="speculation">Speculation</option>
                  </select>
                </label>
                <label className="check">
                  <input type="checkbox" checked={showDupes} onChange={(e) => setShowDupes(e.target.checked)} />
                  Show {dupCount} duplicate(s)
                </label>
              </div>
              <p className="subtle small">{data.classificationNote}</p>
              {!news.length ? (
                <Empty title="No news">No items match, or no feeds are configured for this data source.</Empty>
              ) : (
                news.map((n) => (
                  <article key={n.id} className={`news-item${n.duplicateOf ? " dup" : ""}`}>
                    <ExtLink href={n.url}>{n.title}</ExtLink>
                    <div className="row small" style={{ gap: 6 }}>
                      <span className={`chip ${n.claim === "official" ? "chip-good" : n.claim === "speculation" ? "chip-warn" : ""}`}>{n.claim}</span>
                      <span className="chip">{n.tier}</span>
                      {n.duplicateOf && <span className="chip chip-muted">duplicate of an earlier report</span>}
                      <span className="subtle">
                        {n.source} · published {n.published_at ? `${fmtTime(n.published_at, zone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} (${ago(n.published_at, clock)})` : "time unknown"} · retrieved{" "}
                        {ago(n.retrieved_at, clock)}
                      </span>
                    </div>
                    {n.teams.length > 0 && <div className="subtle small">Teams: {n.teams.join(", ")}</div>}
                  </article>
                ))
              )}
            </div>
          )}
          {tab === "injuries" && (
            <div className="stack-sm">
              {data.injuriesChecked.map((c) => (
                <p key={c.sport} className="small text-2">
                  {c.sport}: {c.checked ? "an injury source was checked by this time." : "no injury source checked by this time, so absence of reports means unknown, not healthy."}
                </p>
              ))}
              {!data.injuries.length ? (
                <Empty title="No active injury reports for teams playing this day" />
              ) : (
                <div className="table-wrap" tabIndex={0}>
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Player</th>
                        <th scope="col">Team</th>
                        <th scope="col">Status</th>
                        <th scope="col">Source</th>
                        <th scope="col">Times</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.injuries.map((i, k) => (
                        <tr key={k}>
                          <td>{i.player_name}</td>
                          <td>{i.team}</td>
                          <td>
                            {i.status.replace(/_/g, " ")}
                            {i.detail && <div className="subtle small">{i.detail}</div>}
                          </td>
                          <td>
                            <ExtLink href={i.source_url}>{i.source}</ExtLink>
                            <div className="subtle small">{i.confirmation}</div>
                          </td>
                          <td className="small">
                            Source: {i.source_time ? ago(i.source_time, clock) : "not given"}
                            <div className="subtle">Retrieved {ago(i.retrieved_at, clock)}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          {tab === "lineups" && (
            <div className="table-wrap" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Game</th>
                    <th scope="col">Away</th>
                    <th scope="col">Home</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lineups.map((l) => (
                    <tr key={l.eventId}>
                      <td>
                        <Link to={`/games/${encodeURIComponent(l.eventId)}`}>
                          {l.away} at {l.home}
                        </Link>
                        <div className="subtle small">{fmtTime(l.start, zone)}</div>
                      </td>
                      {[l.awayLineup, l.homeLineup].map((x, i) => (
                        <td key={i} className="small">
                          {x ? (
                            <>
                              <span className={`chip ${x.status === "confirmed" ? "chip-good" : "chip-warn"}`}>{x.status}</span>
                              {x.starter && <div>Starter: {x.starter}</div>}
                              <div className="subtle">
                                <ExtLink href={x.url}>{x.source}</ExtLink> · {ago(x.retrieved_at, clock)}
                              </div>
                            </>
                          ) : (
                            <span className="chip chip-muted">unknown</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {tab === "conflicts" && (
            <div className="stack-sm">
              {!data.conflicts.length ? (
                <Empty title="No conflicting reports detected" />
              ) : (
                data.conflicts.map((c) => (
                  <Callout key={c.player} kind="warn" title={`${c.player} (${c.team})`}>
                    <ul className="list-bullets" style={{ marginTop: 4 }}>
                      {c.statements.map((s, i) => (
                        <li key={i}>
                          <strong>{s.stance === "unavailable" ? "Says unavailable:" : "Says available:"}</strong> <ExtLink href={s.url}>{s.title}</ExtLink>{" "}
                          <span className="subtle">
                            ({s.source}, {s.claim}, {s.published_at ? ago(s.published_at, clock) : "time unknown"})
                          </span>
                        </li>
                      ))}
                      {c.injuryStatuses.map((s, i) => (
                        <li key={`i${i}`}>
                          Injury record: {s.status.replace(/_/g, " ")} ({s.source})
                        </li>
                      ))}
                    </ul>
                    Conflict detection is a keyword heuristic. Wait for an official lineup or announcement before treating either claim as fact.
                  </Callout>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
