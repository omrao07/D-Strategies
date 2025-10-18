// scripts/ally-audit.mjs
// Lightweight Accessibility (“a11y”) audit script — zero deps, Node core only.
// NOTE: You typed "ally" — keeping this filename, but you may want to rename to "a11y-audit.mjs".
// What it does (static-ish checks by fetching HTML):
//   - <img> have alt
//   - Headings hierarchy (no big jumps, starts at h1/h2)
//   - Required ARIA roles/landmarks present (main/nav/footer/header)
//   - Form controls have labels (or aria-label/aria-labelledby)
//   - Skip link presence
//   - Focus-visible CSS hint (very basic)
//   - Page title present
// If axe-core/pa11y CLIs are available, it can optionally call them for a richer report.
//
// Usage:
//   node scripts/ally-audit.mjs --url https://example.com
//   node scripts/ally-audit.mjs --file ./templates/index.html
//   node scripts/ally-audit.mjs --list urls.txt               # one URL/file per line
//   node scripts/ally-audit.mjs --ndjson                      # NDJSON output
//   node scripts/ally-audit.mjs --axe --pa11y                 # try external tools if installed
//
// Exit code: 0 if all targets pass without "error" findings; 1 otherwise.

/* eslint-disable no-console */

import fs from "fs";
import path from "path";
import http from "http";
import https from "https";
import { spawnSync } from "child_process";
import { URL } from "url";

// ---------------- CLI ----------------

const args = parseArgs(process.argv.slice(2));
const TARGET_URL = args.url || null;
const TARGET_FILE = args.file || null;
const LIST = args.list || null;
const OUT_NDJSON = !!args.ndjson;
const TRY_AXE = !!args.axe;
const TRY_PA11Y = !!args.pa11y;
const TIMEOUT = clampInt(args.timeout, 1000, 30000, 8000);

// gather targets
let targets = [];
if (TARGET_URL) targets.push(TARGET_URL);
if (TARGET_FILE) targets.push(TARGET_FILE);
if (LIST && fs.existsSync(LIST)) {
  const lines = fs.readFileSync(LIST, "utf8").split("\n").map(s => s.trim()).filter(Boolean);
  targets.push(...lines);
}
if (!targets.length) {
  console.error("Provide at least one target: --url <url> | --file <path> | --list <file>");
  process.exit(1);
}

// ---------------- Run ----------------

const allFindings = [];
let hasError = false;

(async () => {
  for (const t of targets) {
    try {
      const { html, source } = await getHtml(t, TIMEOUT);
      const ctx = { target: t, source };
      // built-in checks
      const findings = [
        ...checkTitle(html, ctx),
        ...checkImagesAlt(html, ctx),
        ...checkHeadings(html, ctx),
        ...checkLandmarks(html, ctx),
        ...checkLabels(html, ctx),
        ...checkSkipLink(html, ctx),
        ...checkFocusVisibleHint(html, ctx),
      ];
      for (const f of findings) emit(f);
      allFindings.push(...findings);
      if (TRY_AXE) await runAxe(t, html);
      if (TRY_PA11Y) await runPa11y(t);
    } catch (e) {
      const f = finding("error", "fetch-failed", { target: t, message: String(e?.message || e) });
      emit(f);
      allFindings.push(f);
      hasError = true;
    }
  }

  // Summary
  const summary = summarize(allFindings);
  if (!OUT_NDJSON) printSummary(summary);
  if (summary.counts.error > 0) hasError = true;
  process.exit(hasError ? 1 : 0);
})();

// ---------------- Fetch/Load ----------------

async function getHtml(target, timeout) {
  if (/^https?:\/\//i.test(target)) {
    const body = await httpGet(target, timeout);
    return { html: body, source: "url" };
  }
  const p = path.resolve(process.cwd(), target);
  const html = fs.readFileSync(p, "utf8");
  return { html, source: "file" };
}

function httpGet(urlStr, timeout) {
  const u = new URL(urlStr);
  const mod = u.protocol === "https:" ? https : http;
  const headers = { "Accept": "text/html,*/*" };
  return new Promise((resolve, reject) => {
    const req = mod.request({
      method: "GET",
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + (u.search || ""),
      headers,
      timeout,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.setTimeout(timeout, () => { try { req.destroy(new Error(`timeout ${timeout}ms`)); } catch {} });
    req.end();
  });
}

// ---------------- Checks (regex/DOM-lite) ----------------
// These are heuristics — not full HTML parsing. Keep simple and robust.

function checkTitle(html, ctx) {
  const hasTitle = /<title>[^<]+<\/title>/i.test(html);
  if (!hasTitle) return [finding("error", "title-missing", ctx)];
  return [];
}

function checkImagesAlt(html, ctx) {
  // <img ...> without alt or with empty alt (except role="presentation"/aria-hidden="true")
  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  const out = [];
  for (const tag of imgs) {
    const hasPresentational = /\brole\s*=\s*["']?presentation["']?/i.test(tag) || /\baria-hidden\s*=\s*["']?true["']?/i.test(tag);
    const hasAlt = /\balt\s*=/i.test(tag);
    const altVal = /alt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? null;
    if (!hasPresentational && (!hasAlt || altVal === null || altVal.trim() === "")) {
      out.push(finding("error", "img-alt-missing", { ...ctx, sample: trim(tag) }));
    }
  }
  return out;
}

function checkHeadings(html, ctx) {
  const tags = Array.from(html.matchAll(/<(h[1-6])\b[^>]*>(.*?)<\/\1>/gis)).map(m => ({ tag: m[1].toLowerCase(), text: strip(m[2]) }));
  if (!tags.length) return [finding("warn", "headings-missing", ctx)];
  const levels = tags.map(t => Number(t.tag[1]));
  // basic hierarchy: no jump greater than +1 (e.g., h2 -> h4) unless restarting at h1/h2
  const out = [];
  for (let i = 1; i < levels.length; i++) {
    const prev = levels[i - 1], cur = levels[i];
    if (cur > prev + 1) out.push(finding("warn", "heading-hierarchy-jump", { ...ctx, prev, cur, sample: tags[i].text.slice(0, 80) }));
  }
  // recommend starting with h1 or h2
  if (levels[0] > 2) out.push(finding("info", "heading-starts-too-deep", { ...ctx, first: levels[0] }));
  return out;
}

function checkLandmarks(html, ctx) {
  const hasMain = /<main\b/i.test(html) || /\brole\s*=\s*["']main["']/i.test(html);
  const hasNav = /<nav\b/i.test(html) || /\brole\s*=\s*["']navigation["']/i.test(html);
  const hasHeader = /<header\b/i.test(html);
  const hasFooter = /<footer\b/i.test(html);
  const out = [];
  if (!hasMain) out.push(finding("warn", "landmark-main-missing", ctx));
  if (!hasNav) out.push(finding("info", "landmark-nav-missing", ctx));
  if (!hasHeader) out.push(finding("info", "landmark-header-missing", ctx));
  if (!hasFooter) out.push(finding("info", "landmark-footer-missing", ctx));
  return out;
}

function checkLabels(html, ctx) {
  // inputs/select/textarea should have <label for=id>, or aria-label/aria-labelledby
  const ctrls = Array.from(html.matchAll(/<(input|select|textarea)\b([^>]*)>/gi));
  const labels = Array.from(html.matchAll(/<label\b([^>]*)>/gi));
  const idSet = new Set(ctrls.map(m => attr(m[2], "id")).filter(Boolean));
  const forIds = new Set(labels.map(m => attr(m[1], "for")).filter(Boolean));
  const out = [];
  for (const m of ctrls) {
    const attrs = m[2];
    const type = (attr(attrs, "type") || "").toLowerCase();
    if (type === "hidden") continue;
    const id = attr(attrs, "id");
    const hasAria = !!(attr(attrs, "aria-label") || attr(attrs, "aria-labelledby"));
    const labeled = (id && forIds.has(id)) || hasAria;
    if (!labeled) out.push(finding("error", "control-unlabeled", { ...ctx, sample: trim(m[0]) }));
  }
  return out;
}

function checkSkipLink(html, ctx) {
  // look for <a href="#main"> or class/aria techniques
  const has = /<a\b[^>]*href=["']#[^"']+["'][^>]*>\s*(skip|skip to|skip navigation)/i.test(html);
  return has ? [] : [finding("info", "skip-link-missing", ctx)];
}

function checkFocusVisibleHint(html, ctx) {
  // crude hint: ensure there’s a :focus-visible or :focus style somewhere
  const has = /:focus-visible|:focus\s*\{[^}]*outline/i.test(html);
  return has ? [] : [finding("info", "focus-visible-style-missing", ctx)];
}

// ---------------- Optional external tools ----------------

async function runAxe(target, html) {
  if (!hasBin("npx")) return;
  // Try piping HTML via stdin to axe if URL is a file; for URLs, hand axe the URL.
  // Note: This requires axe CLI to be resolvable by npx; best effort only.
  try {
    if (/^https?:\/\//i.test(target)) {
      const res = spawnSync("npx", ["--yes", "@axe-core/cli", "-q", target], { encoding: "utf8" });
      emitTool("axe-core", target, res);
    } else {
      const tmp = path.join(process.cwd(), `.ally_tmp_${Date.now()}.html`);
      fs.writeFileSync(tmp, html);
      const res = spawnSync("npx", ["--yes", "@axe-core/cli", "-q", tmp], { encoding: "utf8" });
      try { fs.unlinkSync(tmp); } catch {}
      emitTool("axe-core", target, res);
    }
  } catch (e) {
    emit(finding("info", "axe-run-failed", { target, message: String(e?.message || e) }));
  }
}

async function runPa11y(target) {
  if (!hasBin("npx")) return;
  try {
    if (!/^https?:\/\//i.test(target)) return; // pa11y expects a URL
    const res = spawnSync("npx", ["--yes", "pa11y", "--reporter", "json", target], { encoding: "utf8" });
    emitTool("pa11y", target, res, true);
  } catch (e) {
    emit(finding("info", "pa11y-run-failed", { target, message: String(e?.message || e) }));
  }
}

function emitTool(tool, target, res, isJson = false) {
  if (res.status !== 0 && !res.stdout && !res.stderr) {
    emit(finding("info", `${tool}-not-available`, { target }));
    return;
  }
  const out = String(res.stdout || res.stderr || "");
  if (!OUT_NDJSON) {
    console.log(`\n[${tool}] target=${target}`);
    console.log(out.slice(0, 2000));
  } else {
    emit({ ts: new Date().toISOString(), kind: "tool", tool, target, output: out.slice(0, 4000) });
  }
}

// ---------------- Output ----------------

function finding(severity, rule, extra = {}) {
  if (severity === "error") hasError = true;
  return { ts: new Date().toISOString(), kind: "a11y", severity, rule, ...extra };
}

function emit(obj) {
  if (OUT_NDJSON) console.log(JSON.stringify(obj));
  else console.log(`- [${obj.severity}] ${obj.rule} @ ${obj.target || ""}${obj.sample ? ` — ${obj.sample}` : ""}`);
}

function summarize(list) {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of list) if (counts[f.severity] != null) counts[f.severity]++;
  return { total: list.length, counts };
}

function printSummary(s) {
  console.log("\nA11y summary:");
  console.log(`  total=${s.total}  error=${s.counts.error}  warn=${s.counts.warn}  info=${s.counts.info}`);
}

// ---------------- Tiny utils ----------------

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
function clampInt(v, lo, hi, dflt) { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : dflt; }
function strip(s) { return String(s).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(); }
function trim(s) { return String(s).replace(/\s+/g, " ").trim().slice(0, 160); }
function attr(attrs, name) { const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(attrs || ""); return m ? m[1] : null; }
function hasBin(bin) { const which = process.platform === "win32" ? "where" : "which"; return spawnSync(which, [bin]).status === 0; }