// jarvis/explainers.ts
// provides functions to generate natural-language explanations
// for positions, factors, and risk metrics.
// no imports, fully standalone.

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Position {
  symbol: string;
  qty: number;
  price: number;
}

export interface FactorExposure {
  factor: string;
  value: number;
}

export interface RiskMetrics {
  var95: number;
  cvar95: number;
  beta?: number;
}

export function explainPosition(p: Position): string {
  const value = p.qty * p.price;
  return [
    `Jarvis analysis for ${p.symbol}:`,
    `- Quantity: ${p.qty}`,
    `- Price: ${p.price}`,
    `- Market value: ${value.toFixed(2)}`,
  ].join("\n");
}

export function explainFactors(factors: FactorExposure[]): string {
  if (!factors.length) return "No factor exposures available.";
  const lines = factors.map(
    f => `- ${f.factor}: ${f.value >= 0 ? "+" : ""}${round4(f.value)}`
  );
  return ["Factor exposures:", ...lines].join("\n");
}

export function explainRisk(r: RiskMetrics): string {
  const parts: string[] = [];
  parts.push(`- VaR 95%: ${pct(r.var95)}`);
  parts.push(`- CVaR 95%: ${pct(r.cvar95)}`);
  if (r.beta !== undefined) parts.push(`- Beta: ${round4(r.beta)}`);
  return ["Risk metrics:", ...parts].join("\n");
}

export function explainFull(p: Position, factors: FactorExposure[], r: RiskMetrics): string {
  return [explainPosition(p), "", explainFactors(factors), "", explainRisk(r)].join("\n");
}

// ---------- helpers ----------

function pct(x: number): string {
  return (x * 100).toFixed(2) + "%";
}
function round4(x: number): string {
  return String(Math.round(x * 1e4) / 1e4);
}