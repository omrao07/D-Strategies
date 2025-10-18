// scripts/security-audit.mjs
// One-stop security audit runner (Node core only; zero deps).
// Combines several static checks in one pass:
//  - Repo hygiene: lockfile present, git clean, .gitignore covers .env*
//  - Secrets scan: regex + high-entropy tokens
//  - package.json checks: risky deps (git URLs, HEAD refs), postinstall hooks
//  - Optional: `npm audit --json` summary
//  - Policy presence: code signing, dependency policy, incident response
//  - Config sanity: security/rbac.ts exists, redact util present (if configured)
// Output: human text (default) or --json / --ndjson
//
// Usage:
//   node scripts/security-audit.mjs
//   node scripts/security-audit.mjs --path . --no-audit --ndjson
//   node scripts/security-audit.mjs --max-bytes 5000000 --fail-on low
//
// Exit codes:
//   0 = no findings at or above fail-threshold
//   1 = findings at or above threshold (default: medium)
//
// NOTE: This script is self-contained. It does not import checks/security.scan.mjs,
// but it performs a similar scan inlined here for convenience.

/* eslint-disable no-console */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawnSync } from "child_process";

// ---------------- CLI ----------------

const args = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(args.path || process.cwd());
const RUN_AUDIT = !truthy(args["no-audit"]);
const OUTPUT_NDJSON = !!args["ndjson"];
const OUTPUT_JSON = !!args["json"];
const MAX_BYTES = clampInt(args["max-bytes"], 0, 50_000_000, 5_000_000);
const FAIL_ON = normSev(args["fail-on"] || "medium"); // info|low|medium|high|critical

const IGNORE_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next", ".turbo", "out", ".cache", "coverage",
  ".venv", ".idea", ".vscode"
]);
const SCAN_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".yaml", ".yml", ".env", ".html", ".txt", ".css"]);

// severity order
const SEV_ORDER = ["info", "low", "medium", "high", "critical"];

// ---------------- Findings store ----------------

/** @type {Array<{severity:string, rule:string, file?:string, line?:number, details?:string}>} */
const findings = [];
const emit = (sev, rule, file, line, details) => {
  const f = { severity: sev, rule, ...(file ? { file: rel(file) } : {}), ...(line ? { line } : {}), ...(details ? { details: String(details).slice(0, 300) } : {}) };
  findings.push(f);
  if (OUTPUT_NDJSON) console.log(JSON.stringify({ ts: new Date().toISOString(), kind: "finding", ...f }));
};

// ---------------- Run ----------------

(async function main() {
  info("audit-start", { root: ROOT });

  // 1) Repo hygiene
  checkLockfile();
  checkGitignoreEnv();
  checkGitClean();

  // 2) Policies present
  checkPolicies();

  // 3) package.json hygiene
  checkPackageJson();

  // 4) Codebase scan (secrets + entropy)
  scanTree();

  // 5) Optional: npm audit
  if (RUN_AUDIT) await runNpmAudit();

  // 6) Summary & exit
  const summary = summarize(findings);
  if (OUTPUT_NDJSON) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), kind: "summary", ...summary }));
  } else if (OUTPUT_JSON) {
    console.log(JSON.stringify({ root: ROOT, ...summary, findings }, null, 2));
  } else {
    printSummary(summary, findings);
  }

  // decide exit
  const fail = SEV_ORDER.indexOf(summary.worst) >= SEV_ORDER.indexOf(FAIL_ON);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error("[fatal]", e?.stack || String(e));
  process.exit(1);
});

// ---------------- Checks ----------------

function checkLockfile() {
  const has = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"].some(f => fs.existsSync(path.join(ROOT, f)));
  if (!has) emit("medium", "lockfile-missing", ROOT, 0, "No lockfile found");
}

function checkGitignoreEnv() {
  const gi = findUp(".gitignore", ROOT);
  if (!gi) { emit("low", "gitignore-missing", ROOT, 0, "Add .gitignore and ignore .env*"); return; }
  const s = safeRead(gi);
  if (!/(^|\n)\.env(\..+)?(\n|$)/.test(s)) emit("low", "env-not-ignored", gi, 1, "Add .env* to .gitignore");
}

function checkGitClean() {
  const res = spawnSync(bin("sh"), ["-c", "git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git status --porcelain || true"], { cwd: ROOT, encoding: "utf8" });
  const dirty = (res.stdout || "").trim();
  if (dirty) emit("info", "git-dirty", ROOT, 0, "Working directory has uncommitted changes");
}

function checkPolicies() {
  const req = [
    ["policies/code-signing.md", "policy-code-signing-missing", "high"],
    ["policies/dependency-policy.md", "policy-dependency-missing", "medium"],
    ["policies/incident-response.md", "policy-incident-missing", "medium"],
    ["security/secrets.md", "policy-secrets-missing", "medium"],
    ["security/threat-model.md", "policy-threat-model-missing", "low"],
    ["security/rbac.ts", "rbac-module-missing", "medium"],
  ];
  for (const [p, rule, sev] of req) {
    if (!fs.existsSync(path.join(ROOT, p))) emit(sev, rule, path.join(ROOT, p));
  }
}

// package.json hygiene and risky deps
function checkPackageJson() {
  const pkgPath = path.join(ROOT, "package.json");
  if (!fs.existsSync(pkgPath)) { emit("info", "package-json-missing", pkgPath); return; }
  let pkg; try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); } catch { emit("low", "package-json-parse-error", pkgPath); return; }

  // postinstall hook
  const scripts = pkg.scripts || {};
  for (const [k, v] of Object.entries(scripts)) {
    if (/postinstall/i.test(k)) emit("low", "postinstall-script", pkgPath, 0, `script=${k}: ${String(v).slice(0,140)}`);
  }

  // risky deps
  const sections = ["dependencies", "devDependencies", "optionalDependencies"];
  for (const sec of sections) {
    const deps = pkg[sec] || {};
    for (const [dep, ver] of Object.entries(deps)) {
      const v = String(ver);
      if (/^git\+|^github:|^[a-z]+:\/\/github\.com\//i.test(v)) emit("medium", "git-url-dependency", pkgPath, 0, `${sec}:${dep} -> ${v}`);
      if (/#(main|master|HEAD)$/i.test(v)) emit("high", "head-branch-dependency", pkgPath, 0, `${sec}:${dep} -> ${v}`);
      if (/file:|link:/.test(v)) emit("low", "local-path-dependency", pkgPath, 0, `${sec}:${dep} -> ${v}`);
    }
  }
}

// Walk tree and scan for secrets/entropy
function scanTree() {
  const secretRules = [
    { id: "aws-access-key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, sev: "high" },
    { id: "aws-secret", re: /\baws(.{0,10})?(secret|key)\b.{0,3}[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi, sev: "high" },
    { id: "gcp-key", re: /"type"\s*:\s*"service_account"[\s\S]*?"private_key_id"\s*:\s*"[0-9a-f]{8,}"/gi, sev: "high" },
    { id: "private-key", re: /-----BEGIN (RSA|DSA|EC|OPENSSH|PGP) PRIVATE KEY-----[\s\S]+?-----END \1 PRIVATE KEY-----/g, sev: "critical" },
    { id: "generic-token", re: /\b(bearer|token|api[-_ ]?key|auth|secret)\b.{0,20}[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/gi, sev: "medium" },
    { id: "password", re: /\b(pass|password)\b.{0,10}[:=]\s*['"].{8,}['"]/gi, sev: "medium" },
    { id: "slack-webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]{9,}\/[A-Z0-9]{9,}\/[A-Za-z0-9]{24,}/g, sev: "high" },
    { id: "gh-token", re: /\bghp_[A-Za-z0-9]{36}\b/g, sev: "high" },
  ];
  const ENTROPY_MIN_LEN = 20;
  const ENTROPY_THRESHOLD = 4.0; // Shannon bits/char

  for (const f of walk(ROOT)) {
    let buf;
    try {
      const st = fs.statSync(f);
      if (st.size > MAX_BYTES) continue;
      buf = fs.readFileSync(f);
    } catch { continue; }
    const txt = buf.toString("utf8");

    // regex-based
    for (const rule of secretRules) {
      let m;
      while ((m = rule.re.exec(txt)) !== null) {
        const line = 1 + (txt.slice(0, m.index).match(/\n/g)?.length || 0);
        emit(rule.sev, rule.id, f, line, m[0]);
        if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
      }
      rule.re.lastIndex = 0;
    }

    // entropy tokens
    const tokens = txt.match(/[A-Za-z0-9+/_=-]{20,}/g) || [];
    for (const t of tokens) {
      if (t.length < ENTROPY_MIN_LEN) continue;
      if (/[\/\\]/.test(t) || t.includes(".") || t.length > 2000) continue; // likely path or blob
      const H = shannon(t);
      if (H >= ENTROPY_THRESHOLD) {
        const idx = txt.indexOf(t);
        const line = 1 + (txt.slice(0, idx).match(/\n/g)?.length || 0);
        emit("medium", "high-entropy-token", f, line, t.slice(0, 120));
      }
    }
  }
}

// npm audit summary (best effort)
async function runNpmAudit() {
  if (!fs.existsSync(path.join(ROOT, "package.json"))) {
    emit("info", "npm-audit-skip", ROOT, 0, "package.json missing");
    return;
  }
  const binName = process.platform === "win32" ? "npm.cmd" : "npm";
  const res = spawnSync(binName, ["audit", "--json", "--production"], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, NO_UPDATE_NOTIFIER: "1", NPM_CONFIG_FUND: "false", NPM_CONFIG_AUDIT_LEVEL: "low" },
  });
  if (res.error || res.status === null) {
    emit("info", "npm-audit-error", ROOT, 0, String(res.error || "spawn failed"));
    return;
  }
  let json;
  try { json = JSON.parse(res.stdout || "{}"); } catch { emit("info", "npm-audit-parse", ROOT, 0, "could not parse output"); return; }
  const advisories = extractAuditProblems(json);
  for (const adv of advisories) {
    emit(adv.severity || "low", "npm-audit", path.join(ROOT, "package.json"), 0, `${adv.module || ""} ${adv.title || ""}`);
  }
}

function extractAuditProblems(json) {
  const out = [];
  if (json?.vulnerabilities) {
    for (const [name, v] of Object.entries(json.vulnerabilities)) {
      const via = Array.isArray(v.via) ? v.via : [];
      const title = via.map(x => (typeof x === "string" ? x : x?.title)).filter(Boolean).join("; ");
      out.push({ module: name, severity: v.severity || "low", title });
    }
  } else if (json?.advisories) {
    for (const adv of Object.values(json.advisories)) {
      out.push({ module: adv.module_name, severity: adv.severity || "low", title: adv.title || adv.url || "" });
    }
  }
  return out;
}

// ---------------- Utils ----------------

function* walk(dir) {
  let list;
  try { list = fs.readdirSync(dir); } catch { return; }
  for (const name of list) {
    if (IGNORE_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    let st; try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { yield* walk(p); continue; }
    if (!st.isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    if (SCAN_EXT.size && !SCAN_EXT.has(ext)) continue;
    yield p;
  }
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

function truthy(v) { const s = String(v ?? "").toLowerCase(); return s === "1" || s === "true" || s === "yes"; }
function clampInt(v, lo, hi, dflt) { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : dflt; }
function shannon(str) { const f = new Map(); for (const ch of str) f.set(ch, (f.get(ch) || 0) + 1); let H = 0; for (const c of f.values()) { const p = c / str.length; H -= p * Math.log2(p); } return H; }
function safeRead(p) { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } }
function findUp(name, start) { let dir = start; while (true) { const p = path.join(dir, name); if (fs.existsSync(p)) return p; const up = path.dirname(dir); if (up === dir) return null; dir = up; } }
function rel(p) { return path.relative(ROOT, p); }
function normSev(s) { const x = String(s || "").toLowerCase(); return SEV_ORDER.includes(x) ? x : "medium"; }
function bin(sh) { return process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : sh; }

function summarize(list) {
  const counts = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  let worst = "info";
  for (const f of list) {
    if (counts[f.severity] != null) counts[f.severity]++;
  }
  for (const s of SEV_ORDER.slice().reverse()) {
    if (counts[s] > 0) { worst = s; break; }
  }
  return {
    total: list.length,
    counts,
    worst,
    failOn: FAIL_ON,
    recommendation: recommendation(counts),
  };
}

function recommendation(counts) {
  const tips = [];
  if (counts.critical || counts.high) tips.push("Rotate exposed credentials, purge from history, audit access.");
  if (counts.medium) tips.push("Fix git URL/HEAD deps, remove postinstall hooks, review high-entropy tokens.");
  if (counts.low) tips.push("Ensure .env* is ignored, lockfile present, clean working tree.");
  if (!tips.length) tips.push("No material risks detected.");
  return tips;
}

function printSummary(summary, list) {
  console.log("\n=== Security Audit Summary ===");
  console.log(`Root: ${ROOT}`);
  console.log(`Findings: total=${summary.total}  info=${summary.counts.info} low=${summary.counts.low} medium=${summary.counts.medium} high=${summary.counts.high} critical=${summary.counts.critical}`);
  console.log(`Worst severity: ${summary.worst} (fail-on: ${summary.failOn})`);
  if (list.length) {
    console.log("\nTop findings:");
    const top = list.slice(0, 50);
    for (const f of top) {
      const loc = f.file ? `${f.file}${f.line ? ":" + f.line : ""}` : "";
      console.log(` - [${f.severity}] ${f.rule}${loc ? " @ " + loc : ""}${f.details ? " — " + f.details : ""}`);
    }
    if (list.length > top.length) console.log(` ... and ${list.length - top.length} more.`);
  } else {
    console.log("No findings. ✔️");
  }
  console.log("\nRecommendations:");
  for (const tip of summary.recommendation) console.log(" - " + tip);
  console.log("");
}