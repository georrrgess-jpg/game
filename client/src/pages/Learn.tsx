import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { americanToDecimal, breakEvenProbability, decimalToAmerican, expectedNetPointsWithPush, formatPct, parseAmerican, parseDecimal } from "../../../shared/odds";
import { DEVIG_METHODS, arbitrage, closingLineValue, decimalToFractional, devig, hedgeStake, kellyFraction, parlay, parseFractional, shinZ } from "../../../shared/betting";
import { mulberry32 } from "../../../shared/rng";
import { Callout } from "../components/ui";

// ---------------------------------------------------------------- helpers
/** Parse a price typed as American (-110, +150), decimal (1.91) or fractional (10/11). */
function parsePrice(input: string): { ok: true; decimal: number } | { ok: false; error: string } {
  const s = input.trim();
  if (!s) return { ok: false, error: "Enter a price" };
  if (s.includes("/")) {
    const f = parseFractional(s);
    return f.ok ? { ok: true, decimal: f.value } : { ok: false, error: f.error };
  }
  if (/^[+-]/.test(s) || Math.abs(Number(s)) >= 100) {
    const a = parseAmerican(s);
    return a.ok ? { ok: true, decimal: americanToDecimal(a.value) } : { ok: false, error: a.error };
  }
  const d = parseDecimal(s);
  return d.ok ? { ok: true, decimal: d.value } : { ok: false, error: d.error };
}

const am = (d: number) => {
  const a = Math.round(decimalToAmerican(d));
  return a > 0 ? `+${a}` : `${a}`;
};
const pct = (x: number, digits = 1) => formatPct(x, digits);
const signedPct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(2)}%`;

function PriceInput({ label, value, onChange, width = 110 }: { label: string; value: string; onChange: (v: string) => void; width?: number }) {
  const p = parsePrice(value);
  return (
    <label className="field">
      {label}
      <input type="text" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} style={{ width }} aria-invalid={!p.ok} />
      {!p.ok && value.trim() !== "" && <span className="small" style={{ color: "var(--danger)" }}>{p.error}</span>}
    </label>
  );
}

function NumInput({ label, value, onChange, step = "0.01", min, max, width = 110, suffix }: { label: string; value: string; onChange: (v: string) => void; step?: string; min?: number; max?: number; width?: number; suffix?: string }) {
  return (
    <label className="field">
      {label}
      <span className="row" style={{ gap: 4 }}>
        <input type="number" value={value} step={step} min={min} max={max} onChange={(e) => onChange(e.target.value)} style={{ width }} />
        {suffix && <span className="small subtle">{suffix}</span>}
      </span>
    </label>
  );
}

const prob = (s: string) => {
  const n = Number(s) / 100;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
};

function Calc({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card card-tight" style={{ marginTop: 10 }}>
      <h3 style={{ margin: "0 0 8px", fontSize: "1rem" }}>{title}</h3>
      <div className="stack-sm">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- calculators
function OddsConverter() {
  const [v, setV] = useState("-110");
  const p = parsePrice(v);
  return (
    <Calc title="Odds converter">
      <PriceInput label="Price (American, decimal or fractional)" value={v} onChange={setV} width={140} />
      {p.ok && (
        <div className="grid grid-4">
          <div>
            <div className="small subtle">American</div>
            <div className="num">{am(p.decimal)}</div>
          </div>
          <div>
            <div className="small subtle">Decimal</div>
            <div className="num">{p.decimal.toFixed(3)}</div>
          </div>
          <div>
            <div className="small subtle">Fractional</div>
            <div className="num">{decimalToFractional(p.decimal)}</div>
          </div>
          <div>
            <div className="small subtle">Implied probability (break-even)</div>
            <div className="num">{pct(1 / p.decimal, 2)}</div>
          </div>
        </div>
      )}
    </Calc>
  );
}

function DevigCalc() {
  const [prices, setPrices] = useState(["-200", "+170"]);
  const parsed = prices.map(parsePrice);
  const ok = parsed.every((p) => p.ok);
  const ds = ok ? parsed.map((p) => (p as { decimal: number }).decimal) : [];
  const total = ds.reduce((s, d) => s + 1 / d, 0);
  return (
    <Calc title="Margin removal: four methods side by side">
      <div className="row">
        {prices.map((p, i) => (
          <PriceInput key={i} label={`Outcome ${i + 1}`} value={p} onChange={(x) => setPrices(prices.map((y, j) => (j === i ? x : y)))} />
        ))}
        <button className="btn btn-sm" onClick={() => setPrices(prices.length === 2 ? [...prices, "+260"] : prices.slice(0, 2))}>
          {prices.length === 2 ? "Add a draw" : "Back to 2 outcomes"}
        </button>
      </div>
      {ok && (
        <>
          <div className="table-wrap" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Method</th>
                  {ds.map((_, i) => (
                    <th key={i} scope="col" className="r">
                      Outcome {i + 1}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Raw implied (1/d)</td>
                  {ds.map((d, i) => (
                    <td key={i} className="r num">
                      {pct(1 / d)}
                    </td>
                  ))}
                </tr>
                {DEVIG_METHODS.map((m) => {
                  const p = devig(ds, m.key);
                  return (
                    <tr key={m.key}>
                      <td>{m.label}</td>
                      {p.map((x, i) => (
                        <td key={i} className="r num">
                          {pct(x)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="small text-2">
            Margin (overround) {pct(total - 1, 2)}. Shin's estimated share of informed money z = {(shinZ(ds) * 100).toFixed(2)}%. The methods agree for evenly matched sides and disagree most on longshots, where books usually take more margin. Overround Lab chooses the method per sport by how well each matched past results, and shows the choice in the Model Report.
          </p>
        </>
      )}
    </Calc>
  );
}

/** Price at which EV is exactly zero: w·(d − 1) = loss, so d = (w + loss) / w. */
function fairText(w: number, push: number): string {
  const loss = Math.max(0, 1 - w - push);
  if (!(w > 0) || !(loss > 0)) return "—";
  return am((w + loss) / w);
}

function EvCalc() {
  const [price, setPrice] = useState("-110");
  const [win, setWin] = useState("54");
  const [push, setPush] = useState("0");
  const p = parsePrice(price);
  const w = prob(win);
  const pu = prob(push);
  const valid = p.ok && w != null && pu != null && w + pu <= 1 + 1e-9;
  // Clamp: 0.07 + 0.93 can leave a loss chance of -1e-17 in floating point.
  const ev = valid ? expectedNetPointsWithPush(w!, Math.max(0, 1 - w! - pu!), Math.max(0, Math.min(1 - w!, pu!)), p.decimal) : null;
  return (
    <Calc title="Expected value (with pushes)">
      <div className="row">
        <PriceInput label="Price" value={price} onChange={setPrice} />
        <NumInput label="Chance of winning" value={win} onChange={setWin} step="0.5" min={0} max={100} suffix="%" />
        <NumInput label="Chance of a push" value={push} onChange={setPush} step="0.5" min={0} max={100} suffix="%" />
      </div>
      {!valid && <p className="small" style={{ color: "var(--danger)" }}>Chances must be between 0 and 100% and add up to at most 100%.</p>}
      {valid && p.ok && (
        <p>
          Expected net per 1 point staked: <strong className="num">{ev! >= 0 ? "+" : ""}{ev!.toFixed(4)}</strong> ({signedPct(ev!)}). Break-even chance of winning
          (ignoring pushes): <span className="num">{pct(breakEvenProbability(p.decimal), 2)}</span>; with this push chance you need{" "}
          <span className="num">{pct((1 - pu!) / p.decimal, 2)}</span>. Fair price for your estimate: <span className="num">{fairText(w!, pu!)}</span>.
        </p>
      )}
    </Calc>
  );
}

function KellyCalc() {
  const [price, setPrice] = useState("+120");
  const [win, setWin] = useState("50");
  const p = parsePrice(price);
  const w = prob(win);
  const f = p.ok && w != null ? kellyFraction(w, p.decimal) : null;
  return (
    <Calc title="Kelly criterion (theory, simulation points)">
      <div className="row">
        <PriceInput label="Price" value={price} onChange={setPrice} />
        <NumInput label="True chance of winning" value={win} onChange={setWin} step="0.5" min={0} max={100} suffix="%" />
      </div>
      {f != null && (
        <p>
          {f <= 0 ? (
            <>Kelly fraction {(f * 100).toFixed(1)}%: no stake, because the expected value is not positive.</>
          ) : (
            <>
              Full Kelly would stake <strong className="num">{(f * 100).toFixed(1)}%</strong> of a simulation bankroll; quarter Kelly {(f * 25).toFixed(1)}%.
            </>
          )}
        </p>
      )}
      <Callout kind="warn">
        Kelly assumes the probability is known exactly. Estimated probabilities are noisy and usually too optimistic, so full Kelly overbets and produces huge swings. This calculator is for understanding the formula f* = (p·d − 1)/(d − 1), not for staking decisions.
      </Callout>
    </Calc>
  );
}

function ParlayCalc() {
  const [legs, setLegs] = useState([
    { price: "-110", p: "52" },
    { price: "-110", p: "52" },
  ]);
  const parsed = legs.map((l) => ({ d: parsePrice(l.price), p: prob(l.p) }));
  const ok = parsed.every((l) => l.d.ok && l.p != null);
  const r = ok ? parlay(parsed.map((l) => ({ decimal: (l.d as { decimal: number }).decimal, probability: l.p! }))) : null;
  const fairLegs = ok ? parsed.map((l) => (l.d as { decimal: number }).decimal) : [];
  return (
    <Calc title="Parlay (accumulator)">
      {legs.map((l, i) => (
        <div className="row" key={i}>
          <PriceInput label={`Leg ${i + 1} price`} value={l.price} onChange={(v) => setLegs(legs.map((x, j) => (j === i ? { ...x, price: v } : x)))} />
          <NumInput label="Chance" value={l.p} onChange={(v) => setLegs(legs.map((x, j) => (j === i ? { ...x, p: v } : x)))} step="0.5" suffix="%" />
        </div>
      ))}
      <div className="row">
        <button className="btn btn-sm" onClick={() => setLegs([...legs, { price: "-110", p: "52" }])} disabled={legs.length >= 8}>
          Add leg
        </button>
        <button className="btn btn-sm" onClick={() => setLegs(legs.slice(0, -1))} disabled={legs.length <= 2}>
          Remove leg
        </button>
      </div>
      {r && (
        <p>
          Combined price <span className="num">{am(r.decimal)}</span> ({r.decimal.toFixed(2)}). If the legs are independent: chance{" "}
          <span className="num">{pct(r.probabilityIfIndependent!, 2)}</span>, expected net per point <strong className="num">{signedPct(r.ev!)}</strong>. Each leg's margin compounds: at −110 on every leg the book's edge grows from about 4.5% on one leg to about{" "}
          {pct(1 - (1 / (2 * (1 / americanToDecimal(-110)))) ** fairLegs.length, 1)} on {fairLegs.length} legs.
        </p>
      )}
      <Callout kind="info">Legs from the same game are usually correlated (a team that covers a big spread also tends to push the total over), so multiplying chances is wrong for them. Books price same-game parlays with extra margin for that reason.</Callout>
    </Calc>
  );
}

function ArbCalc() {
  const [prices, setPrices] = useState(["+105", "+102"]);
  const [total, setTotal] = useState("100");
  const parsed = prices.map(parsePrice);
  const ok = parsed.every((p) => p.ok);
  const ds = ok ? parsed.map((p) => (p as { decimal: number }).decimal) : [];
  const a = ok ? arbitrage(ds) : null;
  const T = Number(total);
  return (
    <Calc title="Arbitrage check">
      <div className="row">
        {prices.map((p, i) => (
          <PriceInput key={i} label={`Best price, outcome ${i + 1}`} value={p} onChange={(x) => setPrices(prices.map((y, j) => (j === i ? x : y)))} />
        ))}
        <NumInput label="Total points" value={total} onChange={setTotal} step="10" min={1} />
        <button className="btn btn-sm" onClick={() => setPrices(prices.length === 2 ? [...prices, "+300"] : prices.slice(0, 2))}>
          {prices.length === 2 ? "Add a third outcome" : "Two outcomes"}
        </button>
      </div>
      {a && (
        <>
          <p>
            Sum of implied probabilities: <span className="num">{pct(a.impliedTotal, 2)}</span>.{" "}
            {a.isArbitrage ? (
              <strong>Arbitrage: these prices return {signedPct(a.margin)} on every result, if every leg could be placed at them at the same moment.</strong>
            ) : (
              <>No arbitrage: covering every outcome loses {signedPct(-a.margin).replace("+", "")} of the total for certain.</>
            )}
          </p>
          {Number.isFinite(T) && T > 0 && (
            <p className="small text-2">
              Split: {a.stakeShares.map((s, i) => `outcome ${i + 1} ${(s * T).toFixed(2)} pts`).join(", ")}; every result returns {(T * (1 + a.margin)).toFixed(2)} pts.
            </p>
          )}
        </>
      )}
    </Calc>
  );
}

function HedgeCalc() {
  const [stake, setStake] = useState("10");
  const [orig, setOrig] = useState("+300");
  const [hedge, setHedge] = useState("-150");
  const po = parsePrice(orig);
  const ph = parsePrice(hedge);
  const s = Number(stake);
  const h = po.ok && ph.ok && s > 0 ? hedgeStake(s, po.decimal, ph.decimal) : null;
  return (
    <Calc title="Hedging">
      <div className="row">
        <NumInput label="Original stake" value={stake} onChange={setStake} step="1" min={0} />
        <PriceInput label="Original price" value={orig} onChange={setOrig} />
        <PriceInput label="Price on the other side now" value={hedge} onChange={setHedge} />
      </div>
      {h && (
        <p>
          Staking <strong className="num">{h.stake.toFixed(2)}</strong> on the other side pays the same whatever happens: a locked result of{" "}
          <strong className="num">
            {h.lockedProfit >= 0 ? "+" : ""}
            {h.lockedProfit.toFixed(2)}
          </strong>{" "}
          points. Hedging never adds expected value; it trades it for certainty, and pays the margin a second time.
        </p>
      )}
    </Calc>
  );
}

function ClvCalc() {
  const [taken, setTaken] = useState("+150");
  const [c1, setC1] = useState("+130");
  const [c2, setC2] = useState("-150");
  const pt = parsePrice(taken);
  const p1 = parsePrice(c1);
  const p2 = parsePrice(c2);
  const fair = p1.ok && p2.ok ? devig([p1.decimal, p2.decimal], "shin")[0] : null;
  return (
    <Calc title="Closing line value">
      <div className="row">
        <PriceInput label="Price you took" value={taken} onChange={setTaken} />
        <PriceInput label="Closing price, same side" value={c1} onChange={setC1} />
        <PriceInput label="Closing price, other side" value={c2} onChange={setC2} />
      </div>
      {pt.ok && fair != null && (
        <p>
          Closing fair chance (margin removed): <span className="num">{pct(fair, 2)}</span>, fair price {am(1 / fair)}. Closing line value:{" "}
          <strong className="num">{signedPct(closingLineValue(pt.decimal, fair))}</strong>. Beating the closing line consistently is the best available evidence that prices were good, because the closing price includes almost all public information.
        </p>
      )}
    </Calc>
  );
}

function VarianceSim() {
  const [win, setWin] = useState("54");
  const [price, setPrice] = useState("-110");
  const [n, setN] = useState("200");
  const p = parsePrice(price);
  const w = prob(win);
  const N = Math.max(1, Math.min(5000, Math.round(Number(n) || 0)));
  const result = useMemo(() => {
    if (!p.ok || w == null) return null;
    const rand = mulberry32(20260616);
    const runs = 2000;
    const finals: number[] = [];
    let losing = 0;
    for (let r = 0; r < runs; r++) {
      let net = 0;
      for (let i = 0; i < N; i++) net += rand() < w ? p.decimal - 1 : -1;
      finals.push(net);
      if (net < 0) losing++;
    }
    finals.sort((a, b) => a - b);
    return { losing: losing / runs, p5: finals[Math.floor(runs * 0.05)], p50: finals[Math.floor(runs * 0.5)], p95: finals[Math.floor(runs * 0.95)], ev: N * (w * (p.decimal - 1) - (1 - w)) };
  }, [p.ok, p.ok ? p.decimal : 0, w, N]);
  return (
    <Calc title="Luck versus skill: simulate many seasons">
      <div className="row">
        <NumInput label="True chance of winning" value={win} onChange={setWin} step="0.5" suffix="%" />
        <PriceInput label="Price" value={price} onChange={setPrice} />
        <NumInput label="Selections per season" value={n} onChange={setN} step="50" min={1} max={5000} />
      </div>
      {result && (
        <p>
          Expected result {result.ev >= 0 ? "+" : ""}
          {result.ev.toFixed(1)} points. Across 2,000 simulated seasons the middle 90% ended between <span className="num">{result.p5.toFixed(1)}</span> and{" "}
          <span className="num">{result.p95.toFixed(1)}</span> points (median {result.p50.toFixed(1)}), and <strong>{pct(result.losing)}</strong> of seasons lost points.{" "}
          {result.ev > 0 ? "Even a real edge loses often over short samples." : "A negative edge still produces winning seasons, which is why short records prove little."}
        </p>
      )}
    </Calc>
  );
}

function BreakEvenTable() {
  const prices = [-300, -200, -150, -120, -110, -105, 100, 110, 130, 150, 200, 300, 500];
  return (
    <div className="table-wrap" tabIndex={0} style={{ marginTop: 10 }}>
      <table>
        <thead>
          <tr>
            <th scope="col">American</th>
            <th scope="col" className="r">Decimal</th>
            <th scope="col" className="r">Fractional</th>
            <th scope="col" className="r">Break-even chance</th>
          </tr>
        </thead>
        <tbody>
          {prices.map((a) => {
            const d = americanToDecimal(a);
            return (
              <tr key={a}>
                <td className="num">{a > 0 ? `+${a}` : a}</td>
                <td className="r num">{d.toFixed(3)}</td>
                <td className="r num">{decimalToFractional(d)}</td>
                <td className="r num">{pct(1 / d, 2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- topics
interface Topic {
  id: string;
  group: string;
  title: string;
  body: ReactNode;
}

const TOPICS: Topic[] = [
  // ---- prices
  {
    id: "odds-formats",
    group: "Prices and probability",
    title: "Odds formats: American, decimal, fractional",
    body: (
      <>
        <p>
          All three describe the same thing: what a winning stake returns. Decimal odds d are the total return per point (stake included): 2.50 returns 2.50 for 1. American odds are written around 100: +150 wins 150 for 100 staked (d = 2.50), −200 needs 200 staked to win 100 (d = 1.50). Fractional odds show profit over stake: 3/2 is d = 2.50.
        </p>
        <OddsConverter />
        <BreakEvenTable />
      </>
    ),
  },
  {
    id: "implied",
    group: "Prices and probability",
    title: "Implied probability and break-even",
    body: (
      <p>
        The implied probability of a price is 1/d. It is also the break-even chance: at −110 (d ≈ 1.909) you must win 52.38% of the time just to break even. Implied probability includes the bookmaker's margin, so it is not the book's fair estimate.
      </p>
    ),
  },
  {
    id: "overround",
    group: "Prices and probability",
    title: "Margin, overround, vig and hold",
    body: (
      <p>
        Across all outcomes of one contract at one book, implied probabilities add to more than 100%. The excess is the overround (a −110/−110 market sums to 104.76%). The hold is the share of all stakes the book expects to keep if action is balanced: 1 − 1/sum, about 4.5% at −110/−110. Lower margins usually mean a sharper, more competitive market.
      </p>
    ),
  },
  {
    id: "devig",
    group: "Prices and probability",
    title: "Removing the margin: proportional, power, Shin, odds ratio",
    body: (
      <>
        <p>
          To estimate the market's own view, remove the margin from one book's complete set of prices. Proportional scaling divides each implied probability by the total. Real books tend to put more margin on longshots (the favourite–longshot bias), so methods that shift margin towards longshots (power, Shin, odds ratio) often match results better. Never combine the best price of each outcome from different books into one "market".
        </p>
        <DevigCalc />
      </>
    ),
  },
  {
    id: "consensus",
    group: "Prices and probability",
    title: "Market consensus and sharp books",
    body: (
      <p>
        A consensus averages several books' margin-free probabilities. Some books move first and track results better ("sharp"); others copy, react slowly or shade prices for their customers ("soft"). Overround Lab weights books by how well their prices matched results in an earlier season, and only uses those weights if they also helped on later games.
      </p>
    ),
  },
  {
    id: "fls",
    group: "Prices and probability",
    title: "Favourite–longshot bias",
    body: (
      <p>
        Across many sports, longshots win less often than their prices imply and heavy favourites slightly more. Bettors overpay for small chances of a big payout, and books protect themselves on outcomes that are hard to price. This is why "cheap" longshot prices are usually the worst value on the board.
      </p>
    ),
  },
  // ---- value
  {
    id: "ev",
    group: "Value",
    title: "Expected value",
    body: (
      <>
        <p>
          Expected value is the average result per point if the same situation repeated many times: EV = p·(d − 1) − (1 − p). It is positive only if your chance of winning is above the break-even chance. EV depends entirely on the probability you plug in, so it is only as good as that estimate.
        </p>
        <EvCalc />
      </>
    ),
  },
  {
    id: "likely-vs-value",
    group: "Value",
    title: "Most likely is not the same as best value",
    body: (
      <p>
        A team with a 75% chance priced at −400 (break-even 80%) loses money on average; an underdog with a 40% chance priced at +170 (break-even 37%) makes money on average. Ranking by probability answers "what will probably happen"; value asks "is the price wrong". The Value Finder keeps the two lists apart for that reason.
      </p>
    ),
  },
  {
    id: "beat-consensus",
    group: "Value",
    title: "Prices that beat the consensus",
    body: (
      <p>
        The most reliable signal of a good price is a book paying more than the margin-free consensus of several other books. It does not need a model; it uses the market's own information against one outlier price. Edges are usually small (1–3%), short-lived, and books limit customers who take them consistently.
      </p>
    ),
  },
  {
    id: "clv",
    group: "Value",
    title: "Closing line value (CLV)",
    body: (
      <>
        <p>
          The closing price, just before the start, reflects almost all public information. If the prices you take are consistently better than the margin-free closing price, you are probably finding real value, even when short-run results are negative. Professional bettors judge themselves by CLV because results take thousands of bets to separate skill from luck.
        </p>
        <ClvCalc />
      </>
    ),
  },
  {
    id: "line-movement",
    group: "Value",
    title: "Line movement and steam",
    body: (
      <p>
        Prices move when new information arrives (injuries, lineups, weather) or when respected money hits a book. A sudden move across many books ("steam") usually means information, not noise. The Market Explorer shows each book's price history with source times so you can see who moved first.
      </p>
    ),
  },
  {
    id: "arbitrage",
    group: "Value",
    title: "Arbitrage",
    body: (
      <>
        <p>
          If the best prices for every outcome, taken from different books, have implied probabilities that add to less than 100%, splitting stakes in the right proportions pays the same on every result. In practice these windows close in seconds, books cap stakes, and palpable errors get voided.
        </p>
        <ArbCalc />
      </>
    ),
  },
  {
    id: "middles",
    group: "Value",
    title: "Middles",
    body: (
      <p>
        When books disagree on a line (one has a team −2.5, another the opponent +3.5), taking both sides can win both if the result lands in between (a 3-point margin) and loses only the margin otherwise. Middles are most valuable around key numbers.
      </p>
    ),
  },
  {
    id: "hedging",
    group: "Value",
    title: "Hedging",
    body: (
      <>
        <p>Hedging means betting the other side to lock in a result. It reduces variance but never increases expected value: you pay the margin again.</p>
        <HedgeCalc />
      </>
    ),
  },
  {
    id: "parlays",
    group: "Value",
    title: "Parlays and correlation",
    body: (
      <>
        <p>A parlay multiplies prices and needs every leg to win. Margins compound with each leg, so parlays usually carry far more margin than single bets. Probabilities only multiply if legs are independent.</p>
        <ParlayCalc />
      </>
    ),
  },
  {
    id: "teasers",
    group: "Value",
    title: "Teasers",
    body: (
      <p>
        A teaser moves the spread in your favour on several legs in exchange for a worse combined price. Moving a football line through 3 and 7 (for example from +1.5 to +7.5) gains the most, because so many games end on those margins. Most other teasers are poor value.
      </p>
    ),
  },
  // ---- markets
  {
    id: "moneyline",
    group: "Markets",
    title: "Moneylines (2-way and 3-way)",
    body: (
      <p>
        A 2-way moneyline settles on the final result including overtime; ties are void. A 3-way result (common in soccer) includes the draw as a full outcome and settles on regulation time only. They are different contracts and are never compared directly.
      </p>
    ),
  },
  {
    id: "spreads",
    group: "Markets",
    title: "Point spreads",
    body: (
      <p>
        A spread adds a handicap to one side. Home −3.5 wins if the home team wins by 4 or more. A whole-number line can land exactly (a push), which returns the stake. The model prices spreads from a full distribution of margins, so it can give the chance of a push as well as of winning.
      </p>
    ),
  },
  {
    id: "totals",
    group: "Markets",
    title: "Totals (over/under)",
    body: (
      <p>
        A total is a line on combined points. Totals depend on pace and scoring form more than on which team is better. The model's total uses both teams' recent points scored and allowed, shrunk towards the league average at the start of each season.
      </p>
    ),
  },
  {
    id: "key-numbers",
    group: "Markets",
    title: "Key numbers",
    body: (
      <p>
        In American football, scores come in 3s and 7s, so many games end with margins of 3, 7, 10 or 14. Moving a line across 3 or 7 changes the chance of covering far more than moving it from 5 to 5.5. Overround Lab learns these frequencies from past games and builds them into its margin distribution, so the push chance at −3 is realistic.
      </p>
    ),
  },
  {
    id: "push",
    group: "Markets",
    title: "Pushes, voids and settlement rules",
    body: (
      <p>
        A push returns the stake. Postponed or cancelled games are void; in this app a game moved by more than 12 hours counts as void. Read the settlement rule of each contract: regulation-only and full-game markets can settle differently on the same game.
      </p>
    ),
  },
  // ---- models
  {
    id: "elo",
    group: "Models",
    title: "Elo ratings",
    body: (
      <p>
        Elo gives every team or player a rating; after each game, the winner takes points from the loser in proportion to how surprising the result was. The rating difference converts into a win probability. Ratings regress towards the average between seasons because rosters change.
      </p>
    ),
  },
  {
    id: "mov",
    group: "Models",
    title: "Margin of victory",
    body: (
      <p>
        In basketball and football, a 20-point win says more than a 1-point win. A margin-of-victory multiplier, damped for big favourites to avoid runaway ratings, makes Elo learn faster. Baseball and tennis use plain win/loss updates.
      </p>
    ),
  },
  {
    id: "tennis",
    group: "Models",
    title: "Tennis: surfaces, experience and best-of-five",
    body: (
      <p>
        Player ratings in tennis move quickly for newcomers and slowly for veterans (an experience-dependent K factor). Players differ by surface, so the model blends an overall rating with a surface-specific one, with the blend chosen on past data. Best-of-five matches favour the stronger player more than best-of-three, so the model lets the rating effect grow in five-set matches.
      </p>
    ),
  },
  {
    id: "rest",
    group: "Models",
    title: "Home advantage, rest and back-to-backs",
    body: (
      <p>
        Home teams win more often, by different amounts in each sport. Playing on consecutive days (a back-to-back) costs basketball teams measurably. Overround Lab tests each factor on a validation season and keeps it only if it improves out-of-sample accuracy.
      </p>
    ),
  },
  {
    id: "blend",
    group: "Models",
    title: "Combining a model with the market",
    body: (
      <p>
        A model rarely beats a liquid market on its own, but it can add information. The combined estimate fits weights for the model and the market on a past season. For spreads and totals, the model's expected margin is blended with the margin implied by the market's line and price. If the market is better, the weights say so and the model gets little or no weight.
      </p>
    ),
  },
  {
    id: "leakage",
    group: "Models",
    title: "Information time and leakage",
    body: (
      <p>
        A forecast is only honest if it uses information available at the time. Every analysis has an information time; later quotes, injuries, results and refitted models are excluded. Replays recreate exactly what was knowable at a past moment.
      </p>
    ),
  },
  // ---- evaluation
  {
    id: "scoring",
    group: "Judging forecasts",
    title: "Brier score and log loss",
    body: (
      <p>
        Both score probabilities against what happened; lower is better. Brier is the squared error, log loss punishes confident mistakes much harder. A forecaster who says 50% on everything gets a Brier score of 0.25 and a log loss of 0.693, the coin-flip baseline.
      </p>
    ),
  },
  {
    id: "calibration",
    group: "Judging forecasts",
    title: "Calibration",
    body: (
      <p>
        A calibrated forecaster's 70% calls happen about 70% of the time. Calibration charts group forecasts into bins and compare the average forecast with the observed rate. Good calibration does not mean good forecasts (always saying 50% is calibrated in a coin-flip league), so look at scores too.
      </p>
    ),
  },
  {
    id: "overfitting",
    group: "Judging forecasts",
    title: "Overfitting and validation",
    body: (
      <p>
        A model tuned to look good on past data often fails on new data. The fix is chronological splits: fit on old seasons, choose settings on a validation season, and judge only on games the model never saw (the holdout). Results on the validation season are optimistic by construction.
      </p>
    ),
  },
  {
    id: "sample-size",
    group: "Judging forecasts",
    title: "Sample size, luck and confidence intervals",
    body: (
      <>
        <p>
          Betting results are mostly noise over hundreds of bets. A 95% interval that includes zero means the result is consistent with luck. Use the simulator to see how often a real edge loses over a season.
        </p>
        <VarianceSim />
      </>
    ),
  },
  {
    id: "kelly",
    group: "Judging forecasts",
    title: "Kelly criterion and risk of ruin",
    body: (
      <>
        <p>
          Kelly sizing maximises long-run growth if probabilities are known exactly. With estimated probabilities it overbets badly, which is why practitioners use a fraction of Kelly, and why most should not size real stakes from a model at all.
        </p>
        <KellyCalc />
      </>
    ),
  },
  // ---- thinking
  {
    id: "fallacies",
    group: "Thinking clearly",
    title: "Gambler's fallacy, hot hands and streaks",
    body: (
      <p>
        Independent outcomes do not balance out: after five losses the next chance is unchanged. Streaks are common in random data, and short hot or cold runs are poor evidence of skill. The market already prices form, injuries and public opinion.
      </p>
    ),
  },
  {
    id: "efficiency",
    group: "Thinking clearly",
    title: "Why markets are hard to beat",
    body: (
      <p>
        Prices aggregate many informed opinions, react to news in minutes, and include a margin you must overcome. Closing lines in major leagues are among the best available forecasts. A model that matches the market is already doing well; beating it consistently is rare.
      </p>
    ),
  },
  {
    id: "media",
    group: "Thinking clearly",
    title: "Tips, touts and \"locks\"",
    body: (
      <p>
        Nobody can guarantee a result. Services that advertise locks, sure things or win rates without full records, sample sizes and closing-line comparisons are selling a story. Ask for every pick, timestamped before the game, with the price and the closing price.
      </p>
    ),
  },
  {
    id: "responsible",
    group: "Thinking clearly",
    title: "Responsible gambling",
    body: (
      <>
        <p>
          This app uses simulation points only and is meant for learning. Real-money betting is restricted by age and location, and the house margin means most bettors lose over time. Warning signs include chasing losses, betting more than planned, borrowing to bet, or hiding it from others.
        </p>
        <p>
          If gambling stops being fun for you or someone you know, talk to someone you trust and contact a local support service. In the United States the National Council on Problem Gambling helpline is 1-800-GAMBLER; most countries have a free, confidential national helpline.
        </p>
      </>
    ),
  },
];

const GROUPS = [...new Set(TOPICS.map((t) => t.group))];

export default function LearnPage() {
  const [query, setQuery] = useState("");
  const [openAll, setOpenAll] = useState(false);
  const q = query.trim().toLowerCase();
  const shown = q ? TOPICS.filter((t) => t.title.toLowerCase().includes(q) || t.group.toLowerCase().includes(q) || t.id.includes(q)) : TOPICS;
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Knowledge Center</div>
          <h1>How betting markets work</h1>
          <p>
            {TOPICS.length} short explainers with working calculators: prices and margins, value and closing line value, spreads, totals and key numbers, models and how to judge them. Everything here is arithmetic you can check; nothing is a tip.
          </p>
        </div>
      </div>
      <div className="row no-print">
        <label className="field">
          <span className="sr-only">Search topics</span>
          <input type="search" placeholder="Search topics" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search topics" style={{ width: 240 }} />
        </label>
        <button className="btn btn-sm" onClick={() => setOpenAll((v) => !v)}>
          {openAll ? "Collapse all" : "Expand all"}
        </button>
        <span className="small subtle">
          See it applied: <Link to="/value">Value Finder</Link>, <Link to="/lines">Average Lines</Link>, <Link to="/report">Model Report</Link>.
        </span>
      </div>
      {!shown.length && <p className="subtle">No topic matches “{query}”.</p>}
      {GROUPS.map((g) => {
        const ts = shown.filter((t) => t.group === g);
        if (!ts.length) return null;
        return (
          <section key={g} className="card" aria-labelledby={`g-${g}`}>
            <h2 id={`g-${g}`}>{g}</h2>
            <div className="stack-sm">
              {ts.map((t) => (
                <details key={`${t.id}-${openAll}`} className="disclosure" id={t.id} open={openAll || !!q}>
                  <summary>{t.title}</summary>
                  <div className="disclosure-body stack-sm">{t.body}</div>
                </details>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
