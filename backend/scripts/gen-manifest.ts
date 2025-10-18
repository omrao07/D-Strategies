// scripts/gen manifest.ts
// Generate strategies/manifest.json by scanning your repository for strategy modules.
//
// Zero external deps. Works with Node + TypeScript via ts-node (ESM).
// Heuristics:
// - Looks for files under `strategies/` (default) and optionally extra dirs via --dir.
// - Extracts metadata from top-of-file JSDoc-style blocks or inline //@strategy tags.
// - If no metadata is present, infers name/id from filename.
// - Outputs a stable, sorted manifest with SHA-like content hash for each entry.
//
// Usage:
//   npx ts-node --esm scripts/gen\ manifest.ts
//   npx ts-node --esm scripts/gen\ manifest.ts --dir examples --out strategies/manifest.json --pretty
//
// Metadata schema (put this at the very top of your strategy file):
/**
 * @strategy
 * name: Trend Following
 * id: trend-following
 * description: A simple MA crossover example.
 * author: yourname
 * version: 1.0.0
 * markets: equities, futures
 * tags: momentum, crossover
 * params:
 *   fast: 20
 *   slow: 50
 * risk:
 *   maxLeverage: 2
 *   maxPositions: 10
 */

import { promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import crypto from "node:crypto"

type Dict<T = any> = Record<string, T>

type StrategyEntry = {
  id: string
  name: string
  path: string           // relative path from repo root (POSIX-style)
  description?: string
  author?: string
  version?: string
  markets?: string[]
  tags?: string[]
  params?: Dict<any>
  risk?: Dict<any>
  exports?: string[]     // exported symbols (best-effort)
  hash?: string          // content hash (sha1)
  updatedAt?: string     // ISO8601 of file mtime
}

type CliOptions = {
  out: string
  dirs: string[]
  pretty: boolean
  dry: boolean
  verbose: boolean
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, "..")

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const roots = opts.dirs.length ? opts.dirs : ["strategies"]
  const files = (await Promise.all(roots.map((d) => safeWalk(path.resolve(REPO_ROOT, d)))))
    .flat()
    .filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
    // ignore clearly non-strategy files
    .filter((f) => !/\.d\.ts$/.test(f))

  if (opts.verbose) log(`Scanning ${files.length} files...`)

  const entries: StrategyEntry[] = []
  for (const abs of files) {
    const rel = toPosix(path.relative(REPO_ROOT, abs))
    try {
      const text = await fs.readFile(abs, "utf8")
      const st = await fs.stat(abs)

      const meta = parseMeta(text)
      const id = meta.id || inferIdFromFilename(rel)
      const name = meta.name || humanizeId(id)

      const entry: StrategyEntry = {
        id,
        name,
        path: rel,
        description: meta.description,
        author: meta.author,
        version: meta.version,
        markets: meta.markets,
        tags: meta.tags,
        params: meta.params,
        risk: meta.risk,
        exports: parseExports(text),
        hash: sha1(text),
        updatedAt: st.mtime.toISOString(),
      }
      entries.push(entry)
    } catch (e: any) {
      warn(`Failed parsing ${rel}: ${e?.message || e}`)
    }
  }

  // Stable sort: by name, then path
  entries.sort((a, b) => (a.name || "").localeCompare(b.name || "") || a.path.localeCompare(b.path))

  const manifest = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    count: entries.length,
    entries,
  }

  const outAbs = path.resolve(REPO_ROOT, opts.out)
  const json = opts.pretty ? JSON.stringify(manifest, null, 2) + "\n" : JSON.stringify(manifest)

  if (opts.dry) {
    log("(dry-run) Would write manifest to " + toPosix(path.relative(REPO_ROOT, outAbs)))
    process.stdout.write(json)
    return
  }

  await fs.mkdir(path.dirname(outAbs), { recursive: true })
  await fs.writeFile(outAbs, json, "utf8")
  ok(`Wrote ${toPosix(path.relative(REPO_ROOT, outAbs))} with ${entries.length} entries`)
}

/* =========================
 * Parsing helpers
 * ========================= */

/** Parse top-of-file metadata comment or //@strategy lines. */
function parseMeta(source: string): Dict<any> {
  const meta: Dict<any> = {}
  const top = readTopComment(source) || readStrategyLines(source)
  if (!top) return meta
  // Parse simple "key: value" pairs; supports nested sections `params:` `risk:` with YAML-ish indentation.
  const lines = top.split(/\r?\n/).map((s) => s.replace(/^\s*\*\s?/, "").trim())
  let section: string | null = null
  for (let raw of lines) {
    if (!raw) continue
    // stop if comment body ends
    if (/^\*\//.test(raw)) break
    // detect section headers
    const sec = raw.match(/^([a-zA-Z][\w-]*):\s*$/)
    if (sec) {
      section = sec[1].toLowerCase()
      if (!meta[section]) meta[section] = {}
      continue
    }
    // key: value
    const kv = raw.match(/^([a-zA-Z][\w-]*):\s*(.+)$/)
    if (kv) {
      const key = kv[1].toLowerCase()
      const val = parseValue(kv[2])
      if (section && (section === "params" || section === "risk")) {
        meta[section][key] = val
      } else {
        meta[key] = val
      }
    }
  }
  // Normalize common keys
  if (meta.tags && typeof meta.tags === "string") meta.tags = splitCSV(meta.tags)
  if (meta.markets && typeof meta.markets === "string") meta.markets = splitCSV(meta.markets)
  return meta
}

/** Grab the very first block comment if it looks like a header. */
function readTopComment(src: string): string | null {
  const m = src.match(/^\s*\/\*\*([\s\S]*?)\*\//)
  return m ? m[1] : null
}

/** Fallback: collect consecutive //@strategy lines near the top. */
function readStrategyLines(src: string): string | null {
  const lines = src.split(/\r?\n/)
  const buff: string[] = []
  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    const ln = lines[i].trim()
    if (ln.startsWith("//@strategy")) {
      buff.push(ln.replace("//@strategy", "").trim())
    } else if (buff.length) {
      break
    }
  }
  return buff.length ? buff.join("\n") : null
}

/** Parse `export` names (best-effort). */
function parseExports(src: string): string[] {
  const names = new Set<string>()
  // export function NAME(
  for (const m of src.matchAll(/\bexport\s+function\s+([A-Za-z_]\w*)\s*\(/g)) names.add(m[1])
  // export const NAME =
  for (const m of src.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_]\w*)\s*=/g)) names.add(m[1])
  // export class NAME
  for (const m of src.matchAll(/\bexport\s+class\s+([A-Za-z_]\w*)\b/g)) names.add(m[1])
  // export default class|function NAME?
  if (/\bexport\s+default\b/.test(src)) names.add("default")
  return Array.from(names).sort()
}

/* =========================
 * Utilities
 * ========================= */

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { out: "strategies/manifest.json", dirs: [], pretty: false, dry: false, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--out" && argv[i + 1]) { opts.out = argv[++i]; continue }
    if (a === "--dir" && argv[i + 1]) { opts.dirs.push(argv[++i]); continue }
    if (a === "--pretty") { opts.pretty = true; continue }
    if (a === "--dry") { opts.dry = true; continue }
    if (a === "--verbose" || a === "-v") { opts.verbose = true; continue }
  }
  return opts
}

async function safeWalk(root: string): Promise<string[]> {
  const out: string[] = []
  async function rec(dir: string) {
    let ents: any[]
    try { ents = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        // Skip common build/dep dirs
        if (/node_modules|dist|\.git|\.next|coverage/.test(e.name)) continue
        await rec(p)
      } else if (e.isFile()) {
        out.push(p)
      }
    }
  }
  await rec(root)
  return out
}

function parseValue(raw: string): any {
  const s = raw.trim()
  // JSON-ish
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try { return JSON.parse(s) } catch {}
  }
  // booleans / numbers
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === "true"
  const num = Number(s)
  if (isFinite(num) && /^\-?\d+(\.\d+)?$/.test(s)) return num
  return s
}

function splitCSV(s: string): string[] {
  return s
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean)
}

function inferIdFromFilename(rel: string): string {
  const base = path.basename(rel).replace(/\.(ts|js)$/, "")
  return toSlug(base)
}
function humanizeId(id: string): string {
  return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}
function toSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
}

function sha1(text: string): string {
  return crypto.createHash("sha1").update(text, "utf8").digest("hex")
}

function toPosix(p: string): string { return p.split(path.sep).join("/") }

function log(s: string) { console.log(`▸ ${s}`) }
function ok(s: string) { console.log(`✔ ${s}`) }
function warn(s: string) { console.warn(`⚠ ${s}`) }

if (import.meta.url === `file://${__filename}`) {
  main().catch((e) => {
    console.error("gen manifest failed:", e)
    process.exit(1)
  })
}
