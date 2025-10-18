# Backtester Project

A lightweight **options & futures analytics and backtesting framework** written in TypeScript.  
It includes payoff calculators, strategy builders, pricing models, margin checks, and a simple CLI interface.

---

## Features

- **Options Analytics**
  - Payoff & PnL calculation
  - Strategy builders (covered calls, spreads, butterflies, condors, calendars, etc.)
  - Black–Scholes & Bachelier pricing
  - Greeks calculation
  - Margin estimation (Reg-T and SPAN-lite)

- **Futures Support**
  - Continuous contracts
  - Futures curve representation
  - Execution, ledger, and margin handling
  - Spreads and calendars

- **Backtester CLI**
  - `payoff` → generate payoff & PnL curve CSV
  - `strategy:summary` → quick stats (breakevens, max profit/loss, net premium)
  - `price` → option pricing with BS or Bachelier
  - `margin:options` → portfolio margin stress test

- **Utilities**
  - Date/time helpers
  - Normalization & array utilities
  - Testing utilities

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- TypeScript ≥ 5
- ts-node (`npm install -g ts-node`)

### Installation

```bash
git clone <your-repo-url>
cd backtester
npm install
