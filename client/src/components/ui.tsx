import { useEffect, useId, useRef, type ReactNode } from "react";
import type { CompletenessItem, Discrepancy, Outcome, Probs } from "../api";
import { useApp } from "../state";
import { ago, fmtDateTime, formatPct } from "../format";
import { IconCheck, IconInfo, IconLink, IconQuestion, IconWarn, IconX, IconRefresh } from "./icons";

export function Callout({ kind = "info", title, children }: { kind?: "info" | "warn" | "danger" | "hypo"; title?: ReactNode; children?: ReactNode }) {
  const Icon = kind === "warn" || kind === "danger" ? IconWarn : kind === "hypo" ? IconQuestion : IconInfo;
  return (
    <div className={`callout callout-${kind}`} role={kind === "danger" ? "alert" : undefined}>
      <Icon />
      <div>
        {title && <strong>{title} </strong>}
        {children}
      </div>
    </div>
  );
}

export function Loading({ label = "Loading…", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="stack-sm">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: i === 0 ? 22 : 64, width: i === 0 ? "40%" : "100%" }} />
      ))}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="callout callout-danger" role="alert">
      <IconWarn />
      <div className="stack-sm" style={{ gap: 6 }}>
        <span>{error}</span>
        {onRetry && (
          <span>
            <button className="btn btn-sm" onClick={onRetry}>
              <IconRefresh /> Try again
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {children && <div className="subtle">{children}</div>}
    </div>
  );
}

export function ExtLink({ href, children }: { href: string | null | undefined; children: ReactNode }) {
  if (!href || !/^https?:\/\//i.test(href)) return <>{children}</>;
  const fictional = href.includes(".invalid");
  if (fictional) {
    return (
      <span title="Fictional demo source: this link intentionally goes nowhere.">
        {children} <span className="chip chip-hypo">fictional link</span>
      </span>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children} <IconLink style={{ width: 13, height: 13, verticalAlign: "-2px" }} />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

export function TimeStamp({ iso, label }: { iso: string | null | undefined; label?: string }) {
  const { zone, clock } = useApp();
  if (!iso) return <span className="subtle">{label ? `${label}: ` : ""}unknown</span>;
  return (
    <time dateTime={iso} title={iso}>
      {label ? `${label} ` : ""}
      {fmtDateTime(iso, zone)} <span className="subtle">({ago(iso, clock)})</span>
    </time>
  );
}

export const VERDICT_TEXT: Record<Discrepancy["verdict"], string> = {
  research_lead: "Research lead",
  no_credible_difference: "No credible difference",
  insufficient_evidence: "Insufficient evidence",
};

export function VerdictChip({ verdict }: { verdict: Discrepancy["verdict"] }) {
  const cls = verdict === "research_lead" ? "chip-info" : verdict === "no_credible_difference" ? "chip-muted" : "chip-warn";
  return <span className={`chip ${cls}`}>{VERDICT_TEXT[verdict]}</span>;
}

const STATUS_META: Record<CompletenessItem["status"], { cls: string; text: string }> = {
  ok: { cls: "chip-good", text: "Available" },
  partial: { cls: "chip-warn", text: "Partial" },
  missing: { cls: "chip-danger", text: "Missing" },
  stale: { cls: "chip-warn", text: "Stale" },
  unknown: { cls: "chip-muted", text: "Unknown" },
  not_applicable: { cls: "chip-muted", text: "Not applicable" },
};

export function CompletenessMeter({ available, applicable, items }: { available: number; applicable: number; items?: CompletenessItem[] }) {
  const parts = items?.filter((i) => i.status !== "not_applicable") ?? [];
  return (
    <span className="row" style={{ gap: 6 }} title={parts.map((p) => `${p.label}: ${STATUS_META[p.status].text}`).join("\n")}>
      <span className="meter" aria-hidden="true">
        {(parts.length ? parts : Array.from({ length: applicable }, (_, i) => ({ status: i < available ? "ok" : "missing" }) as CompletenessItem)).map((p, i) => (
          <span key={i} className={p.status === "ok" ? "on" : p.status === "partial" || p.status === "stale" ? "partial" : ""} />
        ))}
      </span>
      <span className="small text-2">
        {available}/{applicable} inputs
      </span>
    </span>
  );
}

export function CompletenessList({ items }: { items: CompletenessItem[] }) {
  return (
    <ul className="list-plain">
      {items.map((i) => (
        <li key={i.key} className="row-between" style={{ alignItems: "flex-start" }}>
          <span>
            <strong style={{ fontWeight: 600 }}>{i.label}</strong>
            <br />
            <span className="subtle">{i.detail}</span>
          </span>
          <span className={`chip ${STATUS_META[i.status].cls}`}>
            {i.status === "ok" ? <IconCheck /> : i.status === "missing" ? <IconX /> : null}
            {STATUS_META[i.status].text}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Side-by-side probability rows: market reference, model (with 80% range), combined. */
export function ProbRows({
  outcome,
  name,
  market,
  model,
  interval,
  combined,
  raw,
}: {
  outcome: Outcome;
  name: string;
  market?: number | null;
  model?: number | null;
  interval?: [number, number] | null;
  combined?: number | null;
  raw?: number | null;
}) {
  const rows: { label: string; p: number | null | undefined; color: string; range?: [number, number] | null }[] = [
    { label: "Raw implied (best price, incl. margin)", p: raw, color: "var(--muted)" },
    { label: "Market reference", p: market, color: "var(--series-1)" },
    { label: "Independent model", p: model, color: "var(--series-2)", range: interval },
    { label: "Combined (uses market)", p: combined, color: "var(--series-3)" },
  ].filter((r) => r.p != null);
  return (
    <div>
      <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>
        {name} <span className="subtle">({outcome})</span>
      </div>
      <div className="prob-rows" role="list">
        {rows.map((r) => (
          <div key={r.label} role="listitem" style={{ display: "contents" }}>
            <span className="prob-label">
              <span className="swatch" style={{ background: r.color }} aria-hidden="true" />
              <span>{r.label}</span>
            </span>
            <span className="prob-track" aria-hidden="true">
              <span className="prob-fill" style={{ width: `${(r.p ?? 0) * 100}%`, background: r.color }} />
              {r.range && <span className="prob-range" style={{ left: `${r.range[0] * 100}%`, width: `${Math.max(0.5, (r.range[1] - r.range[0]) * 100)}%` }} />}
            </span>
            <span className="num" style={{ fontWeight: 600 }}>
              {formatPct(r.p)}
              {r.range && (
                <span className="subtle" style={{ fontWeight: 400 }}>
                  {" "}
                  ({formatPct(r.range[0])}–{formatPct(r.range[1])})
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ProbBar({ probs, outcomes, names }: { probs: Probs | null; outcomes: Outcome[]; names: Partial<Record<Outcome, string>> }) {
  if (!probs) return <div className="probbar" aria-hidden="true" style={{ background: "var(--panel-3)" }} />;
  const colors = ["var(--series-1)", "var(--muted)", "var(--series-2)"];
  return (
    <div className="probbar" role="img" aria-label={outcomes.map((o) => `${names[o] ?? o} ${formatPct(probs[o])}`).join(", ")}>
      {outcomes.map((o, i) => (
        <span key={o} style={{ width: `${(probs[o] ?? 0) * 100}%`, background: outcomes.length === 2 ? (i === 0 ? colors[0] : colors[2]) : colors[i] }} />
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input, button, select, textarea, a[href]");
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && ref.current) {
        const f = [...ref.current.querySelectorAll<HTMLElement>("input, button, select, textarea, a[href]")].filter((el) => !el.hasAttribute("disabled"));
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
        <div className="row-between" style={{ marginBottom: 12 }}>
          <h2 id={id} style={{ margin: 0 }}>
            {title}
          </h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close dialog">
            <IconX />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void; label: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="tab"
          role="tab"
          id={`tab-${t.id}`}
          aria-selected={value === t.id}
          aria-controls={`panel-${t.id}`}
          tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
            if (!dir) return;
            e.preventDefault();
            const next = (i + dir + tabs.length) % tabs.length;
            onChange(tabs[next].id);
            refs.current[next]?.focus();
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === "error" ? "toast-error" : ""}`}>
          <div className="row-between" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
            <span>{t.text}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
              <IconX />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="subtle small">{sub}</span>}
    </div>
  );
}

export function FictionalNote() {
  const { dataset } = useApp();
  if (dataset !== "demo") return null;
  return (
    <Callout kind="hypo" title="Fictional demo world.">
      Every team, player, book and news item here is invented and generated by a simulator, so you can practise without real data. Nothing here is a real game or price.
    </Callout>
  );
}
