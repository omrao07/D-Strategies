// scripts/seed.demo.mjs
// Demo seeding script for Hedge Fund Engine
// - Seeds demo users, roles, and example strategies
// - Seeds a sample portfolio and positions
// - Seeds historical price data snapshots (small mock)
// Usage: node scripts/seed.demo.mjs

/* eslint-disable no-console */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ------------------- Helpers -------------------

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJSON(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  console.log("seeded:", file);
}

// ------------------- Demo Users -------------------

const users = [
  { id: "u1", name: "Alice", role: "admin" },
  { id: "u2", name: "Bob", role: "trader" },
  { id: "u3", name: "Charlie", role: "viewer" }
];

// ------------------- Demo Strategies -------------------

const strategies = [
  { id: "s1", name: "Mean Reversion", type: "stat-arb", status: "active" },
  { id: "s2", name: "Momentum", type: "trend", status: "active" },
  { id: "s3", name: "Carry Trade", type: "fx", status: "inactive" }
];

// ------------------- Demo Portfolio -------------------

const portfolio = {
  id: "demo",
  baseCurrency: "USD",
  cash: 1_000_000,
  positions: [
    { symbol: "AAPL", qty: 100, entry: 150 },
    { symbol: "ES_F", qty: -2, entry: 4500 },
    { symbol: "BTC-USD", qty: 0.5, entry: 30_000 }
  ]
};

// ------------------- Demo Prices -------------------

const samplePrices = [
  { ts: "2025-01-01T00:00:00Z", symbol: "AAPL", px: 150 },
  { ts: "2025-01-01T00:00:00Z", symbol: "ES_F", px: 4500 },
  { ts: "2025-01-01T00:00:00Z", symbol: "BTC-USD", px: 30000 },
  { ts: "2025-02-01T00:00:00Z", symbol: "AAPL", px: 160 },
  { ts: "2025-02-01T00:00:00Z", symbol: "ES_F", px: 4600 },
  { ts: "2025-02-01T00:00:00Z", symbol: "BTC-USD", px: 35000 }
];

// ------------------- Seed -------------------

function main() {
  writeJSON(path.join(ROOT, "data", "demo-users.json"), users);
  writeJSON(path.join(ROOT, "data", "demo-strategies.json"), strategies);
  writeJSON(path.join(ROOT, "portfolios", "demo.portfolio.json"), portfolio);
  writeJSON(path.join(ROOT, "data", "demo-prices.json"), samplePrices);
}

main();