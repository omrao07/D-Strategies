// strategies/examples/mean_reversion.js
// Example demo strategy: simple mean reversion.
// Exports a factory() returning { meta, run }.

export default function factory() {
  return {
    meta: {
      id: "examples.mean_reversion",
      name: "Mean Reversion Demo",
      tags: ["demo", "equities", "mean-reversion"]
    },

    /**
     * Run the strategy
     * @param {any} ctx  StrategyContext (id, data, broker, log, start, end)
     * @param {any} params user params, e.g. { symbol: "SPY" }
     */
    async run(ctx, params) {
      const symbol = params?.symbol ?? "SPY";

      // Fetch daily bars from datafeed (ctx.data is injected by CLI/context)
      const bars = await ctx.data.getPrices(
        [symbol],
        ctx.start ?? "2024-01-01",
        ctx.end ?? "2024-12-31",
        "1d"
      );

      // Dummy implementation: track equity drifting upward
      const startEquity = 100000;
      const curve = [];

      for (let i = 0; i < bars.length; i++) {
        const date = bars[i]?.date ?? `2024-01-${String(i + 1).padStart(2, "0")}`;
        const equity = startEquity + i * 10; // +10 per day
        curve.push({ date, equity });
      }

      // If no bars returned, fake 2 points
      if (curve.length === 0) {
        curve.push({ date: "2024-01-01", equity: startEquity });
        curve.push({ date: "2024-12-31", equity: startEquity * 1.01 });
      }

      // Return result
      return {
        id: ctx.id,
        equityCurve: curve,
        metrics: {
          Sharpe: 0.7,
          CAGR: 0.01,
          MaxDD: -0.02
        },
        summary: {
          symbol,
          trades: curve.length - 1
        }
      };
    }
  };
}