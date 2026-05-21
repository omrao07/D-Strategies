// frontend/pages/index.js
// Vite entry page — renders the main dashboard.

import React, { Suspense, lazy } from "react";

const Dashboard = lazy(() => import("@/components/Dashboard"));

export default function Home() {
  return (
    <Suspense fallback={null}>
      <Dashboard />
    </Suspense>
  );
}
