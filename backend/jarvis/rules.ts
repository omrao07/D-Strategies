// jarvis/rules.ts
// Tiny, dependency-free rules engine for Jarvis.
// - Define rules that inspect portfolio state (positions, risk, exposures)
// - Produce normalized findings (advice, warnings, alerts, actions)
// - No imports. Strict-TS friendly.

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------- Core types ----------

export type Severity = "info" | "notice" | "warning" | "critical";

export type Action =
  | "none"
  | "rebalance"
  | "reduce-position"
  | "increase-cash"
  | "hedge"
  | "close-position"
  | "review-orders"
  | "check-liquidity";

export interface Position {
  symbol: string;
  qty: number;
  price: number;        // last
  cost?: number;        // avg cost
  meta?: Record<string, any>;
}

export interface FactorExposure {
  factor: string;
  value: number;        // +/- exposure
}

export interface RiskMetrics {
  var95: number;        // negative numbers indicate loss fraction at 95% (e.g., -0.025)
  cvar95: number;
  beta?: number;
  stdev?: number;
  horizonDays?: number;
}

export interface PortfolioLike {
  cash: number;
  positions: Position[];
  value: number;                      // total value (cash + positions)
  exposuresBySymbol?: Record<string, FactorExposure[]>; // optional
}

export interface MarketContext {
  nowISO?: string;
  prices?: Record<string, number>;    // latest prices (optional)
  calendar?: { isMarketOpen?: boolean };
  risk?: RiskMetrics;                 // portfolio-level risk (optional)
}

export interface Finding {
  id: string;               // stable id like "risk.var95.limit"
  title: string;            // one-line summary
  detail?: string;          // more text
  severity: Severity;
  action: Action;
  tags?: string[];          // e.g., ["risk","limit","drawdown"]
  subject?: string;         // symbol/factor/portfolio
  metrics?: Record<string, number | string | boolean>;
}

export interface RuleContext {
  portfolio: PortfolioLike;
  market?: MarketContext;
  params?: Record<string, any>;
}

export type RuleFn = (ctx: RuleContext) => Finding[] | Finding | null | undefined | Promise<Finding[] | Finding | null | undefined>;

export interface Rule {
  name: string;
  description?: string;
  run: RuleFn;
  enabled?: boolean;
  tags?: string[];
  defaultParams?: Record<string, any>;
}

// ---------- Utilities ----------

function pct(x: number): string { return (x * 100).toFixed(2) + "%"; }
function round2(x: number): number { return Math.round(x * 100) / 100; }
function isFiniteNum(x: any): x is number { return typeof x === "number" && Number.isFinite(x); }
function sum(a: number[]): number { let s=0; for (const x of a) s+=x; return s; }
function abs(x: number): number { return Math.abs(x); }
function clamp(x: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, x)); }

// ---------- Built-in rules ----------

/** Limit portfolio 1-day VaR95 (fraction) — alerts if breach. */
export const ruleLimitVaR: Rule = {
  name: "risk.var95.limit",
  description: "Alert when 1-day VaR 95% exceeds threshold (in absolute terms).",
  defaultParams: { maxAbsVaR: 0.03 }, // 3%
  async run(ctx) {
    const p = ctx.portfolio; const r = ctx.market?.risk;
    if (!r || !isFiniteNum(r.var95)) return null;
    const limit = Number(ctx.params?.maxAbsVaR ?? (ruleLimitVaR.defaultParams!.maxAbsVaR));
    const breach = Math.abs(r.var95) > Math.abs(limit);
    if (!breach) return null;
    return {
      id: "risk.var95.limit",
      title: `VaR 95% breach: ${pct(r.var95)} > ${pct(limit)}`,
      detail: `Portfolio 1-day VaR (95%) ${pct(r.var95)} exceeds configured limit ${pct(limit)}.`,
      severity: Math.abs(r.var95) > limit * 1.5 ? "critical" : "warning",
      action: "reduce-position",
      tags: ["risk","var","limit"],
      subject: "PORTFOLIO",
      metrics: { var95: r.var95, limit },
    };
  }
};

/** Concentration: any single position > N% of portfolio value. */
export const ruleConcentration: Rule = {
  name: "exposure.concentration",
  description: "Warn if a single name exceeds max weight.",
  defaultParams: { maxWeight: 0.1 }, // 10%
  run(ctx) {
    const p = ctx.portfolio;
    const W = Number(ctx.params?.maxWeight ?? (ruleConcentration.defaultParams!.maxWeight));
    if (!p.value || p.positions.length === 0) return null;

    const findings: Finding[] = [];
    for (const pos of p.positions) {
      const w = (pos.qty * pos.price) / p.value;
      if (w > W) {
        findings.push({
          id: "exposure.concentration",
          title: `Concentration: ${pos.symbol} = ${(w*100).toFixed(1)}% (> ${(W*100).toFixed(0)}%)`,
          detail: `${pos.symbol} weight ${pct(w)} exceeds ${pct(W)} of portfolio value.`,
          severity: w > W * 1.5 ? "critical" : "warning",
          action: "rebalance",
          tags: ["exposure","concentration"],
          subject: pos.symbol,
          metrics: { weight: w, threshold: W },
        });
      }
    }
    return findings.length ? findings : null;
  }
};

/** Cash buffer: ensure minimum cash % for liquidity/fees. */
export const ruleCashBuffer: Rule = {
  name: "liquidity.cash-buffer",
  description: "Maintain a minimum cash buffer percentage.",
  defaultParams: { minCashPct: 0.02 }, // 2%
  run(ctx) {
    const p = ctx.portfolio;
    const minPct = Number(ctx.params?.minCashPct ?? (ruleCashBuffer.defaultParams!.minCashPct));
    const cashPct = p.value ? p.cash / p.value : 0;
    if (cashPct >= minPct) return null;
    return {
      id: "liquidity.cash-buffer",
      title: `Low cash buffer: ${pct(cashPct)} (< ${pct(minPct)})`,
      detail: `Available cash is ${pct(cashPct)} of portfolio value, below the target ${pct(minPct)}.`,
      severity: cashPct < minPct * 0.5 ? "critical" : "warning",
      action: "increase-cash",
      tags: ["liquidity","cash"],
      subject: "PORTFOLIO",
      metrics: { cashPct, minPct },
    };
  }
};

/** Stop/P&L guide: flag deep losers (> drawdown %) for review. */
export const ruleDeepLosers: Rule = {
  name: "pnl.deep-losers",
  description: "Flag positions with loss worse than threshold from cost.",
  defaultParams: { maxDrawdownPct: -0.15 }, // -15%
  run(ctx) {
    const thr = Number(ctx.params?.maxDrawdownPct ?? (ruleDeepLosers.defaultParams!.maxDrawdownPct));
    const findings: Finding[] = [];
    for (const pos of ctx.portfolio.positions) {
      if (!isFiniteNum(pos.cost) || pos.cost === 0) continue;
      const dd = (pos.price - (pos.cost as number)) / (pos.cost as number);
      if (dd <= thr) {
        findings.push({
          id: "pnl.deep-losers",
          title: `${pos.symbol} loss ${pct(dd)} <= ${pct(thr)} (review)`,
          detail: `${pos.symbol} is down ${pct(dd)} vs cost.`,
          severity: dd <= thr * 1.5 ? "critical" : "warning",
          action: "review-orders",
          tags: ["pnl","risk"],
          subject: pos.symbol,
          metrics: { drawdownPct: dd, threshold: thr },
        });
      }
    }
    return findings.length ? findings : null;
  }
};

/** Factor tilt: signal when absolute exposure to a single factor exceeds threshold (by name weight sum). */
export const ruleFactorTilt: Rule = {
  name: "factor.tilt.limit",
  description: "Warn on excessive tilt to a single factor across holdings.",
  defaultParams: { maxAbsTilt: 0.6, factor: "momentum" }, // arbitrary factor name
  run(ctx) {
    const map = ctx.portfolio.exposuresBySymbol || {};
    const target = String(ctx.params?.factor ?? (ruleFactorTilt.defaultParams!.factor));
    const limit = Number(ctx.params?.maxAbsTilt ?? (ruleFactorTilt.defaultParams!.maxAbsTilt));

    const { positions, value } = ctx.portfolio;
    if (!value || !positions.length) return null;

    // value-weighted sum of factor exposures
    let total = 0;
    for (const pos of positions) {
      const w = (pos.qty * pos.price) / value;
      const exps = map[pos.symbol] || [];
      const e = exps.find(e => e.factor.toLowerCase() === target.toLowerCase());
      if (e) total += w * e.value;
    }
    const breach = Math.abs(total) > Math.abs(limit);
    if (!breach) return null;

    return {
      id: "factor.tilt.limit",
      title: `Excess ${target} tilt: ${round2(total)} (limit ${limit})`,
      detail: `Value-weighted ${target} exposure = ${round2(total)} exceeds limit ${limit}.`,
      severity: Math.abs(total) > Math.abs(limit) * 1.5 ? "critical" : "warning",
      action: "hedge",
      tags: ["factor","tilt"],
      subject: target,
      metrics: { tilt: total, limit, factor: target },
    };
  }
};

/** Trade size sanity: extremely small notional positions → suggest close to reduce noise. */
export const ruleDustPositions: Rule = {
  name: "ops.dust-positions",
  description: "Suggest closing tiny notional positions (bookkeeping noise).",
  defaultParams: { minNotional: 200 }, // $200
  run(ctx) {
    const min = Number(ctx.params?.minNotional ?? (ruleDustPositions.defaultParams!.minNotional));
    const findings: Finding[] = [];
    for (const pos of ctx.portfolio.positions) {
      const notional = abs(pos.qty * pos.price);
      if (notional > 0 && notional < min) {
        findings.push({
          id: "ops.dust-positions",
          title: `Dust position: ${pos.symbol} ≈ $${round2(notional)}`,
          detail: `Notional $${round2(notional)} below housekeeping minimum $${round2(min)}.`,
          severity: "notice",
          action: "close-position",
          tags: ["ops","cleanup"],
          subject: pos.symbol,
          metrics: { notional, min },
        });
      }
    }
    return findings.length ? findings : null;
  }
};

// ---------- Engine ----------

export interface EngineOptions {
  // Default parameters for built-in rules (by rule.name)
  params?: Record<string, Record<string, any>>;
  // Disable some built-ins by name
  disable?: string[];
}

/** Default built-in rules in evaluation order. */
export function defaultRules(): Rule[] {
  return [
    ruleLimitVaR,
    ruleConcentration,
    ruleCashBuffer,
    ruleDeepLosers,
    ruleFactorTilt,
    ruleDustPositions,
  ];
}

/**
 * Evaluate a set of rules and return flattened findings, sorted by severity.
 * - Pass custom rules to extend/override behavior.
 * - `opts.params` can inject per-rule parameters.
 * - Rules that throw are caught and converted into a critical finding.
 */
export async function evaluateRules(
  portfolio: PortfolioLike,
  market?: MarketContext,
  rules: Rule[] = defaultRules(),
  opts: EngineOptions = {}
): Promise<Finding[]> {
  // apply enable/disable & params
  const disable = new Set((opts.disable || []).map(String));
  const paramOver = opts.params || {};

  const out: Finding[] = [];
  for (const r of rules) {
    if (disable.has(r.name)) continue;
    if (r.enabled === false) continue;

    const params = { ...(r.defaultParams || {}), ...(paramOver[r.name] || {}) };
    const ctx: RuleContext = { portfolio, market, params };

    try {
      const res = await r.run(ctx);
      const findings = Array.isArray(res) ? res : (res ? [res] : []);
      for (const f of findings) {
        if (!f) continue;
        out.push(normalizeFinding(r.name, f));
      }
    } catch (e: any) {
      out.push({
        id: `${r.name}.error`,
        title: `Rule error: ${r.name}`,
        detail: e?.message || String(e),
        severity: "critical",
        action: "none",
        tags: ["rule-error"],
        subject: "ENGINE",
      });
    }
  }

  // sort by severity & then by title
  const rank: Record<Severity, number> = { critical: 3, warning: 2, notice: 1, info: 0 };
  out.sort((a,b) => (rank[b.severity]-rank[a.severity]) || a.title.localeCompare(b.title));
  return out;
}

function normalizeFinding(sourceRule: string, f: Finding): Finding {
  const id = f.id || sourceRule;
  const title = f.title || sourceRule;
  const severity: Severity = (["info","notice","warning","critical"] as Severity[]).includes(f.severity as Severity)
    ? (f.severity as Severity) : "info";
  const action: Action = (["none","rebalance","reduce-position","increase-cash","hedge","close-position","review-orders","check-liquidity"] as Action[])
    .includes(f.action as Action) ? (f.action as Action) : "none";
  const tags = f.tags ? Array.from(new Set(f.tags)) : [];
  return { ...f, id, title, severity, action, tags };
}

// ---------- Convenience: summarize results ----------

export function summarizeFindings(findings: Finding[]): string {
  if (!findings.length) return "No issues detected.";
  const lines: string[] = [];
  const counts: Record<Severity, number> = { info: 0, notice: 0, warning: 0, critical: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;

  lines.push(`Findings: ${findings.length}  (critical=${counts.critical}, warning=${counts.warning}, notice=${counts.notice}, info=${counts.info})`);
  lines.push("");
  for (const f of findings) {
    lines.push(`[${f.severity.toUpperCase()}] ${f.title}`);
    if (f.subject) lines.push(`  subject: ${f.subject}`);
    if (f.detail) lines.push(`  ${f.detail}`);
    if (f.metrics) lines.push(`  metrics: ${JSON.stringify(f.metrics)}`);
    if (f.action && f.action !== "none") lines.push(`  action: ${f.action}`);
    if (f.tags?.length) lines.push(`  tags: ${f.tags.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------- Quick factory for PortfolioLike ----------

export function makePortfolioLike(input: {
  cash?: number;
  positions?: Array<{ symbol: string; qty: number; price: number; cost?: number }>;
  exposuresBySymbol?: Record<string, FactorExposure[]>;
}): PortfolioLike {
  const positions = (input.positions || []).map(p => ({
    symbol: String(p.symbol).toUpperCase(),
    qty: Number(p.qty) || 0,
    price: Number(p.price) || 0,
    cost: p.cost != null ? Number(p.cost) : undefined,
  }));
  const value = (Number(input.cash) || 0) + sum(positions.map(p => p.qty * p.price));
  return { cash: Number(input.cash) || 0, positions, value, exposuresBySymbol: input.exposuresBySymbol || {} };
}

// ---------- Example custom rule (template) ----------

export function makeThresholdPnLRule(thresholdPct = 0.2): Rule {
  return {
    name: "pnl.take-profit",
    description: "Suggest trimming winners beyond threshold from cost.",
    defaultParams: { thresholdPct },
    run(ctx) {
      const thr = Number(ctx.params?.thresholdPct ?? thresholdPct);
      const out: Finding[] = [];
      for (const pos of ctx.portfolio.positions) {
        if (!isFiniteNum(pos.cost) || pos.cost === 0) continue;
        const gain = (pos.price - (pos.cost as number)) / (pos.cost as number);
        if (gain >= thr) {
          out.push({
            id: "pnl.take-profit",
            title: `${pos.symbol} gain ${pct(gain)} ≥ ${pct(thr)} (trim?)`,
            severity: "notice",
            action: "rebalance",
            subject: pos.symbol,
            tags: ["pnl","profit"],
            metrics: { gainPct: gain, thresholdPct: thr },
          });
        }
      }
      return out.length ? out : null;
    },
  };
}