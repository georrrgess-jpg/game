import { StrictMode, Suspense, lazy, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import "@fontsource-variable/inter";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { AppProvider } from "./state";
import { Layout } from "./components/Layout";
import { Loading, Empty } from "./components/ui";
import { TodayPage } from "./pages/Today";

const GamesPage = lazy(() => import("./pages/Games"));
const GamePage = lazy(() => import("./pages/Game"));
const MarketsPage = lazy(() => import("./pages/Markets"));
const EvidencePage = lazy(() => import("./pages/Evidence"));
const LabPage = lazy(() => import("./pages/Lab"));
const ReportPage = lazy(() => import("./pages/Report"));
const SettingsPage = lazy(() => import("./pages/Settings"));
const ValuePage = lazy(() => import("./pages/Value"));
const LinesPage = lazy(() => import("./pages/Lines"));
const LearnPage = lazy(() => import("./pages/Learn"));

function RouteFocus() {
  const { pathname } = useLocation();
  useEffect(() => {
    // Move focus to the main region on navigation so keyboard and screen-reader users land on the new page.
    const main = document.getElementById("main");
    if (main && document.activeElement && document.activeElement !== document.body) main.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [pathname]);
  return null;
}

function App() {
  return (
    <BrowserRouter>
      <AppProvider>
        <RouteFocus />
        <Layout>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={<TodayPage />} />
              <Route path="/value" element={<ValuePage />} />
              <Route path="/lines" element={<LinesPage />} />
              <Route path="/learn" element={<LearnPage />} />
              <Route path="/games" element={<GamesPage />} />
              <Route path="/games/:id" element={<GamePage />} />
              <Route path="/markets" element={<MarketsPage />} />
              <Route path="/evidence" element={<EvidencePage />} />
              <Route path="/lab" element={<LabPage />} />
              <Route path="/report" element={<ReportPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Empty title="Page not found">Use the navigation to continue.</Empty>} />
            </Routes>
          </Suspense>
        </Layout>
      </AppProvider>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
