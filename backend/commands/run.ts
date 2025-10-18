// commands/run.ts
// Single entry that dispatches to subcommands without using `import` syntax.
// Works with CommonJS or ts-node. Lazy-loads via `require` only when needed.

// ---- tiny ambient shims (so strict TS doesn't yell) ----
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const require: any;
declare const module: any;
declare const process: any;

// ---------- Small argv parser ----------
type Argv = { _: string[]; [k: string]: unknown };

function parseArgv(argv: string[]): Argv {
  const out: Argv = { _: [] };
  let expectKey: string | null = null;
  for (const raw of argv) {
    const a = String(raw);
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) {
        out[a.slice(2, eq)] = coerce(a.slice(eq + 1));
        expectKey = null;
      } else {
        expectKey = a.slice(2);
        out[expectKey] = true;
      }
    } else if (a.startsWith("-") && a.length > 2) {
      for (let i = 1; i < a.length; i++) out[a[i]] = true;
      expectKey = null;
    } else if (a.startsWith("-")) {
      expectKey = a.slice(1);
      out[expectKey] = true;
    } else {
      if (expectKey && out[expectKey] === true) {
        out[expectKey] = coerce(a);
        expectKey = null;
      } else {
        out._.push(a);
      }
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

// ---------- Loader without imports ----------

type Loader = (argv: string[]) => Promise<number>;

const registry: Record<string, Loader> = {
  async models(argv) {
    // expected export: runModelsCommand(argv:string[]): string
    let mod: any;
    try { mod = require("./models"); }
    catch { console.error("models command not found."); return 1; }
    if (typeof mod.runModelsCommand !== "function") {
      console.error("models command not available"); return 1;
    }
    const res: string = mod.runModelsCommand(argv);
    if (res && res.trim()) console.log(res);
    return 0;
  },

  async jarvis(argv) {
    // expected export: jarvisCmd with .run(argv)
    let mod: any;
    try { mod = require("./jarvis"); }
    catch { console.error("jarvis command not found."); return 1; }
    const cmd = mod.jarvisCmd;
    if (!cmd?.run) { console.error("jarvis command not available"); return 1; }
    await cmd.run(argv);
    return 0;
  },

  async commodities(argv) {
    let mod: any;
    try { mod = require("./commodities"); }
    catch { console.error("commodities command not found."); return 1; }
    const cmd = mod.commoditiesCmd;
    if (!cmd?.run) { console.error("commodities command not available"); return 1; }
    await cmd.run(argv);
    return 0;
  },

  async diagnostics(argv) {
    try {
      const mod: any = require("./diagnostics");
      const cmd = mod.diagnosticsCmd;
      if (!cmd?.run) { console.error("diagnostics command not available"); return 1; }
      await cmd.run(argv);
      return 0;
    } catch {
      console.error("diagnostics command not found.");
      return 1;
    }
  },

  async factors(argv) {
    try {
      const mod: any = require("./factors");
      const cmd = mod.factorsCmd;
      if (!cmd?.run) { console.error("factors command not available"); return 1; }
      await cmd.run(argv);
      return 0;
    } catch {
      console.error("factors command not found.");
      return 1;
    }
  },

  async data(argv) {
    try {
      const mod: any = require("./data");
      const cmd = mod.dataCmd;
      if (!cmd?.run) { console.error("data command not available"); return 1; }
      await cmd.run(argv);
      return 0;
    } catch {
      console.error("data command not found.");
      return 1;
    }
  },

  async serve(argv) {
    try {
      const mod: any = require("./serve");
      const cmd = mod.serveCmd;
      if (!cmd?.run) { console.error("serve command not available"); return 1; }
      await cmd.run(argv);
      return 0;
    } catch {
      console.error("serve command not found.");
      return 1;
    }
  },
};

// ---------- Help ----------

function rootHelp(): string {
  const names = Object.keys(registry).sort();
  return [
    "run <command> [...args]",
    "",
    "Commands:",
    ...names.map(n => `  ${n}`),
    "",
    "Examples:",
    "  run models list",
    "  run models show linear_value",
    "  run jarvis status",
    "  run commodities list",
  ].join("\n");
}

// ---------- Main ----------

export async function main(argv = (typeof process !== "undefined" ? process.argv.slice(2) : [])): Promise<number> {
  const parsed = parseArgv(argv);
  const [cmd, ...rest] = parsed._;

  if (!cmd || cmd === "help" || parsed.help || parsed.h) {
    console.log(rootHelp());
    return 0;
  }

  const loader = registry[String(cmd)];
  if (!loader) {
    console.error(`Unknown command "${cmd}".\n`);
    console.log(rootHelp());
    return 1;
  }

  try {
    return await loader(rest.map(String));
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`Error running "${cmd}": ${msg}`);
    return 1;
  }
}

// execute directly
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main().then((code) => {
    if (typeof process !== "undefined" && process && typeof process.exit === "function") {
      process.exit(code);
    }
  });
}