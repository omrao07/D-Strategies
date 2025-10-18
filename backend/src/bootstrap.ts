/**
 * src/bootstrap.ts
 *
 * Initializes and registers all data providers (Polygon, TwelveData, Finnhub,
 * EODHD, IndiaAPI, Weather). Uses the local structure shown in your screenshot.
 */

import { loadSecrets } from "./secrets";
import { ProviderRegistry } from "./registry";

// import all provider adapters from ./providers/
import { PolygonAdapter } from "./providers/polygon";
import { TwelveDataAdapter } from "./providers/twelvedata";
import { FinnhubAdapter } from "./providers/finnhub";
import { EodHdAdapter } from "./providers/eodhd";
import { IndiaApiAdapter } from "./providers/indiaapi";
import { WeatherAdapter } from "./providers/weather";

/**
 * Bootstraps and returns a ProviderRegistry with all providers initialized.
 */
export async function bootstrapProviders(): Promise<ProviderRegistry> {
  const keys = await loadSecrets();
  const registry = new ProviderRegistry();

  // Polygon (U.S. equities)
  if (keys.PROVIDER_POLYGON_KEY) {
    registry.register(new PolygonAdapter(keys.PROVIDER_POLYGON_KEY));
  } else {
    console.warn("⚠️ Missing Polygon API key — skipping adapter.");
  }

  // TwelveData (global)
  if (keys.PROVIDER_TWELVEDATA_KEY) {
    registry.register(new TwelveDataAdapter(keys.PROVIDER_TWELVEDATA_KEY));
  } else {
    console.warn("⚠️ Missing TwelveData API key — skipping adapter.");
  }

  // Finnhub (Europe + Global)
  if (keys.PROVIDER_FINNHUB_KEY) {
    registry.register(new FinnhubAdapter(keys.PROVIDER_FINNHUB_KEY));
  } else {
    console.warn("⚠️ Missing Finnhub API key — skipping adapter.");
  }

  // EODHD (Japan + global EOD)
  if (keys.PROVIDER_EODHD_KEY) {
    registry.register(new EodHdAdapter(keys.PROVIDER_EODHD_KEY));
  } else {
    console.warn("⚠️ Missing EODHD API key — skipping adapter.");
  }

  // India API (Indian equities)
  if (keys.PROVIDER_INDIA_KEY) {
    registry.register(new IndiaApiAdapter(keys.PROVIDER_INDIA_KEY));
  } else {
    console.warn("⚠️ Missing India API key — skipping adapter.");
  }

  // Weather (environmental/commodity-linked)
  if (keys.PROVIDER_WEATHER_KEY) {
    registry.register(new WeatherAdapter(keys.PROVIDER_WEATHER_KEY));
  } else {
    console.warn("⚠️ Missing Weather API key — skipping adapter.");
  }

  // Check readiness of all providers
  const checks = await Promise.all(
    registry.list().map(async (p) => {
      try {
        const ok = await p.ready();
        console.log(`✅ [${p.name}] ready=${ok}`);
      } catch (err) {
        console.warn(`⚠️ [${p.name}] readiness check failed:`, (err as Error).message);
      }
    })
  );

  console.log(
    `\n🌍 Providers loaded: ${registry.list().map((p) => p.name).join(", ") || "none"}`
  );

  return registry;
}

/**
 * Optional global initializer.
 * Attaches registry to globalThis.PROVIDER_REGISTRY for convenience.
 */
export async function initGlobalRegistry() {
  const registry = await bootstrapProviders();
  (globalThis as any).PROVIDER_REGISTRY = registry;
  return registry;
}