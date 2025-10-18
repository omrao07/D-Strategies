/**
 * src/integrations/providers/weather.ts
 *
 * Adapter for a weather data provider (example: OpenWeatherMap).
 * - Uses relative imports: ../adapter and ../httpclient
 * - Maps a weather response into the engine's Quote shape:
 *   - symbol: location key (city name or "lat,lon")
 *   - last: primary numeric metric (temperature in °C)
 *   - bid/ask: left undefined (not applicable)
 *   - ts: timestamp of the weather observation (ms)
 *   - raw: full provider response
 *
 * NOTE:
 * - Replace baseUrl / endpoints if you use a different weather provider.
 * - For OpenWeatherMap, provide the API key as PROVIDER_WEATHER_KEY in your env/Vault.
 */

import { AbstractBaseAdapter, normalizeSymbolForProvider, type Quote } from "../adapter";
import { HttpClient } from "../httpClient";

export class WeatherAdapter extends AbstractBaseAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly clientTyped: HttpClient;

  constructor(apiKey: string, opts: { baseUrl?: string; rateLimitPerMin?: number } = {}) {
    // Default reasonable rate-limit for weather lookups
    const client = new HttpClient(opts.rateLimitPerMin ?? 60, { "User-Agent": "saturn-hedge/1.0" });
    super("weather", client, { baseUrl: opts.baseUrl });
    if (!apiKey) throw new Error("Weather API key required");
    this.apiKey = apiKey;
    // Default uses OpenWeatherMap current weather endpoint base
    this.baseUrl = opts.baseUrl ?? "https://api.openweathermap.org/data/2.5";
    this.clientTyped = client;
  }

  /**
   * Readiness probe: call current weather for a known location (example: London)
   */
  protected async _readyProbe(): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/weather?q=London&units=metric&appid=${encodeURIComponent(this.apiKey)}`;
      const r: any = await this.clientTyped.get(url);
      // OpenWeather returns { main: { temp: ... }, weather: [...] } on success
      return !!r && !!r.main && (typeof r.main.temp === "number" || typeof r.main.temp === "string");
    } catch {
      return false;
    }
  }

  /**
   * symbol can be:
   *  - a city name: "London"
   *  - "City,CountryCode": "Mumbai,IN"
   *  - lat/lon: "lat:12.34,lon:56.78" (we detect and call the appropriate endpoint)
   *
   * The returned Quote will use `last` to store the temperature in °C (best-effort).
   */
  async fetchQuote(symbol: string): Promise<Quote> {
    const normalized = normalizeSymbolForProvider(symbol, "weather");
    let url: string;

    // support lat/lon format: "lat:12.34,lon:56.78" or "12.34,56.78"
    const latlonMatch = normalized.match(/(?:lat:)?\s*([+-]?\d+(\.\d+)?)[,\s]+(?:lon:)?\s*([+-]?\d+(\.\d+)?)/i);
    if (latlonMatch) {
      const lat = latlonMatch[1];
      const lon = latlonMatch[3];
      url = `${this.baseUrl}/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(
        lon
      )}&units=metric&appid=${encodeURIComponent(this.apiKey)}`;
    } else {
      // treat as city name (OpenWeather supports "City" or "City,COUNTRY")
      url = `${this.baseUrl}/weather?q=${encodeURIComponent(normalized)}&units=metric&appid=${encodeURIComponent(
        this.apiKey
      )}`;
    }

    const r: any = await this.clientTyped.get(url);

    // Defensive extraction: OpenWeather shapes vary slightly for some providers / plan levels
    const temp = r?.main?.temp ?? r?.temperature?.value ?? r?.current?.temp ?? undefined;
    const humidity = r?.main?.humidity ?? r?.humidity ?? undefined;
    const windSpeed = r?.wind?.speed ?? r?.current?.wind_speed ?? undefined;
    const obsTs =
      (typeof r?.dt === "number" && r.dt > 0)
        ? (r.dt > 1e12 ? Number(r.dt) : Number(r.dt) * 1000)
        : Date.now();

    return {
      symbol: normalized,
      // Weather data is not bid/ask; leave undefined to signal non-tradable metric
      bid: undefined,
      ask: undefined,
      // Use temperature (°C) as the primary numeric "last" metric
      last: this.safeNumber(temp),
      ts: obsTs,
      // Include common weather fields in raw for downstream use
      raw: {
        provider: "openweathermap",
        response: r,
        additional: {
          humidity: this.safeNumber(humidity),
          windSpeed: this.safeNumber(windSpeed),
        },
      },
    };
  }
}