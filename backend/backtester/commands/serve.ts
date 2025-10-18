// commands/serve.ts
// Tiny zero-dependency HTTP server + CLI-style runner (Node-only; uses built-ins via dynamic import).
//
// What this gives you
// - Minimal router (method + path), path params (/api/users/:id), query parsing
// - JSON / text / binary responses; small JSON body parser (limit-safe)
// - CORS (optional), gzip/deflate compression (best-effort if available), ETag/If-None-Match
// - Static file serving (cache-control, index.html fallback), directory listing (optional)
// - Health/metrics endpoints out of the box
// - Graceful shutdown (SIGINT/SIGTERM), request logging, rate limit (very light, IP-based token bucket)
// - CLI-ish helper: runServeCommand(["start","--port",8080,"--static","./public","--cors","*"])
//
// Programmatic usage:
//   import { Server, runServeCommand } from "./commands/serve";
//   const s = await Server.start({ port: 8080, cors: "*", staticDir: "public" });
//   s.route("GET", "/hello", (ctx) => ctx.json({ok:true}));
//   // await s.close();

type Handler = (ctx: Ctx) => Promise<void> | void;
type Millis = number;

export interface ServerOptions {
  host?: string;                 // default "0.0.0.0"
  port?: number;                 // default 8080
  basePath?: string;             // mount under base (default "")
  cors?: string | boolean;       // "*" or origin string; true => "*"; false => disabled
  staticDir?: string;            // serve files from this directory (optional)
  staticIndex?: string;          // default "index.html"
  staticCacheSeconds?: number;   // default 300
  staticList?: boolean;          // allow directory listing (default false)
  log?: boolean;                 // request log (default true)
  bodyLimitMB?: number;          // JSON body limit (default 2)
  rate?: { capacity: number; refillMs: Millis; perIp?: boolean }; // simple token bucket (default off)
}

export interface Ctx {
  req: any;
  res: any;
  method: string;
  path: string;
  params: Record<string,string>;
  query: Record<string,string | string[]>;
  headers: Record<string,string>;
  // helpers
  text: (body: string, code?: number, type?: string) => void;
  json: (obj: unknown, code?: number) => void;
  bytes: (buf: Uint8Array, code?: number, type?: string) => void;
  status: (code: number) => void;
  set: (name: string, value: string) => void;
  notFound: () => void;
  // body (lazy)
  bodyJson: <T=any>() => Promise<T>;
}

type Route = { method: string; re: RegExp; keys: string[]; handler: Handler };

export class Server {
  private http: any;
  private zlib: any | null = null;
  private fs: any;
  private pathmod: any;
  private server: any;
  private routes: Route[] = [];
  private opts: Required<ServerOptions>;
  private startedAt = Date.now();
  private limiter = new TokenBucket();

  static async start(opts?: ServerOptions): Promise<Server> {
    const s = new Server(opts);
    await s._start();
    return s;
  }

  private constructor(opts?: ServerOptions) {
    const o = opts ?? {};
    this.opts = {
      host: o.host ?? "0.0.0.0",
      port: isPosInt(o.port) ? o.port! : 8080,
      basePath: normalizeBase(o.basePath ?? ""),
      cors: o.cors ?? false,
      staticDir: o.staticDir,
      staticIndex: o.staticIndex ?? "index.html",
      staticCacheSeconds: isPosInt(o.staticCacheSeconds) ? o.staticCacheSeconds! : 300,
      staticList: !!o.staticList,
      log: o.log !== false,
      bodyLimitMB: isPosNum(o.bodyLimitMB) ? o.bodyLimitMB! : 2,
      rate: o.rate ?? { capacity: 0, refillMs: 1000, perIp: true },
    } as Required<ServerOptions>;
  }

  private async _start() {
    const { http } = await lazyHttp();
    const { fs } = await lazyFs();
    const { path } = await lazyPath();
    this.http = http; this.fs = fs; this.pathmod = path;
    try { const { zlib } = await lazyZlib(); this.zlib = zlib; } catch { this.zlib = null; }

    // built-ins
    this.builtinRoutes();

    // static (if configured)
    if (this.opts.staticDir) {
      this.route("GET", "/(.*)", (ctx) => this.handleStatic(ctx));
    }

    this.server = this.http.createServer((req: any, res: any) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(this.opts.port, this.opts.host, resolve));

    // graceful
    const onShutdown = async () => { await this.close(); process.exit(0); };
    if (hasNode()) {
      process.on("SIGINT", onShutdown);
      process.on("SIGTERM", onShutdown);
    }

    if (this.opts.log) {
      console.log(`[serve] listening on http://${this.opts.host}:${this.opts.port}${this.opts.basePath}`);
      if (this.opts.staticDir) console.log(`[serve] static ${this.opts.staticDir}`);
    }
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server = null;
  }

  // ----- Public API -----

  route(method: string, path: string, handler: Handler): void {
    const { re, keys } = pathToRegex(this.opts.basePath + path);
    this.routes.push({ method: method.toUpperCase(), re, keys, handler });
  }

  // ----- Core -----

  private async handle(req: any, res: any) {
    const start = Date.now();
    // rate limit
    if (this.opts.rate.capacity && !this.limiter.allow(this.ip(req), this.opts.rate)) {
      this.writeHead(res, 429, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Too Many Requests");
      return;
    }
    // CORS preflight
    if (this.opts.cors && req.method === "OPTIONS") {
      this.cors(res, req.headers["origin"]);
      this.writeHead(res, 204, { "Access-Control-Max-Age": "600" });
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    const method = (req.method || "GET").toUpperCase();

    // router
    let matched: Route | null = null;
    let params: Record<string,string> = {};
    for (const r of this.routes) {
      if (r.method !== method && !(r.method === "GET" && method === "HEAD")) continue;
      const m = pathname.match(r.re);
      if (m) { matched = r; params = toParams(r.keys, m); break; }
    }

    const ctx: Ctx = {
      req, res,
      method, path: pathname, params,
      query: toQuery(url.searchParams),
      headers: toLowerHeaderMap(req.headers),
      text: (b: string, code = 200, type = "text/plain; charset=utf-8") => this.respond(req, res, Buffer.from(b), code, type),
      json: (obj: unknown, code = 200) => this.respond(req, res, Buffer.from(JSON.stringify(obj)), code, "application/json; charset=utf-8"),
      bytes: (buf: Uint8Array, code = 200, type = "application/octet-stream") => this.respond(req, res, buf, code, type),
      status: (code: number) => { this.writeHead(res, code, {}); },
      set: (name: string, value: string) => res.setHeader(name, value),
      notFound: () => this.notFound(res),
      bodyJson: async <T=any>() => parseJsonBody<T>(req, this.opts.bodyLimitMB),
    };

    try {
      if (matched) {
        await matched.handler(ctx);
      } else if (!this.opts.staticDir) {
        this.notFound(res);
      }
    } catch (e) {
      this.sendError(res, e);
    } finally {
      if (this.opts.log) {
        const ms = Date.now() - start;
        const code = res.statusCode || 0;
        console.log(`${this.ip(req)} ${method} ${pathname} -> ${code} ${ms}ms`);
      }
    }
  }

  private writeHead(res: any, code: number, extra: Record<string,string>) {
    if (this.opts.cors) this.cors(res);
    for (const k in extra) res.setHeader(k, extra[k]);
    res.statusCode = code;
  }

  private cors(res: any, originHeader?: string) {
    const allow = this.opts.cors === true ? "*" : typeof this.opts.cors === "string" ? this.opts.cors : originHeader || "*";
    res.setHeader("Access-Control-Allow-Origin", allow);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,Accept,If-None-Match");
  }

  private async respond(req: any, res: any, body: Uint8Array, code: number, type: string) {
    const etag = makeEtag(body);
    res.setHeader("ETag", etag);
    if (req.headers["if-none-match"] === etag) {
      this.writeHead(res, 304, {});
      res.end();
      return;
    }
    res.setHeader("Content-Type", type);
    // compression if available and client accepts
    const accept = String(req.headers["accept-encoding"] || "");
    if (this.zlib && body.length > 512) {
      if (accept.includes("br") && this.zlib.brotliCompress) {
        const buf = await promisify(this.zlib.brotliCompress)(body);
        res.setHeader("Content-Encoding", "br");
        this.writeHead(res, code, {});
        res.end(buf);
        return;
      }
      if (accept.includes("gzip")) {
        const buf = await promisify(this.zlib.gzip)(body);
        res.setHeader("Content-Encoding", "gzip");
        this.writeHead(res, code, {});
        res.end(buf);
        return;
      }
      if (accept.includes("deflate")) {
        const buf = await promisify(this.zlib.deflate)(body);
        res.setHeader("Content-Encoding", "deflate");
        this.writeHead(res, code, {});
        res.end(buf);
        return;
      }
    }
    this.writeHead(res, code, {});
    res.end(body);
  }

  private notFound(res: any) {
    this.writeHead(res, 404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }

  private sendError(res: any, e: unknown) {
    const msg = errToString(e);
    this.writeHead(res, 500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: msg }));
  }

  private ip(req: any): string {
    return (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket?.remoteAddress || "") as string;
  }

  // ----- Built-in endpoints -----

  private builtinRoutes() {
    // health
    this.route("GET", "/health", (ctx) => ctx.json({ status: "ok", uptime: Math.round((Date.now() - this.startedAt)/1000) }));
    // metrics (Prometheus-ish, minimal)
    this.route("GET", "/metrics", (ctx) => {
      const lines = [
        "# HELP up 1 if server is up",
        "# TYPE up gauge",
        "up 1",
        "# HELP process_uptime_seconds Uptime",
        "# TYPE process_uptime_seconds counter",
        `process_uptime_seconds ${Math.round((Date.now() - this.startedAt)/1000)}`,
      ];
      ctx.text(lines.join("\n"), 200, "text/plain; version=0.0.4");
    });
    // echo (debug)
    this.route("POST", "/echo", async (ctx) => {
      const b = await ctx.bodyJson<any>().catch(() => ({}));
      ctx.json({ method: ctx.method, path: ctx.path, query: ctx.query, headers: ctx.headers, body: b });
    });
  }

  // ----- Static -----

  private async handleStatic(ctx: Ctx) {
    if (!this.opts.staticDir || ctx.method !== "GET") return ctx.notFound();
    const reqPath = decodeURI(ctx.path);
    const safe = toSafePath(this.pathmod, this.opts.staticDir, reqPath);
    if (!safe) return ctx.notFound();
    let stat: any;
    try { stat = await fsStat(this.fs, safe); } catch { /* ignore */ }

    const trySend = async (p: string) => {
      try {
        const s = await fsStat(this.fs, p);
        if (s.isDirectory()) return false;
        const buf = await fsRead(this.fs, p);
        const type = mimeFromExt(p);
        ctx.set("Cache-Control", `public, max-age=${this.opts.staticCacheSeconds}`);
        ctx.bytes(buf, 200, type);
        return true;
      } catch { return false; }
    };

    if (stat?.isDirectory()) {
      // index.html?
      const index = this.pathmod.join(safe, this.opts.staticIndex);
      if (await trySend(index)) return;
      if (this.opts.staticList) {
        const items = await fsReadDir(this.fs, safe).catch(()=>[]);
        const html = renderDirList(reqPath, items);
        ctx.text(html, 200, "text/html; charset=utf-8");
        return;
      }
      return ctx.notFound();
    }

    if (await trySend(safe)) return;

    // SPA fallback: serve index.html for unknown paths
    const fallback = this.pathmod.join(this.opts.staticDir!, this.opts.staticIndex);
    if (await trySend(fallback)) return;
    ctx.notFound();
  }
}

// ---------------- CLI-ish runner ----------------

export async function runServeCommand(argv: string[]): Promise<string> {
  const args = parseArgv(argv);
  const cmd = String(args._[0] ?? "help").toLowerCase();
  try {
    switch (cmd) {
      case "help": return help();
      case "start": {
        const port = toInt(args.port, 8080);
        const host = String(args.host ?? "0.0.0.0");
        const base = normalizeBase(String(args.base ?? ""));
        const cors = args.cors === undefined ? false : (args.cors === true || String(args.cors) === "true" ? "*" : String(args.cors));
        const staticDir = args.static ? String(args.static) : undefined;
        const staticIndex = args.index ? String(args.index) : "index.html";
        const list = !!args.list || !!args.dirlist;
        const bodyLimitMB = toNum(args.bodyLimitMB, 2);
        const rate = args.rate ? parseRate(String(args.rate)) : undefined;

        const s = await Server.start({
          port, host, basePath: base, cors, staticDir, staticIndex,
          staticList: list, bodyLimitMB, rate, log: args.log !== false,
        });

        // Keep process alive; print hint
        return `listening on http://${host}:${port}${base}${staticDir ? ` (static: ${staticDir})` : ""}`;
      }
      default:
        return `Unknown subcommand "${cmd}".\n` + help();
    }
  } catch (e) {
    return `Error: ${errToString(e)}`;
  }
}

// ---------------- Utilities ----------------

function pathToRegex(pattern: string): { re: RegExp; keys: string[] } {
  // convert /users/:id/files/* to regex
  const keys: string[] = [];
  const esc = pattern.replace(/\/+/g, "/").replace(/\/$/, "");
  const reStr = esc
    .replace(/([.+?^=!:${}()|[\]\\])/g, "\\$1")
    .replace(/\*/g, ".*")
    .replace(/:(\w+)/g, (_m, k) => { keys.push(k); return "([^/]+)"; });
  const re = new RegExp("^" + (reStr || "/") + "$");
  return { re, keys };
}

function toParams(keys: string[], m: RegExpMatchArray): Record<string,string> {
  const out: Record<string,string> = {};
  for (let i = 0; i < keys.length; i++) out[keys[i]] = decodeURIComponent(m[i+1] || "");
  return out;
}

function toQuery(s: URLSearchParams): Record<string,string | string[]> {
  const out: Record<string, any> = {};
  for (const [k,v] of s.entries()) {
    if (k in out) out[k] = Array.isArray(out[k]) ? [...out[k], v] : [out[k], v];
    else out[k] = v;
  }
  return out;
}

function toLowerHeaderMap(h: any): Record<string,string> {
  const out: Record<string,string> = {};
  for (const k in h) if (Object.prototype.hasOwnProperty.call(h,k)) out[k.toLowerCase()] = String(h[k]);
  return out;
}

async function parseJsonBody<T>(req: any, limitMB: number): Promise<T> {
  const limit = Math.max(1, Math.floor(limitMB)) * 1024 * 1024;
  return new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let len = 0;
    req.on("data", (b: Buffer) => {
      len += b.length;
      if (len > limit) { reject(new Error(`body too large (>${limitMB}MB)`)); req.destroy(); return; }
      chunks.push(b);
    });
    req.on("end", () => {
      if (!len) { resolve({} as any); return; }
      const raw = Buffer.concat(chunks).toString("utf8");
      try { resolve(JSON.parse(raw)); } catch { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function normalizeBase(x: string): string {
  if (!x) return "";
  let s = x.trim();
  if (s === "/") return "";
  if (!s.startsWith("/")) s = "/" + s;
  if (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function mimeFromExt(p: string): string {
  const map: Record<string,string> = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".ts": "text/plain; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
  };
  const ext = p.toLowerCase().slice(p.lastIndexOf("."));
  return map[ext] || "application/octet-stream";
}

function toSafePath(pathmod: any, root: string, reqPath: string): string | null {
  const unsafe = reqPath.replace(/^\/+/, "");
  const abs = pathmod.normalize(pathmod.join(root, unsafe));
  const rootAbs = pathmod.resolve(root);
  if (!abs.startsWith(rootAbs)) return null;
  return abs;
}

function renderDirList(path: string, entries: string[]): string {
  const links = entries.map((n) => `<li><a href="${path.replace(/\/$/,"")}/${encodeURIComponent(n)}">${escapeHtml(n)}</a></li>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>Index of ${escapeHtml(path)}</title><h1>Index of ${escapeHtml(path)}</h1><ul>${links}</ul>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]!));
}

function makeEtag(buf: Uint8Array): string {
  const base = simpleHash(buf);
  return `"${base}-${buf.length}"`;
}

function simpleHash(buf: Uint8Array): string {
  // FNV-1a 32-bit
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ("0000000" + h.toString(16)).slice(-8);
}

// ---- file ops ----
async function fsStat(fs: any, p: string): Promise<any> { return new Promise((res, rej)=>fs.stat(p,(e:any,s:any)=>e?rej(e):res(s))); }
async function fsRead(fs: any, p: string): Promise<Buffer> { return new Promise((res, rej)=>fs.readFile(p,(e:any,b:Buffer)=>e?rej(e):res(b))); }
async function fsReadDir(fs: any, p: string): Promise<string[]> { return new Promise((res, rej)=>fs.readdir(p,(e:any,arr:string[])=>e?rej(e):res(arr))); }
function promisify(fn: any) { return (arg: any) => new Promise<Buffer>((res, rej)=>fn(arg,(e: any, out: Buffer)=>e?rej(e):res(out))); }

// ---- token bucket limiter ----
class TokenBucket {
  private map = new Map<string, { tokens: number; last: number }>();
  allow(key: string, cfg: { capacity: number; refillMs: number; perIp?: boolean }): boolean {
    if (!cfg.capacity) return true;
    const now = Date.now();
    const item = this.map.get(key) ?? { tokens: cfg.capacity, last: now };
    const elapsed = Math.max(0, now - item.last);
    const refill = Math.floor(elapsed / cfg.refillMs);
    if (refill > 0) {
      item.tokens = Math.min(cfg.capacity, item.tokens + refill);
      item.last = now;
    }
    if (item.tokens > 0) { item.tokens--; this.map.set(key, item); return true; }
    this.map.set(key, item);
    return false;
  }
}

// ---- lazy built-ins ----
function hasNode(): boolean { try { return !!(globalThis as any).process?.versions?.node; } catch { return false; } }
async function lazyHttp() { return { http: await import("node:http") }; }
async function lazyFs() { return { fs: await import("node:fs") }; }
async function lazyPath() { return { path: await import("node:path") }; }
async function lazyZlib() { return { zlib: await import("node:zlib") }; }

// ---- tiny argv + help ----
type Argv = { _: string[]; [k: string]: any };
function parseArgv(argv: string[]): Argv {
  const out: Argv = { _: [] }; let k: string | null = null;
  for (const raw of argv) {
    const a = String(raw);
    if (a.startsWith("--")) {
      const eq = a.indexOf("="); if (eq > -1) { out[a.slice(2,eq)] = coerce(a.slice(eq+1)); k = null; }
      else { k = a.slice(2); out[k] = true; }
    } else if (a.startsWith("-") && a.length > 2) { for (let i=1;i<a.length;i++) out[a[i]] = true; k = null; }
    else if (a.startsWith("-")) { k = a.slice(1); out[k] = true; }
    else { if (k && out[k] === true) { out[k] = coerce(a); k = null; } else out._.push(a); }
  }
  return out;
}
function coerce(x: string) {
  if (x === "true") return true;
  if (x === "false") return false;
  if (!Number.isNaN(Number(x)) && x.trim() !== "") return Number(x);
  try { return JSON.parse(x); } catch { /* not JSON */ }
  return x;
}
function toInt(x: any, d: number): number { const n = Number(x); return Number.isFinite(n) ? Math.floor(n) : d; }
function toNum(x: any, d: number): number { const n = Number(x); return Number.isFinite(n) ? n : d; }
function isPosInt(x: any): x is number { return Number.isInteger(x) && x > 0; }
function isPosNum(x: any): x is number { return typeof x === "number" && Number.isFinite(x) && x >= 0; }
function parseRate(s: string): { capacity: number; refillMs: number } {
  // "10/1000" => 10 tokens per 1000ms
  const m = String(s).match(/^(\d+)\s*\/\s*(\d+)$/); if (!m) return { capacity: 0, refillMs: 1000 };
  return { capacity: parseInt(m[1],10), refillMs: parseInt(m[2],10) };
}
function help(): string {
  return [
    "serve <subcommand>",
    "",
    "Subcommands:",
    "  start [--port 8080] [--host 0.0.0.0] [--base /api] [--cors *] [--static ./public] [--index index.html]",
    "        [--dirlist] [--rate '10/1000'] [--bodyLimitMB 2] [--log false]",
    "",
    "Examples:",
    "  serve start --port 8080 --static ./public --cors *",
    "  serve start --base /api --rate '60/1000'",
  ].join("\n");
}
function errToString(e: unknown): string { if (e instanceof Error) return `${e.name}: ${e.message}`; try { return JSON.stringify(e); } catch { return String(e); } }
