// engine/persistence/kv.ts
// Simple in-memory key–value store with optional JSON persistence.

import * as fs from "fs";
import * as path from "path";

type KVRecord = Record<string, any>;

export class KV {
  private store: KVRecord;

  constructor(seed?: KVRecord) {
    this.store = { ...(seed ?? {}) };
  }

  /* ===== Core ops ===== */
  get<T = any>(key: string, fallback?: T): T {
    return (this.store[key] as T) ?? fallback as T;
  }

  set<T = any>(key: string, value: T): void {
    this.store[key] = value;
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.store, key);
  }

  delete(key: string): void {
    delete this.store[key];
  }

  clear(): void {
    this.store = {};
  }

  keys(): string[] {
    return Object.keys(this.store);
  }

  values(): any[] {
    return Object.values(this.store);
  }

  entries(): [string, any][] {
    return Object.entries(this.store);
  }

  all(): KVRecord {
    return { ...this.store };
  }

  /* ===== Persistence ===== */
  static loadFrom(filePath: string): KV {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return new KV(JSON.parse(raw));
    } catch {
      return new KV();
    }
  }

  saveTo(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(this.store, null, 2) + "\n", "utf8");
  }
}

/* ===== Convenience factory ===== */
export function createKV(seed?: KVRecord) {
  return new KV(seed);
}

export default KV;