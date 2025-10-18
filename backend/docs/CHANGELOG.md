# Changelog

All notable changes to this project will be documented here.  
This project follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

- Initial CLI skeleton for backtester prepared (`backtester/cli.ts`).
- Core option/futures modules added:
  - `options/payoff.ts`
  - `options/strategies.ts`
  - `options/pricing.ts`
  - `options/margin.ts`
- Futures components added:
  - `futures/calenders.ts`
  - `futures/continuous.ts`
  - `futures/contracts.ts`
  - `futures/curve.ts`
  - `futures/execution.ts`
  - `futures/ledger.ts`
  - `futures/margin.ts`
  - `futures/spreads.ts`

---

## [0.1.0] - 2025-10-08

### Added

- First working draft of **options analytics**:
  - Payoff/PnL calculators
  - Common strategy builders
  - Black–Scholes and Bachelier pricing models
  - Greeks calculators
  - Reg-T and SPAN-lite margin estimators
- Backtester CLI with commands:
  - `payoff`
  - `strategy:summary`
  - `price`
  - `margin:options`

### Changed

- Refactored file/folder structure into `options/`, `futures/`, `backtester/`, `docs/`.

### Fixed

- Corrected TypeScript imports for NodeNext/ESM mode (explicit `.js` suffix).

---

## [0.0.1] - 2025-09

- Project scaffolding created.
- Baseline utils (`utils/dates.ts`, `utils/normalize.ts`, `utils/testutils.ts`).
- Packaged initial sample FX data (`packs/fx small.csv`).
