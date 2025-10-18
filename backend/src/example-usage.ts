/**
 * src/example-usage.ts
 *
 * Example of how to use the unified ProviderRegistry after bootstrapping.
 * Demonstrates:
 *   - loading all providers
 *   - fetching a quote from a specific provider
 *   - aggregating quotes from all providers
 *   - computing best bid/ask across regions
 */

import { bootstrapProviders } from "./bootstrap";
import type { Quote } from "./adapter";
import { aggregateBestBidAsk } from "./adapter";

/**
 * Fetch and display quotes from all integrated providers.
 * This is a diagnostic / smoke-test script to confirm that your
 * adapters, secrets, and network connectivity are configured correctly.
 */
async function main() {
  console.log("🔧 Bootstrapping providers...");
  const registry = await bootstrapProviders();

  const providers = registry.list();
  if (providers.length === 0) {
    console.error("❌ No providers were initialized. Check your .env or Vault keys.");
    process.exit(1);
  }

  console.log(`📡 Registered providers: ${providers.map(p => p.name).join(", ")}`);

  const symbol = process.argv[2] ?? "AAPL";

  console.log(`\n🔍 Fetching quotes for ${symbol} from all providers...\n`);

  // Fetch concurrently from all providers
  const results = await Promise.allSettled(
    providers.map((p) => p.fetchQuote(symbol))
  );

  const quotes: Quote[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const name = providers[i].name;
    if (r.status === "fulfilled") {
      const q = r.value;
      quotes.push(q);
      console.log(`✅ [${name}] ${symbol} → last=${q.last ?? "-"} bid=${q.bid ?? "-"} ask=${q.ask ?? "-"}`);
    } else {
      console.warn(`⚠️  [${name}] fetch failed:`, r.reason?.message ?? r.reason);
    }
  }

  if (quotes.length === 0) {
    console.error("\n❌ No valid quotes returned from any provider.");
    process.exit(1);
  }

  // Compute aggregated best bid/ask
  const { bestBid, bestAsk } = aggregateBestBidAsk(quotes);
  const avgLast =
    quotes.reduce((acc, q) => acc + (q.last ?? 0), 0) / quotes.filter((q) => q.last !== undefined).length;

  console.log("\n📊 Aggregated Market Data");
  console.log("---------------------------");
  console.log(`Best Bid: ${bestBid ?? "n/a"}`);
  console.log(`Best Ask: ${bestAsk ?? "n/a"}`);
  console.log(`Average Last: ${avgLast.toFixed(2)}`);
  console.log(`Providers contributing: ${quotes.length}`);

  console.log("\n✅ Example usage completed successfully.");
}

// Allow running directly via: `ts-node src/example-usage.ts AAPL`
if (require.main === module) {
  main().catch((err) => {
    console.error("❌ Fatal error:", err);
    process.exit(1);
  });
}

export default main;