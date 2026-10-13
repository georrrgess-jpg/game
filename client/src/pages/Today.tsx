import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, qs, type Board, type BoardItem, type Outcome, type StepResult } from "../api";
import { useApi, useApp } from "../state";
import { ago, fmtDate, fmtTime, formatAmerican, formatDecimal, formatPct, formatPctPoints, localDate, outcomeLabel, shiftDate, sportLabel, statusLabel } from "../format";
import { Callout, CompletenessMeter, Empty, ErrorBox, FictionalNote, Loading, ProbBar, Stat, Tabs, VerdictChip } from "../components/ui";
import { IconDownload, IconPrint, IconRefresh, IconSpark, IconWarn } from "../components/icons";

type View = "likely" | "price" | "gap";

interface Filters {
  sport: string;
  league: string;
  fromHour: number;
  toHour: number;
  contract: string;
  freshOnly: boolean;
  minInputs: number;
  hideStarted: boolean;
}

const DEFAULT_FILTERS: Filters = { sport: "", league: "", fromHour: 0, toHour: 24, contract: "", freshOnly: false, minInputs: 0, hideStarted: false };

function hourIn(iso: string, zone: string): number {
  const h = new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: zone }).format(new Date(iso));
  return Number(h);
}

export function TodayPage() {
  const { dataset, asOfParam, zone, clock, mode, toast, bumpData, status } = useApp();
  const baseDate = localDate(asOfParam ?? clock, zone);
  const [date, setDate] = useState<string | null>(null);
  const day = date ?? baseDate;
  const [view, setView] = useState<View>("likely");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [priceOutcome, setPriceOutcome] = useState<"home" | "away" | "draw" | "favorite" | "underdog">("home");
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<StepResult[] | null>(null);
  const [snapshotNote, setSnapshotNote] = useState<string | null>(null);
  const url = `/api/board${qs({ dataset, asOf: asOfParam, date: day })}`;
  const { data: board, error, loading, reload } = useApi<Board>(url);

  const analyze = async () => {
    setRunning(true);
    setSteps(null);
    try {
      const r = await api.post<{ board: Board; refresh: StepResult[]; snapshot: { recorded: number; abstentions: number; skipped: number } | null }>("/api/analyze-today", {
        dataset,
        date: day,
        asOf: asOfParam,
      });
      setSteps(r.refresh);
      setSnapshotNote(
        r.snapshot
          ? `Recorded ${r.snapshot.recorded} system forecast(s) and ${r.snapshot.abstentions} abstention(s) with immutable timestamps (${r.snapshot.skipped} skipped: started, void, or already recorded this hour).`
          : "Replay mode: nothing is recorded to the forward track record.",
      );
      bumpData();
      toast(`Analysis complete: ${r.board.items.length} game(s).`);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setRunning(false);
    }
  };

  const items = useMemo(() => {
    if (!board) return [];
    return board.items.filter((i) => {
      if (filters.sport && i.sport !== filters.sport) return false;
      if (filters.league && i.league !== filters.league) return false;
      if (filters.contract && i.contract !== filters.contract) return false;
      if (filters.freshOnly && !i.market) return false;
      if (i.completeness.available < filters.minInputs) return false;
      if (filters.hideStarted && (i.started || i.voided)) return false;
      const h = hourIn(i.start, zone);
      if (h < filters.fromHour || h >= filters.toHour) return false;
      return true;
    });
  }, [board, filters, zone]);

  const sports = [...new Set(board?.items.map((i) => i.sport) ?? [])];
  const leagues = [...new Set(board?.items.map((i) => i.league) ?? [])];
  const contracts = [...new Map(board?.items.map((i) => [i.contract, i.contractShort]) ?? []).entries()];
  const liveWithoutData = dataset === "live" && status && status.liveEvents === 0;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Daily research board</div>
          <h1>{fmtDate(day)}</h1>
          <p>
            Three different questions, answered separately: which outcome is most likely, where the highest quoted price is, and where an independent model disagrees with the market. Each is labelled with its information time, coverage and uncertainty.
          </p>
        </div>
        <div className="row no-print">
          <button className="btn btn-primary btn-hero" onClick={analyze} disabled={running} aria-describedby="analyze-help">
            {running ? <IconRefresh className="spin" /> : <IconSpark />}
            {running ? "Analyzing…" : mode === "replay" ? "Analyze this replay day" : "Analyze Today"}
          </button>
        </div>
      </div>
      <p id="analyze-help" className="sr-only">
        {dataset === "live" ? "Refreshes connected providers within your quotas, then recomputes every game." : "Recomputes every game from the demo data as of the demo clock."}
      </p>

      <FictionalNote />
      {liveWithoutData && (
        <Callout kind="warn" title="No connected data yet.">
          Connected mode shows only data fetched from providers you configure. Nothing is filled in with demo data. Open <Link to="/settings">Settings</Link> to enable the MLB Stats API (no key) and/or add an Odds API key, then press Analyze Today.
        </Callout>
      )}

      <div className="row no-print" role="group" aria-label="Choose day">
        <button className="btn btn-sm" onClick={() => setDate(shiftDate(day, -1))}>
          ← Previous day
        </button>
        <input type="date" aria-label="Board date" value={day} onChange={(e) => e.target.value && setDate(e.target.value)} />
        <button className="btn btn-sm" onClick={() => setDate(shiftDate(day, 1))}>
          Next day →
        </button>
        {date && date !== baseDate && (
          <button className="btn btn-sm btn-ghost" onClick={() => setDate(null)}>
            Back to today
          </button>
        )}
        <span className="topbar-spacer" />
        <a className="btn btn-sm" href={`/api/board.csv${qs({ dataset, asOf: asOfParam, date: day })}`} download>
          <IconDownload /> CSV
        </a>
        <button className="btn btn-sm" onClick={() => window.print()}>
          <IconPrint /> Print
        </button>
      </div>

      {steps && steps.length > 0 && (
        <div className="card card-tight" aria-live="polite">
          <h3>Refresh results</h3>
          <ul className="list-plain small">
            {steps.map((s, i) => (
              <li key={i} className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
                <span className={`chip ${s.ok ? "chip-good" : s.skipped ? "chip-muted" : "chip-danger"}`}>{s.ok ? "OK" : s.skipped ? "Skipped" : "Failed"}</span>
                <span>
                  <strong>{s.step}</strong> <span className="text-2">{s.detail}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="subtle small" style={{ marginTop: 8 }}>
            Partial outages are expected; each provider is refreshed independently and failures never fill in invented data.
          </p>
        </div>
      )}
      {snapshotNote && <Callout kind="info">{snapshotNote}</Callout>}

      {loading && !board && <Loading rows={4} />}
      {error && <ErrorBox error={error} onRetry={reload} />}

      {board && (
        <>
          <div className="card">
            <div className="grid grid-4">
              <Stat label="Games" value={board.coverage.events} sub={`${board.coverage.voided} void · ${board.coverage.started} started`} />
              <Stat label="With a current market reference" value={board.coverage.withCurrentMarket} sub={`quotes ≤ stale limit`} />
              <Stat label="With an independent model" value={board.coverage.withModel} sub="others: market reference only" />
              <Stat label="Research leads" value={board.coverage.researchLeads} sub="never filled to a quota" />
            </div>
            <div className="meta-line" style={{ marginTop: 12 }}>
              <span>As of {fmtTime(board.asOf, zone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</span>
              <span>
                Local day {board.window.hours !== 24 ? <strong>({board.window.hours} h, DST change)</strong> : null} in {board.zone}
              </span>
              <span>Books seen: {board.coverage.books.length ? board.coverage.books.join(", ") : "none"}</span>
            </div>
            {board.notes.map((n) => (
              <p key={n} className="small text-2" style={{ marginTop: 8, marginBottom: 0 }}>
                {n}
              </p>
            ))}
          </div>

          <details className="disclosure">
            <summary>Why are these three different questions?</summary>
            <div className="disclosure-body">
              <p>
                <strong>Most likely</strong> asks which outcome has the highest probability. <strong>Highest quoted price</strong> asks which connected source pays the most if that outcome happens. <strong>Model vs market</strong> asks whether an independent estimate disagrees with the margin-adjusted market.
              </p>
              <p>
                A favourite can be very likely to win while its price is still poor value: at decimal odds 1.30 you need a win probability above 77% just to break even. A higher price is not "better" if it only reflects a lower chance. A model–market gap matters only when the model has a track record of beating the market, which most models do not.
              </p>
            </div>
          </details>

          <fieldset className="card card-tight no-print" style={{ border: "1px solid var(--border)" }}>
            <legend className="sr-only">Filters</legend>
            <div className="row" style={{ alignItems: "flex-end" }}>
              <label className="field">
                Sport
                <select value={filters.sport} onChange={(e) => setFilters({ ...filters, sport: e.target.value })}>
                  <option value="">All sports</option>
                  {sports.map((s) => (
                    <option key={s} value={s}>
                      {sportLabel(s)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                League
                <select value={filters.league} onChange={(e) => setFilters({ ...filters, league: e.target.value })}>
                  <option value="">All leagues</option>
                  {leagues.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Market
                <select value={filters.contract} onChange={(e) => setFilters({ ...filters, contract: e.target.value })}>
                  <option value="">All markets</option>
                  {contracts.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Start from
                <select value={filters.fromHour} onChange={(e) => setFilters({ ...filters, fromHour: Number(e.target.value) })}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, "0")}:00
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                to before
                <select value={filters.toHour} onChange={(e) => setFilters({ ...filters, toHour: Number(e.target.value) })}>
                  {Array.from({ length: 24 }, (_, h) => h + 1).map((h) => (
                    <option key={h} value={h}>
                      {h === 24 ? "24:00" : `${String(h).padStart(2, "0")}:00`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Min. inputs available
                <select value={filters.minInputs} onChange={(e) => setFilters({ ...filters, minInputs: Number(e.target.value) })}>
                  {[0, 1, 2, 3, 4, 5, 6].map((n) => (
                    <option key={n} value={n}>
                      {n === 0 ? "Any" : `${n}+`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="check">
                <input type="checkbox" checked={filters.freshOnly} onChange={(e) => setFilters({ ...filters, freshOnly: e.target.checked })} />
                Current quotes only
              </label>
              <label className="check">
                <input type="checkbox" checked={filters.hideStarted} onChange={(e) => setFilters({ ...filters, hideStarted: e.target.checked })} />
                Hide started / void
              </label>
              {JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS) && (
                <button className="btn btn-sm btn-ghost" onClick={() => setFilters(DEFAULT_FILTERS)}>
                  Clear filters
                </button>
              )}
            </div>
          </fieldset>

          <Tabs
            label="Board views"
            value={view}
            onChange={setView}
            tabs={[
              { id: "likely", label: "Most likely outcomes" },
              { id: "price", label: "Highest quoted price" },
              { id: "gap", label: "Model vs market" },
            ]}
          />
          <div role="tabpanel" id={`panel-${view}`} aria-labelledby={`tab-${view}`}>
            {!items.length ? (
              <Empty title={board.items.length ? "No games match these filters" : "No games on this day"}>
                {board.items.length ? "Clear the filters to see all games." : "That is a valid result: nothing to analyze is not an error."}
              </Empty>
            ) : view === "likely" ? (
              <LikelyView items={items} />
            ) : view === "price" ? (
              <PriceView items={items} outcome={priceOutcome} setOutcome={setPriceOutcome} />
            ) : (
              <GapView items={items} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function GameMeta({ i }: { i: BoardItem }) {
  const { zone, clock } = useApp();
  return (
    <div className="meta-line">
      <span>{fmtTime(i.start, zone, { weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</span>
      <span>{i.league}</span>
      <span>{i.contractShort}</span>
      {i.newestQuote && <span>Quotes as of {ago(i.newestQuote, clock)}</span>}
    </div>
  );
}

function StatusChip({ i }: { i: BoardItem }) {
  if (i.voided) return <span className="chip chip-warn">{statusLabel[i.status] ?? i.status} · void</span>;
  if (i.resultHidden) return <span className="chip chip-muted">Final · result hidden</span>;
  if (i.resultKnown) return <span className="chip">Final {i.score}</span>;
  if (i.started) return <span className="chip chip-muted">Started: pre-game analysis closed</span>;
  return null;
}

function LikelyView({ items }: { items: BoardItem[] }) {
  const sorted = [...items].sort((a, b) => {
    const pa = a.primary.probs && a.primary.mostLikely ? a.primary.probs[a.primary.mostLikely]! : -1;
    const pb = b.primary.probs && b.primary.mostLikely ? b.primary.probs[b.primary.mostLikely]! : -1;
    return pb - pa;
  });
  return (
    <div className="stack-sm" style={{ gap: 12 }}>
      <p className="subtle small">Sorted by the highest outcome probability. Uses the independent model where one exists, otherwise the margin-adjusted market reference (labelled on each card).</p>
      {sorted.map((i, idx) => {
        const o = i.primary.mostLikely;
        const p = o && i.primary.probs ? i.primary.probs[o] : null;
        return (
          <article key={i.eventId} className={`game-card${i.voided ? " voided" : ""}`} style={{ animationDelay: `${Math.min(idx, 10) * 30}ms` }} aria-labelledby={`g-${i.eventId}`}>
            <div className="stack-sm">
              <div className="row" style={{ gap: 8 }}>
                <h3 className="teams" id={`g-${i.eventId}`} style={{ margin: 0 }}>
                  <Link to={`/games/${encodeURIComponent(i.eventId)}`}>
                    {i.away}
                    <span className="at">at</span>
                    {i.home}
                  </Link>
                </h3>
                <StatusChip i={i} />
                {i.evidence.conflicts > 0 && (
                  <span className="chip chip-warn">
                    <IconWarn /> Conflicting reports
                  </span>
                )}
              </div>
              <GameMeta i={i} />
              <ProbBar probs={i.primary.probs} outcomes={[...i.outcomes].reverse()} names={i.outcomeNames} />
              <div className="row small text-2" style={{ gap: "4px 14px" }}>
                {[...i.outcomes].reverse().map((oo) => (
                  <span key={oo}>
                    {outcomeLabel(oo, i.outcomeNames)} <span className="num">{formatPct(i.primary.probs?.[oo])}</span>
                  </span>
                ))}
              </div>
              <div className="row">
                <CompletenessMeter available={i.completeness.available} applicable={i.completeness.applicable} items={i.completeness.items} />
                <span className="chip">{i.evidence.lineups === "confirmed" ? "Lineups confirmed" : i.evidence.lineups === "partial" ? "Lineups partial" : "Lineups unknown"}</span>
                {i.evidence.injuries > 0 && <span className="chip">{i.evidence.injuries} injury report(s)</span>}
                {i.evidence.weather && <span className="chip">{i.evidence.weather}</span>}
              </div>
              <details className="disclosure">
                <summary className="small">Uncertainty and sources</summary>
                <div className="disclosure-body">
                  <p>{i.uncertainty}</p>
                  {!i.model && i.modelUnavailable && <p className="subtle">{i.modelUnavailable}</p>}
                  {!i.market && i.marketUnavailable && <p className="subtle">{i.marketUnavailable}</p>}
                </div>
              </details>
            </div>
            <div>
              {i.voided ? (
                <div className="big-prob-label" style={{ maxWidth: 160 }}>
                  Void: no forecast is scored for a postponed or cancelled game
                </div>
              ) : o && p != null ? (
                <>
                  <div className="big-prob num">{formatPct(p)}</div>
                  <div className="big-prob-label">
                    {outcomeLabel(o, i.outcomeNames)}
                    <br />
                    {i.primary.source === "model" ? "independent model" : "market reference"}
                  </div>
                </>
              ) : (
                <div className="big-prob-label" style={{ maxWidth: 160 }}>
                  No estimate: no model and no current market
                </div>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function PriceView({ items, outcome, setOutcome }: { items: BoardItem[]; outcome: "home" | "away" | "draw" | "favorite" | "underdog"; setOutcome: (o: any) => void }) {
  const { zone, clock } = useApp();
  const [sort, setSort] = useState<"time" | "price">("time");
  const rows = items
    .map((i) => {
      let o: Outcome | null = null;
      if (outcome === "home" || outcome === "away") o = outcome;
      else if (outcome === "draw") o = i.outcomes.includes("draw") ? "draw" : null;
      else {
        const ref = i.market?.probs ?? i.primary.probs;
        if (ref) {
          const two = i.outcomes.filter((x) => x !== "draw");
          const fav = two.reduce((a, b) => ((ref[b] ?? 0) > (ref[a] ?? 0) ? b : a));
          o = outcome === "favorite" ? fav : two.find((x) => x !== fav) ?? null;
        }
      }
      return { i, o, bp: o ? i.bestPrice[o] : undefined };
    })
    .sort((a, b) => (sort === "price" ? (b.bp?.decimal ?? 0) - (a.bp?.decimal ?? 0) : a.i.start.localeCompare(b.i.start)));
  return (
    <div className="stack-sm" style={{ gap: 12 }}>
      <div className="row no-print">
        <div className="segmented" role="group" aria-label="Outcome">
          {(["home", "away", "draw", "favorite", "underdog"] as const).map((o) => (
            <button key={o} aria-pressed={outcome === o} onClick={() => setOutcome(o)}>
              {o === "home" ? "Home team" : o === "away" ? "Away team" : o === "draw" ? "Draw (3-way)" : o === "favorite" ? "Market favourite" : "Market underdog"}
            </button>
          ))}
        </div>
        <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value as "time" | "price")}>
            <option value="time">By start time</option>
            <option value="price">By price (highest first)</option>
          </select>
        </label>
      </div>
      <Callout kind="info">
        Each price is the <strong>highest quoted price among connected sources</strong> at the stated time, for the same contract only. It is not a recommendation: a high price usually reflects a low probability. Stale quotes are excluded.
      </Callout>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Game</th>
              <th scope="col">Outcome</th>
              <th scope="col" className="r">Highest price</th>
              <th scope="col">Source &amp; time</th>
              <th scope="col" className="r">Break-even</th>
              <th scope="col" className="r">Market ref.</th>
              <th scope="col" className="r">Model</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ i, o, bp }) => (
              <tr key={i.eventId}>
                <td>
                  <Link to={`/games/${encodeURIComponent(i.eventId)}`}>
                    {i.away} at {i.home}
                  </Link>
                  <div className="subtle small">{fmtTime(i.start, zone, { hour: "numeric", minute: "2-digit" })} · {i.contractShort}</div>
                </td>
                <td>{o ? outcomeLabel(o, i.outcomeNames) : <span className="subtle">n/a for this market</span>}</td>
                <td className="r num">
                  {bp ? (
                    <>
                      <strong>{formatDecimal(bp.decimal)}</strong>
                      <div className="subtle">{formatAmerican(bp.american)}</div>
                    </>
                  ) : (
                    <span className="subtle">No current quote</span>
                  )}
                </td>
                <td className="small">
                  {bp ? (
                    <>
                      {bp.book_title}
                      <div className="subtle">
                        Highest quoted price among connected sources as of {fmtTime(bp.retrieved_at, zone, { hour: "numeric", minute: "2-digit" })} (last changed {ago(bp.source_time, clock)})
                      </div>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="r num">{bp ? formatPct(1 / bp.decimal) : "—"}</td>
                <td className="r num">{o ? formatPct(i.market?.probs[o]) : "—"}</td>
                <td className="r num">{o ? formatPct(i.model?.probs[o]) : "—"}</td>
              </tr>
            ))}
          </tbody>
          <caption>Break-even = 1 / decimal price. A price is only interesting if your probability is above its break-even, and that requires evidence.</caption>
        </table>
      </div>
    </div>
  );
}

function GapView({ items }: { items: BoardItem[] }) {
  const withGap = items
    .filter((i) => i.discrepancy)
    .map((i) => {
      const entries = Object.entries(i.discrepancy!) as [Outcome, NonNullable<BoardItem["discrepancy"]>[Outcome]][];
      const top = entries.reduce((a, b) => (Math.abs(b[1]!.diff) > Math.abs(a[1]!.diff) ? b : a));
      return { i, o: top[0], d: top[1]! };
    })
    .sort((a, b) => Math.abs(b.d.diff) - Math.abs(a.d.diff));
  const without = items.filter((i) => !i.discrepancy);
  const leads = withGap.filter((g) => g.d.verdict === "research_lead").length;
  return (
    <div className="stack-sm" style={{ gap: 12 }}>
      <Callout kind={leads ? "info" : "warn"} title={leads ? `${leads} research lead(s).` : "No credible model–market differences."}>
        Ranked by the size of the gap between the independent model and the margin-adjusted market reference. The verdict accounts for the model's uncertainty and whether it has ever beaten the market in validation. A difference alone is not evidence of an edge.
      </Callout>
      {withGap.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Game</th>
                <th scope="col">Outcome</th>
                <th scope="col" className="r">Model (80% range)</th>
                <th scope="col" className="r">Market ref.</th>
                <th scope="col" className="r">Difference</th>
                <th scope="col">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {withGap.map(({ i, o, d }) => (
                <tr key={i.eventId}>
                  <td>
                    <Link to={`/games/${encodeURIComponent(i.eventId)}`}>
                      {i.away} at {i.home}
                    </Link>
                    <div className="subtle small">
                      {i.market?.nBooks} book(s) · {i.completeness.available}/{i.completeness.applicable} inputs
                    </div>
                  </td>
                  <td>{outcomeLabel(o, i.outcomeNames)}</td>
                  <td className="r num">
                    {formatPct(i.model?.probs[o])}
                    <div className="subtle">
                      {formatPct(i.model?.interval80[o]?.[0])}–{formatPct(i.model?.interval80[o]?.[1])}
                    </div>
                  </td>
                  <td className="r num">{formatPct(i.market?.probs[o])}</td>
                  <td className="r num">
                    <strong>{formatPctPoints(d.diff)}</strong>
                  </td>
                  <td style={{ maxWidth: 360 }}>
                    <VerdictChip verdict={d.verdict} />
                    <div className="subtle small" style={{ marginTop: 4 }}>
                      {d.reason}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {without.length > 0 && (
        <div className="card card-tight">
          <h3>Insufficient evidence ({without.length})</h3>
          <ul className="list-plain small">
            {without.map((i) => (
              <li key={i.eventId}>
                <Link to={`/games/${encodeURIComponent(i.eventId)}`}>
                  {i.away} at {i.home}
                </Link>
                : <span className="text-2">{!i.model ? i.modelUnavailable : i.marketUnavailable}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
