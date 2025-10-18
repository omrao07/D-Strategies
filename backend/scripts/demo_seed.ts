// scripts/demo-seed.ts
// Script to generate demo strategies, portfolios, and underlyings for quick testing.
// Usage:
//   npx ts-node scripts/demo-seed.ts

import * as fs from "fs";
import * as path from "path";

// ---- Demo strategy: Iron Condor ----
const ironCondor = {
  name: "Iron Condor",
  spotRef: 100,
  legs: [
    { kind: "option", right: "P", strike: 95, premium: 1.2, qty: 1, multiplier: 100 },
    { kind: "option", right: "P", strike: 100, premium: 2.5, qty: -1, multiplier: 100 },
    { kind: "option", right: "C", strike: 105, premium: 2.6, qty: -1, multiplier: 100 },
    { kind: "option", right: "C", strike: 110, premium: 1.3, qty: 1, multiplier: 100 }
  ]
};

// ---- Demo strategy: Bull Call Spread ----
const bullCall = {
  name: "Bull Call Spread",
  spotRef: 100,
  legs: [
    { kind: "option", right: "C", strike: 100, premium: 3.5, qty: 1, multiplier: 100 },
    { kind: "option", right: "C", strike: 110, premium: 1.5, qty: -1, multiplier: 100 }
  ]
};

// ---- Demo portfolio ----
const portfolio = {
  cash: 25000,
  positions: {
    "AAPL-2025-01-17-C-110": { symbol: "AAPL-2025-01-17-C-110", qty: -2 },
    "AAPL-2025-01-17-P-90":  { symbol: "AAPL-2025-01-17-P-90", qty: -2 }
  },
  specs: {
    "AAPL-2025-01-17-C-110": {
      symbol: "AAPL-2025-01-17-C-110",
      underlying: "AAPL",
      right: "C",
      strike: 110,
      expiryISO: "2025-01-17",
      multiplier: 100
    },
    "AAPL-2025-01-17-P-90": {
      symbol: "AAPL-2025-01-17-P-90",
      underlying: "AAPL",
      right: "P",
      strike: 90,
      expiryISO: "2025-01-17",
      multiplier: 100
    }
  }
};

// ---- Demo underlyings ----
const underlyings = [
  { underlying: "AAPL", price: 100, iv: 0.25, r: 0.04, q: 0.01, T: 0.5 },
  { underlying: "MSFT", price: 300, iv: 0.22, r: 0.03, q: 0.00, T: 0.5 }
];

// ---- Write files ----
function writeJSON(name: string, obj: any) {
  const dir = path.resolve(process.cwd(), "examples");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  console.log(`✔ wrote ${file}`);
}

function main() {
  writeJSON("iron_condor.json", ironCondor);
  writeJSON("bull_call.json", bullCall);
  writeJSON("portfolio.json", portfolio);
  writeJSON("underlyings.json", underlyings);
  console.log("\nDemo seed data ready in ./examples/");
}

main();