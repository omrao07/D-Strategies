// frontend/main.tsx
// Vite entry point for D-Strategies dashboard.
import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { useWsSync } from "@/store/useWsSync";

// ---- Lazy-loaded pages ---------------------------------------------------

const Dashboard = lazy(() => import("@/components/Dashboard"));
const StrategiesPage = lazy(() => import("@/pages/strategies"));
const PnLPage = lazy(() => import("@/pages/pnl"));
const RiskPage = lazy(() => import("@/pages/risk"));
const CompliancePage = lazy(() => import("@/pages/compliance"));
const BacktesterPage = lazy(() => import("@/pages/backtester"));
const TerminalPage = lazy(() => import("@/pages/terminal"));
const SettingsPage = lazy(() => import("@/pages/settings"));

// ---- Suspense fallback ---------------------------------------------------

function PageLoader() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        color: "#475569",
        fontSize: 13,
      }}
    >
      Loading…
    </div>
  );
}

// ---- Root app with WS sync -----------------------------------------------

function App() {
  // Mount WS sync once at the app root
  useWsSync();

  return (
    <BrowserRouter>
      <AppShell>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/strategies" element={<StrategiesPage />} />
            <Route path="/pnl" element={<PnLPage />} />
            <Route path="/risk" element={<RiskPage />} />
            <Route path="/compliance" element={<CompliancePage />} />
            <Route path="/backtester" element={<BacktesterPage />} />
            <Route path="/terminal" element={<TerminalPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </Suspense>
      </AppShell>
    </BrowserRouter>
  );
}

// ---- Mount ---------------------------------------------------------------

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
