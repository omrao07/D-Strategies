// commands/factors.ts
// Zero-dependency factor registry + scorer with a tiny CLI-style command handler.
// Designed to live in `commands/*` alongside other command modules (no imports).
//
// What this gives you:
// - Define factors as weighted bundles of signals (e.g., value, momentum, quality)
// - Combine by z-score, rank, or plain weighted-sum
// - Optional winsorization per signal to tame outliers
// - Programmatic scoring across a cross-section (universe) of securities
// - Snapshot/export/import + CRUD (add/upsert/show/list/rm)
// - CLI-ish helper: runFactorsCommand(["list" | "show name" | "score name --json '{...}'" | ...])
//
// Programmatic usage:
//   import { factors, scoreFactor, runFactorsCommand } from "./commands/factors";
//   factors.upsert(SeedFactors.value); // or your own
//   const data = { AAPL: { pe: 30, pb: 12, dy: 0.006 }, MSFT: { pe: 35, pb: 13, dy: 0.008 } };
//   const res = scoreFactor("value", data); // ranks best to worst
//
// CLI-ish usage (wire argv yourself):
//   runFactorsCommand(["list"])
//   runFactorsCommand(["show","value"])
//   runFactorsCommand(["score","momentum","--json", '{"AAPL":{"mom12m":0.25,"mom1m":-0.02}}'])

type Num = number;

export type Direction = "higher" | "lower";
export type Combine = "zscore" | "rank" | "weighted-sum";
export type Normalize = "z" | "minmax" | "none";

export interface Signal {
  key: string;                 // metric name in your cross-sectional data (e.g., "pe", "mom12m")
  weight?: number;             // default 1
  direction?: Direction;       // default "higher" (if "lower", signal is flipped)
  winsor?: { pLow?: number; pHigh?: number }; // optional winsorization percentiles (0..1)
}

export interface FactorConfig {
  name: string;                // unique id
  description?: string;
  signals: Signal[];
  combine?: Combine;           // default "zscore"
  normalize?: Normalize;       // post-combination normalization for output scoring (default "none")
  long?: boolean;              // default true
  short?: boolean;             // default false
  rebalanceDays?: number;      // optional metadata
  universeHint?: string;       // optional note (e.g., "NIFTY500")
  disabled?: boolean;
  notes?: string;
}

export interface FactorSnapshot {
  version: 1;
  savedAt: string;
  items: FactorConfig[];
  default?: string;
}

// ---------- Registry ----------

class FactorRegistry {
  private map = new Map<string, FactorConfig>();
  private _default?: string;

  add(cfg: FactorConfig): FactorConfig {
    const v = this.validate(normalize(cfg));
    if (this.map.has(v.name)) throw new Error(`Factor "${v.name}" already exists`);
    this.map.set(v.name, v);
    if (!this._default) this._default = v.name;
    return v;
  }
  upsert(cfg: FactorConfig): FactorConfig {
    const v = this.validate(normalize(cfg));
    this.map.set(v.name, v);
    if (!this._default) this._default = v.name;
    return v;
  }
  get(name: string): FactorConfig | undefined { return this.map.get(name); }
  has(name: string): boolean { return this.map.has(name); }
  list(includeDisabled = true): FactorConfig[] {
    const arr = Array.from(this.map.values());
    return sortFactors(includeDisabled ? arr : arr.filter(f => !f.disabled));
  }
  remove(name: string): boolean {
    const ok = this.map.delete(name);
    if (ok && this._default === name) this._default = this.list(true)[0]?.name;
    return ok;
  }
  setDefault(name: string): void {
    if (!this.map.has(name)) throw new Error(`Unknown factor "${name}"`);
    this._default = name;
  }
  getDefault(): string | undefined {
    if (this._default && this.map.has(this._default)) return this._default;
    const first = this.list(false)[0]?.name ?? this.list(true)[0]?.name;
    this._default = first;
    return this._default;
  }
  snapshot(): FactorSnapshot {
    return { version: 1, savedAt: new Date().toISOString(), items: this.list(true), default: this._default };
  }
  exportJSON(pretty = false): string { return JSON.stringify(this.snapshot(), null, pretty ? 2 : 0); }
  restore(snap: FactorSnapshot): void {
    if (!snap || snap.version !== 1) throw new Error("Unsupported snapshot version");
    this.map.clear();
    for (const it of snap.items) this.upsert(it);
    if (snap.default) this._default = this.map.has(snap.default) ? snap.default : this._default;
  }
  importJSON(json: string, { replace = false } = {}): void {
    const obj = JSON.parse(json);
    if (obj && obj.version === 1 && Array.isArray(obj.items)) {
      if (replace) this.map.clear();
      this.restore(obj as FactorSnapshot);
      return;
    }
    if (obj && Array.isArray(obj.items)) {
      if (replace) this.map.clear();
      for (const it of obj.items) this.upsert(it);
      return;
    }
    throw new Error("Invalid JSON payload for factor import");
  }

  private validate(f: FactorConfig): FactorConfig {
    if (!f.name || typeof f.name !== "string") throw new Error("name required");
    if (!Array.isArray(f.signals) || f.signals.length === 0) throw new Error("signals[] required (non-empty)");
    for (const s of f.signals) if (!s.key || typeof s.key !== "string") throw new Error("signal.key required");
    return f;
  }
}

export const factors = new FactorRegistry();

// ---------- Scoring ----------

export type CrossSection = Record<string, Record<string, number>>; // { TICKER: { metric: value, ... }, ... }

export interface ScoreRow {
  id: string;
  raw: number;           // combined raw (before final normalize)
  score: number;         // final score (after factor.normalize)
  rank: number;          // 1 = best
  pct: number;           // 0..1 (1 = best)
  components: Record<string, number>; // per-signal standardized & weighted contribution
}

export interface ScoreResult {
  factor: string;
  combine: Combine;
  normalize: Normalize;
  rows: ScoreRow[];      // sorted best -> worst
  stats: { n: number; long: boolean; short: boolean };
}

/** Score a factor against a cross-section (universe). */
export function scoreFactor(factorName: string, data: CrossSection): ScoreResult {
  const f = factors.get(factorName);
  if (!f) throw new Error(`Unknown factor "${factorName}"`);
  return scoreWithConfig(f, data);
}

export function scoreWithConfig(cfg: FactorConfig, data: CrossSection): ScoreResult {
  const ids = Object.keys(data);
  if (!ids.length) return emptyResult(cfg);
  const combine = (cfg.combine ?? "zscore") as Combine;
  const outNormalize = (cfg.normalize ?? "none") as Normalize;

  // Collect per-signal vectors
  const sigs = cfg.signals.map(s => ({
    key: s.key,
    weight: s.weight ?? 1,
    direction: s.direction ?? "higher",
    winsor: s.winsor,
    vec: ids.map(id => toNum(data[id]?.[s.key])),
  }));

  // Winsorize and standardize per signal -> standardized values st[i][j]
  const st: number[][] = [];
  for (let j = 0; j < sigs.length; j++) {
    const v = sigs[j].vec.slice();
    const wcfg = sigs[j].winsor;
    const wv = wcfg ? winsorize(v, wcfg.pLow ?? 0.01, wcfg.pHigh ?? 0.99) : v;
    const dir = sigs[j].direction;
    // Flip if "lower is better": multiply by -1
    const flipped = dir === "lower" ? wv.map(x => isFinite(x) ? -x : x) : wv;
    let standardized: number[];
    if (combine === "rank") {
      standardized = rankToZ(flipped); // ranks converted to ~z for smoother sum
    } else if (combine === "zscore") {
      standardized = zscore(flipped);
    } else {
      standardized = flipped.map(x => (Number.isFinite(x) ? x : NaN)); // weighted-sum on raw
    }
    st.push(standardized);
  }

  // Combine with weights
  const weights = normalizeWeights(sigs.map(s => s.weight));
  const rawCombined: number[] = new Array(ids.length).fill(0);
  const components: Array<Record<string, number>> = new Array(ids.length).fill(null as any).map(() => ({}));
  for (let j = 0; j < sigs.length; j++) {
    const w = weights[j];
    const key = sigs[j].key;
    for (let i = 0; i < ids.length; i++) {
      const contrib = st[j][i] * w;
      rawCombined[i] += Number.isFinite(contrib) ? contrib : 0;
      components[i][key] = round4(Number.isFinite(contrib) ? contrib : 0);
    }
  }

  // Final normalize (optional)
  const final = outNormalize === "z" ? zscore(rawCombined)
              : outNormalize === "minmax" ? minmax(rawCombined)
              : rawCombined.slice();

  // Rank best to worst (higher = better)
  const order = argsortDesc(final);
  const ranked: ScoreRow[] = [];
  for (let r = 0; r < order.length; r++) {
    const i = order[r];
    const pct = order.length > 1 ? r / (order.length - 1) : 1; // 0 best? We'll map 1 best for intuition
    ranked.push({
      id: ids[i],
      raw: round6(rawCombined[i]),
      score: round6(final[i]),
      rank: r + 1,
      pct: round6(1 - pct), // 1 = best percentile
      components: components[i],
    });
  }

  return {
    factor: cfg.name,
    combine,
    normalize: outNormalize,
    rows: ranked,
    stats: { n: ranked.length, long: cfg.long !== false, short: !!cfg.short },
  };
}

// ---------- Seeds (edit freely) ----------

export const SeedFactors: Record<string, FactorConfig> = {
  value: {
    name: "value",
    description: "Composite value (low PE, low PB, high DY).",
    signals: [
      { key: "pe",  weight: 1, direction: "lower", winsor: { pLow: 0.01, pHigh: 0.99 } },
      { key: "pb",  weight: 1, direction: "lower", winsor: { pLow: 0.01, pHigh: 0.99 } },
      { key: "dy",  weight: 1, direction: "higher", winsor: { pLow: 0.01, pHigh: 0.99 } },
    ],
    combine: "zscore",
    normalize: "z",
    long: true,
    short: true,
    notes: "Provide dy as decimal (e.g., 0.03 = 3%).",
  },
  momentum: {
    name: "momentum",
    description: "12-1 momentum (higher = better), slight penalty to 1m reversal.",
    signals: [
      { key: "mom12m", weight: 1.0, direction: "higher", winsor: { pLow: 0.01, pHigh: 0.99 } },
      { key: "mom1m",  weight: 0.3, direction: "lower",  winsor: { pLow: 0.01, pHigh: 0.99 } },
    ],
    combine: "zscore",
    normalize: "z",
    long: true,
    short: true,
  },
  quality: {
    name: "quality",
    description: "High ROE/GM, low leverage.",
    signals: [
      { key: "roe", weight: 1.0, direction: "higher", winsor: { pLow: 0.02, pHigh: 0.98 } },
      { key: "gm",  weight: 0.7, direction: "higher", winsor: { pLow: 0.02, pHigh: 0.98 } },
      { key: "lev", weight: 0.7, direction: "lower",  winsor: { pLow: 0.02, pHigh: 0.98 } },
    ],
    combine: "zscore",
    normalize: "z",
    long: true,
    short: true,
  },
  lowvol: {
    name: "lowvol",
    description: "Lower realized volatility preferred.",
    signals: [{ key: "vol20d", weight: 1, direction: "lower", winsor: { pLow: 0.01, pHigh: 0.99 } }],
    combine: "rank",
    normalize: "none",
    long: true,
    short: true,
  },
  size: {
    name: "size",
    description: "Smaller market cap preferred (SMB style).",
    signals: [{ key: "mcap", weight: 1, direction: "lower", winsor: { pLow: 0.01, pHigh: 0.99 } }],
    combine: "rank",
    normalize: "none",
    long: true,
    short: true,
  },
  growth: {
    name: "growth",
    description: "Revenue/EPS growth higher is better.",
    signals: [
      { key: "rev_g", weight: 1, direction: "higher", winsor: { pLow: 0.02, pHigh: 0.98 } },
      { key: "eps_g", weight: 1, direction: "higher", winsor: { pLow: 0.02, pHigh: 0.98 } },
    ],
    combine: "zscore",
    normalize: "z",
    long: true,
    short: true,
  },
};

// preload seeds safely
for (const k in SeedFactors) {
  try { factors.upsert(SeedFactors[k]); } catch { /* ignore */ }
}

// ---------- CLI-ish command ----------

export function runFactorsCommand(argv: string[]): string {
  const args = parseArgv(argv);
  const cmd = String(args._[0] ?? "help").toLowerCase();

  try {
    switch (cmd) {
      case "help":
        return help();
      case "list": {
        const rows = factors.list(true).map(f => ({
          name: f.name + (factors.getDefault() === f.name ? " *" : ""),
          signals: f.signals.length,
          combine: f.combine ?? "zscore",
          normalize: f.normalize ?? "none",
          long: f.long === false ? "" : "✓",
          short: f.short ? "✓" : "",
          disabled: f.disabled ? "✓" : "",
        }));
        return table(rows, ["name","signals","combine","normalize","long","short","disabled"]);
      }
      case "show": {
        const name = String(args._[1] ?? args.name ?? "");
        if (!name) return "Usage: show <name>";
        const f = factors.get(name);
        if (!f) return `Factor "${name}" not found.`;
        return pretty(f);
      }
      case "add":
      case "upsert": {
        const cfg = collectConfig(args);
        (cmd === "add" ? factors.add(cfg) : factors.upsert(cfg));
        return `Saved factor "${cfg.name}".`;
      }
      case "rm":
      case "remove": {
        const name = String(args._[1] ?? args.name ?? "");
        if (!name) return "Usage: rm <name>";
        const ok = factors.remove(name);
        return ok ? `Removed "${name}".` : `Factor "${name}" not found.`;
      }
      case "set-default": {
        const name = String(args._[1] ?? args.name ?? "");
        if (!name) return "Usage: set-default <name>";
        factors.setDefault(name);
        return `Default factor set to "${name}".`;
      }
      case "export": {
        const prettyOut = !!args.pretty || !!args.p;
        return factors.exportJSON(prettyOut);
      }
      case "import": {
        const payload = String(args.json ?? args._[1] ?? "");
        if (!payload) return `Usage: import --json '<snapshot|{items:[]}> ' [--replace]`;
        factors.importJSON(payload, { replace: !!args.replace });
        return `Imported ${factors.list(true).length} factors.`;
      }
      case "score": {
        const name = String(args._[1] ?? args.name ?? "");
        if (!name) return "Usage: score <name> --json '{ TICKER:{metric:value,...}, ... }' [--top N] [--bottom N]";
        const raw = String(args.json ?? "");
        if (!raw) return "Provide --json cross-section payload.";
        const sec = JSON.parse(raw) as CrossSection;
        const res = scoreFactor(name, sec);
        const top = toInt(args.top, 0);
        const bottom = toInt(args.bottom, 0);
        const rows = sliceTopBottom(res.rows, top, bottom);
        const tableRows = rows.map(r => ({
          id: r.id,
          rank: r.rank,
          score: numFmt(r.score),
          raw: numFmt(r.raw),
          pct: numFmt(r.pct),
        }));
        return [
          `factor=${res.factor} combine=${res.combine} normalize=${res.normalize} n=${res.stats.n}`,
          table(tableRows, ["id","rank","score","raw","pct"]),
        ].join("\n");
      }
      default:
        return `Unknown subcommand "${cmd}".\n` + help();
    }
  } catch (e) {
    return `Error: ${errToString(e)}`;
  }
}

// ---------- Helpers ----------

function normalize(f: FactorConfig): FactorConfig {
  const copy: FactorConfig = { ...f };
  copy.name = copy.name.trim();
  copy.combine = (copy.combine ?? "zscore") as Combine;
  copy.normalize = (copy.normalize ?? "none") as Normalize;
  copy.long = copy.long !== false;
  copy.short = !!copy.short;
  copy.signals = (copy.signals ?? []).map(s => ({
    key: s.key.trim(),
    weight: Number.isFinite(s.weight as number) ? (s.weight as number) : 1,
    direction: (s.direction ?? "higher") as Direction,
    winsor: s.winsor ? { pLow: clamp01(s.winsor.pLow ?? 0), pHigh: clamp01(s.winsor.pHigh ?? 1) } : undefined,
  }));
  return copy;
}

function sortFactors(arr: FactorConfig[]): FactorConfig[] {
  return arr.slice().sort((a,b) => a.name.localeCompare(b.name));
}

function emptyResult(cfg: FactorConfig): ScoreResult {
  return { factor: cfg.name, combine: (cfg.combine ?? "zscore") as Combine, normalize: (cfg.normalize ?? "none") as Normalize, rows: [], stats: { n: 0, long: cfg.long !== false, short: !!cfg.short } };
}

function toNum(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function argsortDesc(a: number[]): number[] {
  return a.map((v,i)=>[v,i] as [number,number]).sort((x,y)=> (y[0]-x[0]) || (x[1]-y[1]) ).map(p=>p[1]);
}

function zscore(a: number[]): number[] {
  const xs = a.filter(Number.isFinite);
  const m = mean(xs);
  const s = stdev(xs);
  return a.map(v => Number.isFinite(v) ? (s > 0 ? (v - m) / s : 0) : NaN);
}

function minmax(a: number[]): number[] {
  const xs = a.filter(Number.isFinite);
  if (!xs.length) return a.map(_=>NaN);
  const lo = Math.min(...xs), hi = Math.max(...xs);
  const span = hi - lo;
  return a.map(v => Number.isFinite(v) ? (span > 0 ? (v - lo) / span : 0.5) : NaN);
}

function rankToZ(a: number[]): number[] {
  const xs = a.map((v,i)=>({v,i})).filter(x=>Number.isFinite(x.v));
  xs.sort((x,y)=> x.v - y.v); // ascending
  // convert rank to z via inverse-normal approx: z ~ Phi^-1((rank+1)/(n+1))
  const n = xs.length;
  const out = new Array(a.length).fill(NaN);
  for (let r=0;r<n;r++) {
    const p = (r+1)/(n+1);
    out[xs[r].i] = invNormApprox(p);
  }
  return out;
}

function winsorize(a: number[], pLow: number, pHigh: number): number[] {
  const xs = a.filter(Number.isFinite).slice().sort((x,y)=>x-y);
  if (!xs.length) return a.map(()=>NaN);
  const lo = quantile(xs, clamp01(pLow));
  const hi = quantile(xs, clamp01(pHigh));
  return a.map(v => Number.isFinite(v) ? clamp(v, lo, hi) : NaN);
}

function normalizeWeights(ws: number[]): number[] {
  const xs = ws.map(x => (Number.isFinite(x) ? Math.max(0, x) : 0));
  const s = xs.reduce((p,c)=>p+c,0);
  if (s === 0) return xs.map(() => 1 / xs.length);
  return xs.map(x => x / s);
}

function sliceTopBottom(rows: ScoreRow[], top: number, bottom: number): ScoreRow[] {
  if (!top && !bottom) return rows;
  const out: ScoreRow[] = [];
  if (top > 0) out.push(...rows.slice(0, top));
  if (bottom > 0) out.push(...rows.slice(Math.max(0, rows.length - bottom)));
  return out;
}

// ---------- Math utils ----------

function mean(a: number[]): number { return a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0; }
function stdev(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a); let s=0; for (const x of a) s += (x-m)*(x-m);
  return Math.sqrt(s/(a.length-1));
}
function quantile(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (q <= 0) return sorted[0];
  if (q >= 1) return sorted[n-1];
  const pos = (n-1)*q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const w = pos - lo;
  return sorted[lo]*(1-w) + sorted[hi]*w;
}
function invNormApprox(p: number): number {
  // Acklam's inverse CDF approximation (good enough for ranking)
  // constants
  const a=[-3.969683028665376e+01,2.209460984245205e+02,-2.759285104469687e+02,1.383577518672690e+02,-3.066479806614716e+01,2.506628277459239e+00];
  const b=[-5.447609879822406e+01,1.615858368580409e+02,-1.556989798598866e+02,6.680131188771972e+01,-1.328068155288572e+01];
  const c=[-7.784894002430293e-03,-3.223964580411365e-01,-2.400758277161838e+00,-2.549732539343734e+00,4.374664141464968e+00,2.938163982698783e+00];
  const d=[7.784695709041462e-03,3.224671290700398e-01,2.445134137142996e+00,3.754408661907416e+00];
  const pl=0.02425, ph=1-pl;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2*Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (ph < p) {
    q = Math.sqrt(-2*Math.log(1-p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
            ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else {
    q = p-0.5; r=q*q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  }
}

// ---------- tiny argv & formatting ----------

type Argv = { _: string[]; [k: string]: any };

function parseArgv(argv: string[]): Argv {
  const out: Argv = { _: [] };
  let k: string | null = null;
  for (const raw of argv) {
    const a = String(raw);
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) { out[a.slice(2,eq)] = coerce(a.slice(eq+1)); k = null; }
      else { k = a.slice(2); out[k] = true; }
    } else if (a.startsWith("-") && a.length > 2) {
      for (let i=1;i<a.length;i++) out[a[i]] = true;
      k = null;
    } else if (a.startsWith("-")) {
      k = a.slice(1); out[k] = true;
    } else {
      if (k && out[k] === true) { out[k] = coerce(a); k = null; }
      else out._.push(a);
    }
  }
  return out;
}
function coerce(x: string) {
  if (x === "true") return true;
  if (x === "false") return false;
  if (!Number.isNaN(Number(x)) && x.trim() !== "") return Number(x);
  try { return JSON.parse(x); } catch { /* not JSON */ }
  return x;
}
function help(): string {
  return [
    "factors <subcommand>",
    "",
    "Subcommands:",
    "  list                                       List factors",
    "  show <name>                                Show full config",
    "  add|upsert --name n --signals '[...]'      Save factor (signals JSON array)",
    "      [--combine zscore|rank|weighted-sum] [--normalize z|minmax|none] [--long] [--short] [--notes '...']",
    "  rm|remove <name>                           Remove factor",
    "  set-default <name>                         Set default factor",
    "  export [--pretty|-p]                       Export snapshot JSON",
    "  import --json '<payload>' [--replace]      Import snapshot JSON",
    "  score <name> --json '{TICKER:{metric:value,...},...}' [--top N] [--bottom N]",
    "",
    "Signals example:",
    `  --signals '[{"key":"pe","weight":1,"direction":"lower"},{"key":"dy","weight":1,"direction":"higher"}]'`,
  ].join("\n");
}
function collectConfig(a: Argv): FactorConfig {
  const name = String(a.name ?? a._[1] ?? "");
  if (!name) throw new Error("add/upsert requires --name");
  const signals = parseSignals(a.signals);
  const combine = a.combine ? String(a.combine) as Combine : undefined;
  const normalizeOut = a.normalize ? String(a.normalize) as Normalize : undefined;
  return {
    name,
    signals,
    combine,
    normalize: normalizeOut,
    long: a.long === undefined ? true : !!a.long,
    short: !!a.short,
    notes: a.notes != null ? String(a.notes) : undefined,
    disabled: !!a.disabled,
  };
}
function parseSignals(src: any): Signal[] {
  if (!src) throw new Error("--signals JSON array required");
  const arr = typeof src === "string" ? JSON.parse(src) : src;
  if (!Array.isArray(arr)) throw new Error("--signals must be JSON array");
  return arr as Signal[];
}
function table(rows: Array<Record<string, any>>, headers: string[]): string {
  if (!rows.length) return "(empty)";
  const cols = headers;
  const widths = cols.map((h,i)=>Math.max(h.length, ...rows.map(r => String(r[cols[i]] ?? "").length)));
  const line = (cells: string[]) => cells.map((c,i)=>String(c).padEnd(widths[i]," ")).join("  ");
  const out: string[] = [];
  out.push(line(cols));
  out.push(line(widths.map(w=>"─".repeat(w))));
  for (const r of rows) out.push(line(cols.map(h=>String(r[h] ?? ""))));
  return out.join("\n");
}
function pretty(x: unknown): string { try { return JSON.stringify(x, null, 2); } catch { return String(x); } }
function errToString(e: unknown): string { if (e instanceof Error) return `${e.name}: ${e.message}`; try { return JSON.stringify(e); } catch { return String(e); } }
function toInt(v: any, d: number): number { const n = Number(v); return Number.isFinite(n) ? Math.floor(n) : d; }
function numFmt(x: number): string { return Number.isFinite(x) ? String(Math.round(x*1e4)/1e4) : ""; }
function clamp01(x?: number): number { const n = Number(x); if (!Number.isFinite(n)) return 0; return Math.min(1, Math.max(0, n)); }
function clamp(x: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, x)); }
function round4(x: number): number { return Math.round(x*1e4)/1e4; }
function round6(x: number): number { return Math.round(x*1e6)/1e6; }

// ------------- Expose minimal API -------------

export type { FactorRegistry as Factors };
export function addFactor(cfg: FactorConfig): FactorConfig { return factors.add(cfg); }
export function upsertFactor(cfg: FactorConfig): FactorConfig { return factors.upsert(cfg); }
export function getFactor(name: string): FactorConfig | undefined { return factors.get(name); }
export function listFactors(includeDisabled = true): FactorConfig[] { return factors.list(includeDisabled); }
export function setDefaultFactor(name: string): void { factors.setDefault(name); }
export function exportFactors(pretty = false): string { return factors.exportJSON(pretty); }
export function importFactors(json: string, opts?: { replace?: boolean }) { factors.importJSON(json, opts); }
