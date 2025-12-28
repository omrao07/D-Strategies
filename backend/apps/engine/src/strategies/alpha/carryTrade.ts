// engine/src/strategies/alpha/carryTrade.ts
// FX Carry Trade Strategy (Backtest)

/* =========================
   Types
   ========================= */

export interface Price {
  spot: number;
  fwdNext?: number;
}

export interface Rate {
  rBase: number;
  rQuote: number;
}

export interface DailyRow {
  ts: number;
  pairs: Record<string, Price>;
  rates?: Record<string, Rate>;
  vol?: Record<string, number>;
}

export interface SignalRow {
  pair: string;
  carryAnn: number;
  T: number;
  rank: number;
}

export interface Portfolio {
  equity: number;
  weights: Record<string, number>;
}

export interface BacktestOptions {
  useForwards?: boolean;
}

export interface TradeLog {
  ts: number;
  event: string;
  trades: unknown[];
  cost: number;
  weights: Record<string, number>;
}

/* =========================
   Helpers (assumed existing)
   ========================= */

declare function fxCarrySignal(input: {
  spot: number;
  fwd: number;
  T: number;
}): number;

declare function fxCarrySignalRates(input: {
  rBase: number;
  rQuote: number;
  T: number;
}): number;

declare function rankSignals(
  sigs: SignalRow[],
  opts: { longShort: boolean }
): SignalRow[];

declare function rebalanceCarry(
  port: Portfolio,
  ranked: SignalRow[],
  vol: Record<string, number>,
  opts: BacktestOptions
): {
  weightsAfter: Record<string, number>;
  trades: unknown[];
  estCost: number;
};

/* =========================
   Strategy
   ========================= */

export function backtestCarry(
  data: DailyRow[],
  universe: string[],
  opts: BacktestOptions = {}
) {
  const port: Portfolio = {
    equity: 1,
    weights: {},
  };

  const log: TradeLog[] = [];
  const ann = 1; // annualization factor

  for (const row of data) {
    const sigs: SignalRow[] = [];

    for (const pair of universe) {
      const px = row.pairs[pair];
      if (!px || !Number.isFinite(px.spot)) continue;

      const T = 1;
      let carryAnn: number | null = null;

      if (
        opts.useForwards &&
        typeof px.fwdNext === "number" &&
        Number.isFinite(px.fwdNext)
      ) {
        carryAnn = fxCarrySignal({
          spot: px.spot,
          fwd: px.fwdNext,
          T,
        });
      } else if (row.rates && row.rates[pair]) {
        const r = row.rates[pair];
        carryAnn = fxCarrySignalRates({
          rBase: r.rBase,
          rQuote: r.rQuote,
          T,
        });
      }

      if (carryAnn === null || !Number.isFinite(carryAnn)) continue;

      sigs.push({ pair, carryAnn, T, rank: 0 });
    }

    if (sigs.length === 0) continue;

    const ranked = rankSignals(sigs, { longShort: true });
    const vol = row.vol ?? {};

    const reb = rebalanceCarry(port, ranked, vol, opts);

    port.weights = reb.weightsAfter;
    port.equity = Math.max(0, port.equity - reb.estCost);

    log.push({
      ts: row.ts,
      event: "rebalance",
      trades: reb.trades,
      cost: reb.estCost,
      weights: { ...port.weights },
    });

    // Daily PnL from carry accrual
    let pnl = 0;

    for (const pair in port.weights) {
      const w = port.weights[pair];
      const px = row.pairs[pair];
      if (!px) continue;

      let carry = 0;

      if (
        opts.useForwards &&
        typeof px.fwdNext === "number" &&
        Number.isFinite(px.fwdNext)
      ) {
        carry = fxCarrySignal({
          spot: px.spot,
          fwd: px.fwdNext,
          T: 1,
        });
      } else if (row.rates && row.rates[pair]) {
        const r = row.rates[pair];
        carry = fxCarrySignalRates({
          rBase: r.rBase,
          rQuote: r.rQuote,
          T: 1,
        });
      }

      pnl += w * (carry / ann) * port.equity;
    }

    port.equity += pnl;
  }

  return { portfolio: port, log };
}