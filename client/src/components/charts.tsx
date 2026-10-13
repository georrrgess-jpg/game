// Hand-rolled SVG charts: 2px lines, recessive hairline grid, legend for >= 2 series,
// crosshair tooltip (mouse + keyboard), and a data-table view for every chart.

import { useId, useMemo, useRef, useState } from "react";
import { useApp } from "../state";
import { fmtTime, formatPct } from "../format";

export const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"];

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  points: { x: number; y: number }[];
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

export function StepLineChart({
  series,
  title,
  yFormat = (v) => formatPct(v),
  markers = [],
  height = 240,
  yLabel,
}: {
  series: LineSeries[];
  title: string;
  yFormat?: (v: number) => string;
  markers?: { x: number; label: string }[];
  height?: number;
  yLabel: string;
}) {
  const { zone } = useApp();
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const W = 640;
  const H = height;
  const m = { l: 44, r: 16, t: 12, b: 28 };
  const all = series.flatMap((s) => s.points);
  const xs = [...all.map((p) => p.x), ...markers.map((mk) => mk.x)];
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs, xMin + 1);
  const yVals = all.map((p) => p.y);
  let yMin = Math.min(...yVals);
  let yMax = Math.max(...yVals);
  const pad = Math.max(0.02, (yMax - yMin) * 0.15);
  yMin = Math.max(0, yMin - pad);
  yMax = Math.min(1, yMax + pad);
  if (!(yMax > yMin)) yMax = yMin + 0.05;
  const sx = (x: number) => m.l + ((x - xMin) / (xMax - xMin || 1)) * (W - m.l - m.r);
  const sy = (y: number) => m.t + (1 - (y - yMin) / (yMax - yMin)) * (H - m.t - m.b);
  const ticks = niceTicks(yMin, yMax, 4);
  const xTicks = useMemo(() => {
    const n = 4;
    return Array.from({ length: n + 1 }, (_, i) => xMin + ((xMax - xMin) * i) / n);
  }, [xMin, xMax]);
  const allX = useMemo(() => [...new Set(all.map((p) => p.x))].sort((a, b) => a - b), [all]);

  const valueAt = (s: LineSeries, x: number) => {
    let v: number | null = null;
    for (const p of s.points) {
      if (p.x <= x) v = p.y;
      else break;
    }
    return v;
  };

  const path = (s: LineSeries) => {
    const pts = [...s.points].sort((a, b) => a.x - b.x);
    if (!pts.length) return "";
    let d = `M${sx(pts[0].x)},${sy(pts[0].y)}`;
    for (let i = 1; i < pts.length; i++) d += `H${sx(pts[i].x)}V${sy(pts[i].y)}`;
    return d;
  };

  const onMove = (clientX: number) => {
    const svg = wrapRef.current?.querySelector("svg");
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const x = xMin + (((clientX - r.left) / r.width) * W - m.l) / ((W - m.l - m.r) / (xMax - xMin || 1));
    const nearest = allX.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a), allX[0]);
    setHoverX(nearest);
  };

  if (!all.length) return <p className="subtle">No quote history available for this time.</p>;

  return (
    <figure style={{ margin: 0 }} aria-labelledby={titleId}>
      <div className="row-between" style={{ marginBottom: 6 }}>
        <figcaption id={titleId} className="small" style={{ fontWeight: 600 }}>
          {title}
        </figcaption>
        <button className="btn btn-sm btn-ghost" onClick={() => setShowTable((v) => !v)} aria-pressed={showTable}>
          {showTable ? "Show chart" : "Show data table"}
        </button>
      </div>
      {series.length >= 2 && (
        <div className="legend" style={{ marginBottom: 6 }}>
          {series.map((s) => (
            <span key={s.key}>
              <span className="swatch" style={{ background: s.color, height: 3, width: 14, borderRadius: 2 }} aria-hidden="true" />
              {s.label}
            </span>
          ))}
        </div>
      )}
      {showTable ? (
        <div className="table-wrap" tabIndex={0} style={{ maxHeight: 300, overflow: "auto" }}>
          <table>
            <thead>
              <tr>
                <th scope="col">Time</th>
                {series.map((s) => (
                  <th scope="col" key={s.key} className="r">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allX.map((x) => (
                <tr key={x}>
                  <td>{fmtTime(new Date(x).toISOString(), zone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                  {series.map((s) => {
                    const p = s.points.find((pp) => pp.x === x);
                    return (
                      <td key={s.key} className="r num">
                        {p ? yFormat(p.y) : ""}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          ref={wrapRef}
          style={{ position: "relative" }}
          tabIndex={0}
          role="group"
          aria-label={`${title}. Use left and right arrow keys to move through time.`}
          onMouseMove={(e) => onMove(e.clientX)}
          onMouseLeave={() => setHoverX(null)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            const idx = hoverX == null ? (e.key === "ArrowLeft" ? allX.length - 1 : 0) : allX.indexOf(hoverX) + (e.key === "ArrowRight" ? 1 : -1);
            setHoverX(allX[Math.max(0, Math.min(allX.length - 1, idx))]);
          }}
          onBlur={() => setHoverX(null)}
        >
          <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${yLabel}`}>
            {ticks.map((t) => (
              <g key={t}>
                <line className="grid-line" x1={m.l} x2={W - m.r} y1={sy(t)} y2={sy(t)} />
                <text x={m.l - 8} y={sy(t) + 4} textAnchor="end">
                  {yFormat(t)}
                </text>
              </g>
            ))}
            {xTicks.map((t, i) => (
              <text key={i} x={sx(t)} y={H - 8} textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}>
                {fmtTime(new Date(t).toISOString(), zone, { month: "short", day: "numeric", hour: "numeric" })}
              </text>
            ))}
            {markers.map((mk) => (
              <g key={mk.label}>
                <line x1={sx(mk.x)} x2={sx(mk.x)} y1={m.t} y2={H - m.b} stroke="var(--border-strong)" strokeWidth={1} />
                <text x={sx(mk.x) - 4} y={m.t + 10} textAnchor="end" style={{ fill: "var(--text-2)" }}>
                  {mk.label}
                </text>
              </g>
            ))}
            {series.map((s) => (
              <path key={s.key} d={path(s)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {series.map((s) => {
              const last = [...s.points].sort((a, b) => a.x - b.x).slice(-1)[0];
              return last ? <circle key={s.key} cx={sx(last.x)} cy={sy(last.y)} r={4} fill={s.color} stroke="var(--chart-surface)" strokeWidth={2} /> : null;
            })}
            {hoverX != null && (
              <g>
                <line x1={sx(hoverX)} x2={sx(hoverX)} y1={m.t} y2={H - m.b} stroke="var(--text-2)" strokeWidth={1} />
                {series.map((s) => {
                  const v = valueAt(s, hoverX);
                  return v == null ? null : <circle key={s.key} cx={sx(hoverX)} cy={sy(v)} r={4.5} fill={s.color} stroke="var(--chart-surface)" strokeWidth={2} />;
                })}
              </g>
            )}
          </svg>
          {hoverX != null && (
            <div className="chart-tooltip" style={{ left: `min(calc(${(sx(hoverX) / W) * 100}% + 10px), calc(100% - 220px))`, top: 8 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{fmtTime(new Date(hoverX).toISOString(), zone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
              {series.map((s) => {
                const v = valueAt(s, hoverX);
                return (
                  <div key={s.key} className="row" style={{ gap: 6 }}>
                    <span className="swatch" style={{ background: s.color }} />
                    <span className="text-2">{s.label}</span>
                    <span className="num" style={{ marginLeft: "auto", fontWeight: 600 }}>
                      {v == null ? "—" : yFormat(v)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

export interface CalBin {
  lower: number;
  upper: number;
  count: number;
  meanPredicted: number | null;
  observedRate: number | null;
  ciLow: number | null;
  ciHigh: number | null;
}

export function CalibrationChart({ series, title }: { series: { key: string; label: string; color: string; bins: CalBin[] }[]; title: string }) {
  const [hover, setHover] = useState<{ s: string; i: number } | null>(null);
  const [showTable, setShowTable] = useState(false);
  const titleId = useId();
  const W = 420;
  const H = 360;
  const m = { l: 44, r: 14, t: 12, b: 40 };
  const sx = (p: number) => m.l + p * (W - m.l - m.r);
  const sy = (p: number) => m.t + (1 - p) * (H - m.t - m.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const hovered = hover ? series.find((s) => s.key === hover.s)?.bins[hover.i] : null;
  return (
    <figure style={{ margin: 0 }} aria-labelledby={titleId}>
      <div className="row-between" style={{ marginBottom: 6 }}>
        <figcaption id={titleId} className="small" style={{ fontWeight: 600 }}>
          {title}
        </figcaption>
        <button className="btn btn-sm btn-ghost" onClick={() => setShowTable((v) => !v)} aria-pressed={showTable}>
          {showTable ? "Show chart" : "Show data table"}
        </button>
      </div>
      <div className="legend" style={{ marginBottom: 6 }}>
        {series.map((s) => (
          <span key={s.key}>
            <span className="swatch" style={{ background: s.color, borderRadius: "50%" }} aria-hidden="true" />
            {s.label}
          </span>
        ))}
        <span>
          <span className="swatch" style={{ background: "transparent", border: "1px dashed var(--muted)", height: 2, width: 14 }} aria-hidden="true" />
          Perfect calibration
        </span>
      </div>
      {showTable ? (
        <div className="table-wrap" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">Bin</th>
                {series.map((s) => (
                  <th scope="col" key={s.key} className="r">
                    {s.label}: predicted / observed (n)
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {series[0]?.bins.map((b, i) => (
                <tr key={i}>
                  <td className="num">
                    {formatPct(b.lower)}–{formatPct(b.upper)}
                  </td>
                  {series.map((s) => {
                    const x = s.bins[i];
                    return (
                      <td key={s.key} className="r num">
                        {x.count ? `${formatPct(x.meanPredicted)} / ${formatPct(x.observedRate)} (${x.count})` : "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ position: "relative", maxWidth: 520 }}>
          <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}. Points on the dashed diagonal are perfectly calibrated.`}>
            {ticks.map((t) => (
              <g key={t}>
                <line className="grid-line" x1={m.l} x2={W - m.r} y1={sy(t)} y2={sy(t)} />
                <text x={m.l - 8} y={sy(t) + 4} textAnchor="end">
                  {formatPct(t)}
                </text>
                <text x={sx(t)} y={H - m.b + 16} textAnchor="middle">
                  {formatPct(t)}
                </text>
              </g>
            ))}
            <text x={(m.l + W - m.r) / 2} y={H - 4} textAnchor="middle" style={{ fill: "var(--text-2)" }}>
              Forecast probability
            </text>
            <text x={12} y={(m.t + H - m.b) / 2} transform={`rotate(-90 12 ${(m.t + H - m.b) / 2})`} textAnchor="middle" style={{ fill: "var(--text-2)" }}>
              Observed frequency
            </text>
            <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} stroke="var(--muted)" strokeDasharray="4 4" strokeWidth={1} />
            {series.map((s, si) =>
              s.bins.map((b, i) =>
                b.count && b.meanPredicted != null && b.observedRate != null ? (
                  <g key={`${s.key}-${i}`}>
                    {b.ciLow != null && b.ciHigh != null && (
                      <line x1={sx(b.meanPredicted) + si * 3} x2={sx(b.meanPredicted) + si * 3} y1={sy(b.ciLow)} y2={sy(b.ciHigh)} stroke={s.color} strokeWidth={1.5} opacity={0.55} />
                    )}
                    <circle
                      cx={sx(b.meanPredicted) + si * 3}
                      cy={sy(b.observedRate)}
                      r={Math.max(4, Math.min(9, 3 + Math.sqrt(b.count) / 3))}
                      fill={s.color}
                      stroke="var(--chart-surface)"
                      strokeWidth={2}
                      tabIndex={0}
                      role="img"
                      aria-label={`${s.label}: predicted ${formatPct(b.meanPredicted)}, observed ${formatPct(b.observedRate)}, ${b.count} games`}
                      onMouseEnter={() => setHover({ s: s.key, i })}
                      onMouseLeave={() => setHover(null)}
                      onFocus={() => setHover({ s: s.key, i })}
                      onBlur={() => setHover(null)}
                      style={{ cursor: "default" }}
                    />
                  </g>
                ) : null,
              ),
            )}
          </svg>
          {hovered && hovered.meanPredicted != null && (
            <div className="chart-tooltip" style={{ left: `${Math.min(70, (sx(hovered.meanPredicted) / W) * 100)}%`, top: `${(sy(hovered.observedRate ?? 0) / H) * 100}%` }}>
              <div style={{ fontWeight: 600 }}>{series.find((s) => s.key === hover!.s)?.label}</div>
              <div>Predicted (mean): {formatPct(hovered.meanPredicted)}</div>
              <div>Observed: {formatPct(hovered.observedRate)}</div>
              <div>
                95% interval: {formatPct(hovered.ciLow)}–{formatPct(hovered.ciHigh)}
              </div>
              <div className="subtle">{hovered.count} games</div>
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
