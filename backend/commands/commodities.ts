// commands/commodities.ts
// CLI command set for commodity-related operations (prices, curves, linking to models).
// No external deps. Designed for integration with backtester/cli.mjs.
//
// Commands:
//   commodities list             → show available commodity symbols
//   commodities spot <symbol>    → get spot price
//   commodities curve <symbol>   → print forward curve (mock)
//   commodities link <symbol>    → link commodity into factors/models
//
// Extend as needed to connect with real feeds.

import { logger } from "../observability/logger";

export interface Command {
  name: string;
  run(argv: string[]): Promise<void>;
  help(): string;
}

const commodities: Record<string, number> = {
  "CL": 86.2,   // crude oil
  "GC": 2385.1, // gold
  "SI": 28.2,   // silver
  "HG": 4.11,   // copper
  "NG": 3.21,   // natural gas
};

function listSymbols(): string[] {
  return Object.keys(commodities);
}

async function runList(): Promise<void> {
  console.log("Available commodities:");
  for (const sym of listSymbols()) console.log(`- ${sym}`);
}

async function runSpot(argv: string[]): Promise<void> {
  const sym = argv[0];
  if (!sym || !commodities[sym]) {
    console.error("Usage: commodities spot <symbol>");
    return;
  }
  console.log(`${sym} spot price: ${commodities[sym]}`);
}

async function runCurve(argv: string[]): Promise<void> {
  const sym = argv[0];
  if (!sym || !commodities[sym]) {
    console.error("Usage: commodities curve <symbol>");
    return;
  }
  // Mock forward curve (flat + contango)
  const base = commodities[sym];
  const curve = Array.from({ length: 6 }, (_v, i) => ({
    month: i + 1,
    price: +(base * (1 + i * 0.01)).toFixed(2),
  }));
  console.log(`Forward curve for ${sym}:`);
  for (const p of curve) console.log(`M+${p.month}: ${p.price}`);
}

async function runLink(argv: string[]): Promise<void> {
  const sym = argv[0];
  if (!sym || !commodities[sym]) {
    console.error("Usage: commodities link <symbol>");
    return;
  }
  logger.info("Linking commodity into models", { symbol: sym });
  console.log(`Linked ${sym} into factor/model pipeline.`);
}

export const commoditiesCmd: Command = {
  name: "commodities",
  async run(argv: string[]) {
    const sub = argv[0];
    const rest = argv.slice(1);
    switch (sub) {
      case "list": return runList();
      case "spot": return runSpot(rest);
      case "curve": return runCurve(rest);
      case "link": return runLink(rest);
      default:
        console.error(this.help());
    }
  },
  help() {
    return `Usage: commodities <subcommand>

Subcommands:
  list                List commodity symbols
  spot <symbol>       Show spot price
  curve <symbol>      Show forward curve (mock)
  link <symbol>       Link commodity into models/factors
`;
  },
};