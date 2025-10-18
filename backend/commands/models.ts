// commands/models.ts
// Clean, dependency-free model registry + CLI for cross-section scoring.
// Models: linear (ridge), weighted, rank, tree-stub.

//////////////////////////////
// Types
//////////////////////////////

export type ModelKind = "linear" | "rank" | "weighted" | "tree-stub";

export interface ModelConfig {
  name: string;
  kind: ModelKind;
  description?: string;
  features: string[];

  // weighted
  weights?: Record<string, number>;

  // linear
  fit?: {
    intercept?: boolean;
    l2?: number;
    standardize?: boolean;
    clipWeights?: number;
  };

  // tree
  tree?: Array<{ feature: string; thresh: number; left: number; right: number }>;

  notes?: string;
  disabled?: boolean;
}

export interface ModelState {
  coef?: Record<string, number>;
  intercept?: number;
  trainedAt?: string;
  nTrain?: number;
  fitStats?: { mse?: number; r2?: number };
}

export interface Model extends ModelConfig { state?: ModelState }
export interface Snapshot { version: 1; savedAt: string; default?: string; items: Model[] }

export type CrossSection = Record<string, Record<string, number>>;
export type Targets = Record<string, number>;

export interface PredRow { id: string; score: number; rank: number; pct: number; details?: Record<string, number> }
export interface PredictResult { model: string; rows: PredRow[]; stats: { n: number } }

//////////////////////////////
// Registry
//////////////////////////////

class ModelRegistry {
  private map = new Map<string, Model>();
  private def?: string;

  add(m: Model): Model {
    const v = this.validate(normalizeModel(m));
    if (this.map.has(v.name)) throw new Error(`Model "${v.name}" already exists`);
    this.map.set(v.name, v);
    this.def ??= v.name;
    return v;
  }
  upsert(m: Model): Model {
    const v = this.validate(normalizeModel(m));
    const prev = this.map.get(v.name);
    if (prev && !v.state) v.state = prev.state;
    this.map.set(v.name, v);
    this.def ??= v.name;
    return v;
  }
  get(name: string) { return this.map.get(name); }
  list(includeDisabled = true): Model[] {
    return [...this.map.values()]
      .filter(m => includeDisabled || !m.disabled)
      .sort((a,b)=>a.name.localeCompare(b.name));
  }
  remove(name: string) {
    const ok = this.map.delete(name);
    if (ok && this.def === name) this.def = this.list(true)[0]?.name;
    return ok;
  }
  setDefault(name: string) {
    if (!this.map.has(name)) throw new Error(`Unknown model "${name}"`);
    this.def = name;
  }
  getDefault(): string | undefined {
    if (this.def && this.map.has(this.def)) return this.def;
    const first = this.list(false)[0]?.name ?? this.list(true)[0]?.name;
    this.def = first;
    return this.def;
  }
  snapshot(): Snapshot {
    return { version: 1, savedAt: isoNow(), default: this.def, items: this.list(true) };
  }
  exportJSON(pretty=false) { return JSON.stringify(this.snapshot(), null, pretty ? 2 : 0); }
  restore(s: Snapshot) {
    if (!s || s.version !== 1) throw new Error("Unsupported snapshot");
    this.map.clear();
    for (const it of s.items) this.upsert(it);
    if (s.default && this.map.has(s.default)) this.def = s.default;
  }
  importJSON(json: string, opts: { replace?: boolean } = {}) {
    const o = JSON.parse(json);
    if (o?.version === 1 && Array.isArray(o.items)) {
      if (opts.replace) this.map.clear();
      this.restore(o as Snapshot);
      return;
    }
    if (Array.isArray(o?.items)) {
      if (opts.replace) this.map.clear();
      for (const it of o.items) this.upsert(it as Model);
      return;
    }
    throw new Error("Invalid import payload");
  }

  private validate(m: Model): Model {
    if (!m.name?.trim()) throw new Error("name required");
    if (!m.kind) throw new Error("kind required");
    if (!Array.isArray(m.features) || m.features.length === 0) throw new Error("features[] required");
    if (m.kind === "weighted" && !m.weights) throw new Error("weighted model requires weights{}");
    return m;
  }
}

export const models = new ModelRegistry();

//////////////////////////////
// Seed models
//////////////////////////////

export const SeedModels: Record<string, Model> = {
  linear_value: {
    name: "linear_value",
    kind: "linear",
    description: "Linear ridge: low PE/PB, high DY → higher score",
    features: ["pe","pb","dy"],
    fit: { intercept: true, l2: 0, standardize: true, clipWeights: 10 },
    notes: "dy as decimal (0.03 = 3%)",
  },
  rank_mom: {
    name: "rank_mom",
    kind: "rank",
    description: "mom12m − mom1m (penalize reversal)",
    features: ["mom12m","mom1m"],
  },
  weighted_quality: {
    name: "weighted_quality",
    kind: "weighted",
    description: "Quality: +roe, +gm, −lev",
    features: ["roe","gm","lev"],
    weights: { roe: +1.0, gm: +0.7, lev: -0.7 },
  },
  tree_stub_lowvol: {
    name: "tree_stub_lowvol",
    kind: "tree-stub",
    description: "Prefer low vol + positive momentum",
    features: ["vol20d","mom12m"],
    tree: [
      { feature: "vol20d", thresh: 0.35, left: +0.5, right: -0.5 },
      { feature: "mom12m", thresh: 0.0, left: +0.3, right: -0.3 },
    ],
  },
};
for (const k in SeedModels) { try { models.upsert(SeedModels[k]); } catch {} }

//////////////////////////////
// Public API
//////////////////////////////

export function fitModel(name: string, X: CrossSection, y: Targets): ModelState {
  const m = models.get(name); if (!m) throw new Error(`Unknown model "${name}"`);
  const s = fitWithConfig(m, X, y); m.state = s; return s;
}
export function predictModel(name: string, X: CrossSection): PredictResult {
  const m = models.get(name); if (!m) throw new Error(`Unknown model "${name}"`);
  return predictWithConfig(m, X);
}

//////////////////////////////
// Core fit / predict
//////////////////////////////

type FitOpts = { intercept: boolean; l2: number; standardize: boolean; clipWeights?: number };

function fitWithConfig(cfg: Model, X: CrossSection, y: Targets): ModelState {
  const ids = intersectIds(Object.keys(X), Object.keys(y));
  if (!ids.length) throw new Error("No overlapping IDs between X and y");

  if (cfg.kind === "linear") {
    const opt: FitOpts = normFitOpts(cfg.fit);

    const M = ids.map(id => cfg.features.map(f => num(X[id][f])));
    const Y = ids.map(id => num(y[id]));

    const { Z, means, stds } = opt.standardize
      ? standardizeCols(M)
      : { Z: M, means: zeros(cfg.features.length), stds: ones(cfg.features.length) };

    const A = opt.intercept ? Z.map(r => [1, ...r]) : Z;

    // ridge (AᵀA + λI)w = Aᵀy
    const wStd = ridgeSolve(A, Y, Math.max(0, opt.l2)); // weights in standardized space

    // de-standardize to original feature scale
    let intercept = 0;
    let coefs: number[] = [];
    if (opt.intercept) {
      const w0 = wStd[0];
      const wr = wStd.slice(1);
      coefs = wr.map((c, j) => c / (stds[j] || 1));
      
    } else {
      coefs = wStd.slice();
      intercept = 0;
    }

    // clip if requested
    if (opt.clipWeights != null && Number.isFinite(opt.clipWeights)) {
      const cap = Math.abs(opt.clipWeights);
      coefs = coefs.map(c => clamp(c, -cap, +cap));
      intercept = clamp(intercept, -10 * cap, 10 * cap);
    }

    // fit stats
    const preds = predictLinear(ids, X, cfg.features, coefs, intercept);
    const yy = ids.map(id => num(y[id]));
    const mse = mean(yy.map((t, i) => (t - preds[i]) ** 2));
    const r2  = rSquared(yy, preds);

    return { coef: zip(cfg.features, coefs), intercept, trainedAt: isoNow(), nTrain: ids.length, fitStats: { mse, r2 } };
  }

  if (cfg.kind === "weighted") {
    const raw = cfg.weights || {};
    const ws = normalizeWeights(cfg.features.map(f => raw[f] ?? 0));
    return { coef: zip(cfg.features, ws), intercept: 0, trainedAt: isoNow(), nTrain: ids.length };
  }

  // rank / tree-stub: nothing to fit
  return { trainedAt: isoNow(), nTrain: ids.length };
}

function predictWithConfig(cfg: Model, X: CrossSection): PredictResult {
  const ids = Object.keys(X);
  if (!ids.length) return { model: cfg.name, rows: [], stats: { n: 0 } };

  let scores: number[];

  if (cfg.kind === "linear") {
    const wRec = cfg.state?.coef ?? {};
    const b = cfg.state?.intercept ?? 0;
    const w = cfg.features.map(f => num(wRec[f]));
    scores = predictLinear(ids, X, cfg.features, w, b);
  } else if (cfg.kind === "weighted") {
    const wRec = cfg.state?.coef || cfg.weights || {};
    const w = cfg.features.map(f => num(wRec[f]));
    scores = predictLinear(ids, X, cfg.features, w, 0);
  } else if (cfg.kind === "rank") {
    scores = ids.map(id => {
      let s = 0;
      for (const f of cfg.features) {
        const v = num(X[id][f]);
        s += /(^mom1m$|rev)/i.test(f) ? -v : v;
      }
      return s;
    });
  } else if (cfg.kind === "tree-stub") {
    scores = ids.map(id => (cfg.tree || [])
      .reduce((acc, n) => acc + (num(X[id][n.feature]) <= n.thresh ? n.left : n.right), 0));
  } else {
    scores = ids.map(() => 0);
  }

  const ord = argsortDesc(scores);
  const rows: PredRow[] = ord.map((i, r) => {
    const pct = ord.length > 1 ? 1 - r / (ord.length - 1) : 1;
    const details = Object.fromEntries(cfg.features.map(f => [f, num(X[ids[i]][f])]));
    return { id: ids[i], score: round6(scores[i]), rank: r + 1, pct: round6(pct), details };
  });

  return { model: cfg.name, rows, stats: { n: rows.length } };
}

//////////////////////////////
// Ridge via Cholesky (SPD)
//////////////////////////////

/** Solve (AᵀA + λI) w = Aᵀy. A: n×k. */
function ridgeSolve(A: number[][], y: number[], lambda: number): number[] {
  const n = A.length, k = A[0]?.length || 0;

  const G = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i=0;i<k;i++) for (let j=i;j<k;j++) {
    let s = 0;
    for (let r=0;r<n;r++) s += (A[r][i] || 0) * (A[r][j] || 0);
    G[i][j] = G[j][i] = s + (i === j ? lambda : 0);
  }
  const r = new Array(k).fill(0);
  for (let i=0;i<k;i++) {
    let s = 0; for (let t=0;t<n;t++) s += (A[t][i] || 0) * (y[t] || 0);
    r[i] = s;
  }
  return choleskySolveSPD(G, r);
}

function choleskySolveSPD(G: number[][], b: number[]): number[] {
  const k = G.length;
  const L = Array.from({ length: k }, () => new Array(k).fill(0));

  for (let i=0;i<k;i++) {
    for (let j=0;j<=i;j++) {
      let s = G[i][j];
      for (let p=0;p<j;p++) s -= L[i][p] * L[j][p];
      if (i === j) {
        if (s <= 1e-18) s = 1e-18;
        L[i][j] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  // forward: L z = b
  const z = new Array(k).fill(0);
  for (let i=0;i<k;i++) {
    let s = b[i];
    for (let p=0;p<i;p++) s -= L[i][p] * z[p];
    z[i] = s / L[i][i];
  }
  // back: Lᵀ x = z
  const x = new Array(k).fill(0);
  for (let i=k-1;i>=0;i--) {
    let s = z[i];
    for (let p=i+1;p<k;p++) s -= L[p][i] * x[p];
    x[i] = s / L[i][i];
  }
  return x;
}

//////////////////////////////
// Helpers
//////////////////////////////

function normalizeModel(m: Model): Model {
  const c: Model = { ...m };
  c.name = c.name.trim();
  c.features = (c.features ?? []).map(f => String(f).trim());
  if (c.kind === "weighted") {
    const raw = c.weights || {};
    c.weights = Object.fromEntries(c.features.map(f => [f, num(raw[f])]));
  }
  if (c.kind === "linear") c.fit = normFitOpts(c.fit);
  return c;
}
function normFitOpts(f?: ModelConfig["fit"]): FitOpts {
  return {
    intercept: f?.intercept !== false,
    l2: isFiniteNum(f?.l2) ? Math.max(0, Number(f!.l2)) : 0,
    standardize: f?.standardize !== false,
    clipWeights: isFiniteNum(f?.clipWeights) ? Number(f!.clipWeights) : undefined,
  };
}

function predictLinear(ids: string[], X: CrossSection, feats: string[], w: number[], b: number): number[] {
  return ids.map(id => {
    let s = b;
    for (let j=0;j<feats.length;j++) s += num(X[id][feats[j]]) * (w[j] || 0);
    return s;
  });
}

/** Fixed the typo: proper `for (let j = 0; j < cols; j++)` loop. */
function standardizeCols(M: number[][]): { Z: number[][]; means: number[]; stds: number[] } {
  const rows = M.length; const cols = M[0]?.length || 0;
  const means = new Array(cols).fill(0);
  const stds  = new Array(cols).fill(1);

  for (let j = 0; j < cols; j++) {
    let sumCol = 0; for (let i=0;i<rows;i++) sumCol += M[i][j];
    const mean = rows ? sumCol / rows : 0;
    means[j] = mean;
    let varCol = 0; for (let i=0;i<rows;i++){ const d = M[i][j] - mean; varCol += d*d; }
    stds[j] = rows ? Math.sqrt(varCol / rows) || 1 : 1;
  }

  const Z = M.map(r => r.map((v,j) => (v - means[j]) / (stds[j] || 1)));
  return { Z, means, stds };
}

function intersectIds(a: string[], b: string[]): string[] { const set = new Set(b); return a.filter(x => set.has(x)); }
function normalizeWeights(ws: number[]): number[] {
  const xs = ws.map(v => (isFiniteNum(v) ? v : 0));
  const s = xs.reduce((p,c)=>p+Math.abs(c),0);
  return s ? xs.map(v => v/s) : xs.map(()=>0);
}
function zip(keys: string[], vals: number[]): Record<string, number> { const o: Record<string, number> = {}; for (let i=0;i<keys.length;i++) o[keys[i]] = Number(vals[i] ?? 0); return o; }
function argsortDesc(a: number[]): number[] { return a.map((v,i)=>[v,i] as [number,number]).sort((x,y)=> (y[0]-x[0]) || (x[1]-y[1]) ).map(p=>p[1]); }

function num(v: any): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function mean(a: number[]): number { return a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0; }
function rSquared(y: number[], yhat: number[]): number { const m = mean(y); let ssr=0, sst=0; for (let i=0;i<y.length;i++){ const e=y[i]-yhat[i]; ssr+=e*e; const d=y[i]-m; sst+=d*d; } return sst>0 ? 1-ssr/sst : 0; }
function round6(x: number): number { return Math.round(x*1e6)/1e6; }
function clamp(x: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, x)); }
function zeros(n: number) { return new Array(n).fill(0); }
function ones(n: number) { return new Array(n).fill(1); }
function isFiniteNum(x: any): x is number { return typeof x === "number" && Number.isFinite(x); }
function isoNow() { return new Date().toISOString(); }

//////////////////////////////
// CLI
//////////////////////////////

type Argv = { _: string[]; [k: string]: any };

export function runModelsCommand(argv: string[]): string {
  const args = parseArgv(argv);
  const cmd = String(args._[0] ?? "help").toLowerCase();

  try {
    switch (cmd) {
      case "help": return help();
      case "list": {
        const rows = models.list(true).map(m => ({
          name: m.name + (models.getDefault() === m.name ? " *" : ""),
          kind: m.kind,
          feats: m.features.length,
          trained: m.state?.trainedAt ? "✓" : "",
          disabled: m.disabled ? "✓" : "",
        }));
        return table(rows, ["name","kind","feats","trained","disabled"]);
      }
      case "show": {
        const name = String(args._[1] ?? args.name ?? "");
        if (!name) return "Usage: show <name>";
        const m = models.get(name); return m ? pretty(m) : `Model "${name}" not found.`;
      }
      case "add":
      case "upsert": {
        const name = String(args.name ?? args._[1] ?? "");
        if (!name) throw new Error("add/upsert requires --name");
        const kind = String(args.kind ?? args.type ?? "linear") as ModelKind;
        const features = parseStrList(args.features);
        if (!features.length) throw new Error("--features 'f1,f2,...' required");
        const cfg: Model = { name, kind, features };
        if (args.description) cfg.description = String(args.description);
        if (args.notes) cfg.notes = String(args.notes);
        cfg.disabled = !!args.disabled;
        if (kind === "weighted") cfg.weights = parseRecord(args.weights);
        if (kind === "linear") cfg.fit = {
          intercept: args.intercept === undefined ? true : !!args.intercept,
          l2: isFiniteNum(args.l2) ? Number(args.l2) : 0,
          standardize: args.standardize === undefined ? true : !!args.standardize,
          clipWeights: isFiniteNum(args.clip) ? Number(args.clip) : undefined,
        };
        if (kind === "tree-stub") cfg.tree = parseArray(args.tree);
        (cmd === "add" ? models.add(cfg) : models.upsert(cfg));
        return `Saved model "${cfg.name}".`;
      }
      case "rm":
      case "remove": {
        const name = String(args._[1] ?? args.name ?? "");
        if (!name) return "Usage: rm <name>";
        return models.remove(name) ? `Removed "${name}".` : `Model "${name}" not found.`;
      }
      case "set-default": {
        const name = String(args._[1] ?? args.name ?? "");
        if (!name) return "Usage: set-default <name>";
        models.setDefault(name); return `Default model set to "${name}".`;
      }
      case "export": {
        return models.exportJSON(!!args.pretty || !!args.p);
      }
      case "import": {
        const payload = String(args.json ?? args._[1] ?? "");
        if (!payload) return `Usage: import --json '<snapshot|{items:[]}> ' [--replace]`;
        models.importJSON(payload, { replace: !!args.replace });
        return `Imported ${models.list(true).length} models.`;
      }
      case "fit": {
        const name = String(args._[1] ?? args.name ?? "");
        if (!name) return "Usage: fit <name> --X '<json>' --y '<json>'";
        const X = parseObj(args.X ?? args.x, "X");
        const Y = parseObj(args.y ?? args.Y, "y");
        const st = fitModel(name, X, Y);
        return pretty({ ok: true, state: st });
      }
      case "predict": {
        const name = String(args._[1] ?? args.name ?? "");
        if (!name) return "Usage: predict <name> --X '<json>' [--top N] [--bottom N]";
        const X = parseObj(args.X ?? args.x, "X");
        const res = predictModel(name, X);
        const top = toInt(args.top, 0), bottom = toInt(args.bottom, 0);
        const rows = pickTopBottom(res.rows, top, bottom)
          .map(r => ({ id:r.id, rank:r.rank, score:numFmt(r.score), pct:numFmt(r.pct) }));
        const header = `model=${res.model} n=${res.stats.n}`;
        return [header, table(rows, ["id","rank","score","pct"])].join("\n");
      }
      default:
        return `Unknown subcommand "${cmd}".\n` + help();
    }
  } catch (e) {
    return `Error: ${errToString(e)}`;
  }
}

//////////////////////////////
// CLI helpers
//////////////////////////////

function parseArgv(argv: string[]): Argv {
  const out: Argv = { _: [] }; let k: string | null = null;
  for (const raw of argv) {
    const a = String(raw);
    if (a.startsWith("--")) {
      const eq = a.indexOf("="); if (eq > -1) { out[a.slice(2,eq)] = coerce(a.slice(eq+1)); k = null; }
      else { k = a.slice(2); out[k] = true; }
    } else if (a.startsWith("-") && a.length > 2) {
      for (let i=1;i<a.length;i++) out[a[i]] = true; k = null;
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
  try { return JSON.parse(x); } catch { return x; }
}
function parseStrList(x: any): string[] { if (x == null) return []; if (Array.isArray(x)) return x.map(String); return String(x).split(",").map(s=>s.trim()).filter(Boolean); }
function parseObj(x: any, label: string): any { if (x == null) throw new Error(`Missing --${label}`); if (typeof x === "string") return JSON.parse(x); return x; }
function parseRecord(x: any): Record<string, number> { const obj = typeof x === "string" ? JSON.parse(x) : (x || {}); const o: Record<string, number> = {}; for (const k in obj) o[k] = num(obj[k]); return o; }
function parseArray(x: any): any[] { return typeof x === "string" ? JSON.parse(x) : (Array.isArray(x) ? x : []); }
function toInt(x: any, d=0) { const n = Number(x); return Number.isFinite(n) ? Math.floor(n) : d; }
function table(rows: Array<Record<string, any>>, headers: string[]): string {
  if (!rows.length) return "(empty)";
  const widths = headers.map(h => Math.max(h.length, ...rows.map(r => String(r[h] ?? "").length)));
  const line = (cells: string[]) => cells.map((c,i)=>String(c).padEnd(widths[i]," ")).join("  ");
  const out: string[] = [];
  out.push(line(headers));
  out.push(line(widths.map(w=>"─".repeat(w))));
  for (const r of rows) out.push(line(headers.map(h => String(r[h] ?? ""))));
  return out.join("\n");
}
function pretty(x: unknown): string { try { return JSON.stringify(x, null, 2); } catch { return String(x); } }
function numFmt(x: number): string { return Number.isFinite(x) ? String(Math.round(x*1e4)/1e4) : ""; }
function help(): string {
  return [
    "models <subcommand>",
    "",
    "Subcommands:",
    "  list                                       List models",
    "  show <name>                                Show model",
    "  add|upsert --name n --kind linear|rank|weighted|tree-stub --features 'f1,f2,...'",
    "         [--description '...'] [--notes '...'] [--disabled]",
    "         (weighted) --weights '{\"f1\":1,\"f2\":-0.5}'",
    "         (linear)   [--intercept true] [--l2 0] [--standardize true] [--clip 10]",
    "         (tree)     --tree '[{\"feature\":\"x\",\"thresh\":0,\"left\":0.5,\"right\":-0.5}]'",
    "  rm|remove <name>                           Remove model",
    "  set-default <name>                         Set default",
    "  export [--pretty|-p]                       Export snapshot JSON",
    "  import --json '<payload>' [--replace]      Import snapshot JSON",
    "  fit <name> --X '<{ID:{feat:val}}>' --y '<{ID:target}>'",
    "  predict <name> --X '<{ID:{feat:val}}>' [--top N] [--bottom N]",
  ].join("\n");
}
function errToString(e: unknown): string { if (e instanceof Error) return `${e.name}: ${e.message}`; try { return JSON.stringify(e); } catch { return String(e); } }

function pickTopBottom<T>(rows: T[], top: number, bottom: number): T[] {
  if (!top && !bottom) return rows;
  const out: T[] = [];
  if (top > 0) out.push(...rows.slice(0, top));
  if (bottom > 0) out.push(...rows.slice(Math.max(0, rows.length - bottom)));
  return out;
}