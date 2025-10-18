// utils/persist.ts
// Simple, dependency-free persistence helpers for browser (localStorage/sessionStorage)
// with safe fallbacks for Node/test environments.
//
// Features:
// - get/set/remove/clear
// - JSON encode/decode
// - namespacing
// - expiry support
// - in-memory fallback if storage unavailable

export interface PersistOptions {
  storage?: "local" | "session" | Storage; // which storage to use
  namespace?: string;                      // prefix for keys
  ttlMs?: number;                          // time-to-live (expiry in ms)
}

type PersistValue<T> = {
  value: T;
  expiry?: number; // epoch ms
};

function safeStorage(kind: "local" | "session" | Storage | undefined): StorageLike {
  if (kind && typeof (kind as Storage).getItem === "function") {
    return kind as Storage;
  }
  if (typeof window !== "undefined") {
    try {
      if (kind === "local" && window.localStorage) return window.localStorage;
      if (kind === "session" && window.sessionStorage) return window.sessionStorage;
    } catch {
      // storage might be disabled
    }
  }
  return memoryStorage;
}

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  clear(): void;
}

const memory: Record<string, string> = {};
const memoryStorage: StorageLike = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(memory, k) ? memory[k] : null; },
  setItem(k, v) { memory[k] = v; },
  removeItem(k) { delete memory[k]; },
  clear() { for (const k in memory) delete memory[k]; },
};

// Namespace helper
function nsKey(key: string, opts?: PersistOptions): string {
  return opts?.namespace ? `${opts.namespace}:${key}` : key;
}

/* ----------------------------- Public API ----------------------------- */

export function persistSet<T>(key: string, value: T, opts?: PersistOptions): void {
  const store = safeStorage(opts?.storage ?? "local");
  const expiry = opts?.ttlMs ? Date.now() + opts.ttlMs : undefined;
  const payload: PersistValue<T> = { value, expiry };
  try {
    store.setItem(nsKey(key, opts), JSON.stringify(payload));
  } catch {
    // ignore (e.g. quota exceeded)
  }
}

export function persistGet<T>(key: string, opts?: PersistOptions): T | null {
  const store = safeStorage(opts?.storage ?? "local");
  try {
    const raw = store.getItem(nsKey(key, opts));
    if (!raw) return null;
    const payload = JSON.parse(raw) as PersistValue<T>;
    if (payload.expiry && Date.now() > payload.expiry) {
      store.removeItem(nsKey(key, opts));
      return null;
    }
    return payload.value;
  } catch {
    return null;
  }
}

export function persistRemove(key: string, opts?: PersistOptions): void {
  const store = safeStorage(opts?.storage ?? "local");
  try { store.removeItem(nsKey(key, opts)); } catch {}
}

export function persistClear(opts?: PersistOptions): void {
  const store = safeStorage(opts?.storage ?? "local");
  try { store.clear(); } catch {}
}

/* ----------------------------- Convenience ----------------------------- */

// Wrap object state with persist (get or init with default)
export function persistState<T>(key: string, defaultValue: T, opts?: PersistOptions): [() => T, (v: T) => void] {
  const getter = (): T => {
    const v = persistGet<T>(key, opts);
    return v === null ? defaultValue : v;
  };
  const setter = (v: T): void => {
    persistSet<T>(key, v, opts);
  };
  return [getter, setter];
}
