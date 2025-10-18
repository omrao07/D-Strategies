// scripts/build release.ts
// End-to-end release helper (ESM, zero third-party deps).
//
// What it can do (best-effort, all optional via flags):
// 1) Bump package.json version (semver)             --bump patch|minor|major|prerelease|none
// 2) Build the project (npm run build OR tsc)       --build (default on)
// 3) Produce an npm pack tarball (.tgz)             --pack (default on)
// 4) Generate release notes from git commits        --notes (default on)
// 5) Create git commit + tag                        --tag (default on)
// 6) Push branch + tags                             --push
// 7) Publish to npm                                 --publish
// 8) Dry-run mode to preview commands               --dry
//
// Usage examples:
//   npx ts-node --esm scripts/build\ release.ts --bump patch --push
//   npx ts-node --esm scripts/build\ release.ts --bump minor --publish --no-build
//
// Output artifacts:
//   releases/release-vX.Y.Z.md  (notes + checksum)
//   npm pack output (*.tgz) moved into ./releases/
//
// This script avoids external modules; it shells out to git/npm/tsc.

import { promises as fs } from "node:fs"
import * as path from "node:path"
import crypto from "node:crypto"
import { exec as _exec } from "node:child_process"
import { promisify } from "node:util"
const exec = promisify(_exec)

// ---------- Types ----------

type BumpKind = "patch" | "minor" | "major" | "prerelease" | "none"
type Options = {
  bump: BumpKind
  preid?: string
  build: boolean
  pack: boolean
  notes: boolean
  tag: boolean
  push: boolean
  publish: boolean
  dry: boolean
  verbose: boolean
}

type Pkg = { name?: string; version?: string; scripts?: Record<string, string> }

// ---------- CLI ----------

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    bump: "none",
    build: true,
    pack: true,
    notes: true,
    tag: true,
    push: false,
    publish: false,
    dry: false,
    verbose: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--bump" && argv[i + 1]) opts.bump = argv[++i] as BumpKind
    else if (a === "--preid" && argv[i + 1]) opts.preid = argv[++i]
    else if (a === "--build") opts.build = true
    else if (a === "--no-build") opts.build = false
    else if (a === "--pack") opts.pack = true
    else if (a === "--no-pack") opts.pack = false
    else if (a === "--notes") opts.notes = true
    else if (a === "--no-notes") opts.notes = false
    else if (a === "--tag") opts.tag = true
    else if (a === "--no-tag") opts.tag = false
    else if (a === "--push") opts.push = true
    else if (a === "--publish") opts.publish = true
    else if (a === "--dry") opts.dry = true
    else if (a === "--verbose" || a === "-v") opts.verbose = true
  }
  return opts
}

// ---------- Utilities ----------

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")

async function cmd(s: string, cwd = ROOT, allowFail = false) {
  if (FLAGS.dry) { log(`[dry] ${s}`); return { ok: true, stdout: "", stderr: "" } }
  try {
    FLAGS.verbose && log(`$ ${s}`)
    const { stdout, stderr } = await exec(s, { cwd, maxBuffer: 10_000_000 })
    return { ok: true, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" }
  } catch (e: any) {
    if (!allowFail) warn(`${s}\n${e?.stderr || e?.message || e}`)
    return { ok: false, stdout: e?.stdout?.toString?.() ?? "", stderr: e?.stderr?.toString?.() ?? (e?.message ?? String(e)) }
  }
}

function sha256File(abs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256")
    const rs = fs
      .open(abs, "r")
      .then((fh) => {
        const stream = fh.createReadStream()
        stream.on("data", (c) => h.update(c))
        stream.on("end", async () => {
          await fh.close()
          resolve(h.digest("hex"))
        })
        stream.on("error", reject)
      })
      .catch(reject)
  })
}

function bumpSemver(v: string, kind: BumpKind, preid?: string): string {
  if (kind === "none") return v
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/)
  if (!m) throw new Error(`Invalid semver: ${v}`)
  let [major, minor, patch] = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
  if (kind === "major") { major++; minor = 0; patch = 0 }
  else if (kind === "minor") { minor++; patch = 0 }
  else if (kind === "patch") { patch++ }
  else if (kind === "prerelease") {
    // If already pre, increment trailing number; else bump patch and add preid.0
    const pre = m[4]
    if (pre) {
      const parts = pre.split(".")
      const n = parts.length && /^\d+$/.test(parts[parts.length - 1]) ? parseInt(parts.pop()!, 10) + 1 : 0
      const tag = preid ? [preid, n].join(".") : [...parts, String(n)].join(".")
      return `${major}.${minor}.${patch}-${tag}`
    } else {
      const tag = preid ? `${preid}.0` : "0"
      return `${major}.${minor}.${patch + 1}-${tag}`
    }
  }
  return `${major}.${minor}.${patch}`
}

function log(s: string) { console.log(`▸ ${s}`) }
function ok(s: string) { console.log(`\x1b[32m✔ ${s}\x1b[0m`) }
function warn(s: string) { console.warn(`\x1b[33m⚠ ${s}\x1b[0m`) }

let FLAGS: Options

// ---------- Steps ----------

async function readPkg(): Promise<Pkg> {
  const p = path.join(ROOT, "package.json")
  return JSON.parse(await fs.readFile(p, "utf8"))
}
async function writePkg(pkg: Pkg) {
  const p = path.join(ROOT, "package.json")
  if (FLAGS.dry) { log(`[dry] write ${p}`); return }
  await fs.writeFile(p, JSON.stringify(pkg, null, 2) + "\n", "utf8")
}

async function ensureCleanGit() {
  const s = await cmd("git status --porcelain")
  if (!s.ok) return
  if (s.stdout.trim()) warn("Working tree not clean (continuing).")
}

async function computeNotes(prevTag?: string, nextVer?: string) {
  let range = ""
  if (prevTag) range = `${prevTag}..HEAD`
  const r = await cmd(`git log --pretty=format:"* %h %s (%an) %ad" --date=short ${range}`.trim())
  const body = r.ok ? r.stdout.trim() : ""
  const head = `# Release ${nextVer ?? ""}\n\n`
  const prev = prevTag ? `Previous tag: ${prevTag}\n\n` : ""
  return head + prev + (body || "_No commits found._") + "\n"
}

async function runBuild(pkg: Pkg) {
  const has = !!pkg.scripts?.build
  const r = await cmd(has ? "npm run -s build" : "npx tsc -p tsconfig.json")
  if (!r.ok) throw new Error("Build failed")
  ok("Build completed")
}

async function runPack(): Promise<string | undefined> {
  const r = await cmd("npm pack")
  if (!r.ok) throw new Error("npm pack failed")
  const line = r.stdout.trim().split(/\r?\n/).pop() || ""
  const file = line.trim()
  if (!file.endsWith(".tgz")) { warn("npm pack output unexpected"); return undefined }
  // move to releases/
  const rels = path.join(ROOT, "releases")
  if (!FLAGS.dry) await fs.mkdir(rels, { recursive: true })
  const src = path.join(ROOT, file)
  const dst = path.join(rels, file)
  if (FLAGS.dry) { log(`[dry] mv ${src} -> ${dst}`) }
  else await fs.rename(src, dst)
  ok(`Packaged ${file}`)
  return dst
}

async function tagAndCommit(version: string) {
  await cmd(`git add package.json`)
  await cmd(`git commit -m "chore(release): v${version}"`, ROOT, true)
  await cmd(`git tag v${version}`, ROOT, true)
  ok(`Tagged v${version}`)
}

async function pushAll() {
  await cmd("git push", ROOT, true)
  await cmd("git push --tags", ROOT, true)
  ok("Pushed branch & tags")
}

async function publishNpm() {
  const r = await cmd("npm publish --access public", ROOT, true)
  if (!r.ok) warn("npm publish failed (see output)")
  else ok("Published to npm")
}

// ---------- Main ----------

async function main() {
  FLAGS = parseArgs(process.argv.slice(2))

  const pkg = await readPkg()
  const name = pkg.name ?? path.basename(ROOT)
  const cur = pkg.version || "0.0.0"

  log(`Package: ${name}`)
  log(`Current version: ${cur}`)

  await ensureCleanGit()

  // Find previous tag
  const prevTag = (await cmd("git describe --tags --abbrev=0", ROOT, true)).stdout.trim() || undefined

  // Bump version (if requested)
  let next = cur
  if (FLAGS.bump !== "none") {
    next = bumpSemver(cur, FLAGS.bump, FLAGS.preid)
    pkg.version = next
    await writePkg(pkg)
    ok(`Version bumped -> ${next}`)
  }

  // Build
  if (FLAGS.build) await runBuild(pkg)
  else log("Skip build (--no-build)")

  // Pack
  let tarball: string | undefined
  if (FLAGS.pack) tarball = await runPack()
  else log("Skip pack (--no-pack)")

  // Notes
  let notes = ""
  if (FLAGS.notes) {
    notes = await computeNotes(prevTag, next)
    const releases = path.join(ROOT, "releases")
    if (!FLAGS.dry) await fs.mkdir(releases, { recursive: true })
    const mdPath = path.join(releases, `release-v${next}.md`)
    // checksum
    let checksum = ""
    if (tarball && !FLAGS.dry) checksum = await sha256File(tarball)
    const footer = tarball ? `\n**SHA256**: \`${checksum}\`\nFile: \`${path.basename(tarball)}\`\n` : ""
    if (FLAGS.dry) log(`[dry] write ${mdPath}`)
    else await fs.writeFile(mdPath, notes + footer, "utf8")
    ok(`Release notes ${tarball ? "(+checksum)" : ""} generated`)
  } else {
    log("Skip notes (--no-notes)")
  }

  // Git tag
  if (FLAGS.tag) await tagAndCommit(next)
  else log("Skip tag (--no-tag)")

  if (FLAGS.push) await pushAll()
  if (FLAGS.publish) await publishNpm()

  ok(`Release flow complete ${FLAGS.dry ? "(dry-run)" : ""}`)
}

// ---------- Run ----------

main().catch((e) => {
  console.error("\x1b[31m✖ Release failed:\x1b[0m", e?.message || e)
  process.exit(2)
})
