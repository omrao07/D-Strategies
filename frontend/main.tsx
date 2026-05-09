// frontend/main.tsx
// Vite entry point for D-Strategies dashboard.
import React from "react";
import { createRoot } from "react-dom/client";
import Dashboard from "@/components/Dashboard";

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <Dashboard />
    </React.StrictMode>
  );
}
