// data/live-feed.ts
// Pure TypeScript (no imports). Works with global WebSocket and/or EventSource.
// Rewritten end-to-end for wider TS targets (no nullish coalescing, no numeric separators).
// Features: WS/SSE auto-select, auto-reconnect (exp backoff + jitter), heartbeat/pong,
// pause/resume, topic subscriptions (string/RegExp), replay buffer, send queue + rate limit,
// minimal event emitter, and safe JSON/text/bytes parsing.

type Dict = { [k: string]: string };

type LiveProtocol = "auto" | "ws" | "sse";
type ParseMode = "auto" | "json" | "text" | "bytes";

type LiveEvent = "open" | "close" | "error" | "message" | "reconnect" | "pause" | "resume";

export interface LiveFeedOptions {
  protocol?: LiveProtocol;
  headers?: Dict;                     // (SSE polyfills only; native EventSource ignores)
  parse?: ParseMode;
  retries?: number;                   // -1 = infinite
  backoffMs?: number;                 // initial backoff
  backoffFactor?: number;             // multiplier per attempt
  maxBackoffMs?: number;              // clamp
  jitter?: boolean;                   // +/- 20%
  heartbeatMs?: number;               // ping interval (WS); also used for idle detection
  heartbeatPayload?: any;             // payload to send as ping over WS
  expectPongWithinMs?: number;        // idle threshold before reconnect
  minSendIntervalMs?: number;         // client-side rate limit for WS send()
  sendQueueCapacity?: number;         // buffer while WS is down or rate-limited
  replayCapacity?: number;            // per-topic replay
  topicField?: string;                // field used to detect topic in JSON payloads
  timestampField?: string;            // field used to detect ts in JSON payloads
  preferText?: boolean;               // when parse=auto and JSON fails, keep text (true)
  topicResolver?: (raw: MessageEvent | Event, parsed: any) => string | undefined;
}

export interface SubscriptionOptions {
  filter?: (data: any) => boolean;
  once?: boolean;
}

export interface LiveMessage<T = unknown> {
  topic?: string;
  ts?: number;
  data: T;
  raw?: string | Uint8Array | null;
  protocol: "ws" | "sse";
}

type Sub = {
  id: number;
  topic?: string | RegExp;
  handler: (msg: LiveMessage) => void;
  filter?: (data: any) => boolean;
  once?: boolean;
};

export class LiveFeed {
  private url: string;
  private opts: Required<LiveFeedOptions>;

  private ws: WebSocket | null = null;
  private sse: EventSource | null = null;
  private connecting = false;
  private connectedProto: "ws" | "sse" | null = null;

  private listeners: { [K in LiveEvent]?: Array<(...args: any[]) => void> } = {};
  private subs: Sub[] = [];
  private subSeq = 1;

  private reconnects = 0;
  private lastBackoff = 0;
  private lastMsgAt = 0;
  private lastPongAt = 0;

  private hbTimer: any = null;
  private idleTimer: any = null;

  private paused = false;

  private minSendNextAt = 0;
  private sendQueue: any[] = [];
  private replay: Map<string, LiveMessage[]> = new Map();

  constructor(url: string, options: LiveFeedOptions = {}) {
    this.assertRuntime();
    this.url = url;
    this.opts = this.normalizeOptions(options);
  }

  // ---------------- Public API ----------------

  public async connect(): Promise<void> {
    if (this.isConnected() || this.connecting) return;
    this.connecting = true;
    try {
      if (this.opts.protocol === "ws") {
        await this.openWS();
      } else if (this.opts.protocol === "sse") {
        await this.openSSE();
      } else {
        // auto
        if (/^wss?:\/\//i.test(this.url)) {
          try {
            await this.openWS();
          } catch {
            await this.openSSE();
          }
        } else {
          const wsUrl = this.httpToWs(this.url);
          try {
            await this.openWS(wsUrl);
          } catch {
            await this.openSSE(this.url);
          }
        }
      }
      this.reconnects = 0;
      this.emit("open");
      this.flushSendQueue();
      this.startHeartbeat();
    } finally {
      this.connecting = false;
    }
  }

  public pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.emit("pause");
  }

  public resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.emit("resume");
  }

  public async reconnectNow(reason?: string): Promise<void> {
    this.cleanup("reconnect");
    this.emit("reconnect", reason || "manual");
    await this.connect();
  }

  public close(code?: number, reason?: string): void {
    this.cleanup("close", code, reason);
    this.emit("close", code, reason);
  }

  public isConnected(): boolean {
    if (this.ws) return this.ws.readyState === 1;
    if (this.sse) return (this.sse as any).readyState === 1;
    return false;
  }

  public protocol(): "ws" | "sse" | null {
    return this.connectedProto;
  }

  public on(event: LiveEvent, fn: (...args: any[]) => void): () => void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event]!.push(fn);
    return () => this.off(event, fn);
  }

  public off(event: LiveEvent, fn: (...args: any[]) => void): void {
    const arr = this.listeners[event];
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }

  /** Send raw payload over WS, or queue if WS not open / rate-limited */
  public send(payload: any): void {
    if (this.connectedProto !== "ws" || !this.ws) {
      this.enqueueSend(payload);
      return;
    }
    var now = Date.now();
    var wait = this.opts.minSendIntervalMs > 0 ? Math.max(0, this.minSendNextAt - now) : 0;
    if (wait > 0) {
      this.enqueueSend(payload);
      setTimeout(() => this.flushSendQueue(), wait + 1);
      return;
    }
    try {
      this.ws.send(this.serialize(payload));
      if (this.opts.minSendIntervalMs > 0) {
        this.minSendNextAt = Date.now() + this.opts.minSendIntervalMs;
      }
    } catch {
      this.enqueueSend(payload);
    }
  }

  /** Convenience: publish(topic,data) creates {topic,timestampField,data,...extra} JSON */
  public publish(topic: string, data: any, extra: Record<string, any> = {}): void {
    var env: any = {};
    env[this.opts.topicField] = topic;
    env[this.opts.timestampField] = Date.now();
    env.data = data;
    for (var k in extra) env[k] = (extra as any)[k];
    this.send(env);
  }

  /** Subscribe by topic (exact string or RegExp). Returns unsubscribe function. */
  public subscribe(topic: string | RegExp | undefined, handler: (msg: LiveMessage) => void, options: SubscriptionOptions = {}): () => void {
    const sub: Sub = {
      id: this.subSeq++,
      topic: topic,
      handler: handler,
      filter: options.filter,
      once: options.once
    };
    this.subs.push(sub);
    return () => this.unsubscribeById(sub.id);
  }

  /** Replay last N messages for a topic if recorded */
  public getLast(topic: string, n: number = 1): LiveMessage[] {
    const arr = this.replay.get(topic) || [];
    if (n <= 0) return [];
    if (n >= arr.length) return arr.slice();
    return arr.slice(arr.length - n);
  }

  // ---------------- Open connections ----------------

  private openWS(explicitUrl?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = explicitUrl || this.url;
      const ws = new WebSocket(url);
      this.ws = ws;
      this.connectedProto = "ws";

      let opened = false;
      const openGuard = setTimeout(() => {
        if (!opened && ws.readyState !== 1) {
          try { ws.close(); } catch {}
          if (this.ws === ws) { this.ws = null; this.connectedProto = null; }
          reject(new Error("WebSocket failed to open in time."));
        }
      }, 10000);

      ws.onopen = () => {
        opened = true;
        clearTimeout(openGuard);
        this.lastMsgAt = Date.now();
        this.lastPongAt = Date.now();
        resolve();
      };
      ws.onerror = (ev) => {
        this.emit("error", ev);
      };
      ws.onclose = () => {
        if (this.ws === ws) {
          this.ws = null;
          this.connectedProto = null;
          this.scheduleReconnect();
        }
      };
      ws.onmessage = (ev: MessageEvent) => {
        this.handleIncoming(ev, "ws");
      };
    });
  }

  private openSSE(explicitUrl?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = explicitUrl || this.url;
      const es = new EventSource(url);
      this.sse = es;
      this.connectedProto = "sse";

      let resolved = false;
      const openGuard = setTimeout(() => {
        if (!resolved && (es as any).readyState !== 1) {
          try { es.close(); } catch {}
          if (this.sse === es) { this.sse = null; this.connectedProto = null; }
          reject(new Error("SSE failed to open in time."));
        }
      }, 10000);

      const fulfillOpen = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(openGuard);
          this.lastMsgAt = Date.now();
          resolve();
        }
      };

      es.onopen = () => fulfillOpen();
      es.onerror = (ev) => {
        this.emit("error", ev);
        if ((es as any).readyState === 2) {
          if (this.sse === es) {
            this.sse = null;
            this.connectedProto = null;
            this.scheduleReconnect();
          }
        }
        if (!resolved) {
          resolved = true;
          clearTimeout(openGuard);
          reject(new Error("SSE failed to open."));
        }
      };
      es.onmessage = (ev: MessageEvent) => {
        fulfillOpen();
        this.handleIncoming(ev, "sse");
      };
    });
  }

  // ---------------- Message handling ----------------

  private handleIncoming(ev: MessageEvent, proto: "ws" | "sse"): void {
    this.lastMsgAt = Date.now();
    const parsed = this.parseIncoming(ev);
    const topic = this.resolveTopic(ev, parsed);
    const ts = this.resolveTimestamp(parsed);

    if (this.isPong(parsed)) {
      this.lastPongAt = Date.now();
    }

    const msg: LiveMessage = {
      topic: topic,
      ts: ts,
      data: parsed,
      raw: this.rawFromEvent(ev),
      protocol: proto
    };

    this.emit("message", msg);
    if (!this.paused) this.dispatchToSubscribers(msg);
    if (topic) this.pushReplay(topic, msg);
  }

  private parseIncoming(ev: MessageEvent): any {
    const data: any = (ev as any).data;
    const mode = this.opts.parse;

    if (mode === "text") return String(data);
    if (mode === "bytes") {
      if (typeof data === "string") return this.stringToBytes(data);
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      if (this.isBlob(data)) return data;
      if (this.isTypedArray(data)) return new Uint8Array((data as any).buffer || data);
      return data;
    }
    if (mode === "json") {
      return this.tryParseJson(data);
    }

    // auto
    if (typeof data === "string") {
      const j = this.tryParseJson(data);
      if (j !== undefined) return j;
      return this.opts.preferText ? data : this.tryParseJsonOrText(data);
    }
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (this.isBlob(data)) return data;
    return data;
  }

  private resolveTopic(ev: MessageEvent | Event, parsed: any): string | undefined {
    if (this.opts.topicResolver) {
      try {
        const t = this.opts.topicResolver(ev, parsed);
        if (t) return String(t);
      } catch {}
    }
    if (parsed && typeof parsed === "object") {
      const f = this.opts.topicField;
      const cand = (parsed as any)[f];
      if (cand !== undefined && cand !== null) return String(cand);
      const anyEv: any = ev as any;
      if (typeof anyEv.type === "string" && anyEv.type !== "message") return anyEv.type;
    }
    return undefined;
  }

  private resolveTimestamp(parsed: any): number | undefined {
    if (parsed && typeof parsed === "object") {
      const t = (parsed as any)[this.opts.timestampField];
      if (t == null) return undefined;
      const n = Number(t);
      return isNaN(n) ? undefined : n;
    }
    return undefined;
  }

  private dispatchToSubscribers(msg: LiveMessage): void {
    if (this.subs.length === 0) return;
    const toRemove: number[] = [];
    for (var i = 0; i < this.subs.length; i++) {
      const s = this.subs[i];
      if (s.topic === undefined || this.topicMatches(s.topic, msg.topic)) {
        if (!s.filter || s.filter(msg.data)) {
          try { s.handler(msg); } catch {}
          if (s.once) toRemove.push(s.id);
        }
      }
    }
    if (toRemove.length) {
      this.subs = this.subs.filter(x => toRemove.indexOf(x.id) === -1);
    }
  }

  private topicMatches(sel: string | RegExp, topic?: string): boolean {
    if (topic == null) return false;
    if (typeof sel === "string") return sel === topic;
    return sel.test(topic);
  }

  private pushReplay(topic: string, msg: LiveMessage): void {
    const cap = this.opts.replayCapacity;
    if (cap <= 0) return;
    let arr = this.replay.get(topic);
    if (!arr) {
      arr = [];
      this.replay.set(topic, arr);
    }
    arr.push(msg);
    if (arr.length > cap) arr.splice(0, arr.length - cap);
  }

  // ---------------- Heartbeat & reconnect ----------------

  private startHeartbeat(): void {
    this.stopHeartbeat();

    const hb = this.opts.heartbeatMs;
    const idle = this.opts.expectPongWithinMs || (hb > 0 ? hb * 3 : 0);

    if (hb > 0 && this.connectedProto === "ws" && this.ws) {
      this.hbTimer = setInterval(() => {
        if (!this.ws) return;
        try {
          const ping = this.opts.heartbeatPayload !== undefined ? this.opts.heartbeatPayload : { type: "ping", ts: Date.now() };
          this.ws.send(this.serialize(ping));
        } catch {}
      }, hb);
    }

    if (idle > 0) {
      this.idleTimer = setInterval(() => {
        const now = Date.now();
        const last = Math.max(this.lastMsgAt || 0, this.lastPongAt || 0);
        if (last === 0) return;
        if (now - last > idle) {
          this.reconnectNow("idle-timeout").catch(() => {});
        }
      }, Math.max(1000, Math.floor(idle / 2)));
    }
  }

  private stopHeartbeat(): void {
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
  }

  private scheduleReconnect(): void {
    if (this.connecting) return;
    const max = this.opts.retries;
    if (max >= 0 && this.reconnects >= max) {
      this.emit("close", "max-retries-reached");
      return;
    }
    this.reconnects++;
    const base = this.reconnects === 1 ? this.opts.backoffMs : Math.max(this.opts.backoffMs, this.lastBackoff * this.opts.backoffFactor);
    const withJitter = this.opts.jitter ? this.jittered(base) : base;
    const delay = Math.min(withJitter, this.opts.maxBackoffMs);
    this.lastBackoff = delay;
    setTimeout(() => {
      this.connect().catch(err => this.emit("error", err));
      this.emit("reconnect", { attempt: this.reconnects, delay: delay });
    }, delay);
  }

  private cleanup(_reason?: "close" | "reconnect", code?: number, msg?: string): void {
    this.stopHeartbeat();
    if (this.ws) {
      try { (this.ws as any).onopen = null; (this.ws as any).onmessage = null; (this.ws as any).onerror = null; (this.ws as any).onclose = null; } catch {}
      try { this.ws.close(code, msg); } catch {}
      this.ws = null;
    }
    if (this.sse) {
      try { (this.sse as any).onopen = null; (this.sse as any).onmessage = null; (this.sse as any).onerror = null; } catch {}
      try { this.sse.close(); } catch {}
      this.sse = null;
    }
    this.connectedProto = null;
  }

  // ---------------- Utilities ----------------

  private enqueueSend(payload: any): void {
    const cap = this.opts.sendQueueCapacity;
    if (cap <= 0) return;
    if (this.sendQueue.length >= cap) {
      this.sendQueue.splice(0, this.sendQueue.length - cap + 1);
    }
    this.sendQueue.push(payload);
  }

  private flushSendQueue(): void {
    if (!this.ws || this.connectedProto !== "ws") return;
    if (this.sendQueue.length === 0) return;
    while (this.sendQueue.length > 0 && this.ws && this.ws.readyState === 1) {
      const item = this.sendQueue.shift();
      try {
        this.ws.send(this.serialize(item));
      } catch {
        this.sendQueue.unshift(item as any);
        break;
      }
      if (this.opts.minSendIntervalMs > 0) {
        this.minSendNextAt = Date.now() + this.opts.minSendIntervalMs;
        setTimeout(() => this.flushSendQueue(), this.opts.minSendIntervalMs + 1);
        break;
      }
    }
  }

  private serialize(obj: any): string | ArrayBuffer | Uint8Array {
    if (obj == null) return "";
    if (typeof obj === "string" || obj instanceof ArrayBuffer || obj instanceof Uint8Array) return obj;
    try { return JSON.stringify(obj); } catch { return String(obj); }
  }

  private rawFromEvent(ev: MessageEvent): string | Uint8Array | null {
    const d: any = (ev as any).data;
    if (typeof d === "string") return d;
    if (d instanceof ArrayBuffer) return new Uint8Array(d);
    if (this.isBlob(d)) return null; // sync read not possible
    if (this.isTypedArray(d)) return new Uint8Array((d as any).buffer || d);
    return null;
    }

  private tryParseJson(s: any): any {
    if (typeof s !== "string") return s;
    try { return JSON.parse(s); } catch { return undefined; }
  }

  private tryParseJsonOrText(s: string): any {
    try { return JSON.parse(s); } catch { return s; }
  }

  private stringToBytes(s: string): Uint8Array {
    const arr = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i) & 0xff;
    return arr;
  }

  private isBlob(x: any): x is Blob {
    return typeof Blob !== "undefined" && x instanceof Blob;
  }

  private isTypedArray(x: any): boolean {
    return x && (x instanceof Uint8Array || x instanceof Int8Array || x instanceof Uint16Array || x instanceof Int16Array || x instanceof Uint32Array || x instanceof Int32Array || x instanceof Float32Array || x instanceof Float64Array);
  }

  private isPong(parsed: any): boolean {
    if (!parsed) return false;
    if (typeof parsed === "object") {
      if ((parsed as any).type === "pong" || (parsed as any).op === "pong") return true;
      try {
        if (this.opts.heartbeatPayload !== undefined) {
          const a = JSON.stringify(parsed);
          const b = JSON.stringify(this.opts.heartbeatPayload);
          return a === b;
        }
      } catch {}
    }
    return false;
  }

  private jittered(ms: number): number {
    const delta = ms * 0.2;
    const r = (Math.random() * 2 - 1) * delta;
    const out = Math.floor(ms + r);
    return out < 0 ? 0 : out;
  }

  private httpToWs(u: string): string {
    if (/^https:\/\//i.test(u)) return u.replace(/^https:\/\//i, "wss://");
    if (/^http:\/\//i.test(u)) return u.replace(/^http:\/\//i, "ws://");
    return u;
  }

  private emit(event: LiveEvent, ...args: any[]): void {
    const arr = this.listeners[event];
    if (!arr || arr.length === 0) return;
    for (let i = 0; i < arr.length; i++) {
      try { arr[i].apply(null, args); } catch {}
    }
  }

  private unsubscribeById(id: number): void {
    const i = this.subs.findIndex(s => s.id === id);
    if (i >= 0) this.subs.splice(i, 1);
  }

  private normalizeOptions(o: LiveFeedOptions): Required<LiveFeedOptions> {
    const valOr = function<T>(v: T | undefined | null, d: T): T { return (v === undefined || v === null) ? d : v; };
    const noopResolver = function(_ev: MessageEvent | Event, _parsed: any): string | undefined { return undefined; };

    const protocol: LiveProtocol = valOr(o.protocol, "auto");
    const headers: Dict = o.headers ? { ...o.headers } : {};
    const parse: ParseMode = valOr(o.parse, "auto");
    const retries = valOr(o.retries, -1);
    const backoffMs = valOr(o.backoffMs, 500);
    const backoffFactor = valOr(o.backoffFactor, 2.0);
    const maxBackoffMs = valOr(o.maxBackoffMs, 30000);
    const jitter = valOr(o.jitter, true);
    const heartbeatMs = valOr(o.heartbeatMs, 15000);
    const heartbeatPayload = (o.heartbeatPayload !== undefined) ? o.heartbeatPayload : { type: "ping" };
    const expectPongWithinMs = valOr(o.expectPongWithinMs, 45000);
    const minSendIntervalMs = valOr(o.minSendIntervalMs, 0);
    const sendQueueCapacity = valOr(o.sendQueueCapacity, 256);
    const replayCapacity = valOr(o.replayCapacity, 100);
    const topicField = valOr(o.topicField, "topic");
    const timestampField = valOr(o.timestampField, "ts");
    const preferText = valOr(o.preferText, true);
    const topicResolver = o.topicResolver ? o.topicResolver : noopResolver;

    return {
      protocol: protocol,
      headers: headers,
      parse: parse,
      retries: retries,
      backoffMs: backoffMs,
      backoffFactor: backoffFactor,
      maxBackoffMs: maxBackoffMs,
      jitter: jitter,
      heartbeatMs: heartbeatMs,
      heartbeatPayload: heartbeatPayload,
      expectPongWithinMs: expectPongWithinMs,
      minSendIntervalMs: minSendIntervalMs,
      sendQueueCapacity: sendQueueCapacity,
      replayCapacity: replayCapacity,
      topicField: topicField,
      timestampField: timestampField,
      preferText: preferText,
      topicResolver: topicResolver
    };
  }

  private assertRuntime(): void {
    const hasWS = typeof WebSocket === "function";
    const hasSSE = typeof EventSource === "function";
    if (!hasWS && !hasSSE) {
      throw new Error("LiveFeed requires global WebSocket and/or EventSource support.");
    }
  }
}

// -----------------------------
// Example (commented):
// const live = new LiveFeed("wss://stream.example.com/quotes", { heartbeatMs: 10000 });
// live.on("open", () => console.log("connected"));
// live.on("message", m => console.log(m.topic, m.data));
// const unsub = live.subscribe(/^price:/, m => {/* ... */});
// live.connect();
// live.publish("hello", { foo: 1 });
