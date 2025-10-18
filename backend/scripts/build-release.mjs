// scripts/buils-release.mjs
// One-shot release packager (Node core only; no external deps).
// - Preflight: git clean check, lockfile present, optional code-sign policy
// - Build: runs `npm run build` (configurable)
// - Collects artifacts from ./dist (configurable)
// - Creates versioned release dir + tarball
// - Writes MANIFEST.json + SHA256 CHECKSUMS.txt
// - (Optional) GPG sign the tarball if `--sign` and gpg available
//
// Usage:
//   node scripts/buils-release.mjs
//   node scripts/buils-release.mjs --build "npm run build" --out ./RELEASES --sign
//   node scripts/buils-release.mjs --version 1.2.3 --name jarvis
//
// Exit codes: 0 ok; 1 on error
/* eslint-disable no-console */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---------------- CLI ----------------

const args = parseArgs(process.argv.slice(2));
const BUILD_CMD = args.build || "npm run build";
const OUT_DIR = path.resolve(args.out || path.join(ROOT, "RELEASES"));
const FORCE = flag(args.force);
const SIGN = flag(args.sign);
const APP_NAME = args.name || pkgField("name") || "app";
const VERSION = args.version || pkgField("version") || guessVersion();
const ARTIFACT_DIR = path.resolve(args.artifacts || path.join(ROOT, "dist"));
const EXTRA = parseList(args.extra); // comma-separated extra paths to include

// ---------------- Run ----------------

(async function main() {
  try {
    header("Release Builder");

    preflight();

    // 1) Build
    step("Build");
    run(BUILD_CMD, { cwd: ROOT });

    // 2) Collect artifacts
    step("Collect Artifacts");
    const releaseId = `${APP_NAME}-v${VERSION}-${ymdHis()}`;
    const relDir = path.join(OUT_DIR, releaseId);
    const binDir = path.join(relDir, "artifacts");
    ensureDir(binDir);

    copyTree(ARTIFACT_DIR, binDir);
    for (const p of EXTRA) copyAny(path.resolve(ROOT, p), path.join(relDir, path.basename(p)));

    // 3) MANIFEST + CHECKSUMS
    step("Manifest & Checksums");
    const files = listFiles(relDir).map(f => path.relative(relDir, f));
    const manifest = {
      name: APP_NAME,
      version: VERSION,
      releaseId,
      createdAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      commit: gitRev() || undefined,
      files,
      policy: {
        codeSigningRequired: readPolicyFlag(),
      },
    };
    writeJSON(path.join(relDir, "MANIFEST.json"), manifest);

    const checksums = await sha256All(files.map(f => path.join(relDir, f)));
    fs.writeFileSync(path.join(relDir, "CHECKSUMS.txt"), checksums.join("\n") + "\n");

    // 4) Tarball
    step("Archive");
    ensureDir(OUT_DIR);
    const tarName = `${releaseId}.tar`;
    const tgzName = `${releaseId}.tar.gz`;
    // create .tar then gzip — pure Node (no system tar) so it stays portable.
    // For simplicity, we’ll shell out to `tar` if available; else fallback to naive zipless pack.
    if (hasBin("tar")) {
      run(`tar -cf ${esc(tarName)} -C ${esc(OUT_DIR)} ${esc(releaseId)}`, { cwd: OUT_DIR });
      if (hasBin("gzip")) run(`gzip -f ${esc(tarName)}`, { cwd: OUT_DIR });
      else console.warn("gzip not found; leaving .tar uncompressed");
    } else {
      // Fallback: simple directory copy as .tar placeholder (not a real tar)
      // Consumers should prefer having `tar` available.
      console.warn("tar not found; writing directory as-is (no tarball).");
    }

    // 5) Optional signing
    if (SIGN) {
      step("Sign");
      const artifact = fs.existsSync(path.join(OUT_DIR, tgzName))
        ? path.join(OUT_DIR, tgzName)
        : fs.existsSync(path.join(OUT_DIR, tarName.replace(/\.gz$/, "")))
          ? path.join(OUT_DIR, tarName.replace(/\.gz$/, ""))
          : relDir; // last resort: sign the folder manifest

      if (!hasBin("gpg")) {
        console.warn("gpg not found; skipping signing.");
      } else {
        const sig = `${artifact}.sig`;
        run(`gpg --batch --yes --armor --detach-sign -o ${esc(sig)} ${esc(artifact)}`, { cwd: ROOT });
        console.log("signed:", sig);
      }
    }

    // 6) Summary
    step("Done");
    console.log("Release:", releaseId);
    console.log("Output dir:", OUT_DIR);
    if (fs.existsSync(path.join(OUT_DIR, tgzName))) {
      console.log("Artifact:", path.join(OUT_DIR, tgzName));
    } else if (fs.existsSync(path.join(OUT_DIR, tarName.replace(/\.gz$/, "")))) {
      console.log("Artifact:", path.join(OUT_DIR, tarName.replace(/\.gz$/, "")));
    } else {
      console.log("Folder artifact:", relDir);
    }
  } catch (e) {
    console.error("\n[ERROR]", e?.message || e);
    process.exit(1);
  }
})();

// ---------------- Preflight ----------------

function preflight() {
  step("Preflight");

  // lockfile
  const hasLock = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"].some(f => fs.existsSync(path.join(ROOT, f)));
  if (!hasLock) throw new Error("No lockfile found (package-lock.json/pnpm-lock.yaml/yarn.lock).");

  // git status clean (unless --force)
  if (!FORCE) {
    const dirty = run("git status --porcelain", { cwd: ROOT, silent: true }).trim();
    if (dirty) throw new Error("Git working directory not clean. Commit/stash or pass --force.");
  }

  // code signing policy (optional)
  const policyFile = path.join(ROOT, "policies", "code-signing.md");
  if (!fs.existsSync(policyFile)) {
    console.warn("Code signing policy not found (policies/code-signing.md).");
  }

  // build script check
  const pkg = readJSON(path.join(ROOT, "package.json"));
  if (!pkg?.scripts?.build) {
    console.warn("No npm `build` script found. Using default command anyway:", BUILD_CMD);
  }

  ensureDir(OUT_DIR);
}

// ---------------- Helpers ----------------

function step(s) { console.log(`\n== ${s} ==`); }
function header(t) { console.log(`\n=== ${t} (${APP_NAME} v${VERSION}) ===`); }

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.includes("=") ? a.slice(2).split("=") : [a.slice(2), argv[i + 1]?.startsWith("--") ? "true" : argv[++i]];
      out[k] = v ?? "true";
    }
  }
  return out;
}

function flag(v) { return v === "true" || v === true || v === "1" || v === 1; }
function parseList(v) { return v ? String(v).split(",").map(s => s.trim()).filter(Boolean) : []; }
function esc(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

function pkgField(k) {
  try { const p = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")); return p?.[k]; }
  catch { return null; }
}

function guessVersion() {
  const tag = run("git describe --tags --always --dirty", { cwd: ROOT, silent: true }).trim();
  if (tag) return tag.replace(/^v/, "");
  return "0.0.0-dev";
}

function gitRev() {
  return run("git rev-parse --short HEAD", { cwd: ROOT, silent: true }).trim() || null;
}

function run(cmd, opts = {}) {
  const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", cmd] : ["-c", cmd];
  const res = spawnSync(shell, args, { cwd: opts.cwd || process.cwd(), stdio: opts.silent ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8" });
  if (opts.silent) {
    if (res.status !== 0) throw new Error(`Command failed: ${cmd}\n${res.stderr || res.stdout || ""}`);
    return res.stdout || "";
  }
  if (res.status !== 0) throw new Error(`Command failed: ${cmd}`);
  return res.stdout || "";
}

function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function writeJSON(p, obj) { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); console.log("wrote", p); }

function copyTree(src, dst) {
  if (!fs.existsSync(src)) {
    console.warn("artifact dir not found:", src);
    return;
  }
  const st = fs.statSync(src);
  if (st.isFile()) { copyAny(src, dst); return; }
  ensureDir(dst);
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st2 = fs.lstatSync(s);
    if (st2.isSymbolicLink()) continue;
    if (st2.isDirectory()) copyTree(s, d);
    else if (st2.isFile()) copyAny(s, d);
  }
}

function copyAny(src, dst) {
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  console.log("copy:", rel(src), "->", rel(dst));
}

function rel(p) { return path.relative(ROOT, p); }

function listFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(p);
    }
  })(dir);
  return out;
}

async function sha256All(paths) {
  const lines = [];
  for (const p of paths) {
    const hash = await sha256File(p);
    lines.push(`${hash}  ${path.basename(p)}`);
  }
  return lines;
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const rs = fs.createReadStream(p);
    rs.on("error", reject);
    rs.on("data", chunk => h.update(chunk));
    rs.on("end", () => resolve(h.digest("hex")));
  });
}

function hasBin(bin) {
  const which = process.platform === "win32" ? "where" : "which";
  const res = spawnSync(which, [bin], { encoding: "utf8" });
  return res.status === 0;
}

function ymdHis(d = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function readPolicyFlag() {
  try {
    const p = path.join(ROOT, "policies", "code-signing.md");
    const s = fs.readFileSync(p, "utf8");
    return /required/i.test(s);
  } catch { return false; }
}