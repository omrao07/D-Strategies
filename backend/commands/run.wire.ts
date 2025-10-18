// commands/run.wire.ts
// central wiring: map command name → require("./<file>").<export>
// no imports here, only runtime require so it's flexible

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const require: any;

export type CommandDef = {
  run(argv: string[]): Promise<void> | void;
  help(): string;
};

export type WireRegistry = Record<string, () => CommandDef | undefined>;

// each key is subcommand string
export const wire: WireRegistry = {
  models: () => {
    try {
      const mod: any = require("./models");
      return { run: (argv: string[]) => { console.log(mod.runModelsCommand(argv)); }, help: () => "models help" };
    } catch { return undefined; }
  },

  jarvis: () => {
    try { const mod: any = require("./jarvis"); return mod.jarvisCmd; }
    catch { return undefined; }
  },

  commodities: () => {
    try { const mod: any = require("./commodities"); return mod.commoditiesCmd; }
    catch { return undefined; }
  },

  diagnostics: () => {
    try { const mod: any = require("./diagnostics"); return mod.diagnosticsCmd; }
    catch { return undefined; }
  },

  factors: () => {
    try { const mod: any = require("./factors"); return mod.factorsCmd; }
    catch { return undefined; }
  },

  data: () => {
    try { const mod: any = require("./data"); return mod.dataCmd; }
    catch { return undefined; }
  },

  serve: () => {
    try { const mod: any = require("./serve"); return mod.serveCmd; }
    catch { return undefined; }
  },
};