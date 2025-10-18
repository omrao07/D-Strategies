// commands/jarvis.ts
// CLI command for "Jarvis" – a portfolio assistant that answers questions about positions,
// risk metrics, exposures, and linked models. Works with in-memory mock data.
// Extend by wiring into risk/metrics.ts, portfolios, and factor models.

import { logger } from "../observability/logger";

export interface Command {
  name: string;
  run(argv: string[]): Promise<void>;
  help(): string;
}

// ---- Mock portfolio state ----
interface Position {
  symbol: string;
  qty: number;
  price: number;
}
const portfolio: Position[] = [
  { symbol: "AAPL", qty: 100, price: 192 },
  { symbol: "MSFT", qty: 50, price: 342 },
  { symbol: "CL", qty: 10, price: 86.2 },
];

function portfolioValue(): number {
  return portfolio.reduce((s, p) => s + p.qty * p.price, 0);
}

function findPos(sym: string): Position | undefined {
  return portfolio.find(p => p.symbol.toUpperCase() === sym.toUpperCase());
}

async function runStatus(): Promise<void> {
  console.log("Portfolio status:");
  for (const p of portfolio) {
    console.log(`- ${p.symbol}: ${p.qty} @ ${p.price} = ${(p.qty * p.price).toFixed(2)}`);
  }
  console.log(`Total value: ${portfolioValue().toFixed(2)}`);
}

async function runAsk(argv: string[]): Promise<void> {
  const q = argv.join(" ");
  if (!q) {
    console.error("Usage: jarvis ask <question>");
    return;
  }
  logger.info("Jarvis received question", { q });

  // Very naive matcher
  if (/value/i.test(q)) {
    console.log(`Current portfolio value: ${portfolioValue().toFixed(2)}`);
  } else if (/holding|position/i.test(q)) {
    console.log("Holdings:");
    for (const p of portfolio) console.log(`- ${p.symbol}: ${p.qty}`);
  } else if (/risk|var|cvar/i.test(q)) {
    console.log("Risk metrics (mock): VaR 95% = -2.3%, CVaR 95% = -3.8%");
  } else {
    console.log("Jarvis: Sorry, I cannot answer that yet.");
  }
}

async function runExplain(argv: string[]): Promise<void> {
  const sym = argv[0];
  if (!sym) {
    console.error("Usage: jarvis explain <symbol>");
    return;
  }
  const pos = findPos(sym);
  if (!pos) {
    console.log(`No position in ${sym}`);
    return;
  }
  console.log(`Jarvis explanation for ${sym}:`);
  console.log(`- Quantity: ${pos.qty}`);
  console.log(`- Price: ${pos.price}`);
  console.log(`- Exposure: ${(pos.qty * pos.price).toFixed(2)}`);
  console.log("- Linked factors: momentum, value (mock)");
}

export const jarvisCmd: Command = {
  name: "jarvis",
  async run(argv: string[]) {
    const sub = argv[0];
    const rest = argv.slice(1);
    switch (sub) {
      case "status": return runStatus();
      case "ask": return runAsk(rest);
      case "explain": return runExplain(rest);
      default:
        console.error(this.help());
    }
  },
  help() {
    return `Usage: jarvis <subcommand>

Subcommands:
  status              Show portfolio status
  ask <question>      Ask Jarvis about portfolio (value, holdings, risk)
  explain <symbol>    Explain exposure and linked factors
`;
  },
};