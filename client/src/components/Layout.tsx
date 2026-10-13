import { useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useApp } from "../state";
import { fmtDateTime, utcToZonedLocal, zonedLocalToUtc } from "../format";
import { BrandMark, IconClock, IconEvidence, IconGames, IconLab, IconMarket, IconPause, IconPlay, IconReport, IconSettings, IconToday, IconX } from "./icons";
import { Modal, Toasts } from "./ui";

const NAV = [
  { to: "/", label: "Today", icon: IconToday, end: true },
  { to: "/games", label: "Games", icon: IconGames },
  { to: "/markets", label: "Market Explorer", short: "Markets", icon: IconMarket },
  { to: "/evidence", label: "Evidence", icon: IconEvidence },
  { to: "/lab", label: "Classroom Lab", short: "Lab", icon: IconLab },
  { to: "/report", label: "Model Report", short: "Report", icon: IconReport },
  { to: "/settings", label: "Settings", icon: IconSettings },
];

export function ModeBadge() {
  const { mode, dataset, replayAsOf, zone } = useApp();
  if (mode === "replay") {
    return (
      <span className="mode-badge mode-replay" role="status" aria-live="polite">
        <span className="dot" aria-hidden="true" />
        Historical replay{dataset === "demo" ? " · demo" : ""}
        <span className="sr-only">: information frozen at {fmtDateTime(replayAsOf!, zone)}</span>
      </span>
    );
  }
  if (dataset === "demo") {
    return (
      <span className="mode-badge mode-demo" role="status">
        <span className="dot" aria-hidden="true" />
        Demo · fictional data
      </span>
    );
  }
  return (
    <span className="mode-badge mode-live" role="status">
      <span className="dot" aria-hidden="true" />
      Connected data
    </span>
  );
}

function ReplayDialog({ onClose }: { onClose: () => void }) {
  const { zone, clock, setReplayAsOf, replayAsOf, dataset } = useApp();
  const [value, setValue] = useState(() => utcToZonedLocal(replayAsOf ?? new Date(Date.parse(clock) - 86400000 * 7).toISOString(), zone));
  const [err, setErr] = useState<string | null>(null);
  const apply = () => {
    const iso = zonedLocalToUtc(value, zone);
    if (!iso) return setErr("Enter a valid date and time.");
    if (iso >= clock) return setErr("Replay time must be earlier than the current clock. Future information is never available.");
    setReplayAsOf(iso);
    onClose();
  };
  return (
    <Modal title="Historical replay" onClose={onClose}>
      <p className="text-2 small">
        Freeze all information at a past moment: only quotes, injuries, lineups and news known by then are used, the model uses parameters fitted on earlier seasons only, and results after that moment stay hidden.
      </p>
      <label className="field">
        Information time ({zone})
        <input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} max={utcToZonedLocal(clock, zone)} />
      </label>
      {dataset === "demo" && <p className="subtle small" style={{ marginTop: 8 }}>The fictional demo world covers 2024–2026 (the model needs two completed seasons, so 2026 dates work best).</p>}
      {err && (
        <p role="alert" className="small" style={{ color: "var(--danger)" }}>
          {err}
        </p>
      )}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
        {replayAsOf && (
          <button
            className="btn"
            onClick={() => {
              setReplayAsOf(null);
              onClose();
            }}
          >
            Exit replay
          </button>
        )}
        <button className="btn btn-primary" onClick={apply}>
          Start replay
        </button>
      </div>
    </Modal>
  );
}

function TopBar() {
  const { dataset, setDataset, status, statusError, zone, clock, mode, replayAsOf, setReplayAsOf } = useApp();
  const [replayOpen, setReplayOpen] = useState(false);
  const sched = status?.scheduler;
  return (
    <header className="topbar">
      <ModeBadge />
      <div className="segmented no-print" role="group" aria-label="Data source">
        <button aria-pressed={dataset === "demo"} onClick={() => setDataset("demo")}>
          Demo
        </button>
        <button aria-pressed={dataset === "live"} onClick={() => setDataset("live")}>
          Connected
        </button>
      </div>
      <div className="topbar-meta">
        <span className="row" style={{ gap: 6 }}>
          <IconClock style={{ width: 15, height: 15 }} />
          {mode === "replay" ? (
            <span>
              Information frozen at <strong>{fmtDateTime(replayAsOf!, zone)}</strong>
            </span>
          ) : dataset === "demo" ? (
            <span>
              Demo clock <strong>{fmtDateTime(clock, zone)}</strong>
            </span>
          ) : (
            <span>
              As of <strong>{fmtDateTime(clock, zone)}</strong>
            </span>
          )}
        </span>
        {mode === "replay" ? (
          <button className="btn btn-sm no-print" onClick={() => setReplayAsOf(null)}>
            <IconX /> Exit replay
          </button>
        ) : (
          <button className="btn btn-sm no-print" onClick={() => setReplayOpen(true)}>
            Replay a past moment
          </button>
        )}
      </div>
      <div className="topbar-spacer" />
      {dataset === "live" && sched && (
        <span className="chip no-print" title={sched.note}>
          {sched.paused ? <IconPause /> : <IconPlay />}
          Scheduler {sched.paused ? "paused" : "on (while app runs)"}
        </span>
      )}
      {statusError && (
        <span className="chip chip-danger" role="alert">
          {statusError}
        </span>
      )}
      {replayOpen && <ReplayDialog onClose={() => setReplayOpen(false)} />}
    </header>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className="shell">
        <nav className="sidebar" aria-label="Main">
          <NavLink to="/" className="brand" end>
            <BrandMark className="brand-mark" />
            <span>
              <span className="brand-name">Overround Lab</span>
              <span className="brand-sub">Sports market classroom</span>
            </span>
          </NavLink>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
              <n.icon />
              {n.label}
            </NavLink>
          ))}
          <div className="sidebar-foot">
            Simulation points only. No wagering, deposits or sportsbook accounts. Forecasts are uncertain; "no credible difference" is a normal result.
          </div>
        </nav>
        <div className="main">
          <TopBar />
          <main id="main" className="content" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
      <nav className="mobile-nav" aria-label="Main (mobile)">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? "active" : "")}>
            <n.icon />
            {n.short ?? n.label}
          </NavLink>
        ))}
      </nav>
      <Toasts />
    </>
  );
}
