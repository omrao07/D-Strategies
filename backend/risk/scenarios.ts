// risk/scenarios.ts
// Scenario analysis helpers (pure TypeScript, no imports).
// Clean, strongly-typed rewrite with safe number guards and FX-aware factor shock.

export type ISO8601 = string

export type Position = {
  symbol: string
  quantity: number          // signed; <0 short
  price?: number            // current mark (if absent, use Prices)
  avgEntry?: number
  currency?: string
}

export type Portfolio = {
  ts?: ISO8601
  baseCurrency?: string
  cash?: number
  positions: Position[]
}

export type Prices = Record<string, number>    // symbol -> last
export type FX = Record<string, number>        // currency -> FX to base (1 if base)

// ---------- Scenario primitives ----------

export type PriceShock =
  | { type: "absolute"; by: Record<string, number> }  // new = px + by[sym]
  | { type: "relative"; by: Record<string, number> }  // new = px * (1 + by[sym])
  | { type: "level"; to: Record<string, number> }     // new = to[sym]

export type FXShock = {
  /** Set absolute FX levels (ccy -> new level). */
  to?: Record<string, number>
  /** Relative FX change multipliers (ccy -> multiplier). */
  rel?: Record<string, number>
}

export type Scenario = {
  name: string
  price?: PriceShock
  fx?: FXShock
  overrides?: { prices?: Prices; fx?: FX }  // wins over computed shocks
  meta?: Record<string, any>
}

export type ScenarioLeg = {
  symbol: string
  qty: number
  price0: number
  price1: number
  mv0: number
  mv1: number
  pnl: number
}

export type ScenarioResult = {
  scenario: string
  equity0: number
  equity1: number
  pnlAbs: number
  pnlPct?: number
  cashImpact?: number
  perSymbol: ScenarioLeg[]
}

// ---------- Factor shock ----------

export type FactorShock = {
  name: string
  /** exposures[symbol] -> { factorName: exposure } */
  exposures: Record<string, Record<string, number>>
  /** factorMoves[factor] -> return (e.g., +0.02 = +2%) */
  factorMoves: Record<string, number>
  prices: Prices
  fx?: FX
  /** If true, apply FX of position.currency from fx map to both price0/price1. */
  useFX?: boolean
}

// ---------- Monte Carlo ----------

export type GBMConfig = {
  mu?: number         // drift per step
  sigma?: number      // vol per sqrt(step)
  dt?: number         // step size (1 default)
  steps: number
  paths: number
  seed?: number
}

export type BootstrapConfig = {
  returns: Record<string, number[]> // per-symbol historical returns
  block?: number                    // block bootstrap size
  steps: number
  paths: number
  seed?: number
}

// ======================================================================
// Public API
// ======================================================================

/** Apply a single scenario (prices + FX) to a portfolio. */
export function applyScenario(pf: Portfolio, prices: Prices, fx?: FX, sc?: Scenario): ScenarioResult {
  const px0 = materializePrices(pf, prices)
  const fx0 = { ...(fx || {}) }
  const equity0 = (pf.cash ?? 0) + sumMV(pf, px0, fx0)

  const px1 = withOverrides(applyPriceShock(px0, sc?.price), sc?.overrides?.prices)
  const fx1 = withOverrides(applyFXShock(fx0, sc?.fx), sc?.overrides?.fx)

  const { legs, mv1 } = legsPnL(pf, px0, px1, fx0, fx1)
  const cashImpact = 0
  const equity1 = (pf.cash ?? 0) + mv1 + cashImpact

  return {
    scenario: sc?.name ?? "untitled",
    equity0,
    equity1,
    pnlAbs: equity1 - equity0,
    pnlPct: equity0 ? equity1 / equity0 - 1 : undefined,
    cashImpact,
    perSymbol: legs,
  }
}

/** Run multiple scenarios. */
export function runScenarios(pf: Portfolio, prices: Prices, list: Scenario[], fx?: FX): ScenarioResult[] {
  const out: ScenarioResult[] = []
  for (const s of list) out.push(applyScenario(pf, prices, fx, s))
  return out
}

/** Build a uniform relative shock grid for given symbols. */
export function gridScenarios(symbols: string[], levels: number[]): Scenario[] {
  return levels.map(lev => ({
    name: `${(lev * 100).toFixed(1)}%`,
    price: { type: "relative", by: Object.fromEntries(symbols.map(s => [s, lev])) },
  }))
}

/** Factor shock P&L. Optionally FX-adjust with sc.useFX and sc.fx. */
export function factorShockPnl(pf: Portfolio, sc: FactorShock): ScenarioResult {
  const px0 = materializePrices(pf, sc.prices)
  const equity0 = (pf.cash ?? 0) + sumMV(pf, px0, sc.useFX ? sc.fx : undefined)

  const legs: ScenarioLeg[] = []
  let mv1 = 0
  let pnlTotal = 0

  for (const p of pf.positions) {
    const p0 = takePx(p, px0)
    if (!isFiniteNum(p0)) continue

    // Aggregate factor return
    let ret = 0
    const exp = sc.exposures[p.symbol] || {}
    for (const [f, e] of Object.entries(exp)) {
      const mv = sc.factorMoves[f]
      if (isFiniteNum(e) && isFiniteNum(mv)) ret += e * mv
    }

    const p1 = p0 * (1 + ret)
    const fxRate0 = sc.useFX ? takeFX(p, sc.fx) : 1
    const fxRate1 = sc.useFX ? takeFX(p, sc.fx) : 1

    const mv0 = p.quantity * p0 * fxRate0
    const mvNew = p.quantity * p1 * fxRate1
    const pnl = mvNew - mv0

    mv1 += mvNew
    pnlTotal += pnl

    legs.push({
      symbol: p.symbol,
      qty: p.quantity,
      price0: p0 * fxRate0,
      price1: p1 * fxRate1,
      mv0,
      mv1: mvNew,
      pnl,
    })
  }

  const equity1 = (pf.cash ?? 0) + mv1

  return {
    scenario: sc.name,
    equity0,
    equity1,
    pnlAbs: pnlTotal,
    pnlPct: equity0 ? equity1 / equity0 - 1 : undefined,
    perSymbol: legs,
  }
}

/** Replay a vector of returns as a scenario. */
export function replayReturns(pf: Portfolio, prices: Prices, returns: Record<string, number>): ScenarioResult {
  const by: Record<string, number> = {}
  for (const k of Object.keys(prices)) if (isFiniteNum(returns[k])) by[k] = returns[k]
  return applyScenario(pf, prices, undefined, { name: "historical-replay", price: { type: "relative", by } })
}

/** MC via GBM (independent per symbol). Returns P&L paths and starting equity. */
export function mcGbmPnL(pf: Portfolio, prices: Prices, cfg: GBMConfig): { pnl: number[]; equity0: number } {
  const px0 = materializePrices(pf, prices)
  const equity0 = (pf.cash ?? 0) + sumMV(pf, px0)
  const rng = prng(cfg.seed ?? 1234)
  const mu = cfg.mu ?? 0
  const sigma = cfg.sigma ?? 0.2
  const dt = cfg.dt ?? 1
  const steps = Math.max(1, cfg.steps | 0)
  const paths = Math.max(1, cfg.paths | 0)

  const pnl = new Array<number>(paths).fill(0)

  for (let k = 0; k < paths; k++) {
    let mv = 0
    for (const p of pf.positions) {
      let S = px0[p.symbol]
      if (!isFiniteNum(S)) continue
      for (let t = 0; t < steps; t++) {
        const z = normal01(rng)
        S = S * Math.exp((mu - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * z)
      }
      mv += p.quantity * S
    }
    pnl[k] = (pf.cash ?? 0) + mv - equity0
  }
  return { pnl, equity0 }
}

/** MC via (block) bootstrap of historical returns per symbol (independent). */
export function mcBootstrapPnL(pf: Portfolio, prices: Prices, cfg: BootstrapConfig): { pnl: number[]; equity0: number } {
  const px0 = materializePrices(pf, prices)
  const equity0 = (pf.cash ?? 0) + sumMV(pf, px0)
  const rng = prng(cfg.seed ?? 4321)
  const steps = Math.max(1, cfg.steps | 0)
  const paths = Math.max(1, cfg.paths | 0)
  const block = Math.max(1, cfg.block || 1)

  const seqFor = (s: string) => (cfg.returns[s] || []).filter(isFiniteNum)
  const pnl = new Array<number>(paths).fill(0)

  for (let k = 0; k < paths; k++) {
    let mv = 0
    for (const p of pf.positions) {
      const series = seqFor(p.symbol)
      if (!series.length) continue
      let S = px0[p.symbol]
      for (let t = 0; t < steps; ) {
        const start = Math.floor(rng() * Math.max(1, series.length - block))
        for (let b = 0; b < block && t < steps; b++, t++) {
          const r = series[(start + b) % series.length]
          S = S * (1 + r)
        }
      }
      mv += p.quantity * S
    }
    pnl[k] = (pf.cash ?? 0) + mv - equity0
  }
  return { pnl, equity0 }
}

/** Stress VaR/ES from arbitrary P&L vector. Loss is positive. */
export function stressVaR(pnl: number[], level = 0.99): { var: number; es?: number } {
  const losses = pnl.filter(isFiniteNum).map(x => -x)
  if (!losses.length) return { var: NaN, es: NaN }
  losses.sort((a, b) => a - b)
  const q = percentile(losses, level)
  const tail = losses.filter(x => x >= q)
  const es = tail.length ? mean(tail) : q
  return { var: q, es }
}

/** Local Δ/Γ approximation (plain vanilla). */
export function deltaGammaPnL(delta: number, gamma: number, dS: number): number {
  return delta * dS + 0.5 * gamma * dS * dS
}

// ======================================================================
// Helpers (no imports)
// ======================================================================

function applyPriceShock(prices: Prices, shock?: PriceShock): Prices {
  if (!shock) return { ...prices }
  if (shock.type === "absolute") {
    const out = { ...prices }
    for (const [s, dv] of Object.entries(shock.by || {})) {
      const p0 = prices[s]
      if (isFiniteNum(p0) && isFiniteNum(dv)) out[s] = p0 + dv
    }
    return out
  }
  if (shock.type === "relative") {
    const out = { ...prices }
    for (const [s, r] of Object.entries(shock.by || {})) {
      const p0 = prices[s]
      if (isFiniteNum(p0) && isFiniteNum(r)) out[s] = p0 * (1 + r)
    }
    return out
  }
  if (shock.type === "level") {
    return { ...prices, ...(shock.to || {}) }
  }
  return { ...prices }
}

function applyFXShock(fx: FX, s?: FXShock): FX {
  if (!s) return { ...fx }
  let out = { ...fx }
  if (s.rel) {
    out = { ...out }
    for (const [ccy, m] of Object.entries(s.rel)) {
      const v = out[ccy]
      if (isFiniteNum(v) && isFiniteNum(m)) out[ccy] = v * m
    }
  }
  if (s.to) out = { ...out, ...s.to }
  return out
}

function withOverrides<T extends Record<string, number> | undefined>(base: T, over?: T): T {
  return { ...(base || {}), ...(over || {}) } as T
}

function legsPnL(pf: Portfolio, px0: Prices, px1: Prices, fx0?: FX, fx1?: FX): { legs: ScenarioLeg[]; mv1: number } {
  const legs: ScenarioLeg[] = []
  let mv1Sum = 0
  for (const pos of pf.positions) {
    const p0 = takePx(pos, px0)
    const p1 = takePx(pos, px1)
    if (!isFiniteNum(p0) || !isFiniteNum(p1)) continue
    const f0 = takeFX(pos, fx0)
    const f1 = takeFX(pos, fx1)
    const mv0 = pos.quantity * p0 * f0
    const mv1 = pos.quantity * p1 * f1
    const pnl = mv1 - mv0
    mv1Sum += mv1
    legs.push({
      symbol: pos.symbol,
      qty: pos.quantity,
      price0: p0 * f0,
      price1: p1 * f1,
      mv0,
      mv1,
      pnl,
    })
  }
  return { legs, mv1: mv1Sum }
}

function materializePrices(pf: Portfolio, prices: Prices): Prices {
  const out: Prices = {}
  for (const p of pf.positions) {
    const v = isFiniteNum(p.price) ? p.price! : prices[p.symbol]
    if (isFiniteNum(v)) out[p.symbol] = v
  }
  for (const [k, v] of Object.entries(prices)) if (!(k in out) && isFiniteNum(v)) out[k] = v
  return out
}

function sumMV(pf: Portfolio, prices: Prices, fx?: FX): number {
  let s = 0
  for (const p of pf.positions) {
    const px = takePx(p, prices)
    if (!isFiniteNum(px)) continue
    s += p.quantity * px * takeFX(p, fx)
  }
  return s
}

function takePx(p: Position, prices: Prices): number { return isFiniteNum(p.price) ? p.price! : prices[p.symbol] }
function takeFX(p: Position, fx?: FX): number {
  if (!fx || !p.currency) return 1
  const r = fx[p.currency]
  return isFiniteNum(r) ? r : 1
}

function isFiniteNum(x: any): x is number { return typeof x === "number" && isFinite(x) }
function mean(xs: number[]): number { let s = 0, n = 0; for (const x of xs) if (isFiniteNum(x)) { s += x; n++ } return n ? s / n : NaN }
function percentile(xs: number[], p: number): number {
  const a = xs.filter(isFiniteNum).slice().sort((x, y) => x - y)
  if (!a.length) return NaN
  const r = Math.max(0, Math.min(1, p)) * (a.length - 1)
  const i = Math.floor(r), j = Math.min(a.length - 1, i + 1), w = r - i
  return a[i] * (1 - w) + a[j] * w
}

// PRNG + Normal(0,1)
function prng(seed: number): () => number {
  let x = seed >>> 0
  return () => {
    x ^= x << 13; x >>>= 0
    x ^= x >> 17; x >>>= 0
    x ^= x << 5;  x >>>= 0
    return (x & 0xffffffff) / 0x100000000
  }
}
function normal01(rng: () => number): number {
  let u = rng(); let v = rng()
  u = u <= 1e-12 ? 1e-12 : u
  v = v <= 1e-12 ? 1e-12 : v
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// ---------- Convenience scenario builders ----------

export function shockUniform(symbols: string[], relReturn: number, name?: string): Scenario {
  return {
    name: name ?? `${(relReturn * 100).toFixed(1)}% uniform`,
    price: { type: "relative", by: Object.fromEntries(symbols.map(s => [s, relReturn])) },
  }
}

export function shockFXRel(currencies: string[], rel: number, name?: string): Scenario {
  const mult: Record<string, number> = {}
  for (const c of currencies) mult[c] = 1 + rel
  return { name: name ?? `FX ${Math.round(rel * 100)}%`, fx: { rel: mult } }
}

export function composeScenarios(name: string, ...scs: Scenario[]): Scenario {
  const out: Scenario = { name }
  for (const s of scs) {
    if (s.price) out.price = mergePriceShock(out.price, s.price)
    if (s.fx) out.fx = mergeFxShock(out.fx, s.fx)
    if (s.overrides?.prices) out.overrides = { ...(out.overrides || {}), prices: { ...(out.overrides?.prices || {}), ...s.overrides.prices } }
    if (s.overrides?.fx) out.overrides = { ...(out.overrides || {}), fx: { ...(out.overrides?.fx || {}), ...s.overrides.fx } }
  }
  return out
}

function mergePriceShock(a?: PriceShock, b?: PriceShock): PriceShock | undefined {
  if (!a) return b
  if (!b) return a
  if (b.type === "level") return b
  if (a.type === "relative" && b.type === "relative") return { type: "relative", by: { ...a.by, ...b.by } }
  if (a.type === "absolute" && b.type === "absolute") return { type: "absolute", by: { ...a.by, ...b.by } }
  return b
}
function mergeFxShock(a?: FXShock, b?: FXShock): FXShock {
  return { to: { ...(a?.to || {}), ...(b?.to || {}) }, rel: { ...(a?.rel || {}), ...(b?.rel || {}) } }
}
// ======================================================================
// The End
// ======================================================================

// backtester/cli.ts
import fs from "fs"
import path from "path"

/** Simple command-line parser: first non-flag is command, rest are flags. */
export function parseArgs(argv: string[]): { cmd?: string; flags: Record<string, string | boolean> } {
  const [, , ...rest] = argv
  const flags: Record<string, string | boolean> = {}
  let cmd: string | undefined
  for (const tok of rest) {
    if (tok.startsWith("--")) {
      const [k, ...vparts] = tok.slice(2).split("=")
      flags[k] = vparts.length ? vparts.join("=") : true
    } else if (!cmd) cmd = tok
    else {
      const kv = tok.split("=")
      if (kv.length === 2) flags[kv[0]] = kv[1]
    }
  }
  return { cmd, flags }
}

/* ============ CSV helpers (no deps) ============ */
export function writeCSV(rows: Array<Record<string, number | string>>, outPath?: string) {
  const data =
    rows.length > 0
      ? [Object.keys(rows[0]).join(","), ...rows.map((r) => Object.keys(rows[0]).map((h) => String((r as any)[h] ?? "")).join(","))].join(
          "\n",
        ) + "\n"
      : ""
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(process.cwd(), outPath)), { recursive: true })
    fs.writeFileSync(outPath, data, "utf8")
  } else {
    process.stdout.write(data)
  }
}

/* ============ Equity curve helpers (no deps) ============ */
type CurvePt = { date: string; equity: number }

function ensureDir(d: string) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
}
export function normalizeCurve(curve: Array<{ date?: any; equity?: any }>): CurvePt[] {
  return (curve || [])
    .filter((p) => p && p.date != null && p.equity != null)
    .map((p) => ({ date: String(p.date), equity: Number(p.equity) }))
    .filter((p) => Number.isFinite(p.equity))
}
export function saveEquityCSV(curve: CurvePt[], outPath: string) {
  const lines = ["date,equity", ...curve.map((p) => `${p.date},${p.equity}`)]
  ensureDir(path.dirname(outPath))
  fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8")
}

export function printAsciiChart(values: number[], opts?: { height?: number; width?: number; leftPad?: number; title?: string }) {
  if (!values.length) {
    console.log("(no equity curve)")
    return
  }
  const height = Math.max(3, Math.floor(opts?.height ?? 12))
  const width = Math.max(10, Math.floor(opts?.width ?? 80))
  const leftPad = " ".repeat(Math.max(0, Math.floor(opts?.leftPad ?? 2)))

  const n = values.length
  const step = Math.max(1, Math.floor(n / width))
  const s: number[] = []
  for (let i = 0; i < n; i += step) s.push(values[i])

  const lo = Math.min(...s)
  const hi = Math.max(...s)
  const span = hi - lo || 1

  const rows: string[] = []
  if (opts?.title) rows.push(`${leftPad}${opts.title}`)
  for (let r = 0; r < height; r++) {
    let line = `${leftPad}|`
    for (let x = 0; x < s.length; x++) {
      const bucket = Math.round((hi - s[x]) * (height - 1) / span)
      line += bucket === r ? "●" : " "
    }
    rows.push(line)
  }
  rows.push(`${leftPad}+${"-".repeat(s.length)}`)
  console.log(rows.join("\n"))
}   