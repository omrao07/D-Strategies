// observability/ids.ts
// Zero-dep helpers for generating sortable, collision-resistant IDs.
// Includes: UUIDv4, ULID (monotonic), nano/short IDs, lexicographically
// sortable IDs, and a simple Snowflake-style generator using BigInt.

export type ByteSource = Uint8Array | number[];

/* ───────────────────────── Random bytes (no deps) ─────────────────────── */

function randBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // Browser
  // @ts-ignore
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    // @ts-ignore
    crypto.getRandomValues(out);
    return out;
  }
  // Node
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const c = require("crypto") as typeof import("crypto");
    return c.randomBytes(n);
  } catch {
    // Fallback (weaker): Math.random
    for (let i = 0; i < n; i++) out[i] = (Math.random() * 256) | 0;
    return out;
  }
}

/* ───────────────────────────── Base encoders ──────────────────────────── */

const CROCKFORD32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // ULID alphabet (no I L O U)
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function toBaseN(bytes: ByteSource, alphabet: string): string {
  // Simple base conversion treating input as big integer (base 256).
  const base = alphabet.length;
  const digits: number[] = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      const x = digits[j] * 256 + carry;
      digits[j] = x % base;
      carry = (x / base) | 0;
    }
    while (carry > 0) {
      digits.push(carry % base);
      carry = (carry / base) | 0;
    }
  }
  return digits.reverse().map((d) => alphabet[d]).join("");
}

function fromBaseN(str: string, alphabet: string): Uint8Array {
  const base = alphabet.length;
  const lookup = new Map(alphabet.split("").map((c, i) => [c, i] as const));
  const digits = str.split("").map((c) => {
    const v = lookup.get(c);
    if (v == null) throw new Error(`Invalid character '${c}' for base${base}`);
    return v;
  });
  const out: number[] = [0];
  for (const d of digits) {
    let carry = d;
    for (let j = 0; j < out.length; j++) {
      const x = out[j] * base + carry;
      out[j] = x & 0xff;
      carry = x >> 8;
    }
    while (carry > 0) {
      out.push(carry & 0xff);
      carry >>= 8;
    }
  }
  return new Uint8Array(out.reverse());
}

/* ───────────────────────────── UUID v4 (RFC4122) ──────────────────────── */

export function uuidv4(): string {
  const b = randBytes(16);
  // Set version (4) and variant (RFC4122)
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;

  const hex: string[] = [];
  for (let i = 0; i < 256; i++) hex[i] = (i + 0x100).toString(16).slice(1);
  return (
    hex[b[0]] + hex[b[1]] + hex[b[2]] + hex[b[3]] + "-" +
    hex[b[4]] + hex[b[5]] + "-" +
    hex[b[6]] + hex[b[7]] + "-" +
    hex[b[8]] + hex[b[9]] + "-" +
    hex[b[10]] + hex[b[11]] + hex[b[12]] + hex[b[13]] + hex[b[14]] + hex[b[15]]
  );
}

export function isUUIDv4(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

/* ─────────────────────────────── ULID (monotonic) ─────────────────────── */

let lastTime = 0;
let lastRand = new Uint8Array(10); // 80 random bits

function incrRandom(rand: Uint8Array) {
  for (let i = rand.length - 1; i >= 0; i--) {
    rand[i] = (rand[i] + 1) & 0xff;
    if (rand[i] !== 0) break;
  }
}

export function ulid(timeMs = Date.now()): string {
  // 48-bit time + 80-bit randomness (Crockford base32)
  if (timeMs === lastTime) {
    incrRandom(lastRand);
  } else {
    lastTime = timeMs;
    lastRand = randBytes(10);
  }
  const time = new Uint8Array(6);
  let t = BigInt(timeMs);
  for (let i = 5; i >= 0; i--) {
    time[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  return toBaseN(time, CROCKFORD32).padStart(10, "0") +
         toBaseN(lastRand, CROCKFORD32).padStart(16, "0");
}

export function isULID(s: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);
}

export function ulidTime(s: string): number {
  if (!isULID(s)) throw new Error("Invalid ULID");
  const timePart = s.slice(0, 10);
  const bytes = fromBaseN(timePart, CROCKFORD32);
  // bytes may be shorter due to leading zeros
  const buf = new Uint8Array(6);
  buf.set(bytes, 6 - bytes.length);
  let v = 0n;
  for (let i = 0; i < 6; i++) v = (v << 8n) | BigInt(buf[i]);
  return Number(v);
}

/* ───────────────────────────── Nano / Short IDs ───────────────────────── */

export function nanoid(len = 21): string {
  const b = randBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += B64URL[b[i] & 63];
  return out;
}

/** Short, readable ID: `yyMMDD-hhmm-XXXX` (base36 random). */
export function shortId(prefix = ""): string {
  const d = new Date();
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  const ts =
    d.getUTCFullYear().toString().slice(-2) +
    pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "-" +
    pad(d.getUTCHours()) + pad(d.getUTCMinutes());
  const rand = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, "0");
  return (prefix ? prefix + "-" : "") + ts + "-" + rand;
}

/* ────────────────────── Lexicographically sortable ID ─────────────────── */
/** k-sortable ID: 6 bytes UTC ms + 8 bytes randomness → base62 string. */
export function lexId(ms = Date.now()): string {
  const time = new Uint8Array(6);
  let t = BigInt(ms);
  for (let i = 5; i >= 0; i--) { time[i] = Number(t & 0xffn); t >>= 8n; }
  const rnd = randBytes(8);
  return toBaseN([...time, ...rnd], BASE62).padStart(22, "0"); // ~22 chars
}

/* ─────────────────────────── Snowflake (BigInt) ───────────────────────── */

export type SnowflakeOpts = {
  epoch?: number;       // custom epoch ms (default 2020-01-01 UTC)
  workerId?: number;    // 0..31
  processId?: number;   // 0..31
};

export class Snowflake {
  private epoch: bigint;
  private workerId: bigint;
  private processId: bigint;
  private seq = 0n;
  private lastMs = 0n;

  // Layout: 41 bits time | 5 worker | 5 process | 12 sequence (Twitter-like)
  constructor(opts: SnowflakeOpts = {}) {
    this.epoch = BigInt(opts.epoch ?? Date.UTC(2020, 0, 1));
    this.workerId = BigInt((opts.workerId ?? 0) & 0x1f);
    this.processId = BigInt((opts.processId ?? 0) & 0x1f);
  }

  next(ms = Date.now()): string {
    let ts = BigInt(ms) - this.epoch;
    if (ts < 0n) ts = 0n;

    if (ts === this.lastMs) {
      this.seq = (this.seq + 1n) & 0xfffn; // 12 bits
      if (this.seq === 0n) {
        // busy-wait to next ms
        let nowMs = BigInt(Date.now()) - this.epoch;
        while (nowMs <= ts) nowMs = BigInt(Date.now()) - this.epoch;
        ts = nowMs;
      }
    } else {
      this.seq = 0n;
      this.lastMs = ts;
    }

    const id =
      (ts << 22n) |
      (this.workerId << 17n) |
      (this.processId << 12n) |
      this.seq;

    return id.toString(); // decimal string (safe via BigInt)
  }

  /** Break a snowflake back into parts. */
  static parse(id: string, epoch = Date.UTC(2020, 0, 1)) {
    const v = BigInt(id);
    const ts = Number((v >> 22n) + BigInt(epoch));
    const worker = Number((v >> 17n) & 0x1fn);
    const proc = Number((v >> 12n) & 0x1fn);
    const seq = Number(v & 0xfffn);
    return { timestamp: ts, workerId: worker, processId: proc, sequence: seq };
  }
}

/* ───────────────────────────── Small hash IDs ─────────────────────────── */

export function hashId(input: string): string {
  // 32-bit FNV-1a
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ("00000000" + h.toString(16)).slice(-8);
}

/* ───────────────────────────── Helpers / Exports ──────────────────────── */

export const base = {
  toBase32: (bytes: ByteSource) => toBaseN(bytes, CROCKFORD32),
  fromBase32: (s: string) => fromBaseN(s, CROCKFORD32),
  toBase62: (bytes: ByteSource) => toBaseN(bytes, BASE62),
  fromBase62: (s: string) => fromBaseN(s, BASE62),
  toBase64url: (bytes: ByteSource) => {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // Tiny base64url without Buffer
    let bin = "";
    for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
    // Browser
    if (typeof btoa !== "undefined") {
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    }
    // Node
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Buffer = require("buffer").Buffer as typeof import("buffer").Buffer;
      return Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    } catch {
      // Fallback: base62 as last resort
      return toBaseN(b, BASE62);
    }
  },
};

export default {
  uuidv4,
  isUUIDv4,
  ulid,
  isULID,
  ulidTime,
  nanoid,
  shortId,
  lexId,
  Snowflake,
  hashId,
  base,
};
