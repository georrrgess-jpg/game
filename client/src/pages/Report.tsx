import { useState } from "react";
import { qs } from "../api";
import { useApi, useApp } from "../state";
import { fmtDateTime, formatPct, formatPoints, sportLabel } from "../format";
import { Callout, Empty, ErrorBox, FictionalNote, Loading, Stat } from "../components/ui";
import { CalibrationChart, type CalBin } from "../components/charts";

interface Scored {
  n: number;
  brier: number;
  logLoss: number;
}
interface CI {
  mean: number;
  low: number;
  high: number;
}
interface Split {
  from: string | null;
  to: string | null;
  n: number;
  seasons: string[];
}

interface ReportResp {
  sports: string[];
  sport?: string;
  asOf?: string;
  mode?: string;
  report: any;
  forward: {
    events: number;
    abstentions: number;
    pending: number;
    voided: number;
    model: Scored | null;
    market: Scored | null;
    paired: { n: number; model: Scored; market: Scored } | null;
    warning: string | null;
    note: string;
  };
}

const f3 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(4));

function CIText({ ci, better }: { ci: CI | null; better: string }) {
  if (!ci) return <span className="subtle">too few games for an interval</span>;
  const verdict = ci.high < 0 ? `${better} is better (interval below 0)` : ci.low > 0 ? `${better} is worse (interval above 0)` : "no clear difference (interval includes 0)";
  return (
    <span>
      <span className="num">
        {ci.mean.toFixed(4)} [{ci.low.toFixed(4)}, {ci.high.toFixed(4)}]
      </span>{" "}
      <span className="subtle">: {verdict}</span>
    </span>
  );
}

export default function ReportPage() {
  const { dataset, asOfParam, zone } = useApp();
  const [sport, setSport] = useState<string>("");
  const { data, error, loading, reload } = useApi<ReportResp>(`/api/report${qs({ dataset, asOf: asOfParam, sport })}`);
  const r = data?.report;
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Model Report</div>
          <h1>Honest evaluation</h1>
          <p>
            Chronological splits, walk-forward holdout predictions, simple baselines and the market reference, with sample sizes and intervals. "No better than the market" is a normal and useful answer.
          </p>
        </div>
        {data && data.sports.length > 0 && (
          <label className="field">
            Sport
            <select value={sport || data.sport || ""} onChange={(e) => setSport(e.target.value)}>
              {data.sports.map((s) => (
                <option key={s} value={s}>
                  {sportLabel(s)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <FictionalNote />
      {loading && !data && <Loading rows={4} />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && !data.sports.length && <Empty title="No data to evaluate yet">Connected mode needs at least two completed seasons of results (enable the MLB Stats API and run Analyze Today).</Empty>}
      {r && r.available === false && <Callout kind="warn">{r.reason}</Callout>}
      {r && r.available && (
        <>
          <div className="card">
            <h2>Setup</h2>
            <div className="grid grid-3">
              <Stat label="Contract" value={<span style={{ fontSize: "1rem" }}>{r.contractLabel}</span>} />
              <Stat label="Holdout season" value={r.season} sub={`results known by ${fmtDateTime(r.asOf, zone)}`} />
              <Stat label="Model" value={<span style={{ fontSize: "1rem" }}>{r.model?.version ?? "none"}</span>} sub={r.model ? `${r.model.gridSearched} settings compared on validation` : r.modelReason} />
            </div>
            <p className="subtle small" style={{ marginTop: 10 }}>
              {r.evaluationTiming} Holdout predictions use parameters fitted only on earlier seasons; ratings update only from games completed before each prediction, so no future scores, later odds, injuries or refits leak in.
            </p>
          </div>

          {r.splits && (
            <div className="card">
              <h2>Training, validation and holdout</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Split</th>
                      <th scope="col">Purpose</th>
                      <th scope="col">Seasons</th>
                      <th scope="col">Period</th>
                      <th scope="col" className="r">Games</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        ["Training", "fit weights for each candidate setting", r.splits.train],
                        ["Validation", "choose settings and factors; fit market blend", r.splits.validation],
                        ["Final holdout", "report only; never used for fitting", r.splits.holdout],
                      ] as [string, string, Split][]
                    ).map(([name, purpose, s]) => (
                      <tr key={name}>
                        <td>{name}</td>
                        <td className="text-2">{purpose}</td>
                        <td>{s.seasons.join(", ")}</td>
                        <td className="small">
                          {s.from?.slice(0, 10) ?? "—"} → {s.to?.slice(0, 10) ?? "—"}
                        </td>
                        <td className="r num">{s.n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="subtle small" style={{ marginTop: 8 }}>
                Final weights are refitted on training + validation with the chosen settings. Factors used: {r.model.featuresUsed.join(", ")}.
              </p>
            </div>
          )}

          {r.holdout && (
            <div className="card">
              <h2>Holdout results (lower is better)</h2>
              {r.holdout.warning && <Callout kind="warn">{r.holdout.warning}</Callout>}
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Forecaster</th>
                      <th scope="col" className="r">Games</th>
                      <th scope="col" className="r">Brier</th>
                      <th scope="col" className="r">Log loss</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        ["Independent model (elo-logit)", r.holdout.model],
                        ["Baseline: training home-win rate", r.holdout.homeRate],
                        ["Baseline: coin flip (50%)", r.holdout.coin],
                        ["Market reference (60 min pre-game)", r.holdout.market],
                        ["Model, on the same games as market", r.holdout.modelOnMarketGames],
                        ["Combined (uses market as input)", r.holdout.combined],
                      ] as [string, Scored | null][]
                    ).map(([name, s]) => (
                      <tr key={name}>
                        <td>{name}</td>
                        <td className="r num">{s?.n ?? "—"}</td>
                        <td className="r num">{f3(s?.brier)}</td>
                        <td className="r num">{f3(s?.logLoss)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="list-bullets small" style={{ marginTop: 10 }}>
                <li>
                  Model minus home-rate baseline, log loss (95% paired bootstrap): <CIText ci={r.holdout.modelMinusHomeRateLogLoss} better="Model" />
                </li>
                <li>
                  Model minus market reference, log loss: <CIText ci={r.holdout.modelMinusMarketLogLoss} better="Model" />
                </li>
                <li>Market coverage: {formatPct(r.holdout.marketCoverage)} of holdout games had a current pre-game market reference.</li>
              </ul>
            </div>
          )}

          {r.holdout?.calibration && (
            <div className="grid grid-2">
              <div className="card">
                <CalibrationChart
                  title="Calibration on the holdout season (home-win probability)"
                  series={[
                    { key: "market", label: "Market reference", color: "var(--series-1)", bins: r.holdout.calibration.market as CalBin[] },
                    { key: "model", label: "Independent model", color: "var(--series-2)", bins: r.holdout.calibration.model as CalBin[] },
                  ]}
                />
                <p className="subtle small" style={{ marginTop: 8 }}>
                  Expected calibration error: model {f3(r.holdout.calibration.modelECE)}, market {f3(r.holdout.calibration.marketECE)}. Larger dots mean more games; whiskers are 95% intervals.
                </p>
              </div>
              <div className="card">
                <h2>Hypothetical points (read with caution)</h2>
                <p className="small text-2">{r.holdout.hypotheticalPoints.rule}</p>
                <div className="grid grid-2" style={{ margin: "10px 0" }}>
                  <Stat label="Simulated stakes" value={r.holdout.hypotheticalPoints.bets} />
                  <Stat label="Net simulation points" value={formatPoints(r.holdout.hypotheticalPoints.netPoints, 1)} />
                </div>
                {r.holdout.hypotheticalPoints.perBetMeanCI && (
                  <p className="small">
                    Mean per stake {formatPoints(r.holdout.hypotheticalPoints.perBetMeanCI.mean, 3)}, 95% interval {formatPoints(r.holdout.hypotheticalPoints.perBetMeanCI.low, 3)} to {formatPoints(r.holdout.hypotheticalPoints.perBetMeanCI.high, 3)}.
                  </p>
                )}
                <Callout kind="warn">{r.holdout.hypotheticalPoints.caveat}</Callout>
              </div>
            </div>
          )}

          {r.validationMetrics && (
            <div className="card">
              <h2>Validation season</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Forecaster</th>
                      <th scope="col" className="r">Games</th>
                      <th scope="col" className="r">Brier</th>
                      <th scope="col" className="r">Log loss</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        ["Model (weights from training seasons only)", r.validationMetrics.model],
                        ["Home-win rate", r.validationMetrics.homeRate],
                        ["Coin flip", r.validationMetrics.coin],
                        ["Market reference", r.validationMetrics.market],
                        ["Model on market games", r.validationMetrics.modelOnMarketGames],
                      ] as [string, Scored | null][]
                    ).map(([n, s]) => (
                      <tr key={n}>
                        <td>{n}</td>
                        <td className="r num">{s?.n ?? "—"}</td>
                        <td className="r num">{f3(s?.brier)}</td>
                        <td className="r num">{f3(s?.logLoss)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="small" style={{ marginTop: 8 }}>
                Model minus market, log loss: <CIText ci={r.validationMetrics.modelMinusMarketLogLoss} better="Model" />. The board's discrepancy verdicts use this comparison: if the model did not beat the market here, every model–market gap is labelled "no credible difference".
              </p>
            </div>
          )}

          {r.marketOnly && (
            <div className="card">
              <h2>Market-reference evaluation ({r.marketOnly.outcomes.join(" / ")})</h2>
              {r.modelReason && <Callout kind="info">{r.modelReason}</Callout>}
              {r.marketOnly.warning && <Callout kind="warn">{r.marketOnly.warning}</Callout>}
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Forecaster</th>
                      <th scope="col" className="r">Games</th>
                      <th scope="col" className="r">Brier (multi-outcome)</th>
                      <th scope="col" className="r">Log loss</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        ["Market reference", r.marketOnly.market],
                        ["Uniform baseline", r.marketOnly.uniform],
                        ["Outcome-frequency baseline (in-sample)", r.marketOnly.frequency],
                      ] as [string, Scored | null][]
                    ).map(([n, s]) => (
                      <tr key={n}>
                        <td>{n}</td>
                        <td className="r num">{s?.n ?? "—"}</td>
                        <td className="r num">{f3(s?.brier)}</td>
                        <td className="r num">{f3(s?.logLoss)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="subtle small">{r.marketOnly.frequencyNote}</p>
              {r.marketOnly.n > 0 && (
                <div style={{ marginTop: 12 }}>
                  <CalibrationChart title="Market calibration: home-win probability" series={[{ key: "m", label: "Market reference", color: "var(--series-1)", bins: r.marketOnly.calibrationHome }]} />
                </div>
              )}
            </div>
          )}
        </>
      )}

      {data?.forward && (
        <div className="card">
          <h2>Forward record (saved pre-game forecasts)</h2>
          <p className="small text-2">{data.forward.note}</p>
          <div className="grid grid-4" style={{ margin: "10px 0" }}>
            <Stat label="Events with a saved forecast" value={data.forward.events} />
            <Stat label="Abstentions" value={data.forward.abstentions} />
            <Stat label="Pending" value={data.forward.pending} />
            <Stat label="Void" value={data.forward.voided} />
          </div>
          {data.forward.warning && <Callout kind="warn">{data.forward.warning}</Callout>}
          {data.forward.paired && (
            <p className="small" style={{ marginTop: 8 }}>
              On {data.forward.paired.n} settled games with both: model Brier {f3(data.forward.paired.model.brier)}, market Brier {f3(data.forward.paired.market.brier)}.
            </p>
          )}
        </div>
      )}

      <div className="card">
        <h2>Limitations</h2>
        <ul className="list-bullets text-2">
          <li>The model sees team results, home advantage and (if it helps in validation) rest. It does not see starting pitchers, injuries, lineups, weather, travel or motivation, so it should be expected to trail a well-informed market.</li>
          <li>The 80% range reflects uncertainty in the fitted weights only. It understates total uncertainty.</li>
          <li>The market reference removes margin proportionally. That is an approximation; favourite–longshot bias and other effects are not modelled.</li>
          <li>Demo results come from a fictional simulator, so they demonstrate the method, not real-world performance.</li>
          <li>Past performance on one season says little about the next; small samples are dominated by luck.</li>
        </ul>
      </div>
    </div>
  );
}
