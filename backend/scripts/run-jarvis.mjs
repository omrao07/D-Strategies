// cripts/run-jarvis.mjs
// Launcher for the Jarvis app (Node core only; zero deps).
// Wires up: config, health server, simple metrics endpoint, graceful shutdown,
// and a demo “Jarvis loop” to simulate work.
//
// NOTE: The folder name here is literally `cripts/` per your request.
// If you meant `scripts/`, rename this file accordingly.
//
// Usage:
//   node cripts/run-jarvis.mjs --port 8787 --host 127.0.0.1 --name jarvis --env dev
//   SERVE_TOKEN=secret node cripts/run-jarvis.mjs --token $SERVE_TOKEN
//
// Endpoints (GET):
//   /live    -> { live: boolean }
//   /ready   -> { ready: boolean }
//   /health  -> minimal JSON snapshot
//   /metrics -> Prometheus text (very small set)

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ---------- CLI & Config ----------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const APP_NAME = args.name || "jarvis";
const ENV = args.env || process.env.NODE_ENV || "dev";
const HOST = args.host || "127.0.0.1";
const PORT = toInt(args.port, 8787);
const TOKEN = args.token || process.env.SERVE_TOKEN || ""; // optional

// Load configs if present (best-effort)
const HF_CFG = readJSONSafe(path.join(ROOT, "config", "hf.config.json")) || {};
const A11Y_CFG = readJSONSafe(path.join(ROOT, "config", "a11y.config.json")) || {};

// ---------- Tiny health/metrics state ----------

const state = {
  startMs: Date.now(),
  stopping: false,
  ready: false,
  loopErrors: 0,
  loopRuns: 0,
  lastLoopMs: 0,
};

const metrics = {
  up: 1,
  requests: 0,
  requestDurationMs: { sum: 0, count: 0 },
};

// ---------- Jarvis demo loop (replace with real orchestrator) ----------

let loopTimer = null;

function startJarvisLoop() {
  // Simulate background work every second
  loopTimer = setInterval(async () => {
    const t0 = Date.now();
    try {
      // TODO: call your real orchestrator/engine entry here.
      // e.g., await runTick(); or orchestrator.runStep();
      await sleep(50 + Math.random() * 75); // fake work
      state.loopRuns += 1;
      state.lastLoopMs = Date.now() - t0;
      // Consider marking ready after first successful iteration
      if (!state.ready) state.ready = true;
    } catch (e) {
      state.loopErrors += 1;
      state.lastLoopMs = Date.now() - t0;
    }
  }, 1000);
}

function stopJarvisLoop() {
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
}

// ---------- HTTP server (health & metrics) ----------

const server = http.createServer(async (req, res) => {
  const start = Date.now();
  metrics.requests += 1;

  // basic auth (optional)
  if (TOKEN) {
    const ok = timingSafeEqual(
      String(req.headers?.authorization || ""),
      `Bearer ${TOKEN}`
    );
    if (!ok) {
      res.writeHead(401, { "WWW-Authenticate": "Bearer" });
      res.end("unauthorized");
      recordDuration(start);
      return;
    }
  }

  // routes
  const url = String(req.url || "/").split("?")[0];
  if (req.method !== "GET") {
    res.writeHead(405).end("method not allowed");
    recordDuration(start);
    return;
  }

  if (url === "/live") {
    const live = !state.stopping;
    json(res, 200, { live });
    recordDuration(start);
    return;
  }

  if (url === "/ready") {
    const ready = state.ready && !state.stopping;
    json(res, ready ? 200 : 503, { ready });
    recordDuration(start);
    return;
  }

  if (url === "/health" || url === "/") {
    const live = !state.stopping;
    const ready = state.ready && !state.stopping;
    const body = {
      service: APP_NAME,
      version: HF_CFG?.fund?.version || "dev",
      env: ENV,
      now: new Date().toISOString(),
      uptimeSec: Math.floor((Date.now() - state.startMs) / 1000),
      live, ready,
      summary: summarizeHealth(live, ready),
    };
    json(res, ready ? 200 : 503, body);
    recordDuration(start);
    return;
  }

  if (url === "/metrics") {
    const text = renderPrometheus();
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(text);
    recordDuration(start);
    return;
  }

  res.writeHead(404).end("not found");
  recordDuration(start);
});

// ---------- Start/Stop lifecycle ----------

async function main() {
  log(`Starting ${APP_NAME} (${ENV}) on http://${HOST}:${PORT}`);
  if (HF_CFG?.observability?.health?.checks?.includes("memory")) {
    log("Health checks enabled: memory/event_loop_lag/uptime (minimal in this runner)");
  }

  startJarvisLoop();

  await new Promise((resolve) => server.listen(PORT, HOST, resolve));
  log("HTTP server listening.");
  trapSignals();
}

function trapSignals() {
  const onSig = (sig) => {
    log(`Received ${sig}, shutting down…`);
    state.stopping = true;
    stopJarvisLoop();
    server.close(() => {
      log("Server closed.");
      process.exit(0);
    });
    // force exit after grace period
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
}

main().catch((e) => {
  console.error("[fatal]", e?.stack || e);
  process.exit(1);
});

// ---------- Helpers ----------

function renderPrometheus() {
  const lines = [];
  // up gauge
  lines.push(`# HELP process_up 1 if process is up`);
  lines.push(`# TYPE process_up gauge`);
  lines.push(`process_up ${metrics.up}`);

  // requests counter
  lines.push(`# HELP app_requests_total Total HTTP requests`);
  lines.push(`# TYPE app_requests_total counter`);
  lines.push(`app_requests_total{service="${APP_NAME}",env="${ENV}"} ${metrics.requests}`);

  // request duration (summary-ish: sum & count)
  lines.push(`# HELP app_request_duration_ms Request duration (ms) sum and count`);
  lines.push(`# TYPE app_request_duration_ms summary`);
  lines.push(`app_request_duration_ms_sum{service="${APP_NAME}",env="${ENV}"} ${fix(metrics.requestDurationMs.sum)}`);
  lines.push(`app_request_duration_ms_count{service="${APP_NAME}",env="${ENV}"} ${metrics.requestDurationMs.count}`);

  // process uptime seconds as gauge
  const uptime = (Date.now() - state.startMs) / 1000;
  lines.push(`# HELP process_uptime_seconds Uptime in seconds`);
  lines.push(`# TYPE process_uptime_seconds gauge`);
  lines.push(`process_uptime_seconds ${fix(uptime)}`);

  return lines.join("\n") + "\n";
}

function summarizeHealth(live, ready) {
  const out = [];
  if (!live) out.push("stopping");
  if (!ready) out.push("warming");
  if (!out.length) out.push(`${APP_NAME} healthy`);
  return out;
}

function recordDuration(t0) {
  const d = Date.now() - t0;
  metrics.requestDurationMs.sum += d;
  metrics.requestDurationMs.count += 1;
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, v] = a.includes("=") ? a.slice(2).split("=") : [a.slice(2), argv[i + 1]?.startsWith("--") ? "true" : argv[++i]];
    out[k] = v ?? "true";
  }
  return out;
}

function toInt(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : d;
}

function readJSONSafe(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function fix(n) { const x = Number(n); return Number.isFinite(x) ? (Math.round(x * 1000) / 1000).toString() : "0"; }
function log(...a) { console.log(new Date().toISOString(), "-", ...a); }

// constant-time compare for Authorization header
function timingSafeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  const len = Math.max(A.length, B.length);
  let diff = A.length ^ B.length;
  for (let i = 0; i < len; i++) diff |= (A[i % A.length] ^ B[i % B.length]);
  return diff === 0;
}