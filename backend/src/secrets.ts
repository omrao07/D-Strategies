/**
 * src/secrets.ts
 *
 * Secure secrets loader for all provider API keys.
 * Loads from environment variables first (for local/dev),
 * then merges with optional Vault or cloud secret manager if configured.
 *
 * Never hardcode keys here — this file only retrieves them safely.
 */

import { SECRETS, PROVIDER_KEYS } from "./config";

/**
 * Type-safe map of all provider keys
 */
export type ProviderSecrets = Record<string, string>;

/**
 * Fetch secrets from Vault (if configured).
 * Minimal example implementation — replace with your Vault client if needed.
 */
async function fetchFromVault(path: string, token: string): Promise<any> {
  const url = `${SECRETS.VAULT_URL.replace(/\/$/, "")}/v1/${path}`;
  const res = await fetch(url, {
    headers: { "X-Vault-Token": token },
  });

  if (!res.ok) {
    throw new Error(`Vault request failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

/**
 * Main secret loading function.
 * 1. Loads all provider keys from environment variables.
 * 2. Optionally merges Vault secrets if configured.
 * 3. Returns a unified ProviderSecrets object used by bootstrap.ts.
 */
export async function loadSecrets(): Promise<ProviderSecrets> {
  const keys: ProviderSecrets = {};

  // Step 1: Load from environment
  for (const key of Object.keys(PROVIDER_KEYS)) {
    const val = (PROVIDER_KEYS as Record<string, string | undefined>)[key];
    if (val) keys[key] = val;
  }

  // Step 2: If Vault is configured and some keys are missing, merge from Vault
  if (SECRETS.VAULT_URL && SECRETS.VAULT_TOKEN) {
    try {
      const vaultData = await fetchFromVault("secret/data/saturn/integrations", SECRETS.VAULT_TOKEN);
      const data = vaultData?.data?.data ?? {};

      for (const [key, val] of Object.entries(data)) {
        if (!keys[key] && typeof val === "string") {
          keys[key] = val;
        }
      }
      console.log("🔐 Secrets loaded and merged from Vault.");
    } catch (err) {
      console.warn("⚠️  Failed to load secrets from Vault:", (err as Error).message);
    }
  } else {
    console.log("🔑 Using environment variables for provider keys (Vault not configured).");
  }

  // Step 3: Final sanity check
  const missing = Object.keys(PROVIDER_KEYS).filter((k) => !keys[k]);
  if (missing.length > 0) {
    console.warn(`⚠️  Missing provider keys: ${missing.join(", ")}`);
  }

  return keys;
}

/**
 * Optional helper to reload secrets dynamically at runtime.
 * Can be used for hot-reloading or periodic rotation.
 */
export async function reloadSecrets(): Promise<void> {
  const newKeys = await loadSecrets();
  for (const [k, v] of Object.entries(newKeys)) {
    process.env[k] = v;
  }
  console.log("🔁 Provider secrets reloaded into environment.");
}