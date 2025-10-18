/**
 * src/config.ts
 *
 * Centralized configuration for provider integrations.
 * Defines environment variable parsing, retry/rate-limit/circuit-breaker defaults,
 * and a strongly typed map of provider API keys.
 */

export const NODE_ENV = process.env.NODE_ENV ?? "development";

/**
 * Provider API keys.
 * These are loaded either directly from process.env
 * or overridden at runtime by Vault/Secret Manager via loadSecrets().
 */
export const PROVIDER_KEYS = {
  PROVIDER_POLYGON_KEY: process.env.PROVIDER_POLYGON_KEY,
  PROVIDER_TWELVEDATA_KEY: process.env.PROVIDER_TWELVEDATA_KEY,
  PROVIDER_FINNHUB_KEY: process.env.PROVIDER_FINNHUB_KEY,
  PROVIDER_EODHD_KEY: process.env.PROVIDER_EODHD_KEY,
  PROVIDER_INDIA_KEY: process.env.PROVIDER_INDIA_KEY,
  PROVIDER_WEATHER_KEY: process.env.PROVIDER_WEATHER_KEY,
};

/**
 * Optional Vault secret manager configuration.
 * Leave empty if not using Vault (local dev).
 */
export const SECRETS = {
  VAULT_URL: process.env.VAULT_URL ?? "",
  VAULT_TOKEN: process.env.VAULT_TOKEN ?? "",
};

/**
 * Default tuning parameters for retry, rate-limit, and circuit-breaker behavior.
 * These can be overridden per provider at adapter construction time.
 */
export const DEFAULTS = {
  RATE_LIMIT_PER_MIN: Number(process.env.RATE_LIMIT_PER_MIN ?? 300),
  RETRY_MAX_ATTEMPTS: Number(process.env.RETRY_MAX_ATTEMPTS ?? 5),
  RETRY_BASE_MS: Number(process.env.RETRY_BASE_MS ?? 300),
  CIRCUIT_BREAKER_FAILURES: Number(process.env.CB_FAILURES ?? 5),
  CIRCUIT_BREAKER_RESET_MS: Number(process.env.CB_RESET_MS ?? 60_000),
};

/**
 * Derived flags
 */
export const IS_PRODUCTION = NODE_ENV === "production";
export const IS_DEV = NODE_ENV !== "production";

/**
 * Convenience logger level flag
 */
export const DEBUG = process.env.DEBUG === "true" || IS_DEV;

/**
 * Common constants for all integrations
 */
export const USER_AGENT = "saturn-hedge/1.0 (+https://yourdomain.com)";
export const TIMEZONE = process.env.TZ ?? "UTC";

/**
 * Type helpers
 */
export type ProviderKeyMap = typeof PROVIDER_KEYS;
export type ProviderKeyName = keyof ProviderKeyMap;

/**
 * Export full config bundle for convenience
 */
export default {
  NODE_ENV,
  PROVIDER_KEYS,
  SECRETS,
  DEFAULTS,
  IS_PRODUCTION,
  IS_DEV,
  DEBUG,
  USER_AGENT,
  TIMEZONE,
};