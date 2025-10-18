// scripts/audit-status.ts
// Repository health audit (ESM, zero third-party deps).
//
// What it checks (best-effort; degrades gracefully if tools are missing):
// - Git: branch, ahead/behind, uncommitted files
// - Node: versions
// - NPM: outdated/vulnerable packages (npm outdated / npm audit --json)
// - TypeScript: typecheck (tsc --noEmit)
// - ESLint: lint summary
// - Tests: vitest/jest summary if available
// - Build: dry build
// - Strategies: validates strategies/manifest.json
// - Orphans: heuristic *.ts not covered by tsconfig include
//
// Usage:
//   npx ts-node --esm scripts/audit-status.ts
//   node --loader ts-node/esm scripts/audit-status.ts
//
// Output: pretty console report; add --json for a JSON blob.

import { exec as _exec } from "node:child_process"
import { promisify } from "node:util"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const exec = promisify(_exec)

// ---------- Types ----------

type Maybe<T> = T | undefined

type SectionResult<T = any> = {
  ok: boolean
  note?: string
  details?: T
  durationMs?: number
  error?: string
}

// Per-section "details" shapes (avoid optional index type headaches)
type GitDetails = {
  branch?: string
  ahead?: number
  behind?: number
  status?: { added: number; modified: number; deleted: number; renamed: number; untracked: number }
  dirty?: boolean
  lastCommit?: string
}

type SizeDetails = { files: number; bytes: number }

type DepsDetails = {
  outdated?: number
  vulnerabilities?: { total?: number; low?: number; moderate?: number; high?: number; critical?: number }
}

type TypesDetails = { errors?: number; raw?: string }
type LintDetails = { errors?: number; warnings?: number; raw?: string }
type TestDetails = { passed?: number; failed?: number; skipped?: number; duration?: string; raw?: string }
type BuildDetails = { raw?: string }

type StrategiesDetails = {
  manifestFound: boolean
  filesOnDisk: number
  manifestCount: number
  missingInManifest: string[]
  missingOnDisk: string[]
}

type OrphansDetails = { candidates: string[] }

type NodeVersions = { node?: string; npm?: string; pnpm?: string; yarn?: string }

type AuditReport = {
  when: string
  root: string
  node?: NodeVersions
  git?: SectionResult<GitDetails>
  size?: SectionResult<SizeDetails>
  deps?: SectionResult<DepsDetails>
  types?: SectionResult<TypesDetails>
  lint?: SectionResult<LintDetails>
  tests?: SectionResult<TestDetails>
  build?: SectionResult<BuildDetails>
  strategies?: SectionResult<StrategiesDetails>
  orphans?: SectionResult<OrphansDetails>
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, "..")

// ---------- Helpers ----------

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now()
  const value = await fn()
  return { value, ms: Date.now() - t0 }
}

async function cmd(s: string, opts: { cwd?: string; timeoutMs?: number } = {}) {
  try {
    const { stdout, stderr } = await exec(s, {
      cwd: opts.cwd ?? ROOT,
      timeout: opts.timeoutMs ?? 120000,
      maxBuffer: 10_000_000,
    })
    return { ok: true, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" }
  } catch (e: any) {
    return {
      ok: false,
      stdout: e?.stdout?.toString?.() ?? "",
      stderr: e?.stderr?.toString?.() ?? (e?.message ?? String(e)),
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

function prettyBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"]
  let i = 0
  let x = n
  while (x >= 1024 && i < u.length - 1) {
    x /= 1024
    i++
  }
  return `${x.toFixed(x < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}

function color(s: string, c: "red" | "green" | "yellow" | "cyan" | "gray" | "bold" = "gray"): string {
  const map: Record<string, string> = {
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
    gray: "\x1b[90m",
    bold: "\x1b[1m",
  }
  return `${map[c]}${s}\x1b[0m`
}

async function readJSON<T = any>(p: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as T
  } catch {
    return undefined
  }
}

async function walk(dir: string, pred?: (entry: string) => boolean): Promise<string[]> {
  const out: string[] = []
  async function rec(d: string) {
    let ents: any[] = []
    try {
      ents = await fs.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (/node_modules|\.git|dist|coverage|\.next|\.turbo|build/.test(p)) continue
        await rec(p)
      } else if (e.isFile()) {
        if (!pred || pred(p)) out.push(p)
      }
    }
  }
  await rec(dir)
  return out
}

// ---------- Checks ----------

async function checkNode(): Promise<NodeVersions> {
  const node = (await cmd("node -v")).stdout.trim()
  const npm = (await cmd("npm -v")).stdout.trim()
  const pnpm = (await cmd("pnpm -v")).stdout.trim()
  const yarn = (await cmd("yarn -v")).stdout.trim()
  return { node, npm, pnpm, yarn }
}

async function checkGit(): Promise<SectionResult<GitDetails>> {
  const branch = (await cmd("git rev-parse --abbrev-ref HEAD")).stdout.trim()
  if (!branch) return { ok: false, error: "Not a git repo?" }

  const aheadRaw = (await cmd("git rev-list --left-right --count @{upstream}...HEAD")).stdout.trim()
  let ahead = 0
  let behind = 0
  if (aheadRaw) {
    const nums = aheadRaw.split(/\s+/).map((x) => parseInt(x, 10))
    behind = Number.isFinite(nums[0]) ? (nums[0] as number) : 0
    ahead = Number.isFinite(nums[1]) ? (nums[1] as number) : 0
  }

  const statusPorcelain = (await cmd("git status --porcelain")).stdout.trim()
  const dirty = !!statusPorcelain
  const counts = { added: 0, modified: 0, deleted: 0, renamed: 0, untracked: 0 }
  if (dirty) {
    for (const line of statusPorcelain.split(/\r?\n/)) {
      if (!line) continue
      if (/^\?\?/.test(line)) counts.untracked++
      else if (/^A /.test(line)) counts.added++
      else if (/^ M|^MM|^AM/.test(line)) counts.modified++
      else if (/^D |^D$|^ D/.test(line)) counts.deleted++
      else if (/^R/.test(line)) counts.renamed++
    }
  }

  const lastCommit = (await cmd('git log -1 --pretty=format:"%h %ad %s" --date=iso')).stdout
    .trim()
    .replace(/^"|"$/g, "")

  return { ok: true, details: { branch, ahead, behind, status: counts, dirty, lastCommit } }
}

async function checkSize(): Promise<SectionResult<SizeDetails>> {
  const files = await walk(ROOT)
  let bytes = 0
  for (const f of files) {
    try {
      const st = await fs.stat(f)
      bytes += st.size
    } catch {}
  }
  return { ok: true, details: { files: files.length, bytes } }
}

async function checkDeps(): Promise<SectionResult<DepsDetails>> {
  const details: DepsDetails = {}

  const outdated = await cmd("npm outdated --json")
  if (outdated.ok) {
    try {
      const j = JSON.parse(outdated.stdout || "{}")
      details.outdated = Object.keys(j).length
    } catch {
      details.outdated = 0
    }
  }

  const audit = await cmd("npm audit --json --audit-level=low")
  if (audit.ok) {
    try {
      const j = JSON.parse(audit.stdout || "{}")
      const v = j.metadata?.vulnerabilities || {}
      const total = ["low", "moderate", "high", "critical"].reduce((acc, k) => acc + (v[k] || 0), 0)
      details.vulnerabilities = {
        total,
        low: v.low ?? 0,
        moderate: v.moderate ?? 0,
        high: v.high ?? 0,
        critical: v.critical ?? 0,
      }
    } catch {
      /* ignore */
    }
  }

  return { ok: true, details }
}

async function checkTypes(): Promise<SectionResult<TypesDetails>> {
  const res = await cmd("npx tsc -p tsconfig.json --noEmit")
  if (res.ok) return { ok: true, details: { errors: 0 }, note: "TypeScript clean" }
  const raw = `${res.stdout}\n${res.stderr}`.trim()
  const errors = (raw.match(/error TS\d+:/g) || []).length || undefined
  return { ok: false, details: { errors, raw }, error: "Type errors" }
}

async function checkLint(): Promise<SectionResult<LintDetails>> {
  const res = await cmd('npx eslint "**/*.ts"')
  if (res.ok) return { ok: true, note: "ESLint clean", details: { errors: 0, warnings: 0 } }
  const raw = `${res.stdout}\n${res.stderr}`.trim()
  const sum = raw.match(/✖\s+(\d+)\s+problems\s+\((\d+)\s+errors?,\s+(\d+)\s+warnings?\)/)
  const errors = sum ? parseInt(sum[2]!, 10) : undefined
  const warnings = sum ? parseInt(sum[3]!, 10) : undefined
  return { ok: false, details: { errors, warnings, raw }, error: "ESLint issues" }
}

async function checkTests(): Promise<SectionResult<TestDetails>> {
  // Prefer vitest, fallback to jest
  let res = await cmd("npx vitest run --reporter=basic")
  if (!res.ok) res = await cmd("npx jest --ci --reporters=default")
  if (!res.ok) {
    return { ok: false, error: "No test runner or tests failed", details: { raw: `${res.stdout}\n${res.stderr}`.trim() } }
  }
  const raw = res.stdout.trim()
  const pass = (raw.match(/(\d+)\s+passed/g) || []).map((m) => parseInt(m, 10)).reduce((a, b) => a + b, 0)
  const fail = (raw.match(/(\d+)\s+failed/g) || []).map((m) => parseInt(m, 10)).reduce((a, b) => a + b, 0)
  const skip = (raw.match(/(\d+)\s+skipped/g) || []).map((m) => parseInt(m, 10)).reduce((a, b) => a + b, 0)
  const dur = (raw.match(/in\s+([\d\.]+s)/) || [])[1]
  return {
    ok: fail === 0,
    details: { passed: pass, failed: fail, skipped: skip, duration: dur, raw },
    note: fail === 0 ? "All tests passed" : undefined,
    error: fail ? "Some tests failed" : undefined,
  }
}

async function checkBuild(): Promise<SectionResult<BuildDetails>> {
  const pkg = await readJSON<any>(path.join(ROOT, "package.json"))
  const hasBuild = !!pkg?.scripts?.build
  const res = await cmd(hasBuild ? "npm run -s build" : "npx tsc -p tsconfig.json")
  if (res.ok) return { ok: true, note: hasBuild ? "npm run build ok" : "tsc build ok" }
  return { ok: false, error: "Build failed", details: { raw: `${res.stdout}\n${res.stderr}`.trim() } }
}

async function checkStrategies(): Promise<SectionResult<StrategiesDetails>> {
  const manifestPath = path.join(ROOT, "strategies", "manifest.json")
  const hasManifest = await pathExists(manifestPath)
  const manifest = hasManifest ? await readJSON<{ entries?: Array<{ path: string }> }>(manifestPath) : undefined
  const manifestCount = manifest?.entries?.length ?? 0

  const diskFiles = (await walk(path.join(ROOT, "strategies"))).filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
  const filesOnDisk = diskFiles.length

  const setManifest = new Set((manifest?.entries || []).map((e) => (e.path || "").replace(/^\.?\//, "")))
  const diskRel = diskFiles.map((f) => path.relative(ROOT, f).split(path.sep).join("/"))

  const missingInManifest = diskRel.filter((p) => !setManifest.has(p))
  const missingOnDisk = Array.from(setManifest).filter((p) => !diskRel.includes(p))

  const ok = hasManifest && missingInManifest.length === 0
  const note = ok ? "Strategy manifest looks good" : "Manifest mismatch"

  return {
    ok,
    note,
    details: {
      manifestFound: hasManifest,
      filesOnDisk,
      manifestCount,
      missingInManifest,
      missingOnDisk,
    },
  }
}

async function checkOrphans(): Promise<SectionResult<OrphansDetails>> {
  const tsconfigPath = path.join(ROOT, "tsconfig.json")
  const tsc = await readJSON<any>(tsconfigPath)
  if (!tsc) return { ok: true, note: "No tsconfig.json; skipping", details: { candidates: [] } }

  const includes: string[] = Array.isArray(tsc.include) ? tsc.include : ["**/*.ts"]
  const allTs = (await walk(ROOT, (p) => p.endsWith(".ts"))).map((f) => path.relative(ROOT, f).split(path.sep).join("/"))

  if (includes.length === 1 && includes[0] === "**/*.ts") {
    return { ok: true, details: { candidates: [] }, note: "tsconfig includes all *.ts" }
  }

  // crude prefix-based include detection (best effort)
  const inc = new Set<string>()
  for (const pat of includes) {
    const prefix = pat.replace(/\*\*\/\*\.ts$/, "")
    for (const f of allTs) if (f.startsWith(prefix)) inc.add(f)
  }
  const candidates = allTs.filter((f) => !inc.has(f) && !/^scripts\//.test(f))
  return { ok: candidates.length === 0, details: { candidates }, note: candidates.length ? "Potential orphans" : "No obvious orphans" }
}

// ---------- Report rendering ----------

function printHeader() {
  console.log(color("\n=== Repo Audit ===============================", "bold"))
}
function printSection(title: string, ok: boolean, note?: string) {
  const badge = ok ? color("OK", "green") : color("FAIL", "red")
  console.log(`${badge} ${color(title, "cyan")}${note ? " — " + note : ""}`)
}
function printGit(g?: SectionResult<GitDetails>) {
  if (!g?.details) return
  const d = g.details
  console.log(`  branch=${color(d.branch || "-", "bold")} ahead=${d.ahead ?? 0} behind=${d.behind ?? 0} dirty=${d.dirty ? color("yes", "yellow") : "no"}`)
  if (d.lastCommit) console.log(`  last=${d.lastCommit}`)
  const s = d.status || { added: 0, modified: 0, deleted: 0, renamed: 0, untracked: 0 }
  console.log(`  changes: +${s.added} ~${s.modified} -${s.deleted} r${s.renamed} ?${s.untracked}`)
}
function printDeps(d?: SectionResult<DepsDetails>) {
  if (!d?.details) return
  const v = d.details.vulnerabilities || {}
  console.log(`  outdated: ${d.details.outdated ?? 0}`)
  console.log(`  vulnerabilities: tot=${v.total ?? 0} L=${v.low ?? 0} M=${v.moderate ?? 0} H=${v.high ?? 0} C=${v.critical ?? 0}`)
}
function printSize(s?: SectionResult<SizeDetails>) {
  if (!s?.details) return
  console.log(`  files: ${s.details.files}, size: ${prettyBytes(s.details.bytes)}`)
}
function printTests(t?: SectionResult<TestDetails>) {
  if (!t?.details) return
  console.log(`  passed=${t.details.passed ?? 0} failed=${t.details.failed ?? 0} skipped=${t.details.skipped ?? 0} duration=${t.details.duration ?? "-"}`)
}
function printStrategies(s?: SectionResult<StrategiesDetails>) {
  if (!s?.details) return
  const d = s.details
  console.log(`  manifest: ${d.manifestFound ? "found" : "missing"} entries=${d.manifestCount} filesOnDisk=${d.filesOnDisk}`)
  if (d.missingInManifest?.length) {
    console.log(color("  missing in manifest:", "yellow"))
    for (const f of d.missingInManifest) console.log("   - " + f)
  }
  if (d.missingOnDisk?.length) {
    console.log(color("  missing on disk:", "yellow"))
    for (const f of d.missingOnDisk) console.log("   - " + f)
  }
}

// ---------- Main ----------

async function main() {
  const wantJSON = process.argv.includes("--json")

  const report: AuditReport = { when: new Date().toISOString(), root: ROOT }

  report.node = await checkNode()

  const gitT = await timed(checkGit)
  report.git = gitT.value
  report.git!.durationMs = gitT.ms

  const sizeT = await timed(checkSize)
  report.size = sizeT.value
  report.size!.durationMs = sizeT.ms

  const depsT = await timed(checkDeps)
  report.deps = depsT.value
  report.deps!.durationMs = depsT.ms

  const typesT = await timed(checkTypes)
  report.types = typesT.value
  report.types!.durationMs = typesT.ms

  const lintT = await timed(checkLint)
  report.lint = lintT.value
  report.lint!.durationMs = lintT.ms

  const testT = await timed(checkTests)
  report.tests = testT.value
  report.tests!.durationMs = testT.ms

  const buildT = await timed(checkBuild)
  report.build = buildT.value
  report.build!.durationMs = buildT.ms

  const stratT = await timed(checkStrategies)
  report.strategies = stratT.value
  report.strategies!.durationMs = stratT.ms

  const orphanT = await timed(checkOrphans)
  report.orphans = orphanT.value
  report.orphans!.durationMs = orphanT.ms

  if (wantJSON) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  printHeader()
  console.log(`root: ${color(report.root, "bold")}   when: ${report.when}`)
  console.log(`node: ${report.node?.node ?? "-"}   npm: ${report.node?.npm ?? "-"}   pnpm: ${report.node?.pnpm ?? "-"}   yarn: ${report.node?.yarn ?? "-"}`)
  console.log()

  printSection("Git", !!report.git?.ok, report.git?.note)
  printGit(report.git)

  printSection("Repo size", !!report.size?.ok)
  printSize(report.size)

  printSection("Dependencies", !!report.deps?.ok)
  printDeps(report.deps)

  printSection("TypeScript", !!report.types?.ok, report.types?.note || report.types?.error)

  printSection("ESLint", !!report.lint?.ok, report.lint?.note || report.lint?.error)

  printSection("Tests", !!report.tests?.ok, report.tests?.note || report.tests?.error)
  printTests(report.tests)

  printSection("Build", !!report.build?.ok, report.build?.note || report.build?.error)

  printSection("Strategies manifest", !!report.strategies?.ok, report.strategies?.note)
  printStrategies(report.strategies)

  printSection("Orphans", !!report.orphans?.ok, report.orphans?.note)
  console.log()

  // Exit non-zero if important sections failed
  const hardFail = [report.types, report.lint, report.tests, report.build].some((s) => s && !s.ok)
  process.exit(hardFail ? 1 : 0)
}

main().catch((err) => {
  console.error(color("Audit crashed: " + (err?.stack || err), "red"))
  process.exit(2)
})
