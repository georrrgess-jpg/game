import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type Dataset, type Mode, type Status } from "./api";

export interface Prefs {
  theme: "system" | "dark" | "light";
  motion: "system" | "reduce" | "full";
  textScale: 1 | 1.125 | 1.25;
  highContrast: boolean;
}

const PREFS_KEY = "overround.prefs";
const VIEW_KEY = "overround.view";

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or blocked storage: preferences simply don't persist */
  }
}

interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

interface AppState {
  dataset: Dataset;
  setDataset: (d: Dataset) => void;
  replayAsOf: string | null;
  setReplayAsOf: (iso: string | null) => void;
  mode: Mode;
  /** The information time used for all analysis requests (replay time or current clock). */
  asOfParam: string | undefined;
  status: Status | null;
  statusError: string | null;
  refreshStatus: () => Promise<void>;
  zone: string;
  clock: string;
  prefs: Prefs;
  setPrefs: (p: Partial<Prefs>) => void;
  toast: (text: string, kind?: Toast["kind"]) => void;
  toasts: Toast[];
  dismissToast: (id: number) => void;
  /** Bumped after actions that change server data so pages can refetch. */
  dataVersion: number;
  bumpData: () => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const initialView = loadJson<{ dataset: Dataset }>(VIEW_KEY, { dataset: "demo" });
  const [dataset, setDatasetState] = useState<Dataset>(initialView.dataset === "live" ? "live" : "demo");
  const [replayAsOf, setReplayAsOf] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [prefs, setPrefsState] = useState<Prefs>(() => loadJson<Prefs>(PREFS_KEY, { theme: "system", motion: "system", textScale: 1, highContrast: false }));
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dataVersion, setDataVersion] = useState(0);
  const toastId = useRef(0);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await api.get<Status>(`/api/status?dataset=${dataset}`);
      setStatus(s);
      setStatusError(null);
    } catch (e) {
      setStatusError(e instanceof ApiError ? e.message : "Status unavailable");
    }
  }, [dataset]);

  useEffect(() => {
    void refreshStatus();
    const t = setInterval(() => void refreshStatus(), 30000);
    return () => clearInterval(t);
  }, [refreshStatus, dataVersion]);

  useEffect(() => {
    const root = document.documentElement;
    if (prefs.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", prefs.theme);
    if (prefs.motion === "system") root.removeAttribute("data-motion");
    else root.setAttribute("data-motion", prefs.motion);
    root.style.setProperty("--text-scale", String(prefs.textScale));
    if (prefs.highContrast) root.setAttribute("data-contrast", "high");
    else root.removeAttribute("data-contrast");
  }, [prefs]);

  const setPrefs = useCallback((p: Partial<Prefs>) => {
    setPrefsState((cur) => {
      const next = { ...cur, ...p };
      saveJson(PREFS_KEY, next);
      return next;
    });
  }, []);

  const setDataset = useCallback((d: Dataset) => {
    setDatasetState(d);
    setReplayAsOf(null);
    saveJson(VIEW_KEY, { dataset: d });
  }, []);

  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 9000 : 5000);
  }, []);

  const value = useMemo<AppState>(() => {
    const clock = status?.clock ?? new Date().toISOString();
    const mode: Mode = replayAsOf ? "replay" : dataset === "demo" ? "demo" : "live";
    return {
      dataset,
      setDataset,
      replayAsOf,
      setReplayAsOf,
      mode,
      asOfParam: replayAsOf ?? undefined,
      status,
      statusError,
      refreshStatus,
      zone: status?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      clock,
      prefs,
      setPrefs,
      toast,
      toasts,
      dismissToast: (id: number) => setToasts((t) => t.filter((x) => x.id !== id)),
      dataVersion,
      bumpData: () => setDataVersion((v) => v + 1),
    };
  }, [dataset, setDataset, replayAsOf, status, statusError, refreshStatus, prefs, setPrefs, toast, toasts, dataVersion]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside provider");
  return v;
}

/** Fetch JSON with loading/error state; refetches when the URL or dataVersion changes. */
export function useApi<T>(url: string | null): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const { dataVersion } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!url);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!url) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<T>(url)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [url, tick, dataVersion]);
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}
