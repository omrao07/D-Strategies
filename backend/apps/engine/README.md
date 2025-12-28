# Trading Engine

A **pure TypeScript, dependency-free trading engine** designed for quantitative research, backtesting, and future live execution.

The engine provides a deterministic backtesting core with realistic order execution, portfolio accounting, and risk controls, while remaining flexible enough to support multiple strategies, asset classes, and brokers.

---

## ✨ Key Features

### Strategy Framework

- Abstract `StrategyBase` with lifecycle hooks:
  - `onInit(ctx)`
  - `onBar(ctx)`
  - `onEnd(ctx)`
- Clean, minimal context (`Ctx`) exposed to strategies
- Supports long/short strategies with position targeting

### Backtesting Engine

- Deterministic **next-bar execution model**
- Market, limit, and stop orders
- DAY and GTC time-in-force
- Slippage and transaction fees (bps-based)
- Position, cash, and equity tracking
- Realized and unrealized P&L accounting

### Risk Management

- Max gross leverage
- Max per-position weight
- Optional stop-loss and take-profit
- Short-selling controls
- Pre-trade and post-trade risk gates

### Portfolio Accounting

- Cash + mark-to-market equity
- Position average price tracking
- Realized P&L
- Equity curve generation

### Performance Metrics

- CAGR
- Volatility
- Sharpe ratio
- Maximum drawdown
- Trade hit rate
- Average trade P&L

---

## 📁 Project Structure

```text
engine/
├── src/
│   ├── index.ts                 # Public entry point (barrel)
│   ├── strategies/
│   │   ├── base.ts              # Core StrategyBase + engine
│   │   └── alpha/
│   │       └── carryTrade.ts    # Example FX carry strategy
│   ├── data/
│   │   └── loaders/
│   │       └── api.ts           # API-based data loader
│   ├── brokers/                 # (optional) execution adapters
│   └── exchanges/               # (optional) market metadata
└── README.md
