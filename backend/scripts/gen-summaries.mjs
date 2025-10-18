// scripts/gen-summaries.mjs
// Generate quick Markdown summaries for your project (Node core only; zero deps).
// - Aggregates recent logs (NDJSON), health snapshot, SLO summaries, threat model, and release manifest
// - Produces ./reports/summary-<timestamp>.md  (path configurable)
// - Can also emit separate JSON files with --json
//
// Usage:
//   node scripts/gen-summaries.mjs
//   node scripts/gen-summaries.mjs --logs ./logs/app.ndjson --health http://127.0.0.1:8787/health --slo http://127.0.0.1:8787/slo
//   node scripts/gen-summaries.mjs --token $SERVE_TOKEN --out ./reports --top 200 --json
//
// Inputs (all optional; script degrades gracefully):
//   --logs <path>           path to NDJSON log file (or directory containing *.ndjson)
//   --health <url|file>     health endpoint URL or JSON file
//   --metrics <url>         metrics endpoint URL (Prometheus text) — only a few samples shown
//   --slo <url|file>        SLO summary URL (text/NDJSON) or JSON file
//   --threat <file>         threat-model JSON (from `security/threat-model.ts` -> toJSON())
//   --manifest <file>       MANIFEST.json from a release
//   --out <dir>             output directory (default ./reports)
//   --top <n>               number of recent log lines to scan (default 500)
//   --token <string>        Bearer token for HTTP endpoints
//   --json                  also write machine-readable JSON alongside the markdown
//
// Exit codes: 0 success; 1 on fatal error

/* eslint-disable no-console */

import fs from "fs";
import path from "path";
import http from "http";
import https from "https";
import { URL } from "url";

// --------- CLI ---------

const args = parseArgs(process.argv.slice(2));
const OUT_DIR = path.resolve(args.out || "./reports");
const TOP = clampInt(args.top, 1, 50_000, 500);
const TOKEN = args.token || process.env.SERVE_TOKEN || "";
const WRITE_JSON = !!args.json;

const INPUT = {
  logs: args.logs ? String(args.logs) : null,
  health: args.health ? String(args.health) : null,
  metrics: args.metrics ? String(args.metrics) : null,
  slo: args.slo ? String(args.slo) : null,
  threat: args.threat ? String(args.threat) : null,
  manifest: args.manifest ? String(args.manifest) : null,
};

// --------- Run ---------

(async function main() {
  try {
    ensureDir(OUT_DIR);
    const ts = new Date().toISOString().replace(/[:]/g, "-");
    const mdFile = path.join(OUT_DIR, `summary-${ts}.md`);
    const jsonFile = path.join(OUT_DIR, `summary-${ts}.json`);

    // Collect pieces
    const [logSummary, health, metrics, slo, threat, manifest] = await Promise.all([
      summarizeLogs(INPUT.logs, TOP),
      readHealth(INPUT.health, TOKEN),
      fetchMetrics(INPUT.metrics, TOKEN),
      readSlo(INPUT.slo, TOKEN),
      readThreat(INPUT.threat),
      readJSONMaybe(INPUT.manifest),
    ]);

    const md = renderMarkdown({ ts, logSummary, health, metrics, slo, threat, manifest });
    fs.writeFileSync(mdFile, md);
    console.log("wrote", mdFile);

    if (WRITE_JSON) {
      const obj = { ts, logSummary, health, metrics: metrics?.sample, slo, threat, manifest };
      fs.writeFileSync(jsonFile, JSON.stringify(obj, null, 2));
      console.log("wrote", jsonFile);
    }
  } catch (e) {
    console.error("[gen-summaries] error:", e?.stack || e);
    process.exit(1);
  }
})();

// --------- Sections ---------

async function summarizeLogs(p, top) {
  if (!p) return null;

  const lines = await readNdjsonRecent(p, top);
  const counts = { debug: 0, info: 0, warn: 0, error: 0, other: 0 };
  const byMsg = new Map(); // top messages
  let firstTs = null, lastTs = null;

  for (const l of lines) {
    const o = safeJSON(l);
    const level = (o?.level || o?.lvl || "other").toLowerCase();
    if (counts[level] != null) counts[level]++; else counts.other++;
    const msg = String(o?.msg || o?.message || "").slice(0, 120);
    if (msg) byMsg.set(msg, (byMsg.get(msg) || 0) + 1);
    const t = Date.parse(o?.ts || o?.time || o?.timestamp || "");
    if (!Number.isNaN(t)) {
      if (firstTs == null || t < firstTs) firstTs = t;
      if (lastTs == null || t > lastTs) lastTs = t;
    }
  }

  const topMsgs = Array.from(byMsg.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([msg, n]) => `- ${n.toString().padStart(4)} ×  ${msg}`);

  return {
    scanned: lines.length,
    window: { from: firstTs ? new Date(firstTs).toISOString() : null, to: lastTs ? new Date(lastTs).toISOString() : null },
    counts, topMsgs,
  };
}

async function readHealth(src, token) {
  if (!src) return null;
  if (looksLikeUrl(src)) {
    const res = await httpGet(src, { token });
    const json = safeJSON(res.body) || {};
    return { status: res.status, live: !!(json.live ?? json.ok ?? true), ready: !!(json.ready ?? json.ok ?? true), summary: json.summary || [] };
  }
  const json = readJSONMaybe(src) || {};
  return { status: 200, live: !!(json.live ?? json.ok ?? true), ready: !!(json.ready ?? json.ok ?? true), summary: json.summary || [] };
}

async function fetchMetrics(src, token) {
  if (!src) return null;
  if (!looksLikeUrl(src)) return null;
  const res = await httpGet(src, { token });
  const text = res.body || "";
  // sample interesting lines
  const samples = [];
  const up = findFirst(text, /(^|\n)(process_up|[a-zA-Z_:]\w*_up)(\{.*\})?\s+(\d+(\.\d+)?)/);
  if (up) samples.push(up.trim());
  const reqs = findFirst(text, /(^|\n)app_requests_total\{.*\}\s+\d+/);
  if (reqs) samples.push(reqs.trim());
  const rt = findFirst(text, /(^|\n)app_request_duration_seconds_(sum|count|bucket)\{.*\}\s+\d+(\.\d+)?/);
  if (rt) samples.push(rt.trim());
  return { status: res.status, sample: samples.slice(0, 5) };
}

async function readSlo(src, token) {
  if (!src) return null;
  if (looksLikeUrl(src)) {
    const res = await httpGet(src, { token });
    const body = (res.body || "").trim();
    const lines = body.split("\n").map(x => x.trim()).filter(Boolean);
    // Try JSON if possible, else treat as text summary lines
    const maybeJson = safeJSON(lines[lines.length - 1]);
    if (maybeJson && maybeJson.kind === "slo") {
      // NDJSON of snapshots — extract few
      const parsed = lines.map(safeJSON).filter(Boolean).slice(-5);
      return { status: res.status, last: parsed[parsed.length - 1], recent: parsed };
    }
    return { status: res.status, summaryText: lines.slice(-10) };
  }
  // file path
  const content = fs.readFileSync(src, "utf8");
  try {
    const j = JSON.parse(content);
    return { status: 200, last: j };
  } catch {
    return { status: 200, summaryText: content.trim().split("\n").slice(-10) };
  }
}

async function readThreat(src) {
  if (!src) return null;
  const obj = readJSONMaybe(src);
  if (!obj) return null;
  // pull quick stats
  const risks = Array.isArray(obj.risks) ? obj.risks : [];
  const levels = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const r of risks) {
    const lvl = r?.calc?.level || "Medium";
    if (levels[lvl] != null) levels[lvl] += 1;
  }
  return { version: obj.version, asOfISO: obj.asOfISO, risks: levels };
}

// --------- Render ---------

function renderMarkdown({ ts, logSummary, health, metrics, slo, threat, manifest }) {
  const lines = [];
  lines.push(`# System Summary`);
  lines.push(`_Generated: ${ts}_`);
  lines.push("");

  if (manifest) {
    lines.push(`## Release`);
    lines.push(`- **Name**: ${safe(manifest.name)}  •  **Version**: ${safe(manifest.version)}  •  **Commit**: ${safe(manifest.commit) || "n/a"}`);
    lines.push(`- **Created**: ${safe(manifest.createdAt)}  •  **Files**: ${Array.isArray(manifest.files) ? manifest.files.length : 0}`);
    lines.push("");
  }

  if (health) {
    lines.push(`## Health`);
    lines.push(`- Live: **${health.live ? "OK" : "FAIL"}**  •  Ready: **${health.ready ? "OK" : "FAIL"}**  •  (HTTP ${health.status})`);
    if (Array.isArray(health.summary) && health.summary.length) {
      lines.push("", `> ${health.summary.join(" | ")}`, "");
    } else lines.push("");
  }

  if (metrics) {
    lines.push(`## Metrics (samples)`);
    for (const s of metrics.sample || []) lines.push("```\n" + s + "\n```");
    lines.push("");
  }

  if (slo) {
    lines.push(`## SLO`);
    if (slo.last?.name) {
      const l = slo.last;
      lines.push(`- **${l.name}**: value=${pct(l.sli?.value)} target=${pct(l.target)} burn=${fix(l.burn?.overall)}`);
      if (Array.isArray(l.alerts) && l.alerts.length) {
        lines.push(`- Alerts: ${l.alerts.map(a => `${a.policy}@${fix(a.ratio)}`).join(", ")}`);
      }
    } else if (Array.isArray(slo.summaryText)) {
      for (const s of slo.summaryText) lines.push(`- ${s}`);
    }
    lines.push("");
  }

  if (threat) {
    lines.push(`## Threat Model`);
    lines.push(`- Version: ${safe(threat.version)}  •  As of: ${safe(threat.asOfISO)}`);
    lines.push(`- Risks: Critical=${threat.risks.Critical} High=${threat.risks.High} Medium=${threat.risks.Medium} Low=${threat.risks.Low}`);
    lines.push("");
  }

  if (logSummary) {
    lines.push(`## Logs (last ${logSummary.scanned} lines)`);
    lines.push(`- Window: ${logSummary.window.from || "?"} → ${logSummary.window.to || "?"}`);
    lines.push(`- Levels: debug=${logSummary.counts.debug} info=${logSummary.counts.info} warn=${logSummary.counts.warn} error=${logSummary.counts.error} other=${logSummary.counts.other}`);
    if (logSummary.topMsgs?.length) {
      lines.push(`- Top Messages:`);
      lines.push(...logSummary.topMsgs);
    }
    lines.push("");
  }

  lines.push(`---`);
  lines.push(`_End of report_`);
  lines.push("");
  return lines.join("\n");
}

// --------- IO helpers ---------

async function readNdjsonRecent(p, top) {
  const files = [];
  const stat = safeStat(p);
  if (!stat) return [];
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(p)) {
      if (name.toLowerCase().endsWith(".ndjson")) files.push(path.join(p, name));
    }
  } else if (stat.isFile()) {
    files.push(p);
  }
  // read last N lines per file (simple approach: read entire file if < 5MB)
  const lines = [];
  for (const f of files) {
    const st = fs.statSync(f);
    const buf = st.size <= 5_000_000 ? fs.readFileSync(f, "utf8") : tailFile(f, 5_000_000);
    const arr = buf.split("\n").map(s => s.trim()).filter(Boolean);
    lines.push(...arr.slice(-top));
  }
  return lines.slice(-top);
}

function tailFile(f, maxBytes) {
  const st = fs.statSync(f);
  const size = st.size;
  const start = Math.max(0, size - maxBytes);
  const fd = fs.openSync(f, "r");
  const buf = Buffer.alloc(size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  return buf.toString("utf8");
}

async function httpGet(urlStr, { token, timeout = 5000 } = {}) {
  const u = new URL(urlStr);
  const mod = u.protocol === "https:" ? https : http;
  const headers = { "Accept": "*/*" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return new Promise((resolve, reject) => {
    const req = mod.request({
      method: "GET",
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + (u.search || ""),
      headers,
      timeout,
      // rejectUnauthorized: false, // uncomment if using self-signed in dev
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers || {}, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.setTimeout(timeout, () => { try { req.destroy(new Error(`timeout ${timeout}ms`)); } catch {} });
    req.end();
  });
}

function readJSONMaybe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// --------- tiny utils ---------

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
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function clampInt(v, lo, hi, dflt) { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : dflt; }
function looksLikeUrl(s) { return /^https?:\/\//i.test(String(s || "")); }
function safeStat(p) { try { return fs.statSync(p); } catch { return null; } }
function safeJSON(s) { try { return JSON.parse(String(s)); } catch { return null; } }
function findFirst(text, regex) { const m = regex.exec(text); return m ? m[0] : null; }
function pct(x) { const n = Number(x); if (!Number.isFinite(n)) return "n/a"; return (n * 100).toFixed(3) + "%"; }
function fix(x) { const n = Number(x); return Number.isFinite(n) ? n.toFixed(2) : "n/a"; }
function safe(x) { return x == null ? "" : String(x); }