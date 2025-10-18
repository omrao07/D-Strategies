// frontend/tabs/JarvisPanel.tsx
// Production-ready, self-contained Jarvis surface with live alerts, explanations,
// SSE/WebSocket support, and an automatic demo fallback (no placeholders).

import React, { useEffect, useMemo, useRef, useState } from "react";

type Position = { symbol: string; qty: number; price: number; sector?: string };
type Snapshot = {
  timestamp: string;
  portfolio: {
    equity: number;
    cash: number;
    pnlDaily?: number;
    pnlMTD?: number;
    pnlYTD?: number;
    exposures?: Record<string, number>;
    positions?: Position[];
  };
  signals?: Array<{ symbol: string; score: number; kind: string }>;
  arbitrage?: Array<{ leg: string[]; edgeBps: number; notional: number }>;
};

type Notification = {
  id: string;
  level: "info" | "warn" | "crit";
  code: "LOW_CASH" | "PNL_DRAWDOWN" | "SECTOR_CONC" | "RISK_BREACH" | "ARBITRAGE_OPP" | "INFO";
  text: string;
  ts: string;
};

type Props = {
  /** Optional: connect to a Server-Sent Events endpoint that streams Snapshots as JSON lines. */
  sseUrl?: string;
  /** Optional: connect to a WebSocket endpoint that streams Snapshots as JSON messages. */
  wsUrl?: string;
  /** Upper bound on stored alerts (oldest dropped). */
  maxAlerts?: number;
  /** Thresholds for rules (override defaults). */
  thresholds?: Partial<{
    minCashPct: number; // default 0.02 (2%)
    maxSectorAbs: number; // default 0.35 (35%)
    drawdownDailyPct: number; // default 0.02 (2% of equity)
    minArbEdgeBps: number; // default 5
    minArbNotional: number; // default 50_000
  }>;
};

function fmt(n: number, d = 2) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: d }).format(n);
}
function pct(n: number, d = 2) {
  return `${(n * 100).toFixed(d)}%`;
}

function analyze(s: Snapshot, th: Required<NonNullable<Props["thresholds"]>>): Notification[] {
  const out: Notification[] = [];
  const eq = s.portfolio.equity || 0;
  const cashPct = eq ? s.portfolio.cash / eq : 0;

  if (cashPct < th.minCashPct) {
    out.push(n("warn", "LOW_CASH", `Cash low (${pct(cashPct)})`));
  }
  const dd = (s.portfolio.pnlDaily || 0) / Math.max(eq, 1);
  if (dd <= -th.drawdownDailyPct) {
    out.push(n("crit", "PNL_DRAWDOWN", `Daily drawdown ${pct(dd)}`));
  }
  const exp = s.portfolio.exposures || {};
  for (const [sec, w] of Object.entries(exp)) {
    if (Math.abs(w) > th.maxSectorAbs) {
      out.push(n("warn", "SECTOR_CONC", `High ${sec} exposure (${pct(w)})`));
    }
  }
  const arb = (s.arbitrage || []).filter(a => a.edgeBps >= th.minArbEdgeBps && a.notional >= th.minArbNotional);
  for (const a of arb) {
    out.push(n("info", "ARBITRAGE_OPP", `Arb ${a.leg.join(" / ")} | ${a.edgeBps} bps on ${fmt(a.notional, 0)}`));
  }
  // generic info
  out.push(n("info", "INFO", `Equity ${fmt(eq)} | Cash ${fmt(s.portfolio.cash)} | DPNL ${fmt(s.portfolio.pnlDaily || 0)}`));
  return out;

  function n(level: Notification["level"], code: Notification["code"], text: string): Notification {
    return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, level, code, text, ts: new Date().toISOString() };
  }
}

function explanation(s: Snapshot, notes: Notification[]): string {
  const lines: string[] = [];
  lines.push(`As of ${new Date(s.timestamp).toLocaleString()}:`);
  lines.push(`• Equity ${fmt(s.portfolio.equity)} | Cash ${fmt(s.portfolio.cash)} (${pct((s.portfolio.cash || 0) / Math.max(s.portfolio.equity || 1, 1))})`);
  if (typeof s.portfolio.pnlDaily === "number") lines.push(`• Daily PnL ${fmt(s.portfolio.pnlDaily)} (${pct((s.portfolio.pnlDaily || 0) / Math.max(s.portfolio.equity || 1, 1))})`);
  const sigs = (s.signals || []).slice().sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 3);
  if (sigs.length) lines.push("• Top signals: " + sigs.map(x => `${x.symbol}(${x.kind}:${x.score.toFixed(2)})`).join(", "));
  const arbs = (s.arbitrage || []).slice(0, 2);
  if (arbs.length) lines.push("• Arbitrage: " + arbs.map(a => `${a.leg.join("→")} @ ${a.edgeBps}bps`).join("; "));
  if (notes.length) {
    lines.push("• Alerts:");
    for (const n of notes) lines.push(`  – [${n.level}] ${n.text} (${n.code})`);
  } else {
    lines.push("• No alerts. Portfolio within guardrails.");
  }
  return lines.join("\n");
}

// Demo snapshot generator (used when no sseUrl/wsUrl provided)
function makeDemoSnapshot(prev?: Snapshot): Snapshot {
  const baseEq = prev?.portfolio.equity ?? 1_000_000;
  const shock = (Math.random() - 0.5) * 4000; // +/- 2k
  const equity = Math.max(100_000, baseEq + shock);
  const cash = Math.max(1000, (prev?.portfolio.cash ?? 100_000) + (Math.random() - 0.5) * 2000);
  const pnlDaily = shock;
  const exposures = {
    Tech: clamp((prev?.portfolio.exposures?.Tech ?? 0.20) + (Math.random() - 0.5) * 0.01, -0.5, 0.6),
    Energy: clamp((prev?.portfolio.exposures?.Energy ?? 0.10) + (Math.random() - 0.5) * 0.02, -0.5, 0.6),
    Health: clamp((prev?.portfolio.exposures?.Health ?? 0.05) + (Math.random() - 0.5) * 0.01, -0.5, 0.6)
  };
  const arb: NonNullable<Snapshot["arbitrage"]> = Math.random() < 0.25
    ? [{ leg: ["CLZ25", "CLF26"], edgeBps: Math.floor(5 + Math.random() * 12), notional: 50_000 + Math.random() * 150_000 }]
    : [];
  return {
    timestamp: new Date().toISOString(),
    portfolio: { equity, cash, pnlDaily, pnlMTD: (prev?.portfolio.pnlMTD ?? 5_000) + shock * 0.3, pnlYTD: (prev?.portfolio.pnlYTD ?? 25_000) + shock * 0.1, exposures },
    signals: [
      { symbol: "AAPL", score: +(Math.random() * 2 - 1).toFixed(2), kind: "momentum" },
      { symbol: "MSFT", score: +(Math.random() * 2 - 1).toFixed(2), kind: "meanrev" }
    ],
    arbitrage: arb
  };
  function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
}

export default function JarvisPanel({ sseUrl, wsUrl, maxAlerts = 200, thresholds }: Props) {
  const [alerts, setAlerts] = useState<Notification[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState<"disconnected" | "connecting" | "live" | "demo" | "error">("connecting");
  const demoTimer = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const th: Required<NonNullable<Props["thresholds"]>> = {
    minCashPct: 0.02,
    maxSectorAbs: 0.35,
    drawdownDailyPct: 0.02,
    minArbEdgeBps: 5,
    minArbNotional: 50_000,
    ...(thresholds || {})
  };

  // Connect to SSE/WS or start demo
  useEffect(() => {
    let active = true;
    setStatus("connecting");

    if (wsUrl) {
      try {
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        ws.onopen = () => active && setStatus("live");
        ws.onmessage = (ev) => {
          if (!active || paused) return;
          const snap = parseSnapshot(ev.data);
          if (snap) handleSnapshot(snap);
        };
        ws.onerror = () => active && setStatus("error");
        ws.onclose = () => active && setStatus("disconnected");
        return () => { active = false; ws.close(); wsRef.current = null; };
      } catch {
        setStatus("error");
      }
    }

    if (sseUrl && typeof EventSource !== "undefined") {
      const es = new EventSource(sseUrl);
      esRef.current = es;
      es.onopen = () => active && setStatus("live");
      es.onmessage = (ev) => {
        if (!active || paused) return;
        const snap = parseSnapshot(ev.data);
        if (snap) handleSnapshot(snap);
      };
      es.onerror = () => active && setStatus("error");
      return () => { active = false; es.close(); esRef.current = null; };
    }

    // Fallback demo generator
    setStatus("demo");
    let prev: Snapshot | undefined;
    const tick = () => {
      if (!active || paused) return;
      const snap = makeDemoSnapshot(prev);
      prev = snap;
      handleSnapshot(snap);
    };
    tick();
    demoTimer.current = window.setInterval(tick, 1500);
    return () => {
      active = false;
      if (demoTimer.current) window.clearInterval(demoTimer.current);
      demoTimer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sseUrl, wsUrl, paused]);

  function parseSnapshot(raw: any): Snapshot | null {
    try {
      const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!obj?.portfolio?.equity) return null;
      return obj as Snapshot;
    } catch {
      return null;
    }
  }

  function handleSnapshot(s: Snapshot) {
    setSnapshot(s);
    const notes = analyze(s, th);
    setAlerts(prev => {
      const next = [...notes, ...prev];
      return next.slice(0, maxAlerts);
    });
  }

  const filtered = useMemo(
    () => alerts.filter(a => (filter ? (a.text + a.code).toLowerCase().includes(filter.toLowerCase()) : true)),
    [alerts, filter]
  );

  function downloadJSON() {
    const payload = { snapshot, alerts };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `jarvis_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section aria-labelledby="jarvis-heading">
      <header className="mb-3 flex items-center gap-3">
        <h2 id="jarvis-heading" className="text-lg font-semibold">Portfolio Jarvis</h2>
        <span
          aria-live="polite"
          className="text-xs px-2 py-1 rounded"
          style={{ background: statusBadge(status).bg, color: statusBadge(status).fg }}
        >
          {status.toUpperCase()}
        </span>
        <button
          onClick={() => setPaused(p => !p)}
          aria-pressed={paused}
          className="text-sm px-2 py-1 border rounded"
        >
          {paused ? "Resume" : "Pause"}
        </button>
        <button onClick={downloadJSON} className="text-sm px-2 py-1 border rounded">
          Export JSON
        </button>
        <label className="ml-auto text-sm">
          <span className="sr-only">Filter alerts</span>
          <input
            aria-label="Filter alerts"
            placeholder="Filter alerts…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="border px-2 py-1 rounded"
          />
        </label>
      </header>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <Card title="Equity" value={snapshot ? `$${fmt(snapshot.portfolio.equity)}` : "—"} />
        <Card title="Cash" value={snapshot ? `$${fmt(snapshot.portfolio.cash)}` : "—"} />
        <Card title="Daily PnL" value={snapshot ? `$${fmt(snapshot.portfolio.pnlDaily || 0)}` : "—"} />
      </div>

      {/* Explanation */}
      <div className="mb-4">
        <h3 className="font-medium">Explanation</h3>
        <pre
          aria-live="polite"
          className="whitespace-pre-wrap bg-gray-50 border rounded p-3 text-sm overflow-auto"
        >
{snapshot ? explanation(snapshot, alerts.slice(0, 8)) : "Waiting for data…"}
        </pre>
      </div>

      {/* Alerts table */}
      <div className="overflow-auto">
        <table role="table" aria-label="Jarvis alerts" className="min-w-full text-sm">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Level</th>
              <th scope="col">Code</th>
              <th scope="col">Message</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(a => (
              <tr key={a.id}>
                <td><time dateTime={a.ts}>{new Date(a.ts).toLocaleTimeString()}</time></td>
                <td>{badge(a.level)}</td>
                <td>{a.code}</td>
                <td>{a.text}</td>
              </tr>
            ))}
            {!filtered.length && (
              <tr>
                <td colSpan={4} className="italic text-gray-500">No alerts yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Card({ title, value }: { title: string; value: string }) {
  return (
    <div className="border rounded p-3 bg-white">
      <div className="text-xs uppercase text-gray-500">{title}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

function badge(level: Notification["level"]) {
  const m = {
    info: { label: "INFO", color: "#1f6feb" },
    warn: { label: "WARN", color: "#eab308" },
    crit: { label: "CRIT", color: "#dc2626" }
  }[level];
  return <span style={{ color: m.color, fontWeight: 600 }}>{m.label}</span>;
}

function statusBadge(s: "disconnected" | "connecting" | "live" | "demo" | "error") {
  switch (s) {
    case "live": return { bg: "#e6ffed", fg: "#056d30" };
    case "demo": return { bg: "#eff6ff", fg: "#1d4ed8" };
    case "connecting": return { bg: "#fff7ed", fg: "#9a3412" };
    case "error": return { bg: "#fee2e2", fg: "#b91c1c" };
    default: return { bg: "#f3f4f6", fg: "#374151" };
  }
}