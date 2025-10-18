// scripts/snapshot-rotate.ts
// Rotate snapshot files in a directory.
// - Keeps the newest N snapshots (by mtime) and/or those not older than X days
// - Optionally gzip-compress old snapshots (idempotent; skips already .gz)
// - Can tag the "latest" symlink to the newest file
// - Dry-run and verbose modes
//
// Works with Node ESM + ts-node.
// Usage examples:
//   npx ts-node --esm scripts/snapshot-rotate.ts --dir data/snapshots --pattern "*.parquet" --keep 14 --compress --latest latest.parquet
//   npx ts-node --esm scripts/snapshot-rotate.ts --dir backups --pattern "snap-*.json" --max-age 30 --dry --verbose
//
// Exit codes:
//   0 success, 1 rotated with warnings, 2 fatal error.

import { promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { createGzip } from "node:zlib"
import { pipeline } from "node:stream/promises"
import { createReadStream, createWriteStream } from "node:fs"

type Cli = {
  dir: string
  pattern: string
  keep?: number
  maxAgeDays?: number
  compress?: boolean
  latest?: string // symlink (or copy on Windows) name to point at newest
  dry?: boolean
  verbose?: boolean
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  if (!opts.dir || !opts.pattern) {
    die(
      "Usage: snapshot-rotate --dir <folder> --pattern <glob> [--keep N] [--max-age DAYS] [--compress] [--latest name] [--dry] [--verbose]"
    )
  }

  const dirAbs = path.resolve(opts.dir)
  const files = (await listSnapshots(dirAbs, opts.pattern)).sort((a, b) => b.mtime - a.mtime)

  if (opts.verbose) log(`Found ${files.length} snapshots in ${rel(dirAbs)}`)

  // keep newest by index first, then prune by age
  const keepSet = new Set<string>()
  const toDelete: Entry[] = []
  const toCompress: Entry[] = []

  // (1) keep newest N
  if (opts.keep && opts.keep > 0) {
    for (let i = 0; i < Math.min(opts.keep, files.length); i++) keepSet.add(files[i].abs)
  }

  // (2) age threshold
  const maxAgeMs = (opts.maxAgeDays ?? 0) > 0 ? (opts.maxAgeDays as number) * 86400_000 : 0
  const now = Date.now()

  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const isTooOld = maxAgeMs > 0 ? now - f.mtime > maxAgeMs : false
    const shouldKeep = keepSet.has(f.abs) || (!isTooOld && maxAgeMs > 0)
    if (shouldKeep) continue

    // candidates for deletion or compression
    if (opts.compress && !f.abs.endsWith(".gz")) toCompress.push(f)
    else toDelete.push(f)
  }

  // (3) maintain "latest" pointer
  if (opts.latest && files.length) {
    await updateLatestPointer(dirAbs, files[0].abs, opts.latest, opts)
  }

  // (4) perform compression/deletion
  let warnings = 0

  for (const f of toCompress) {
    try {
      await compressFile(f.abs, f.abs + ".gz", opts)
      // after compression, delete the original
      await removeFile(f.abs, opts)
    } catch (e: any) {
      warn(`Failed to compress ${rel(f.abs)}: ${e?.message || e}`)
      warnings++
    }
  }

  for (const f of toDelete) {
    try {
      await removeFile(f.abs, opts)
    } catch (e: any) {
      warn(`Failed to delete ${rel(f.abs)}: ${e?.message || e}`)
      warnings++
    }
  }

  // (5) summary
  const kept = files.length - toCompress.length - toDelete.length
  log(
    `Kept ${kept}, compressed ${toCompress.length}, deleted ${toDelete.length}${
      opts.latest ? `, updated latest -> ${opts.latest}` : ""
    }${opts.dry ? " (dry-run)" : ""}`
  )

  process.exit(warnings ? 1 : 0)
}

/* =========================
 * Filesystem helpers
 * ========================= */

type Entry = { abs: string; mtime: number; size: number }

async function listSnapshots(dir: string, pattern: string): Promise<Entry[]> {
  // Very small globber: supports "*" anywhere (simple contains match), otherwise exact suffix/prefix matches.
  // For full glob, users can pre-filter or swap this with a library.
  const ents = await fs.readdir(dir, { withFileTypes: true })
  const out: Entry[] = []
  for (const e of ents) {
    if (!e.isFile()) continue
    const name = e.name
    if (!match(pattern, name)) continue
    const abs = path.join(dir, name)
    const st = await fs.stat(abs)
    out.push({ abs, mtime: st.mtimeMs, size: st.size })
  }
  return out
}

function match(glob: string, name: string): boolean {
  if (glob === "*" || glob === "*.*") return true
  if (glob.includes("*")) {
    const [pre, suf] = glob.split("*")
    const p = pre ?? ""
    const s = suf ?? ""
    return name.startsWith(p) && name.endsWith(s)
  }
  return name === glob
}

async function compressFile(src: string, dst: string, opts: Cli): Promise<void> {
  if (opts.dry) {
    log(`[dry] gzip ${rel(src)} -> ${rel(dst)}`)
    return
  }
  // skip if dst exists and looks valid
  try {
    const st = await fs.stat(dst)
    if (st.size > 0) {
      if (opts.verbose) log(`Skip compress (exists): ${rel(dst)}`)
      return
    }
  } catch {}

  await pipeline(createReadStream(src), createGzip({ level: 9 }), createWriteStream(dst + ".tmp"))
  await fs.rename(dst + ".tmp", dst)
  if (opts.verbose) log(`Compressed ${rel(src)} -> ${rel(dst)}`)
}

async function removeFile(abs: string, opts: Cli): Promise<void> {
  if (opts.dry) {
    log(`[dry] rm ${rel(abs)}`)
    return
  }
  await fs.unlink(abs)
  if (opts.verbose) log(`Deleted ${rel(abs)}`)
}

async function updateLatestPointer(dirAbs: string, newestAbs: string, latestName: string, opts: Cli) {
  const latestPath = path.join(dirAbs, latestName)
  if (opts.dry) {
    log(`[dry] latest -> ${rel(newestAbs)} (${latestName})`)
    return
  }

  // Try symlink; on Windows without privileges, fall back to copy
  try {
    // remove existing file/symlink
    await fs.rm(latestPath, { force: true })
    const targetRel = path.relative(path.dirname(latestPath), newestAbs)
    await fs.symlink(targetRel, latestPath)
    if (opts.verbose) log(`Updated symlink ${latestName} -> ${rel(newestAbs)}`)
  } catch {
    // fallback: copy small file (could be big—user beware)
    try {
      await fs.cp(newestAbs, latestPath, { force: true })
      if (opts.verbose) log(`Copied latest ${latestName} <- ${rel(newestAbs)}`)
    } catch (e: any) {
      warn(`Failed to set latest pointer: ${e?.message || e}`)
    }
  }
}

/* =========================
 * CLI / utils
 * ========================= */

function parseArgs(argv: string[]): Cli {
  const opts: Cli = {
    dir: "",
    pattern: "*",
    keep: undefined,
    maxAgeDays: undefined,
    compress: false,
    latest: undefined,
    dry: false,
    verbose: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dir" && argv[i + 1]) opts.dir = argv[++i]
    else if (a === "--pattern" && argv[i + 1]) opts.pattern = argv[++i]
    else if (a === "--keep" && argv[i + 1]) opts.keep = parseInt(argv[++i], 10)
    else if (a === "--max-age" && argv[i + 1]) opts.maxAgeDays = parseFloat(argv[++i])
    else if (a === "--compress") opts.compress = true
    else if (a === "--latest" && argv[i + 1]) opts.latest = argv[++i]
    else if (a === "--dry") opts.dry = true
    else if (a === "--verbose" || a === "-v") opts.verbose = true
  }
  return opts
}

function log(s: string) {
  console.log(`▸ ${s}`)
}
function warn(s: string) {
  console.warn(`\x1b[33m⚠ ${s}\x1b[0m`)
}
function die(s: string): never {
  console.error(`\x1b[31m✖ ${s}\x1b[0m`)
  process.exit(2)
}
function rel(p: string): string {
  return path.relative(process.cwd(), p).split(path.sep).join("/")
}

if (import.meta.url === `file://${__filename}`) {
  main().catch((e) => {
    die(e?.stack || e?.message || String(e))
  })
}
