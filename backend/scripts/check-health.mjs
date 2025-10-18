// scripts/check-health.mjs
// Minimal health checker for your service (Node core only).
// - Pings /live, /ready, /health (JSON), and optionally /metrics, /slo
// - Auth: optional Bearer token
// - Timeouts + non-zero exit on not-ready
// - Output: human text (default), or --json / --ndjson
//
// Usage:
//   node scripts/check-health.mjs --url http://127.0.0.1:8787 --token $SERVE_TOKEN
//   node scripts/check-health.mjs --json
//   node scripts/check-health.mjs --ndjson --timeout 3000 --checks live,ready,metrics
//
// Exit codes:
//   0 = ready & live ok
//   1 = any required check fails or times out

/* eslint-disable no-console */

import http from "http";
import https from "https";
import { URL } from "url";

// ---------------- CLI ----------------

const args = parseArgs(process.argv.slice(2));
const base = new URL(args.url || "http://127.0.0.1:8787");
const token = args.token || process.env.SERVE_TOKEN || "";
const timeoutMs = clampInt(args.timeout, 1, 120_000, 5000);
const outJSON = !!args.json;
const outNDJSON = !!args.ndjson;
const checks = (args.checks ? String(args.checks).split(",") : ["live", "ready", "health", "metrics", "slo"])
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// ---------------- Runner ----------------

const results = {
  url: base.toString(),
  ts: new Date().toISOString(),
  checks: {},
  ok: false,
};

const endpoints = {
  live:   "/live",
  ready:  "/ready",
  health: "/health",
  metrics:"/metrics",
  slo:    "/slo",
};

const required = new Set(["live", "ready"]); // must pass for exit=0

(async () => {
  for (const name of checks) {
    const path = endpoints[name];
    if (!path) continue;
    try {
      const r = await fetchJSONorText(join(base, path), { token, timeoutMs });
      const res = interpret(name, r);
      results.checks[name] = res;
      emit({ kind: "check", name, ...res });
    } catch (e) {
      const res = { ok: false, status: 0, error: String(e?.message || e) };
      results.checks[name] = res;
      emit({ kind: "check", name, ...res });
    }
  }

  // overall
  results.ok = Array.from(required).every(n => results.checks[n]?.ok === true);

  if (outNDJSON) {
    emit({ kind: "summary", ok: results.ok, url: results.url, required: Array.from(required) });
  } else if (outJSON) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    prettyPrint(results);
  }

  process.exit(results.ok ? 0 : 1);
})().catch(err => {
  console.error("[fatal]", err?.stack || err);
  process.exit(1);
});

// ---------------- Helpers ----------------

function interpret(name, r) {
  if (name === "metrics") {
    // very light check: process_up == 1 or any *_up == 1
    const up = /(^|\n)(?:[a-zA-Z_:][\w:]*_)?up(?:\{.*\})?\s+(\d+(?:\.\d+)?)/.exec(r.text || "");
    return { ok: !!(up && Number(up[2]) > 0), status: r.status, sample: up ? up[0].trim().slice(0,120) : null };
  }
  if (name === "slo") {
    // expect a text summary or NDJSON; consider ok if not empty
    const body = r.text || r.json || "";
    return { ok: typeof body === "string" ? body.trim().length > 0 : true, status: r.status };
  }
  // JSON endpoints
  const j = r.json || {};
  if (name === "live")  return { ok: !!(j.live ?? j.ok ?? j.status === "ok"), status: r.status, json: j };
  if (name === "ready") return { ok: !!(j.ready ?? j.ok ?? j.status === "ok"), status: r.status, json: j };
  if (name === "health") {
    // expect { live:boolean, ready:boolean } in minimal mode
    const ok = !!((j.live ?? true) && (j.ready ?? true));
    return { ok, status: r.status, json: j };
  }
  return { ok: r.status >= 200 && r.status < 300, status: r.status };
}

function join(base, path) {
  const u = new URL(base.toString());
  u.pathname = path;
  return u;
}

async function fetchJSONorText(url, { token, timeoutMs }) {
  const mod = url.protocol === "https:" ? https : http;
  const hdrs = { "Accept": "*/*" };
  if (token) hdrs["Authorization"] = `Bearer ${token}`;

  const res = await httpRequest(mod, {
    method: "GET",
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    path: url.pathname + (url.search || ""),
    headers: hdrs,
    protocol: url.protocol,
    timeout: timeoutMs,
    // Note: if you need to ignore self-signed certs in dev, uncomment:
    // rejectUnauthorized: false,
  });

  const ct = (res.headers["content-type"] || "").toLowerCase();
  if (ct.includes("application/json") || ct.includes("ndjson") || looksLikeJSON(res.body)) {
    let json = null;
    try { json = JSON.parse(stripNDJSON(res.body)); } catch { /* it's fine; keep as text */ }
    return { status: res.statusCode, headers: res.headers, json, text: res.body };
  }
  return { status: res.statusCode, headers: res.headers, text: res.body };
}

function httpRequest(mod, opts) {
  return new Promise((resolve, reject) => {
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ statusCode: res.statusCode || 0, headers: res.headers || {}, body });
      });
    });
    req.on("error", reject);
    req.setTimeout(opts.timeout || 5000, () => {
      try { req.destroy(new Error(`timeout after ${opts.timeout}ms`)); } catch {}
    });
    req.end();
  });
}

// Output helpers
function emit(obj) {
  if (outNDJSON) { console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj })); }
}

function prettyPrint(res) {
  const ok = (b) => (b ? "OK" : "FAIL");
  console.log(`Health check @ ${res.url}`);
  for (const [k, v] of Object.entries(res.checks)) {
    const line = `${k.padEnd(7)} : ${ok(v.ok)}  (status=${v.status ?? "?"}${v.error ? `, ${v.error}` : ""})`;
    console.log(line);
    if (k === "metrics" && v.sample) console.log(`  sample: ${v.sample}`);
  }
  console.log(`Overall      : ${ok(res.ok)}`);
}

// tiny utils
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, vRaw] = a.includes("=") ? a.slice(2).split("=") : [a.slice(2), argv[i + 1]?.startsWith("--") ? "true" : argv[++i]];
    out[k] = vRaw ?? "true";
  }
  return out;
}

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : dflt;
}

function looksLikeJSON(s = "") {
  const t = String(s).trim();
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
}

function stripNDJSON(s = "") {
  // If /health returned compact JSON you're fine; if NDJSON lines, take the last non-empty JSON object
  const lines = String(s).split("\n").map(x => x.trim()).filter(Boolean);
  if (!lines.length) return "{}";
  if (lines.length === 1) return lines[0];
  const lastJson = [...lines].reverse().find(l => looksLikeJSON(l));
  return lastJson || lines[lines.length - 1];
}