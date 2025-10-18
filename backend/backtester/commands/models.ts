// commands/models.ts
// Zero-dependency model registry + CLI-style command handler.
// Fits projects that want to keep "commands/*" pure TypeScript without imports.
//
// Features:
// - In-memory registry of LLM configs (name, provider, context window, limits, flags)
// - Add/update/remove/show/list/set-default
// - Simple argv parser (POSIX-ish) for subcommands
// - Validate fields; friendly table rendering without external libs
// - Deterministic snapshot/restore (JSON string)
//
// Usage (programmatic):
//   import { models, runModelsCommand } from "./commands/models";
//   models.add({ name: "gpt-5", provider: "openai", ctx: 128000 });
//   console.log(runModelsCommand(["list"]));
//
// Expected CLI shape (caller wires argv):
//   models list
//   models add --name gpt-5 --provider openai --ctx 128000 --maxOut 4096 --rpm 200 --rpd 200000 --vision --tools
//   models set-default gpt-5
//   models show gpt-5
//   models rm gpt-4o
//   models export
//   models import --json '<payload>'

type Int = number;

export type Provider =
  | "openai"
  | "anthropic"
  | "google"
  | "mistral"
  | "cohere"
  | "local"
  | "other";

export interface ModelConfig {
  name: string;               // unique key (e.g., "gpt-5")
  provider: Provider | string;
  ctx: Int;                   // context window tokens
  maxOut?: Int;               // max tokens per response
  rpm?: Int;                  // requests per minute
  rpd?: Int;                  // requests per day
  tpm?: Int;                  // tokens per minute
  tpd?: Int;                  // tokens per day
  costIn?: number;            // $ per 1K input tokens (optional metadata)
  costOut?: number;           // $ per 1K output tokens
  vision?: boolean;           // supports image input
  tools?: boolean;            // supports tool calling
  json?: boolean;             // supports JSON mode
  reasoning?: boolean;        // supports reasoning (long-thought)
  notes?: string;             // free-form
  disabled?: boolean;         // soft switch
}

export interface ModelSnapshot {
  default?: string;
  items: ModelConfig[];
  version: 1;
  savedAt: string;
}

class ModelRegistry {
  private map = new Map<string, ModelConfig>();
  private _default?: string;

  add(cfg: ModelConfig): ModelConfig {
    const v = this.validate(normalize(cfg));
    this.map.set(v.name, v);
    if (!this._default) this._default = v.name;
    return v;
  }

  upsert(cfg: Partial<ModelConfig> & { name: string }): ModelConfig {
    const prev = this.map.get(cfg.name);
    const merged = this.validate(normalize({ ...(prev ?? guessDefaults(cfg.name)), ...cfg }));
    this.map.set(merged.name, merged);
    if (!this._default) this._default = merged.name;
    return merged;
  }

  get(name: string): ModelConfig | undefined {
    return this.map.get(name);
  }

  has(name: string): boolean {
    return this.map.has(name);
  }

  list(includeDisabled = true): ModelConfig[] {
    const arr = Array.from(this.map.values());
    return includeDisabled ? sortModels(arr) : sortModels(arr.filter(m => !m.disabled));
  }

  remove(name: string): boolean {
    const ok = this.map.delete(name);
    if (ok && this._default === name) this._default = this.list(true)[0]?.name;
    return ok;
  }

  setDefault(name: string): void {
    if (!this.map.has(name)) throw new Error(`Unknown model "${name}"`);
    this._default = name;
  }

  getDefault(): string | undefined {
    if (this._default && this.map.has(this._default)) return this._default;
    const first = this.list(false)[0]?.name ?? this.list(true)[0]?.name;
    this._default = first;
    return this._default;
  }

  chooseFor(cap: { vision?: boolean; tools?: boolean; json?: boolean; reasoning?: boolean } = {}): ModelConfig | undefined {
    const want = this.list(false).filter(m =>
      (cap.vision ? !!m.vision : true) &&
      (cap.tools ? !!m.tools : true) &&
      (cap.json ? !!m.json : true) &&
      (cap.reasoning ? !!m.reasoning : true)
    );
    return want[0] ?? this.get(this.getDefault() || "");
  }

  snapshot(): ModelSnapshot {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      default: this._default,
      items: this.list(true),
    };
  }

  restore(snap: ModelSnapshot): void {
    if (!snap || snap.version !== 1) throw new Error("Unsupported snapshot version");
    this.map.clear();
    for (const item of snap.items) this.add(item);
    if (snap.default && this.map.has(snap.default)) this._default = snap.default;
  }

  exportJSON(pretty = false): string {
    return JSON.stringify(this.snapshot(), null, pretty ? 2 : 0);
  }

  importJSON(json: string, { replace = false } = {}): void {
    const parsed = JSON.parse(json) as ModelSnapshot | { items?: ModelConfig[] };
    if ("version" in parsed && "items" in parsed) {
      if (replace) this.map.clear();
      this.restore(parsed as ModelSnapshot);
      return;
    }
    const items = (parsed as any).items as ModelConfig[] | undefined;
    if (Array.isArray(items)) {
      if (replace) this.map.clear();
      for (const it of items) this.upsert(it);
    } else {
      throw new Error("Invalid JSON payload for import");
    }
  }

  // -------- helpers --------
  private validate(m: ModelConfig): ModelConfig {
    if (!m.name || typeof m.name !== "string") throw new Error("name required");
    if (!m.provider) m.provider = "other";
    if (!isPosInt(m.ctx)) throw new Error("ctx (context window) must be a positive integer");
    if (m.maxOut != null && !isPosInt(m.maxOut)) throw new Error("maxOut must be positive integer");
    const limits = ["rpm","rpd","tpm","tpd"] as const;
    for (const k of limits) if ((m as any)[k] != null && !isPosInt((m as any)[k])) throw new Error(`${k} must be positive integer`);
    const costs = ["costIn","costOut"] as const;
    for (const k of costs) if ((m as any)[k] != null && !isPosNum((m as any)[k])) throw new Error(`${k} must be positive number`);
    return m;
  }
}

// ------- singleton registry with sensible starting set -------
export const models = new ModelRegistry();

// Pre-seed (safe guesses; edit as needed)
seed([
  { name: "gpt-5", provider: "openai", ctx: 200000, maxOut: 8192, tools: true, json: true, vision: true, reasoning: true },
  { name: "gpt-4o", provider: "openai", ctx: 128000, maxOut: 4096, tools: true, json: true, vision: true },
  { name: "claude-3.7", provider: "anthropic", ctx: 200000, maxOut: 8000, tools: true, json: true, vision: true, reasoning: true },
  { name: "gemini-2.0-pro", provider: "google", ctx: 1000000, maxOut: 32768, tools: true, json: true, vision: true },
  { name: "local-llama", provider: "local", ctx: 32768, maxOut: 4096, tools: false, json: true, vision: false },
]);

function seed(items: ModelConfig[]) {
  for (const m of items) {
    try { models.upsert(m); } catch { /* ignore invalid seeds */ }
  }
}

// ---------------- CLI-ish command handler ----------------

export function runModelsCommand(argv: string[]): string {
  const args = parseArgv(argv);
  const cmd = args._[0] ?? "help";

  try {
    switch (cmd) {
      case "help":
        return help();
      case "list": {
        const all = models.list(true);
        if (!all.length) return "No models registered.";
        const rows = all.map((m) => ({
          name: m.name + (models.getDefault() === m.name ? " *" : ""),
          provider: m.provider,
          ctx: String(m.ctx),
          maxOut: m.maxOut ?? "",
          vision: flag(m.vision),
          tools: flag(m.tools),
          json: flag(m.json),
          reasoning: flag(m.reasoning),
          disabled: flag(m.disabled),
        }));
        return table(rows, ["name","provider","ctx","maxOut","vision","tools","json","reasoning","disabled"]);
      }
      case "add":
      case "upsert": {
        const cfg = collectConfig(args);
        const v = cmd === "add" ? models.add(cfg) : models.upsert(cfg);
        return `Saved model "${v.name}".`;
      }
      case "show": {
        const name = String(args._[1] ?? args.name ?? "");
        if (!name) return `Usage: show <name>`;
        const m = models.get(name);
        if (!m) return `Model "${name}" not found.`;
        return pretty(m);
      }
      case "rm":
      case "remove": {
        const name = String(args._[1] ?? args.name ?? "");
        if (!name) return `Usage: rm <name>`;
        const ok = models.remove(name);
        return ok ? `Removed "${name}".` : `Model "${name}" not found.`;
      }
      case "set-default": {
        const name = String(args._[1] ?? args.name ?? "");
        if (!name) return `Usage: set-default <name>`;
        models.setDefault(name);
        return `Default set to "${name}".`;
      }
      case "choose": {
        const picked = models.chooseFor({
          vision: !!args.vision,
          tools: !!args.tools,
          json: !!args.json,
          reasoning: !!args.reasoning,
        });
        return picked ? picked.name : "No suitable model.";
      }
      case "export": {
        const prettyJson = !!args.pretty || !!args.p;
        return models.exportJSON(prettyJson);
      }
      case "import": {
        const payload = String(args.json ?? args._[1] ?? "");
        if (!payload) return `Usage: import --json '<snapshot|{items:[]}> ' [--replace]`;
        models.importJSON(payload, { replace: !!args.replace });
        return `Imported ${models.list(true).length} models.`;
      }
      default:
        return `Unknown subcommand "${cmd}".\n` + help();
    }
  } catch (e) {
    return `Error: ${errToString(e)}`;
  }
}

// ---------------- tiny argv & formatting helpers ----------------

type Argv = { _ : string[]; [k: string]: any };

function parseArgv(argv: string[]): Argv {
  const out: Argv = { _: [] };
  let k: string | null = null;
  for (const raw of argv) {
    const a = String(raw);
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) {
        const key = a.slice(2, eq);
        const val = a.slice(eq + 1);
        out[key] = coerce(val);
        k = null;
      } else {
        k = a.slice(2);
        out[k] = true;
      }
    } else if (a.startsWith("-") && a.length > 2) {
      for (let i = 1; i < a.length; i++) out[a[i]] = true;
      k = null;
    } else if (a.startsWith("-")) {
      k = a.slice(1);
      out[k] = true;
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
    "models <subcommand>",
    "",
    "Subcommands:",
    "  list                                 List all models",
    "  add|upsert [--name n --provider p --ctx N] [--maxOut N] [--rpm N] [--tpm N] [--rpd N] [--tpd N]",
    "                                       [--vision] [--tools] [--json] [--reasoning] [--notes '...'] [--disabled]",
    "  show <name>                          Show full config",
    "  rm|remove <name>                     Remove a model",
    "  set-default <name>                   Set default model",
    "  choose [--vision] [--tools] [--json] [--reasoning]   Pick best model for capabilities",
    "  export [--pretty|-p]                 Export snapshot JSON",
    "  import --json '<payload>' [--replace] Import snapshot JSON",
    "",
    "Examples:",
    "  models add --name gpt-5 --provider openai --ctx 200000 --maxOut 8192 --vision --tools --json --reasoning",
    "  models set-default gpt-5",
  ].join("\n");
}

function collectConfig(a: Argv): ModelConfig {
  const name = String(a.name ?? a._.find((x, i) => i > 0) ?? "");
  if (!name) throw new Error("add/upsert requires --name <string>");
  const provider = String(a.provider ?? guessProvider(name));
  const ctx = toInt(a.ctx, 8192);
  const maxOut = a.maxOut != null ? toInt(a.maxOut, 2048) : undefined;
  return normalize({
    name,
    provider,
    ctx,
    maxOut,
    rpm: toIntOpt(a.rpm),
    rpd: toIntOpt(a.rpd),
    tpm: toIntOpt(a.tpm),
    tpd: toIntOpt(a.tpd),
    costIn: toNumOpt(a.costIn),
    costOut: toNumOpt(a.costOut),
    vision: !!a.vision,
    tools: !!a.tools,
    json: !!a.json,
    reasoning: !!a.reasoning,
    notes: a.notes != null ? String(a.notes) : undefined,
    disabled: !!a.disabled,
  });
}

// -------- pure utils --------

function normalize(m: ModelConfig): ModelConfig {
  const copy: ModelConfig = { ...m };
  copy.name = copy.name.trim();
  copy.provider = (copy.provider || "other") as any;
  copy.ctx = Math.max(1, Math.floor(copy.ctx));
  if (copy.maxOut != null) copy.maxOut = Math.max(1, Math.floor(copy.maxOut));
  return copy;
}

function isPosInt(x: any): x is number { return Number.isInteger(x) && x > 0; }
function isPosNum(x: any): x is number { return typeof x === "number" && Number.isFinite(x) && x >= 0; }

function toInt(x: any, d: number): number { const n = Number(x); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; }
function toIntOpt(x: any): number | undefined { const n = Number(x); return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined; }
function toNumOpt(x: any): number | undefined { const n = Number(x); return Number.isFinite(n) && n >= 0 ? n : undefined; }

function guessProvider(name: string): Provider {
  const n = name.toLowerCase();
  if (n.includes("gpt") || n.includes("o")) return "openai";
  if (n.includes("claude")) return "anthropic";
  if (n.includes("gemini")) return "google";
  if (n.includes("llama") || n.includes("qwen") || n.includes("mistral")) return "local";
  return "other";
}

function guessDefaults(name: string): ModelConfig {
  return {
    name,
    provider: guessProvider(name),
    ctx: 8192,
    maxOut: 2048,
    vision: false,
    tools: false,
    json: true,
    reasoning: false,
  };
}

function sortModels(arr: ModelConfig[]): ModelConfig[] {
  const def = models.getDefault();
  return arr.slice().sort((a, b) => {
    const da = a.name === def ? -1 : 0;
    const db = b.name === def ? -1 : 0;
    if (da !== db) return da - db;
    if (a.provider !== b.provider) return String(a.provider).localeCompare(String(b.provider));
    return a.name.localeCompare(b.name);
  });
}

function flag(v?: boolean): string { return v ? "✓" : ""; }

function table(rows: Array<Record<string, any>>, headers: string[]): string {
  if (!rows.length) return "";
  const cols = headers.map(h => String(h));
  const widths = cols.map((h, i) =>
    Math.max(h.length, ...rows.map(r => String(r[cols[i]] ?? "").length))
  );
  const line = (cells: string[], padChar = " ") =>
    cells.map((c, i) => String(c).padEnd(widths[i], padChar)).join("  ");
  const out: string[] = [];
  out.push(line(cols));
  out.push(line(widths.map(w => "─".repeat(w))));
  for (const r of rows) out.push(line(cols.map(h => String(r[h] ?? ""))));
  return out.join("\n");
}

function pretty(obj: unknown): string {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

function errToString(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  try { return JSON.stringify(e); } catch { return String(e); }
}

// ------------- Expose minimal API for other modules -------------

export type { ModelRegistry as Models };

export function addModel(cfg: ModelConfig): ModelConfig { return models.add(cfg); }
export function upsertModel(cfg: Partial<ModelConfig> & { name: string }): ModelConfig { return models.upsert(cfg); }
export function listModels(includeDisabled = true): ModelConfig[] { return models.list(includeDisabled); }
export function getModel(name: string): ModelConfig | undefined { return models.get(name); }
export function setDefaultModel(name: string): void { models.setDefault(name); }
export function defaultModel(): string | undefined { return models.getDefault(); }
export function chooseModel(cap?: { vision?: boolean; tools?: boolean; json?: boolean; reasoning?: boolean }): ModelConfig | undefined {
  return models.chooseFor(cap);
}
export function exportModels(pretty = false): string { return models.exportJSON(pretty); }
export function importModels(json: string, opts?: { replace?: boolean }): void { models.importJSON(json, opts); }
// ========== END models.ts ==========