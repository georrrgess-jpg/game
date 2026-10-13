import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, qs, type Analysis, type MarketView, type Outcome, type BoardItem, type ModelPrediction } from "../api";
import { useApi, useApp } from "../state";
import { ago, fmtDateTime, fmtTime, formatAmerican, formatDecimal, formatPct, formatPctPoints, formatPoints, outcomeLabel, sportLabel, statusLabel } from "../format";
import { Callout, CompletenessList, ErrorBox, ExtLink, Loading, ProbRows, TimeStamp, VerdictChip } from "../components/ui";
import { StepLineChart, SERIES } from "../components/charts";
import { IconPrint, IconSpark, IconWarn } from "../components/icons";

export default function GamePage() {
  const { id = "" } = useParams();
  const { dataset, asOfParam, zone } = useApp();
  const { data: a, error, loading, reload } = useApi<Analysis>(`/api/events/${encodeURIComponent(id)}/analysis${qs({ dataset, asOf: asOfParam })}`);
  if (loading && !a) return <Loading rows={5} />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!a) return null;
  const names: Partial<Record<Outcome, string>> = { home: a.event.home_name, away: a.event.away_name, draw: "Draw" };
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">
            <Link to="/games">Games</Link> / {a.event.league}
          </div>
          <h1>
            {a.event.away_name} <span className="subtle" style={{ fontWeight: 500 }}>at</span> {a.event.home_name}
          </h1>
          <div className="meta-line">
            <span>{fmtDateTime(a.event.start_time, zone)}</span>
            {a.event.venue_name && <span>{a.event.venue_name}{a.event.indoor ? " (indoor)" : ""}</span>}
            <span>{sportLabel(a.event.sport_key)}</span>
            {a.event.game_number > 1 && <span>Game {a.event.game_number} of a doubleheader</span>}
            <span>
              {a.infoAsOf !== a.asOf ? `Pre-game information frozen at the scheduled start (${fmtDateTime(a.infoAsOf, zone)})` : `Information as of ${fmtDateTime(a.asOf, zone)}`}
            </span>
          </div>
        </div>
        <div className="row no-print">
          <Link className="btn btn-primary" to={`/lab?event=${encodeURIComponent(a.event.id)}`}>
            Make a classroom forecast
          </Link>
          <button className="btn" onClick={() => window.print()}>
            <IconPrint /> Print report
          </button>
        </div>
      </div>

      <StatusBanner a={a} />

      <div className="grid grid-main">
        <div className="stack">
          <EstimatesCard a={a} names={names} />
          <QuotesCard market={a.market} names={names} asOf={a.infoAsOf} />
          {a.otherMarkets.length > 0 && (
            <div className="card">
              <h2>Other contracts</h2>
              <p className="subtle small">Spreads and totals with different lines are different contracts. They are shown for comparison only and are never mixed with the moneyline or with each other.</p>
              <div className="stack">
                {a.otherMarkets.map((m) => (
                  <QuotesTable key={m.contractId} market={m} names={names} />
                ))}
              </div>
            </div>
          )}
          <HistoryCard a={a} names={names} />
          <ExplainCard a={a} />
          <WhatIfCard a={a} names={names} />
        </div>
        <div className="stack">
          <div className="card">
            <h2>Data completeness</h2>
            <CompletenessList items={a.completeness.items} />
            <p className="subtle small" style={{ marginTop: 10 }}>
              Completeness describes which inputs exist. It is not a confidence score and does not change any probability.
            </p>
          </div>
          <ModelCard a={a} />
          <EvidenceCard a={a} />
          <SourcesCard a={a} />
        </div>
      </div>
    </div>
  );
}

function StatusBanner({ a }: { a: Analysis }) {
  if (a.resultHidden) return <Callout kind="info" title="Result hidden by the instructor.">The game is final, but results are hidden for this class.</Callout>;
  if (a.status.voided)
    return (
      <Callout kind="warn" title={`${statusLabel[a.event.status]}.`}>
        Postponed and cancelled games are void for every contract here: simulation points are returned and the game is excluded from scoring. A make-up game is a new event.
      </Callout>
    );
  if (a.status.resultKnown)
    return (
      <Callout kind="info" title={`Final: ${a.event.home_name} ${a.event.home_score} – ${a.event.away_score} ${a.event.away_name}.`}>
        The analysis below still uses only information available before the start time, unless you are replaying a different moment.
      </Callout>
    );
  if (a.status.started) return <Callout kind="info" title="Game started.">Pre-game analysis only. Quotes after the scheduled start are excluded and live scores are not modelled.</Callout>;
  return null;
}

function EstimatesCard({ a, names }: { a: Analysis; names: Partial<Record<Outcome, string>> }) {
  const outcomes = a.market.outcomes;
  return (
    <section className="card" aria-labelledby="est-h">
      <div className="card-head">
        <h2 id="est-h">Estimates</h2>
        <VerdictChip verdict={a.overallVerdict.verdict} />
      </div>
      <p className="text-2 small">{a.overallVerdict.text}</p>
      <div className="stack" style={{ gap: 18 }}>
        {outcomes.map((o) => (
          <ProbRows
            key={o}
            outcome={o}
            name={outcomeLabel(o, names)}
            raw={a.market.bestPrice[o] ? 1 / a.market.bestPrice[o]!.decimal : null}
            market={a.market.reference?.probs[o]}
            model={a.model.probs?.[o]}
            interval={a.model.interval80?.[o] ?? null}
            combined={a.combined.probs?.[o]}
          />
        ))}
      </div>
      <div className="stack-sm" style={{ marginTop: 14 }}>
        {!a.model.available && a.model.reason && <Callout kind="warn" title="No independent forecast.">{a.model.reason}</Callout>}
        {!a.market.reference && a.market.referenceUnavailableReason && <Callout kind="warn" title="No current market reference.">{a.market.referenceUnavailableReason}</Callout>}
        {a.combined.available ? (
          <p className="subtle small">
            Combined estimate = logistic blend of model and market fitted on the validation season (weights {formatPoints(a.combined.weights!.model)} model, {formatPoints(a.combined.weights!.market)} market). It uses market odds as an input, so it is not independent of the market.
          </p>
        ) : (
          a.combined.reason && <p className="subtle small">Combined estimate unavailable: {a.combined.reason}</p>
        )}
        <p className="small">{a.uncertainty}</p>
        {a.discrepancy && (
          <details className="disclosure">
            <summary className="small">Why this verdict?</summary>
            <div className="disclosure-body">
              {Object.entries(a.discrepancy).map(([o, d]) => (
                <p key={o}>
                  <strong>
                    {outcomeLabel(o, names)}: {formatPctPoints(d!.diff)}
                  </strong>{" "}
                  · {d!.reason}
                </p>
              ))}
            </div>
          </details>
        )}
      </div>
      {a.expectedPoints && Object.keys(a.expectedPoints).length > 0 && (
        <div style={{ marginTop: 14 }}>
          <h3>Classroom simulation: expected net points per 1-point stake</h3>
          <div className="table-wrap" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Outcome</th>
                  <th scope="col" className="r">Highest quoted price</th>
                  <th scope="col" className="r">Break-even</th>
                  <th scope="col" className="r">Model probability</th>
                  <th scope="col" className="r">p × d − 1</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(a.expectedPoints).map(([o, e]) => (
                  <tr key={o}>
                    <td>{outcomeLabel(o, names)}</td>
                    <td className="r num">
                      {formatDecimal(e!.atPrice)} <span className="subtle">({e!.book})</span>
                    </td>
                    <td className="r num">{formatPct(e!.breakEven)}</td>
                    <td className="r num">{formatPct(a.model.probs?.[o as Outcome])}</td>
                    <td className="r num">{formatPoints(e!.ev)}</td>
                  </tr>
                ))}
              </tbody>
              <caption>These numbers are only as good as the model probability, and the verdict above says how much to trust it. Simulation points only.</caption>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

export function QuotesTable({ market, names }: { market: MarketView; names: Partial<Record<Outcome, string>> }) {
  const { clock } = useApp();
  const statusChip: Record<string, string> = { current: "chip-good", stale: "chip-warn", incomplete: "chip-muted", after_start: "chip-muted", mismatched_times: "chip-warn" };
  const statusText: Record<string, string> = { current: "Current", stale: "Stale", incomplete: "Incomplete set", after_start: "After start", mismatched_times: "Times differ" };
  return (
    <div className="table-wrap" tabIndex={0}>
      <table>
        <caption>
          {market.label}
          {market.line != null ? ` · line ${market.line > 0 ? "+" : ""}${market.line} (home)` : ""}. Raw implied = 1 / decimal (includes margin). Adjusted = this book's own set with its margin removed proportionally.
        </caption>
        <thead>
          <tr>
            <th scope="col">Book</th>
            {market.outcomes.map((o) => (
              <th scope="col" key={o} className="r">
                {outcomeLabel(o, names)}
              </th>
            ))}
            <th scope="col" className="r">Margin</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {market.books.map((b) => (
            <tr key={b.book_key} className={b.status === "current" ? "" : "stale"}>
              <td>
                {b.book_title}
                <div className="subtle small">
                  checked {ago(b.lastConfirmed, clock)} · changed {ago(b.newestSource, clock)}
                </div>
              </td>
              {market.outcomes.map((o) => {
                const q = b.outcomes[o];
                const best = market.bestPrice[o]?.book_key === b.book_key;
                return (
                  <td key={o} className="r num">
                    {q ? (
                      <>
                        <span style={{ fontWeight: best ? 700 : 500 }}>
                          {formatDecimal(q.decimal)} <span className="subtle">{formatAmerican(q.american)}</span>
                        </span>
                        <div className="subtle small">
                          raw {formatPct(q.rawImplied, 1)}
                          {b.noVig?.[o] != null && <> · adj. {formatPct(b.noVig[o], 1)}</>}
                        </div>
                        {best && <span className="chip chip-info" style={{ marginTop: 2 }}>highest</span>}
                      </>
                    ) : (
                      <span className="subtle">—</span>
                    )}
                  </td>
                );
              })}
              <td className="r num">{b.overround != null ? formatPct(b.overround, 1) : "—"}</td>
              <td>
                <span className={`chip ${statusChip[b.status]}`}>{statusText[b.status]}</span>
              </td>
            </tr>
          ))}
          {market.reference && (
            <tr>
              <td>
                <strong>Market reference</strong>
                <div className="subtle small">{market.reference.nBooks} current book(s)</div>
              </td>
              {market.outcomes.map((o) => (
                <td key={o} className="r num">
                  <strong>{formatPct(market.reference!.probs[o], 1)}</strong>
                  {market.reference!.nBooks > 1 && (
                    <div className="subtle small">
                      {formatPct(market.reference!.range[o]?.[0], 1)}–{formatPct(market.reference!.range[o]?.[1], 1)}
                    </div>
                  )}
                </td>
              ))}
              <td className="r">0%</td>
              <td />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function QuotesCard({ market, names, asOf }: { market: MarketView; names: Partial<Record<Outcome, string>>; asOf: string }) {
  const { zone } = useApp();
  return (
    <section className="card" aria-labelledby="q-h">
      <div className="card-head">
        <h2 id="q-h">Quote comparison</h2>
        <span className="subtle small">Connected sources as of {fmtTime(asOf, zone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
      </div>
      {market.books.length ? <QuotesTable market={market} names={names} /> : <p className="subtle">No quotes from connected sources for this contract.</p>}
      {market.reference && <p className="subtle small" style={{ marginTop: 10 }}>{market.reference.method} This is an approximation of the market's view, not a measurement of the true probability.</p>}
      <p className="subtle small">
        "Highest" marks the highest quoted price among connected sources for each outcome. It is only the highest among the sources connected here, not across all sportsbooks.
      </p>
    </section>
  );
}

export function HistoryCard({ a, names }: { a: Analysis; names: Partial<Record<Outcome, string>> }) {
  const { dataset, asOfParam } = useApp();
  const [outcome, setOutcome] = useState<Outcome>(a.market.outcomes[0]);
  const { data, error, loading } = useApi<{ points: { book: string; book_key: string; outcome: string; decimal: number; retrieved_at: string }[]; start: string; asOf: string }>(
    `/api/events/${encodeURIComponent(a.event.id)}/history${qs({ dataset, asOf: asOfParam, contractId: a.market.contractId })}`,
  );
  const series = useMemo(() => {
    if (!data) return [];
    const books = [...new Set(data.points.map((p) => p.book_key))].sort();
    return books.slice(0, 4).map((bk, i) => ({
      key: bk,
      label: data.points.find((p) => p.book_key === bk)!.book,
      color: SERIES[i],
      points: data.points.filter((p) => p.book_key === bk && p.outcome === outcome).map((p) => ({ x: Date.parse(p.retrieved_at), y: 1 / p.decimal })),
    }));
  }, [data, outcome]);
  const nBooks = data ? new Set(data.points.map((p) => p.book_key)).size : 0;
  return (
    <section className="card" aria-labelledby="h-h">
      <div className="card-head">
        <h2 id="h-h">Quote history</h2>
        <div className="segmented" role="group" aria-label="Outcome to chart">
          {a.market.outcomes.map((o) => (
            <button key={o} aria-pressed={outcome === o} onClick={() => setOutcome(o)}>
              {outcomeLabel(o, names)}
            </button>
          ))}
        </div>
      </div>
      {loading && !data ? (
        <Loading rows={1} />
      ) : error ? (
        <ErrorBox error={error} />
      ) : (
        <>
          <StepLineChart
            title={`Raw implied probability for ${outcomeLabel(outcome, names)} by book (includes margin)`}
            yLabel="raw implied probability"
            series={series}
            markers={[
              ...(Date.parse(a.asOf) < Date.parse(a.event.start_time) ? [{ x: Date.parse(a.asOf), label: "as of" }] : []),
              ...(Date.parse(a.event.start_time) <= Date.parse(a.asOf) ? [{ x: Date.parse(a.event.start_time), label: "start" }] : []),
            ]}
          />
          {nBooks > 4 && <p className="subtle small">Showing the first 4 of {nBooks} books; the table view lists them.</p>}
          <p className="subtle small">Only snapshots known by the information time are shown. Historical snapshots depend on the provider and plan; connected live data starts when you first refresh.</p>
        </>
      )}
    </section>
  );
}

function ExplainCard({ a }: { a: Analysis }) {
  const { dataset, asOfParam, status, toast } = useApp();
  const [ai, setAi] = useState<{ source: string; text: string | null; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const aiReady = status?.ai.configured && status.ai.enabled;
  const askAi = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ ai: { source: string; text: string | null; note: string } }>(`/api/events/${encodeURIComponent(a.event.id)}/explain`, { dataset, asOf: asOfParam, useAi: true });
      setAi(r.ai);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const ex = a.explanation;
  const cite = (s: string) => s;
  return (
    <section className="card" aria-labelledby="x-h">
      <div className="card-head">
        <h2 id="x-h">Plain-language explanation</h2>
        <button className="btn btn-sm no-print" onClick={askAi} disabled={busy || !aiReady} title={aiReady ? "Optional AI summary of the computed results" : "AI explanations are off (no key or disabled in Settings)"}>
          <IconSpark /> {busy ? "Writing…" : "AI summary (optional)"}
        </button>
      </div>
      <div className="stack-sm">
        <div>
          <h3>What is the current estimate?</h3>
          <p>{ex.estimate}</p>
        </div>
        <div>
          <h3>Which verified facts support it? (observations)</h3>
          <ul className="list-bullets">{ex.facts.length ? ex.facts.map((f, i) => <li key={i}>{cite(f)}</li>) : <li className="subtle">No verified facts beyond the quotes.</li>}</ul>
        </div>
        <div>
          <h3>Which assumptions matter? (statistical inferences)</h3>
          <ul className="list-bullets">{ex.assumptions.map((f, i) => <li key={i}>{f}</li>)}</ul>
        </div>
        <div>
          <h3>What information is missing?</h3>
          <ul className="list-bullets">{ex.missing.length ? ex.missing.map((f, i) => <li key={i}>{f}</li>) : <li className="subtle">Nothing flagged.</li>}</ul>
        </div>
        <div>
          <h3>What could change the estimate? (hypotheticals)</h3>
          <ul className="list-bullets">{ex.changes.map((f, i) => <li key={i}>{f}</li>)}</ul>
        </div>
      </div>
      {ai && (
        <div className="card card-tight" style={{ marginTop: 12, background: "var(--panel-2)" }}>
          <div className="row-between">
            <strong>{ai.source === "ai" ? "AI summary" : "AI summary not used"}</strong>
            <span className="subtle small">{ai.note}</span>
          </div>
          {ai.text && <div style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{ai.text}</div>}
        </div>
      )}
    </section>
  );
}

function ModelCard({ a }: { a: Analysis }) {
  const p = a.model.prediction;
  const featureLabel: Record<string, string> = { home_advantage: "Home advantage", elo_diff_per_100: "Rating difference (per 100 Elo)", rest_diff_days: "Rest-day difference" };
  return (
    <section className="card" aria-labelledby="m-h">
      <h2 id="m-h">Independent model</h2>
      {!a.model.available || !p ? (
        <p className="text-2">{a.model.reason}</p>
      ) : (
        <>
          <p className="subtle small">
            {a.model.version}. Validation season ends {a.model.trainedThrough?.slice(0, 10)}. <Link to="/report">See the evaluation report.</Link>
          </p>
          <div className="table-wrap" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Input</th>
                  <th scope="col" className="r">Value</th>
                  <th scope="col" className="r">Weight</th>
                  <th scope="col" className="r">Contribution</th>
                </tr>
              </thead>
              <tbody>
                {p.features.map((f) => (
                  <tr key={f.name}>
                    <td>{featureLabel[f.name] ?? f.name}</td>
                    <td className="r num">{f.value.toFixed(2)}</td>
                    <td className="r num">{f.weight === 0 ? "not used" : f.weight.toFixed(2)}</td>
                    <td className="r num">{f.contribution.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
              <caption>
                Ratings: home {Math.round(p.eloHome)}, away {Math.round(p.eloAway)} (from {p.gamesHomeThisSeason} and {p.gamesAwayThisSeason} games this season). Contributions add up on the log-odds scale.
              </caption>
            </table>
          </div>
          <ul className="list-bullets small text-2" style={{ marginTop: 10 }}>
            {a.model.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function EvidenceCard({ a }: { a: Analysis }) {
  const { clock } = useApp();
  const ev = a.evidence;
  return (
    <section className="card" aria-labelledby="e-h">
      <h2 id="e-h">Evidence</h2>
      {ev.conflicts.length > 0 && (
        <div className="stack-sm" style={{ marginBottom: 12 }}>
          {ev.conflicts.map((c) => (
            <Callout key={c.player} kind="warn" title={`Conflicting reports: ${c.player}.`}>
              <ul className="list-bullets" style={{ marginTop: 4 }}>
                {c.statements.map((s, i) => (
                  <li key={i}>
                    <ExtLink href={s.url}>{s.title}</ExtLink> <span className="subtle">({s.source}, {s.claim})</span>
                  </li>
                ))}
                {c.injuryStatuses.map((s, i) => (
                  <li key={`s${i}`}>
                    Status "{s.status.replace(/_/g, " ")}" per {s.source}
                  </li>
                ))}
              </ul>
              Treat availability as unknown until an official source confirms it.
            </Callout>
          ))}
        </div>
      )}
      <h3>Lineups &amp; starters</h3>
      {ev.lineups.length ? (
        <ul className="list-plain small" style={{ marginBottom: 12 }}>
          {ev.lineups.map((l) => (
            <li key={l.team_name}>
              <span className={`chip ${l.status === "confirmed" ? "chip-good" : "chip-warn"}`}>{l.status}</span> <strong>{l.team_name}</strong>
              {l.starter && <> · starter {l.starter} ({l.starter_status})</>}
              <div className="subtle">
                <ExtLink href={l.source_url}>{l.source}</ExtLink> · retrieved {ago(l.retrieved_at, clock)}
              </div>
              {l.playersParsed.length > 0 && (
                <details className="disclosure" style={{ marginTop: 4 }}>
                  <summary className="small">Batting order</summary>
                  <ol className="disclosure-body" style={{ margin: 0 }}>
                    {l.playersParsed.map((p, i) => (
                      <li key={i}>
                        {p.name} {p.position && <span className="subtle">{p.position}</span>}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="subtle small">Not announced or not available: unknown. Lineups are never guessed.</p>
      )}
      <h3>Injuries</h3>
      {ev.injuries.length ? (
        <ul className="list-plain small" style={{ marginBottom: 12 }}>
          {ev.injuries.map((i, k) => (
            <li key={k}>
              <strong>{i.player_name}</strong> ({i.team_name}): {i.status.replace(/_/g, " ")}
              {i.detail && <span className="text-2"> · {i.detail}</span>}
              <div className="subtle">
                <ExtLink href={i.source_url}>{i.source}</ExtLink> · {i.confirmation} · retrieved {ago(i.retrieved_at, clock)}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="subtle small">{a.completeness.items.find((x) => x.key === "injuries")?.detail ?? "None reported."}</p>
      )}
      <p className="subtle small">Injuries are evidence, not model inputs. No numeric effect is assumed without a validated method.</p>
      <h3>News (last 7 days)</h3>
      {ev.news.length ? (
        <div className="stack-sm">
          {ev.news.filter((n) => !n.isDuplicate).slice(0, 10).map((n) => (
            <div key={n.id} className="news-item">
              <ExtLink href={n.url}>{n.title}</ExtLink>
              <div className="row small" style={{ gap: 6 }}>
                <span className={`chip ${n.claim_type === "official" ? "chip-good" : n.claim_type === "speculation" ? "chip-warn" : ""}`}>{n.claim_type}</span>
                <span className="subtle">
                  {n.source_name} · {n.published_at ? ago(n.published_at, clock) : "no publication time"}
                  {n.duplicateCount > 0 && ` · ${n.duplicateCount} similar report(s) grouped`}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="subtle small">No news retrieved for these teams.</p>
      )}
      <h3 style={{ marginTop: 12 }}>Weather</h3>
      {!ev.weatherRelevant ? (
        <p className="subtle small">Not relevant (indoor venue or indoor sport).</p>
      ) : ev.weather ? (
        <p className="small">
          {ev.weather.temperature_c ?? "?"}°C · {ev.weather.precip_probability ?? "?"}% chance of precipitation · wind {ev.weather.wind_kph ?? "?"} km/h at start time.{" "}
          <span className="subtle">
            {ev.weather.source} · retrieved {ago(ev.weather.retrieved_at, clock)}
          </span>
          {ev.weather.source.includes("Open-Meteo") && (
            <>
              {" "}
              · <ExtLink href="https://open-meteo.com/">Weather data by Open-Meteo.com</ExtLink>
            </>
          )}
        </p>
      ) : (
        <p className="subtle small">No forecast retrieved.</p>
      )}
    </section>
  );
}

function SourcesCard({ a }: { a: Analysis }) {
  if (!a.sources.length) return null;
  return (
    <section className="card" aria-labelledby="s-h">
      <h2 id="s-h">Source records</h2>
      <ol className="list-plain small">
        {a.sources.map((s) => (
          <li key={s.id}>
            <span className="kbd">{s.id}</span> <ExtLink href={s.url}>{s.title}</ExtLink>
            <div className="subtle">
              {s.source} · {s.tier} · <TimeStamp iso={s.time} />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------- what-if ----------------
interface WhatIfResult {
  baseline: BoardItem;
  scenario: BoardItem;
  baselinePrediction: ModelPrediction | null;
  scenarioPrediction: ModelPrediction | null;
  recomputed: string[];
  notes: string[];
  price: { decimal: number; breakEven: number; rawImplied: number; evModel: number | null; evMarket: number | null; note: string } | null;
}

function WhatIfCard({ a, names }: { a: Analysis; names: Partial<Record<Outcome, string>> }) {
  const { dataset, asOfParam, toast } = useApp();
  const supported = a.model.available;
  const [neutral, setNeutral] = useState(false);
  const [rest, setRest] = useState<number | null>(null);
  const [adjHome, setAdjHome] = useState(0);
  const [adjAway, setAdjAway] = useState(0);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [priceOutcome, setPriceOutcome] = useState<Outcome>(a.market.outcomes[0]);
  const [priceFormat, setPriceFormat] = useState<"american" | "decimal">("american");
  const [priceValue, setPriceValue] = useState("");
  const [push, setPush] = useState(0);
  const [result, setResult] = useState<WhatIfResult | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: players } = useApi<{ home: { name: string; players: { id: string; name: string; position: string | null; role: string | null }[] }; away: { name: string; players: { id: string; name: string; position: string | null; role: string | null }[] } }>(
    `/api/events/${encodeURIComponent(a.event.id)}/players${qs({ dataset, asOf: asOfParam })}`,
  );

  const run = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { dataset, asOf: asOfParam };
      if (supported) {
        body.neutral = neutral;
        if (rest !== null) body.restDiff = rest;
        body.ratingAdjust = { home: adjHome, away: adjAway };
      }
      if (unavailable.length) body.unavailablePlayers = unavailable;
      if (priceValue.trim()) body.price = { outcome: priceOutcome, format: priceFormat, value: priceValue.trim() };
      if (push > 0) body.pushProbability = push / 100;
      setResult(await api.post<WhatIfResult>(`/api/events/${encodeURIComponent(a.event.id)}/whatif`, body));
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card hypothetical" aria-labelledby="w-h">
      <div className="hypo-label">Hypothetical: classroom what-if</div>
      <h2 id="w-h" style={{ marginTop: 4 }}>
        What-if scenarios
      </h2>
      <p className="small text-2">
        Inputs here are hypothetical and kept separate from confirmed facts. Only inputs the model actually uses are recomputed. Manual adjustments are labelled experimental. Nothing here is saved or changes the analysis above.
      </p>
      <div className="grid grid-2">
        <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }} disabled={!supported}>
          <legend className="small" style={{ fontWeight: 650 }}>
            Model inputs {supported ? "(recomputed)" : "(no model for this game)"}
          </legend>
          <label className="check">
            <input type="checkbox" checked={neutral} onChange={(e) => setNeutral(e.target.checked)} />
            Play at a neutral site (removes home advantage)
          </label>
          <label className="field">
            Rest-day difference (home minus away): {rest === null ? "as scheduled" : rest}
            <input type="range" min={-3} max={3} step={1} value={rest ?? 0} onChange={(e) => setRest(Number(e.target.value))} />
          </label>
          <div className="callout callout-hypo small">
            <div>
              <strong>Experimental manual rating adjustment.</strong> Chosen by you, not estimated by the model.
              <label className="field" style={{ marginTop: 6 }}>
                {a.event.home_name}: {adjHome > 0 ? "+" : ""}
                {adjHome} Elo
                <input type="range" min={-150} max={150} step={5} value={adjHome} onChange={(e) => setAdjHome(Number(e.target.value))} />
              </label>
              <label className="field">
                {a.event.away_name}: {adjAway > 0 ? "+" : ""}
                {adjAway} Elo
                <input type="range" min={-150} max={150} step={5} value={adjAway} onChange={(e) => setAdjAway(Number(e.target.value))} />
              </label>
            </div>
          </div>
        </fieldset>
        <div className="stack-sm">
          <div className="small" style={{ fontWeight: 650 }}>
            Player availability (hypothetical)
          </div>
          {players && (players.home.players.length || players.away.players.length) ? (
            <details className="disclosure">
              <summary className="small">Mark players as unavailable ({unavailable.length})</summary>
              <div className="disclosure-body grid grid-2" style={{ gap: 6 }}>
                {[players.away, players.home].map((t) => (
                  <div key={t.name} className="stack-sm" style={{ gap: 4 }}>
                    <strong className="small">{t.name}</strong>
                    {t.players.map((p) => (
                      <label key={p.id} className="check small">
                        <input
                          type="checkbox"
                          checked={unavailable.includes(p.name)}
                          onChange={(e) => setUnavailable((u) => (e.target.checked ? [...u, p.name] : u.filter((x) => x !== p.name)))}
                        />
                        {p.name} <span className="subtle">{p.position}</span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            </details>
          ) : (
            <p className="subtle small">No roster data for these teams.</p>
          )}
          <p className="subtle small">The model has no validated player-impact estimate, so marking a player unavailable changes nothing on its own. Use the experimental adjustment if you want to explore an effect.</p>
          <div className="small" style={{ fontWeight: 650, marginTop: 6 }}>
            Price calculator
          </div>
          <div className="row">
            <select aria-label="Outcome for price" value={priceOutcome} onChange={(e) => setPriceOutcome(e.target.value as Outcome)}>
              {a.market.outcomes.map((o) => (
                <option key={o} value={o}>
                  {outcomeLabel(o, names)}
                </option>
              ))}
            </select>
            <select aria-label="Price format" value={priceFormat} onChange={(e) => setPriceFormat(e.target.value as "american" | "decimal")}>
              <option value="american">American</option>
              <option value="decimal">Decimal</option>
            </select>
            <input type="text" inputMode="decimal" aria-label="Hypothetical price" placeholder={priceFormat === "american" ? "e.g. +120 or -135" : "e.g. 2.20"} value={priceValue} onChange={(e) => setPriceValue(e.target.value)} style={{ width: 130 }} />
          </div>
          <label className="field">
            Push / refund probability (teaching EV with pushes): {push}%
            <input type="range" min={0} max={20} step={1} value={push} onChange={(e) => setPush(Number(e.target.value))} />
          </label>
        </div>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn btn-primary" onClick={run} disabled={busy}>
          {busy ? "Computing…" : "Compute scenario"}
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => {
            setNeutral(false);
            setRest(null);
            setAdjHome(0);
            setAdjAway(0);
            setUnavailable([]);
            setPriceValue("");
            setPush(0);
            setResult(null);
          }}
        >
          Reset
        </button>
      </div>
      {result && (
        <div className="stack-sm" style={{ marginTop: 14 }} aria-live="polite">
          <div className="table-wrap" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Outcome</th>
                  <th scope="col" className="r">Confirmed-data model</th>
                  <th scope="col" className="r">Hypothetical scenario</th>
                  <th scope="col" className="r">Change</th>
                </tr>
              </thead>
              <tbody>
                {a.market.outcomes.map((o) => {
                  const b = result.baseline.model?.probs[o];
                  const s = result.scenario.model?.probs[o];
                  return (
                    <tr key={o}>
                      <td>{outcomeLabel(o, names)}</td>
                      <td className="r num">{formatPct(b)}</td>
                      <td className="r num">
                        <strong>{formatPct(s)}</strong>
                      </td>
                      <td className="r num">{b != null && s != null ? formatPctPoints(s - b) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {result.recomputed.map((r, i) => (
            <p key={i} className="small">
              • {r}
            </p>
          ))}
          {result.notes.map((r, i) => (
            <p key={i} className="small text-2">
              • {r}
            </p>
          ))}
          {result.price && (
            <div className="card card-tight">
              <strong>Hypothetical price {formatDecimal(result.price.decimal)}</strong>
              <div className="small">
                Break-even probability {formatPct(result.price.breakEven, 1)} (= 1/d). Expected net points per 1-point stake using the model: {formatPoints(result.price.evModel)}; using the market reference: {formatPoints(result.price.evMarket)}.
              </div>
              <div className="subtle small">{result.price.note}</div>
            </div>
          )}
        </div>
      )}
      {!supported && <Callout kind="warn">No independent model for this game, so scenario probabilities cannot be recomputed. The price calculator still works.</Callout>}
      {a.status.started && (
        <p className="subtle small" style={{ marginTop: 8 }}>
          <IconWarn style={{ width: 14, height: 14, verticalAlign: "-2px" }} /> The game has started; scenarios are for learning only.
        </p>
      )}
    </section>
  );
}
