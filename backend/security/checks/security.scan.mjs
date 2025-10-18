// checks/security.scan.mjs
// Lightweight security scanner for your repo (Node core only; no external deps).
// - Scans workspace for likely secrets (regex + entropy)
// - Checks package.json for risky deps (git URLs, postinstall scripts)
// - Verifies lockfile present & .env ignored
// - (Optional) Runs `npm audit --json` and summarizes
// - Emits human text by default, or NDJSON with --ndjson
//
// Usage:
//   node checks/security.scan.mjs
//   node checks/security.scan.mjs --ndjson
//   node checks/security.scan.mjs --path ./ --max-bytes 1000000 --no-audit
//
// Exit codes:
//   0  = clean or only low findings
//   1  = medium/high/critical findings
//
// NOTE: This script uses only Node core (fs, path, crypto, child_process).

/* eslint-disable no-console */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawnSync } from "child_process";

// ------------------------- Config & CLI -------------------------

const args = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(args.path || process.cwd());
const IGNORE_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next", ".turbo", "out", ".cache", "coverage", ".venv"
]);
const SCAN_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml", ".env", ".txt", ".html", ".css"]);
const MAX_BYTES = clampInt(args["max-bytes"], 0, 50_000_000, 5_000_000); // cap read size per file (default 5MB)
const RUN_AUDIT = !flagOff(args["no-audit"]);
const OUTPUT_NDJSON = !!args["ndjson"];

const SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"];

// Secret patterns (add as needed)
const SECRET_REGEXES = [
  { id: "aws-access-key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, sev: "high", msg: "AWS Access Key ID format" },
  { id: "aws-secret", re: /\baws(.{0,10})?(secret|key)\b.{0,3}[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi, sev: "high", msg: "AWS secret-looking value" },
  { id: "gcp-key", re: /"type"\s*:\s*"service_account"[\s\S]*?"private_key_id"\s*:\s*"[0-9a-f]{8,}"/gi, sev: "high", msg: "GCP service account JSON" },
  { id: "private-key", re: /-----BEGIN (RSA|DSA|EC|OPENSSH|PGP) PRIVATE KEY-----[\s\S]+?-----END \1 PRIVATE KEY-----/g, sev: "high", msg: "Private key block" },
  { id: "generic-token", re: /\b(bearer|token|api[-_ ]?key|auth|secret)\b.{0,20}[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/gi, sev: "medium", msg: "Generic token-ish assignment" },
  { id: "password", re: /\b(pass|password)\b.{0,10}[:=]\s*['"].{8,}['"]/gi, sev: "medium", msg: "Password-like assignment" },
  { id: "slack-webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]{9,}\/[A-Z0-9]{9,}\/[A-Za-z0-9]{24,}/g, sev: "high", msg: "Slack webhook URL" },
  { id: "gh-token", re: /\bghp_[A-Za-z0-9]{36}\b/g, sev: "high", msg: "GitHub PAT" },
];

// Entropy scanning config
const ENTROPY_MIN_LEN = 20;
const ENTROPY_THRESHOLD = 4.0; // Shannon bits/char approx; 4-5 is quite random-looking

// ------------------------- Collect findings -------------------------

/** @type {Array<{severity:string, rule:string, file:string, line:number, snippet:string}>} */
const findings = [];

/** Emit finding */
function report(severity, rule, file, line, snippet) {
  const rec = { severity, rule, file: path.relative(ROOT, file), line, snippet: trimSnippet(snippet) };
  findings.push(rec);
  if (OUTPUT_NDJSON) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), kind: "finding", ...rec }));
  }
}

// ------------------------- Scanning -------------------------

/** Recursively walk files under root */
function *walk(dir) {
  const list = safeReadDir(dir);
  for (const name of list) {
    if (!name) continue;
    if (IGNORE_DIRS.has(name)) continue;
    const f = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(f); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { yield* walk(f); continue; }
    if (!st.isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    if (SCAN_EXT.size && !SCAN_EXT.has(ext)) continue;
    yield f;
  }
}

/** Scan a single file for secrets and entropy */
function scanFile(file) {
  let buf;
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_BYTES) return; // skip large files
    buf = fs.readFileSync(file);
  } catch { return; }

  // best effort UTF-8 (do not crash on binary)
  let txt = buf.toString("utf8");

  // quick ignore for minified blobs (few newlines, huge)
  const nlRatio = (txt.split("\n").length / Math.max(1, txt.length));
  if (nlRatio < 1/2000 && txt.length > 200_000) return;

  // RegEx based secrets
  for (const rule of SECRET_REGEXES) {
    let m;
    while ((m = rule.re.exec(txt)) !== null) {
      const lineNo = 1 + (txt.slice(0, m.index).match(/\n/g)?.length || 0);
      report(rule.sev, rule.id, file, lineNo, m[0]);
      // guard against infinite loop on zero-width
      if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
    }
    rule.re.lastIndex = 0; // reset for next file
  }

  // Entropy windows (very simple): look at long tokens like base64-ish
  const tokens = txt.match(/[A-Za-z0-9+/_=-]{20,}/g) || [];
  for (const token of tokens) {
    if (token.length < ENTROPY_MIN_LEN) continue;
    if (looksLikePath(token)) continue;
    const H = shannon(token);
    if (H >= ENTROPY_THRESHOLD) {
      const idx = txt.indexOf(token);
      const lineNo = 1 + (txt.slice(0, idx).match(/\n/g)?.length || 0);
      report("medium", "high-entropy-token", file, lineNo, token.slice(0, 120));
    }
  }
}

// ------------------------- Project checks -------------------------

function checkLockfile() {
  const hasNpm = fs.existsSync(path.join(ROOT, "package-lock.json"));
  const hasPnpm = fs.existsSync(path.join(ROOT, "pnpm-lock.yaml"));
  const hasYarn = fs.existsSync(path.join(ROOT, "yarn.lock"));
  if (!hasNpm && !hasPnpm && !hasYarn) {
    report("medium", "lockfile-missing", ROOT, 0, "No lockfile found (package-lock.json / pnpm-lock.yaml / yarn.lock)");
  }
}

function checkGitignoreEnv() {
  const gi = findGitignore(ROOT);
  if (!gi) {
    report("low", "gitignore-missing", ROOT, 0, ".gitignore not found; ensure .env* and secrets are excluded");
    return;
  }
  let content = "";
  try { content = fs.readFileSync(gi, "utf8"); } catch {}
  const hasEnv = /(^|\n)\.env(\..+)?(\n|$)/.test(content);
  if (!hasEnv) {
    report("low", "env-not-ignored", gi, 1, "Add .env* to .gitignore");
  }
}

function checkPackageJson() {
  const pkgPath = path.join(ROOT, "package.json");
  if (!fs.existsSync(pkgPath)) return;
  let pkg; try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); } catch { return; }

  // Check scripts for postinstall
  const scripts = pkg.scripts || {};
  for (const [name, val] of Object.entries(scripts)) {
    if (/postinstall/i.test(name)) {
      report("low", "postinstall-script", pkgPath, 1, `script "${name}": ${String(val).slice(0, 140)}`);
    }
  }

  // Check deps for git URLs or head refs
  const sections = ["dependencies", "devDependencies", "optionalDependencies"];
  for (const sec of sections) {
    const deps = pkg[sec] || {};
    for (const [dep, ver] of Object.entries(deps)) {
      const v = String(ver);
      if (/^git\+|^github:|^[^:]+:\/\/github\.com\//i.test(v)) {
        report("medium", "git-url-dependency", pkgPath, 1, `${sec}:${dep} -> ${v}`);
      }
      if (/#(main|master|HEAD)$/i.test(v)) {
        report("high", "head-branch-dependency", pkgPath, 1, `${sec}:${dep} -> ${v}`);
      }
      if (/file:|link:/.test(v)) {
        report("low", "local-path-dependency", pkgPath, 1, `${sec}:${dep} -> ${v}`);
      }
    }
  }
}

function runNpmAudit() {
  if (!RUN_AUDIT) return;
  if (!fs.existsSync(path.join(ROOT, "package.json"))) return;

  // Run: npm audit --json --production
  const res = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["audit", "--json", "--production"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, NO_UPDATE_NOTIFIER: "1", NPM_CONFIG_FUND: "false", NPM_CONFIG_AUDIT_LEVEL: "low" },
  });

  if (res.error || res.status === null) {
    report("info", "npm-audit-error", ROOT, 0, String(res.error || "failed to execute npm"));
    return;
  }

  let json;
  try { json = JSON.parse(res.stdout || "{}"); } catch {
    report("info", "npm-audit-parse", ROOT, 0, "Could not parse npm audit output");
    return;
  }

  // npm v9/v10 formats differ; try to summarize generally
  const advisories = extractAuditProblems(json);
  for (const adv of advisories) {
    report(adv.severity, "npm-audit", adv.module || "dependency", 0, `${adv.title || adv.url || ""}`.trim());
  }
}

function extractAuditProblems(json) {
  const out = [];
  // npm v7+ has "vulnerabilities" and "advisories" or "auditReportVersion"
  if (json?.vulnerabilities) {
    for (const [name, v] of Object.entries(json.vulnerabilities)) {
      const sev = v.severity || "low";
      const via = Array.isArray(v.via) ? v.via : [];
      const title = via.map(x => (typeof x === "string" ? x : x?.title)).filter(Boolean).join("; ");
      out.push({ module: name, severity: sev, title });
    }
  } else if (json?.advisories) {
    for (const adv of Object.values(json.advisories)) {
      out.push({
        module: adv.module_name,
        severity: adv.severity || "low",
        title: adv.title || adv.url || "",
        url: adv.url,
      });
    }
  }
  return out;
}

// ------------------------- Run -------------------------

function main() {
  info("scan-start", { root: ROOT });

  // Walk files
  for (const f of walk(ROOT)) {
    try { scanFile(f); } catch { /* ignore per-file errors */ }
  }

  // Project-level checks
  checkLockfile();
  checkGitignoreEnv();
  checkPackageJson();
  runNpmAudit();

  // Summarize
  const summary = summarize(findings);
  if (OUTPUT_NDJSON) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), kind: "summary", ...summary }));
  } else {
    printSummary(summary, findings);
  }

  // Exit code
  const worst = summary.worstSeverity;
  if (["medium", "high", "critical"].includes(worst)) process.exit(1);
  process.exit(0);
}

// ------------------------- Helpers -------------------------

function safeReadDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.includes("=") ? a.slice(2).split("=") : [a.slice(2), argv[i + 1]?.startsWith("--") ? "true" : argv[++i]];
      out[k] = v ?? true;
    }
  }
  return out;
}

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

function flagOff(x) {
  if (x == null) return false;
  const s = String(x).toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function trimSnippet(s) {
  let t = String(s ?? "");
  t = t.replace(/\s+/g, " ").slice(0, 200);
  return t;
}

function info(msg, extra) {
  if (OUTPUT_NDJSON) console.log(JSON.stringify({ ts: new Date().toISOString(), kind: "info", msg, ...extra }));
  else console.log(`[info] ${msg}`, extra ? JSON.stringify(extra) : "");
}

function shannon(str) {
  // Shannon entropy per char (bits/char)
  if (!str || !str.length) return 0;
  const freq = new Map();
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    freq.set(ch, (freq.get(ch) || 0) + 1);
  }
  let H = 0;
  for (const c of freq.values()) {
    const p = c / str.length;
    H -= p * Math.log2(p);
  }
  return H;
}

function looksLikePath(s) {
  return /[\/\\]/.test(s) || s.includes(".") || s.length > 2000;
}

function findGitignore(start) {
  const p = path.join(start, ".gitignore");
  if (fs.existsSync(p)) return p;
  const up = path.dirname(start);
  if (up !== start) return findGitignore(up);
  return null;
}

function summarize(list) {
  const counts = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const f of list) { if (counts[f.severity] != null) counts[f.severity]++; }
  const worst = SEVERITY_ORDER.reduce((acc, s) => (counts[s] > 0 ? s : acc), "info");
  return { counts, total: list.length, worstSeverity: worst };
}

function printSummary(summary, list) {
  console.log("\n=== Security Scan Summary ===");
  console.log(`Root: ${ROOT}`);
  console.log(`Files scanned: (filtered by extensions), max file size: ${fmtBytes(MAX_BYTES)}`);
  console.log(`Findings: total=${summary.total}  info=${summary.counts.info} low=${summary.counts.low} medium=${summary.counts.medium} high=${summary.counts.high} critical=${summary.counts.critical}`);
  if (list.length) {
    console.log("\nTop findings:");
    const top = list.slice(0, 50);
    for (const f of top) {
      console.log(` - [${f.severity}] ${f.rule} @ ${f.file}:${f.line} — ${f.snippet}`);
    }
    if (list.length > top.length) console.log(` ... and ${list.length - top.length} more.`);
  } else {
    console.log("No findings. ✔️");
  }
  console.log("\nRecommendations:");
  if (summary.counts.high || summary.counts.critical) {
    console.log(" - Rotate any exposed credentials immediately; purge secrets from history/logs.");
  }
  if (summary.counts.medium) {
    console.log(" - Review medium findings (high-entropy tokens, git URL deps, missing lockfile).");
  }
  console.log(" - Ensure `.env*` files are gitignored; enable redaction in your logger.");
  console.log(" - Consider adding this script to CI: `node checks/security.scan.mjs --ndjson --no-audit`");
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n/1024).toFixed(1)} KB`;
  return `${(n/1024/1024).toFixed(1)} MB`;
}

// ------------------------- Execute -------------------------
main();