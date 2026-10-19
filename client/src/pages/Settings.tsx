import { useEffect, useState } from "react";
import { api, qs } from "../api";
import { useApi, useApp } from "../state";
import { ago, fmtDateTime } from "../format";
import { Callout, ErrorBox, ExtLink, Loading, Tabs } from "../components/ui";
import { IconPause, IconPlay, IconRefresh } from "../components/icons";

type STab = "providers" | "scheduler" | "general" | "appearance";

interface SettingsResp {
  settings: any;
  secrets: { oddsApiKey: boolean; anthropicApiKey: boolean; balldontlieApiKey?: boolean; instructorPin: boolean };
  envFile?: { path: string; found: boolean; keys: string[]; hints: string[] } | null;
}

interface Provider {
  id: string;
  name: string;
  roles: string[];
  docsUrl: string;
  requiresKey: boolean;
  keyEnvVar: string | null;
  licensing: string;
  coverage: string[];
  history: string;
  costNotes: string;
  limitations: string[];
  enabled: boolean;
  keyConfigured: boolean;
  verification: string;
  health: { state: string; lastAttempt: string | null; lastSuccess: string | null; lastError: string | null; lastErrorAt: string | null; consecutiveFailures: number };
  quota: { remaining: number | null; used: number | null; lastCost: number | null; exhausted: boolean } | null;
  usageToday: { requests: number; credits: number };
  observed: Record<string, any>;
}

const HEALTH: Record<string, { cls: string; text: string }> = {
  ok: { cls: "chip-good", text: "Healthy" },
  degraded: { cls: "chip-warn", text: "Degraded: last request failed" },
  down: { cls: "chip-danger", text: "Down: repeated failures" },
  quota_exhausted: { cls: "chip-danger", text: "Quota exhausted" },
  not_configured: { cls: "chip-muted", text: "Not configured (no key)" },
  disabled: { cls: "chip-muted", text: "Disabled" },
  never_used: { cls: "chip-info", text: "Enabled, not used yet" },
};

export default function SettingsPage() {
  const [tab, setTab] = useState<STab>("providers");
  const { data, error, reload } = useApi<SettingsResp>("/api/settings");
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Settings</div>
          <h1>Providers, schedule and preferences</h1>
          <p>Connected providers stay off until you enable them. Keys live only in the server's .env file and are never sent to the browser. Paid usage needs explicit caps.</p>
        </div>
      </div>
      <Tabs
        label="Settings sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "providers", label: "Providers & coverage" },
          { id: "scheduler", label: "Scheduler & activity" },
          { id: "general", label: "Time & analysis" },
          { id: "appearance", label: "Appearance & accessibility" },
        ]}
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "appearance" ? <AppearancePanel /> : !data ? <Loading /> : tab === "providers" ? <ProvidersPanel s={data} reload={reload} /> : tab === "scheduler" ? <SchedulerPanel s={data} reload={reload} /> : <GeneralPanel s={data} reload={reload} />}
      </div>
    </div>
  );
}

function useSave(reload: () => void) {
  const { toast, bumpData, refreshStatus } = useApp();
  return async (patch: unknown, msg = "Settings saved.") => {
    try {
      await api.put("/api/settings", patch);
      toast(msg);
      reload();
      bumpData();
      await refreshStatus();
      return true;
    } catch (e) {
      const err = e as Error & { details?: string[] };
      toast(`${err.message}${err.details ? `: ${err.details.join("; ")}` : ""}`, "error");
      return false;
    }
  };
}

function ProvidersPanel({ s, reload }: { s: SettingsResp; reload: () => void }) {
  const { data, error, reload: reloadProviders } = useApi<{ providers: Provider[]; ai: { configured: boolean; enabled: boolean; usedToday: number; cap: number; model: string } }>("/api/providers");
  const save = useSave(() => {
    reload();
    reloadProviders();
  });
  const { toast } = useApp();
  const [testing, setTesting] = useState<string | null>(null);
  const st = s.settings;
  const test = async (id: string) => {
    setTesting(id);
    try {
      const r = await api.post<{ detail: string; latencyMs: number }>(`/api/providers/${id}/test`);
      toast(`Connection OK (${r.latencyMs} ms): ${r.detail}`);
    } catch (e) {
      toast(`Connection test failed: ${(e as Error).message}`, "error");
    } finally {
      setTesting(null);
      reloadProviders();
    }
  };
  if (error) return <ErrorBox error={error} onRetry={reloadProviders} />;
  if (!data) return <Loading />;
  return (
    <div className="stack">
      <Callout kind="info" title="What works without keys.">
        The demo world, Classroom Lab, Model Report, Knowledge Center and all calculators work offline. With no key at all you can also enable the MLB Stats API (schedules, results, probable pitchers, lineups, injured lists), nflverse (NFL schedules, results and closing lines), Open-Meteo (weather) and RSS news, and import tennis results files below. NBA history needs a free balldontlie key (BALLDONTLIE_API_KEY). Market quotes need The Odds API key (ODDS_API_KEY in .env). The optional AI explanation needs ANTHROPIC_API_KEY.
      </Callout>
      <EnvFileCard s={s} />
      <Callout kind="warn" title="Coverage is never 'all sportsbooks'.">
        Best prices are always "highest among connected sources". The books, sports and markets actually seen on this installation are listed under each provider after a refresh.
      </Callout>
      {data.providers.map((p) => (
        <section key={p.id} className="card" aria-labelledby={`pv-${p.id}`}>
          <div className="card-head">
            <div>
              <h2 id={`pv-${p.id}`}>{p.name}</h2>
              <div className="subtle small">{p.roles.join(" · ")}</div>
            </div>
            <div className="row">
              <span className={`chip ${HEALTH[p.health.state]?.cls ?? ""}`}>{HEALTH[p.health.state]?.text ?? p.health.state}</span>
              <label className="check">
                <input
                  type="checkbox"
                  checked={p.enabled}
                  onChange={(e) => save({ providers: { [p.id]: { enabled: e.target.checked } } }, `${p.name} ${e.target.checked ? "enabled" : "disabled"}.`)}
                />
                Enabled
              </label>
              <button className="btn btn-sm" onClick={() => test(p.id)} disabled={testing === p.id || !p.enabled || !p.keyConfigured}>
                <IconRefresh className={testing === p.id ? "spin" : undefined} /> Test connection
              </button>
            </div>
          </div>
          {p.requiresKey && !p.keyConfigured && (
            <Callout kind="warn">
              Add <code>{p.keyEnvVar}=…</code> to the <code>.env</code> file next to package.json, then restart the app. The key never leaves the server.
            </Callout>
          )}
          <p className="small">{p.verification}</p>
          <div className="grid grid-2" style={{ marginTop: 8 }}>
            <div className="small">
              <strong>Coverage</strong>
              <ul className="list-bullets text-2">
                {p.coverage.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
              <strong>History</strong>
              <p className="text-2">{p.history}</p>
              <strong>Licensing</strong>
              <p className="text-2">{p.licensing}</p>
            </div>
            <div className="small">
              <strong>Costs and quotas</strong>
              <p className="text-2">{p.costNotes}</p>
              <p className="text-2">
                Today: {p.usageToday.requests} request(s){p.id === "oddsapi" ? `, ${p.usageToday.credits} credit(s)` : ""}.
                {p.quota && (
                  <>
                    {" "}
                    Provider reports {p.quota.remaining ?? "?"} credits remaining{p.quota.used != null ? `, ${p.quota.used} used this period` : ""}.
                  </>
                )}
              </p>
              <strong>Health</strong>
              <p className="text-2">
                Last success: {p.health.lastSuccess ? fmtDateTime(p.health.lastSuccess, st.timezone) : "never"}
                {p.health.lastError && (
                  <>
                    <br />
                    Last error ({p.health.lastErrorAt ? fmtDateTime(p.health.lastErrorAt, st.timezone) : "?"}): {p.health.lastError}
                  </>
                )}
              </p>
              <strong>Limitations</strong>
              <ul className="list-bullets text-2">
                {p.limitations.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
              <ExtLink href={p.docsUrl}>Official documentation</ExtLink>
            </div>
          </div>
          {Object.keys(p.observed).length > 0 && <ObservedCoverage observed={p.observed} />}
          {p.id === "oddsapi" && <OddsApiConfig cfg={st.providers.oddsapi} save={save} />}
          {p.id === "mlb" && <MlbConfig cfg={st.providers.mlb} save={save} />}
          {p.id === "nflverse" && <HistoryConfig id="nflverse" cfg={st.providers.nflverse} save={save} max={10} label="NFL seasons" />}
          {p.id === "balldontlie" && <HistoryConfig id="balldontlie" cfg={st.providers.balldontlie} save={save} max={5} label="NBA seasons" />}
          {p.id === "rss" && <RssConfig cfg={st.providers.rss} save={save} />}
        </section>
      ))}
      <ImportResults />
      <section className="card">
        <div className="card-head">
          <div>
            <h2>Optional AI explanations</h2>
            <div className="subtle small">Summarises computed results and cited sources in plain language. It never changes a number.</div>
          </div>
          <label className="check">
            <input type="checkbox" checked={st.providers.ai.enabled} onChange={(e) => save({ providers: { ai: { enabled: e.target.checked } } })} disabled={!s.secrets.anthropicApiKey} />
            Enabled
          </label>
        </div>
        {!s.secrets.anthropicApiKey && (
          <Callout kind="info">
            No ANTHROPIC_API_KEY on the server, so deterministic summaries are used everywhere. The app is fully functional without it.
          </Callout>
        )}
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label className="field">
            Daily request cap
            <NumberSave value={st.providers.ai.dailyRequestCap} min={0} max={500} onSave={(v) => save({ providers: { ai: { dailyRequestCap: v } } })} />
          </label>
          <span className="small text-2">
            Used today: {data.ai.usedToday}/{data.ai.cap} · model {data.ai.model}. Each explanation is one request, made only when someone clicks the button.
          </span>
        </div>
      </section>
    </div>
  );
}

function ObservedCoverage({ observed }: { observed: Record<string, any> }) {
  const bookKeys = Object.keys(observed).filter((k) => k.startsWith("books:"));
  return (
    <details className="disclosure" style={{ marginTop: 10 }}>
      <summary className="small">Observed on this installation</summary>
      <div className="disclosure-body small">
        {observed.sports && (
          <p>
            Active sports listed by the provider ({observed.sportsCheckedAt?.slice(0, 16)}): {observed.sports.map((s: any) => `${s.title} (${s.key})`).join(", ")}
          </p>
        )}
        {bookKeys.map((k) => (
          <p key={k}>
            Books seen for {k.slice(6)} ({observed[`booksCheckedAt:${k.slice(6)}`]?.slice(0, 16)}): {observed[k].length ? observed[k].join(", ") : "none"}
          </p>
        ))}
        {observed.historySeasons && (
          <p>
            History imported: {observed.historySeasons.join(", ")} ({observed.historyImportedAt?.slice(0, 16)})
          </p>
        )}
      </div>
    </details>
  );
}

function NumberSave({ value, min, max, onSave, step = 1 }: { value: number; min: number; max: number; step?: number; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const n = Number(v);
  const valid = v !== "" && Number.isFinite(n) && n >= min && n <= max;
  return (
    <span className="row" style={{ gap: 6 }}>
      <input type="number" value={v} min={min} max={max} step={step} onChange={(e) => setV(e.target.value)} style={{ width: 100 }} aria-invalid={!valid} />
      <button className="btn btn-sm" disabled={!valid || n === value} onClick={() => onSave(n)}>
        Save
      </button>
    </span>
  );
}

function OddsApiConfig({ cfg, save }: { cfg: any; save: (p: unknown, m?: string) => Promise<boolean> }) {
  const [sports, setSports] = useState(cfg.sports.join(", "));
  const [bookmakers, setBookmakers] = useState(cfg.bookmakers.join(", "));
  const cost = cfg.markets.length * (cfg.bookmakers.length ? Math.ceil(cfg.bookmakers.length / 10) : cfg.regions.length);
  const toggle = (list: string[], item: string) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  return (
    <details className="disclosure" style={{ marginTop: 10 }}>
      <summary>Odds API configuration and cost caps</summary>
      <div className="disclosure-body stack-sm">
        <label className="field">
          Sport keys (comma separated, as listed by /v4/sports, e.g. baseball_mlb, icehockey_nhl, soccer_epl)
          <span className="row">
            <input type="text" value={sports} onChange={(e) => setSports(e.target.value)} style={{ flex: 1 }} />
            <button className="btn btn-sm" onClick={() => save({ providers: { oddsapi: { sports: sports.split(",").map((x: string) => x.trim()).filter(Boolean) } } })}>
              Save
            </button>
          </span>
        </label>
        <fieldset className="row" style={{ border: 0, padding: 0 }}>
          <legend className="small">Regions (each adds cost)</legend>
          {["us", "us2", "uk", "eu", "au"].map((r) => (
            <label key={r} className="check">
              <input type="checkbox" checked={cfg.regions.includes(r)} onChange={() => save({ providers: { oddsapi: { regions: toggle(cfg.regions, r) } } })} />
              {r}
            </label>
          ))}
        </fieldset>
        <fieldset className="row" style={{ border: 0, padding: 0 }}>
          <legend className="small">Markets (each adds cost; spreads and totals are modelled for basketball and football)</legend>
          {["h2h", "h2h_3_way", "spreads", "totals"].map((m) => (
            <label key={m} className="check">
              <input type="checkbox" checked={cfg.markets.includes(m)} onChange={() => save({ providers: { oddsapi: { markets: toggle(cfg.markets, m) } } })} />
              {m}
            </label>
          ))}
        </fieldset>
        <label className="field">
          Specific bookmaker keys (optional, overrides regions; comma separated)
          <span className="row">
            <input type="text" value={bookmakers} onChange={(e) => setBookmakers(e.target.value)} style={{ flex: 1 }} />
            <button className="btn btn-sm" onClick={() => save({ providers: { oddsapi: { bookmakers: bookmakers.split(",").map((x: string) => x.trim()).filter(Boolean) } } })}>
              Save
            </button>
          </span>
        </label>
        <p className="small">
          Estimated cost per odds refresh: <strong>{cost} credit(s) per sport</strong> × {cfg.sports.length} sport(s). Scores refreshes cost 2 credits per non-MLB sport.
        </p>
        <div className="row">
          <label className="field">
            Daily credit cap
            <NumberSave value={cfg.dailyCreditCap} min={0} max={100000} onSave={(v) => save({ providers: { oddsapi: { dailyCreditCap: v } } })} />
          </label>
          <label className="field">
            Keep at least this many credits
            <NumberSave value={cfg.minRemainingCredits} min={0} max={100000} onSave={(v) => save({ providers: { oddsapi: { minRemainingCredits: v } } })} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={cfg.allowHistorical} onChange={(e) => save({ providers: { oddsapi: { allowHistorical: e.target.checked } } })} />
          Allow historical snapshot imports (paid plans only; 10× credits per request)
        </label>
        <label className="check">
          <input type="checkbox" checked={cfg.tennisAuto} onChange={(e) => save({ providers: { oddsapi: { tennisAuto: e.target.checked } } })} />
          Also refresh every active tennis tournament (each tournament is a separate sport key and costs credits on every refresh)
        </label>
        <p className="small subtle">
          Useful keys: basketball_nba, americanfootball_nfl, baseball_mlb, icehockey_nhl, soccer_epl. Tennis tournaments use keys like tennis_atp_wimbledon; their players share one ATP or WTA rating list.
        </p>
      </div>
    </details>
  );
}

/** Shows where the server looked for .env and why a key may not be picked up. Never shows values. */
function EnvFileCard({ s }: { s: SettingsResp }) {
  const e = s.envFile;
  if (!e) return null;
  const keys: [string, boolean | undefined][] = [
    ["ODDS_API_KEY", s.secrets.oddsApiKey],
    ["BALLDONTLIE_API_KEY", s.secrets.balldontlieApiKey],
    ["ANTHROPIC_API_KEY", s.secrets.anthropicApiKey],
  ];
  const problems = e.hints.length > 0 || !e.found;
  return (
    <Callout kind={problems ? "warn" : "info"} title={e.found ? "Server settings file found." : "Server settings file not found."}>
      <span className="small">
        The server read <code>{e.path}</code>
        {e.found ? ` (${e.keys.length} setting${e.keys.length === 1 ? "" : "s"}: ${e.keys.join(", ") || "none"})` : ""}. Keys:{" "}
        {keys.map(([k, ok], i) => (
          <span key={k}>
            {i > 0 && ", "}
            <code>{k}</code> {ok ? "configured" : "not set"}
          </span>
        ))}
        . After editing <code>.env</code>, stop the app (Ctrl+C in its window) and start it again: the file is read only at start-up.
      </span>
      {e.hints.length > 0 && (
        <ul className="list-bullets small" style={{ marginTop: 6 }}>
          {e.hints.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}
    </Callout>
  );
}

function HistoryConfig({ id, cfg, save, max, label }: { id: "nflverse" | "balldontlie"; cfg: any; save: (p: unknown, m?: string) => Promise<boolean>; max: number; label: string }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  return (
    <details className="disclosure" style={{ marginTop: 10 }}>
      <summary>{label} for the model</summary>
      <div className="disclosure-body stack-sm">
        <p>
          The model needs at least two completed seasons before the season being forecast. Imported games are matched to games already in the database (same teams, start within 2.5 hours), so odds stay attached.
          {id === "balldontlie" && " The free tier allows about 5 requests per minute, so importing a season takes a few minutes; keep this page open."}
        </p>
        <div className="row">
          <label className="field">
            Previous seasons to import
            <NumberSave value={cfg.historySeasons} min={1} max={max} onSave={(v) => save({ providers: { [id]: { historySeasons: v } } })} />
          </label>
          {id === "balldontlie" && (
            <label className="field">
              Requests per minute (your plan's limit)
              <NumberSave value={cfg.requestsPerMinute} min={1} max={600} onSave={(v) => save({ providers: { balldontlie: { requestsPerMinute: v } } })} />
            </label>
          )}
        </div>
        <span>
          <button
            className="btn btn-sm"
            disabled={!cfg.enabled || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api.post<{ games: number; created: number; seasons: number[] }>(`/api/providers/${id}/import`);
                toast(`Imported ${r.games} games (${r.created} new) for ${r.seasons.join(", ")}.`);
              } catch (e) {
                toast((e as Error).message, "error");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Importing…" : "Import history now"}
          </button>
        </span>
      </div>
    </details>
  );
}

interface CsvImportResult {
  rows: number;
  imported: number;
  created: number;
  quotes: number;
  skipped: { row: number; reason: string }[];
}

function ImportResults() {
  const { toast, bumpData } = useApp();
  const [sport, setSport] = useState("tennis_atp");
  const [preset, setPreset] = useState<"tennis-data" | "generic">("tennis-data");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CsvImportResult | null>(null);
  const run = async () => {
    if (!file) return;
    if (file.size > 19_000_000) return toast("That file is larger than 19 MB. Split it by season.", "error");
    setBusy(true);
    setResult(null);
    try {
      const csv = await file.text();
      const r = await api.post<CsvImportResult>("/api/import/results", { sport, preset, csv });
      setResult(r);
      bumpData();
      toast(`Imported ${r.imported} of ${r.rows} rows.`);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="imp-h">
      <h2 id="imp-h">Import results (CSV)</h2>
      <p className="small text-2">
        Add history from a file you downloaded yourself; nothing is fetched. For tennis, season files from tennis-data.co.uk work once saved as CSV (columns Date, Surface, Best of, Winner, Loser, Wsets, Lsets, Comment, and the PSW/PSL and AvgW/AvgL closing odds when present). Any sport can use the generic format with columns{" "}
        <code>date, home, away, home_score, away_score</code> and optionally <code>time</code> (UTC, HH:MM), <code>neutral</code>, <code>surface</code>, <code>best_of</code>.
      </p>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label className="field">
          Sport
          <select value={sport} onChange={(e) => setSport(e.target.value)}>
            <option value="tennis_atp">Tennis (ATP)</option>
            <option value="tennis_wta">Tennis (WTA)</option>
            <option value="basketball_nba">NBA</option>
            <option value="americanfootball_nfl">NFL</option>
            <option value="baseball_mlb">MLB</option>
            <option value="icehockey_nhl">NHL (market only)</option>
          </select>
        </label>
        <label className="field">
          Format
          <select value={preset} onChange={(e) => setPreset(e.target.value as "tennis-data" | "generic")}>
            <option value="tennis-data">tennis-data.co.uk (saved as CSV)</option>
            <option value="generic">Generic results CSV</option>
          </select>
        </label>
        <label className="field">
          File
          <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <button className="btn btn-primary btn-sm" onClick={run} disabled={!file || busy}>
          {busy ? "Importing…" : "Import"}
        </button>
      </div>
      {result && (
        <div className="small" style={{ marginTop: 10 }} role="status">
          <p>
            {result.imported} of {result.rows} rows imported ({result.created} new games, {result.quotes} closing quotes stored 60 minutes before each start).
          </p>
          {result.skipped.length > 0 && (
            <details className="disclosure">
              <summary>{result.skipped.length} row(s) skipped</summary>
              <ul className="disclosure-body list-plain">
                {result.skipped.map((x) => (
                  <li key={x.row}>
                    Row {x.row}: {x.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function MlbConfig({ cfg, save }: { cfg: any; save: (p: unknown, m?: string) => Promise<boolean> }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  return (
    <details className="disclosure" style={{ marginTop: 10 }}>
      <summary>MLB history for the model</summary>
      <div className="disclosure-body stack-sm">
        <p>The model needs at least two completed seasons before the season being forecast. History is fetched once per season and cached for a week.</p>
        <label className="field">
          Previous seasons to import
          <NumberSave value={cfg.historySeasons} min={1} max={5} onSave={(v) => save({ providers: { mlb: { historySeasons: v } } })} />
        </label>
        <span>
          <button
            className="btn btn-sm"
            disabled={!cfg.enabled || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api.post<{ seasons: string[]; events: number }>("/api/providers/mlb/history");
                toast(`Imported ${r.events} games for ${r.seasons.join(", ")}.`);
              } catch (e) {
                toast((e as Error).message, "error");
              } finally {
                setBusy(false);
              }
            }}
          >
            Import history now
          </button>
        </span>
      </div>
    </details>
  );
}

function RssConfig({ cfg, save }: { cfg: any; save: (p: unknown, m?: string) => Promise<boolean> }) {
  const [feeds, setFeeds] = useState<{ url: string; name: string; tier: "official" | "media"; sportKey?: string }[]>(cfg.feeds);
  useEffect(() => setFeeds(cfg.feeds), [cfg.feeds]);
  return (
    <details className="disclosure" style={{ marginTop: 10 }}>
      <summary>News feeds ({cfg.feeds.length})</summary>
      <div className="disclosure-body stack-sm">
        <p>Only these https feeds are fetched. Prefer official team and league feeds; mark everything else as media. Requests to private or local network addresses are refused.</p>
        {feeds.map((f, i) => (
          <div key={i} className="row" style={{ alignItems: "flex-end" }}>
            <label className="field" style={{ flex: "2 1 260px" }}>
              Feed URL
              <input type="url" value={f.url} onChange={(e) => setFeeds(feeds.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />
            </label>
            <label className="field" style={{ flex: "1 1 140px" }}>
              Name
              <input type="text" value={f.name} onChange={(e) => setFeeds(feeds.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            </label>
            <label className="field">
              Tier
              <select value={f.tier} onChange={(e) => setFeeds(feeds.map((x, j) => (j === i ? { ...x, tier: e.target.value as "official" | "media" } : x)))}>
                <option value="official">Official</option>
                <option value="media">Media</option>
              </select>
            </label>
            <label className="field">
              Sport key
              <input type="text" value={f.sportKey ?? ""} placeholder="optional" onChange={(e) => setFeeds(feeds.map((x, j) => (j === i ? { ...x, sportKey: e.target.value || undefined } : x)))} style={{ width: 130 }} />
            </label>
            <button className="btn btn-sm btn-danger" onClick={() => setFeeds(feeds.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        <div className="row">
          <button className="btn btn-sm" onClick={() => setFeeds([...feeds, { url: "https://", name: "", tier: "media" }])} disabled={feeds.length >= 25}>
            Add feed
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => save({ providers: { rss: { feeds } } }, "Feeds saved.")}>
            Save feeds
          </button>
        </div>
      </div>
    </details>
  );
}

function SchedulerPanel({ s, reload }: { s: SettingsResp; reload: () => void }) {
  const { toast, refreshStatus } = useApp();
  const { data: sched, reload: reloadSched } = useApi<any>("/api/scheduler");
  const [cat, setCat] = useState("");
  const { data: activity, reload: reloadActivity } = useApi<{ entries: { id: number; at: string; level: string; category: string; message: string }[] }>(`/api/activity${qs({ limit: 200, category: cat })}`);
  const save = useSave(() => {
    reload();
    reloadSched();
  });
  const st = s.settings;
  const [busy, setBusy] = useState<string | null>(null);
  const call = async (url: string, label: string) => {
    setBusy(label);
    try {
      const r = await api.post<any>(url);
      toast(r.result ? `${label}: ${r.result}` : `${label} done.`, r.ok === false ? "error" : "info");
      reloadSched();
      reloadActivity();
      await refreshStatus();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="stack">
      <Callout kind="warn" title="Scans run only while this program is running.">
        The scheduler lives inside the Overround Lab server process. If you close the terminal window or shut down the computer, no scans happen, and missed runs are not back-filled. The scheduler affects connected providers only; the demo needs no refreshes.
      </Callout>
      {sched && (
        <div className="card">
          <div className="card-head">
            <h2>Scheduler</h2>
            <div className="row">
              <span className={`chip ${sched.paused ? "chip-warn" : "chip-good"}`}>{sched.paused ? "Paused" : "Running"}</span>
              {sched.paused ? (
                <button className="btn btn-sm btn-primary" onClick={() => call("/api/scheduler/resume", "Resume")}>
                  <IconPlay /> Resume
                </button>
              ) : (
                <button className="btn btn-sm" onClick={() => call("/api/scheduler/pause", "Pause")}>
                  <IconPause /> Pause
                </button>
              )}
            </div>
          </div>
          <p className="subtle small">Process started {fmtDateTime(sched.processStartedAt, st.timezone)} · times in {sched.timezone}</p>
          <div className="table-wrap" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Last run</th>
                  <th scope="col">Last success</th>
                  <th scope="col">Next run</th>
                  <th scope="col">Last result</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {sched.jobs.map((j: any) => (
                  <tr key={j.name}>
                    <td>
                      {j.label}
                      <div className="subtle small">{j.intervalMinutes ? `every ${j.intervalMinutes} min` : `daily at ${st.scheduler.dailyScanTime}`}</div>
                    </td>
                    <td className="small">{j.last_run_at ? fmtDateTime(j.last_run_at, st.timezone) : "never"}</td>
                    <td className="small">{j.last_success_at ? fmtDateTime(j.last_success_at, st.timezone) : "never"}</td>
                    <td className="small">{sched.paused ? <span className="subtle">paused</span> : j.next_run_at ? fmtDateTime(j.next_run_at, st.timezone) : "—"}</td>
                    <td className="small text-2" style={{ maxWidth: 320 }}>
                      {j.running ? "Running…" : j.last_result ?? "—"}
                    </td>
                    <td>
                      <button className="btn btn-sm" disabled={!!busy || j.running} onClick={() => call(`/api/scheduler/run/${j.name}`, j.label)}>
                        {busy === j.label ? "Running…" : "Run now"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ marginTop: 12, alignItems: "flex-end" }}>
            <label className="field">
              Daily scan time ({st.timezone})
              <span className="row" style={{ gap: 6 }}>
                <TimeSave value={st.scheduler.dailyScanTime} onSave={(v) => save({ scheduler: { dailyScanTime: v } })} />
              </span>
            </label>
            <label className="field">
              Odds refresh (min)
              <NumberSave value={st.scheduler.oddsRefreshMinutes} min={15} max={1440} onSave={(v) => save({ scheduler: { oddsRefreshMinutes: v } })} />
            </label>
            <label className="field">
              Results refresh (min)
              <NumberSave value={st.scheduler.resultsRefreshMinutes} min={15} max={1440} onSave={(v) => save({ scheduler: { resultsRefreshMinutes: v } })} />
            </label>
            <label className="field">
              News refresh (min)
              <NumberSave value={st.scheduler.newsRefreshMinutes} min={30} max={1440} onSave={(v) => save({ scheduler: { newsRefreshMinutes: v } })} />
            </label>
          </div>
          <p className="subtle small">Odds refreshes are skipped automatically when no games remain today, and every paid request is checked against your credit caps first.</p>
        </div>
      )}
      <div className="card">
        <div className="card-head">
          <h2>Activity log</h2>
          <div className="row">
            <select aria-label="Filter activity by category" value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">All categories</option>
              {["scheduler", "refresh", "analyze", "oddsapi", "mlb", "nflverse", "balldontlie", "import", "openmeteo", "rss", "ai", "classroom", "demo", "settings", "server"].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <button className="btn btn-sm" onClick={reloadActivity}>
              <IconRefresh /> Refresh
            </button>
          </div>
        </div>
        {!activity ? (
          <Loading rows={2} />
        ) : !activity.entries.length ? (
          <p className="subtle">No activity yet.</p>
        ) : (
          <div className="table-wrap" tabIndex={0} style={{ maxHeight: 460, overflow: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Level</th>
                  <th scope="col">Category</th>
                  <th scope="col">Message</th>
                </tr>
              </thead>
              <tbody>
                {activity.entries.map((e) => (
                  <tr key={e.id}>
                    <td className="small" style={{ whiteSpace: "nowrap" }}>
                      {fmtDateTime(e.at, st.timezone)}
                    </td>
                    <td>
                      <span className={`chip ${e.level === "error" ? "chip-danger" : e.level === "warn" ? "chip-warn" : ""}`}>{e.level}</span>
                    </td>
                    <td className="small">{e.category}</td>
                    <td className="small">{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function TimeSave({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <>
      <input type="time" value={v} onChange={(e) => setV(e.target.value)} />
      <button className="btn btn-sm" disabled={!v || v === value} onClick={() => onSave(v)}>
        Save
      </button>
    </>
  );
}

const ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Toronto",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
  "UTC",
];

function GeneralPanel({ s, reload }: { s: SettingsResp; reload: () => void }) {
  const save = useSave(reload);
  const st = s.settings;
  const zones = ZONES.includes(st.timezone) ? ZONES : [st.timezone, ...ZONES];
  const { clock } = useApp();
  return (
    <div className="grid grid-2">
      <div className="card">
        <h2>Time zone</h2>
        <p className="text-2 small">All "today" boards use local calendar days in this zone, including 23- and 25-hour days at daylight-saving changes. Late games can belong to the next local day.</p>
        <label className="field">
          Time zone
          <select value={st.timezone} onChange={(e) => save({ timezone: e.target.value }, "Time zone saved.")}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </label>
        <p className="subtle small" style={{ marginTop: 8 }}>
          Clock now: {fmtDateTime(clock, st.timezone)} ({ago(clock, clock)}).
        </p>
      </div>
      <div className="card">
        <h2>Analysis thresholds</h2>
        <label className="field">
          A quote is stale when not re-confirmed for this many minutes
          <NumberSave value={st.staleQuoteMinutes} min={5} max={1440} onSave={(v) => save({ staleQuoteMinutes: v })} />
        </label>
        <p className="subtle small">Stale quotes are shown greyed out and are never used as current prices or in the market reference.</p>
        <label className="field" style={{ marginTop: 10 }}>
          Minimum model–market difference before it can be a research lead (percentage points)
          <NumberSave value={Math.round(st.discrepancyMinPoints * 100)} min={1} max={20} onSave={(v) => save({ discrepancyMinPoints: v / 100 })} />
        </label>
        <p className="subtle small">A lead also requires the gap to exceed the model's uncertainty and the model to have beaten the market in validation.</p>
      </div>
      <div className="card">
        <h2>Security</h2>
        <ul className="list-bullets small text-2">
          <li>The server listens on localhost (127.0.0.1) only by default; other devices cannot connect unless you explicitly set HOST and ALLOW_REMOTE.</li>
          <li>Odds API key: {s.secrets.oddsApiKey ? "configured on the server" : "not set"}. Anthropic key: {s.secrets.anthropicApiKey ? "configured on the server" : "not set"}. Keys are never sent to the browser, exports or logs.</li>
          <li>Instructor PIN: {s.secrets.instructorPin ? "configured; required for settings and instructor actions" : "not set, so anyone using the app can change settings"}.</li>
        </ul>
      </div>
    </div>
  );
}

function AppearancePanel() {
  const { prefs, setPrefs } = useApp();
  return (
    <div className="grid grid-2">
      <div className="card">
        <h2>Theme</h2>
        <div className="segmented" role="group" aria-label="Theme">
          {(["system", "dark", "light"] as const).map((t) => (
            <button key={t} aria-pressed={prefs.theme === t} onClick={() => setPrefs({ theme: t })}>
              {t === "system" ? "Match system" : t === "dark" ? "Dark studio" : "Light"}
            </button>
          ))}
        </div>
        <label className="check" style={{ marginTop: 14 }}>
          <input type="checkbox" checked={prefs.highContrast} onChange={(e) => setPrefs({ highContrast: e.target.checked })} />
          Higher contrast text and borders
        </label>
      </div>
      <div className="card">
        <h2>Motion and text</h2>
        <div className="segmented" role="group" aria-label="Motion">
          {(["system", "reduce", "full"] as const).map((m) => (
            <button key={m} aria-pressed={prefs.motion === m} onClick={() => setPrefs({ motion: m })}>
              {m === "system" ? "Match system" : m === "reduce" ? "Reduce motion" : "Full motion"}
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="Text size" style={{ marginTop: 12 }}>
          {([1, 1.125, 1.25] as const).map((s) => (
            <button key={s} aria-pressed={prefs.textScale === s} onClick={() => setPrefs({ textScale: s })}>
              {s === 1 ? "Default text" : s === 1.125 ? "Larger" : "Largest"}
            </button>
          ))}
        </div>
        <p className="subtle small" style={{ marginTop: 10 }}>
          Preferences are stored in this browser only. Keyboard: <span className="kbd">Tab</span> moves through controls; arrow keys switch tabs and move chart crosshairs.
        </p>
      </div>
    </div>
  );
}
