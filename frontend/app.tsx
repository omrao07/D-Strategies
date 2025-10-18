import React, { useState } from "react";

// --- RunModelsTab inline ---
function RunModelsTab({
  strategies,
  runStrategy
}: {
  strategies: { id: string; name: string; description?: string }[];
  runStrategy: (id: string) => Promise<{ ok: boolean; msg: string }>;
}) {
  const [status, setStatus] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState("");

  const visible = strategies.filter(s =>
    (s.name + " " + (s.description || "")).toLowerCase().includes(filter.toLowerCase())
  );

  const onRun = async (id: string) => {
    setRunning(prev => ({ ...prev, [id]: true }));
    setStatus(prev => ({ ...prev, [id]: "Running…" }));
    try {
      const res = await runStrategy(id);
      setStatus(prev => ({ ...prev, [id]: res.ok ? `✅ ${res.msg}` : `❌ ${res.msg}` }));
    } catch (e: any) {
      setStatus(prev => ({ ...prev, [id]: `❌ ${e?.message || "Failed"}` }));
    } finally {
      setRunning(prev => ({ ...prev, [id]: false }));
    }
  };

  return (
    <section aria-labelledby="models-heading">
      <h2 id="models-heading">Run Quant Models</h2>
      <label>
        <span className="sr-only">Filter strategies</span>
        <input
          aria-label="Filter strategies"
          placeholder="Filter…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      </label>
      <ul>
        {visible.map(s => (
          <li key={s.id}>
            <h3>{s.name}</h3>
            {s.description && <p>{s.description}</p>}
            <button disabled={!!running[s.id]} onClick={() => onRun(s.id)}>
              {running[s.id] ? "Running…" : "Run"}
            </button>
            <span>{status[s.id] || ""}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- JarvisPanel inline ---
function JarvisPanel() {
  const demoAlerts = [
    { level: "warn", text: "Cash low (1.5%)" },
    { level: "info", text: "Arbitrage opportunity CLZ25/CLF26" }
  ];
  return (
    <section>
      <h2>Portfolio Jarvis</h2>
      <ul>
        {demoAlerts.map((a, i) => (
          <li key={i}>
            <strong>[{a.level.toUpperCase()}]</strong> {a.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- CommoditiesPanel inline ---
function CommoditiesPanel({
  asOfISO,
  quotes,
  chain
}: {
  asOfISO: string;
  quotes: { contract: string; expiry: string; price: number }[];
  chain: { expiry: string; K: number; iv: number; call: boolean; F: number; r: number }[];
}) {
  return (
    <section>
      <h2>Commodities</h2>
      <h3>Forward Curve (as of {asOfISO})</h3>
      <table>
        <thead>
          <tr>
            <th>Contract</th>
            <th>Expiry</th>
            <th>Price</th>
          </tr>
        </thead>
        <tbody>
          {quotes.map(q => (
            <tr key={q.contract}>
              <td>{q.contract}</td>
              <td>{q.expiry}</td>
              <td>{q.price}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Options Chain (sample)</h3>
      <table>
        <thead>
          <tr>
            <th>Expiry</th>
            <th>Strike</th>
            <th>Call?</th>
            <th>IV</th>
            <th>Fwd</th>
          </tr>
        </thead>
        <tbody>
          {chain.map((c, i) => (
            <tr key={i}>
              <td>{c.expiry}</td>
              <td>{c.K}</td>
              <td>{c.call ? "Call" : "Put"}</td>
              <td>{(c.iv * 100).toFixed(1)}%</td>
              <td>{c.F}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// --- Main App ---
export default function App() {
  const [activeTab, setActiveTab] = useState<"models" | "jarvis" | "commodities">("models");

  const STRATEGIES = [
    { id: "mean-reversion", name: "Mean Reversion", description: "Trades reversals" },
    { id: "momentum", name: "Momentum", description: "Trend following breakout" }
  ];

  async function runStrategy(id: string): Promise<{ ok: boolean; msg: string }> {
    await new Promise(r => setTimeout(r, 500));
    return { ok: true, msg: `Strategy ${id} completed.` };
  }

  return (
    <div className="min-h-screen flex flex-col font-sans">
      <header className="bg-gray-900 text-white p-4 flex items-center justify-between">
        <h1 className="text-xl font-bold">HF Platform</h1>
        <nav>
          <ul className="flex gap-4">
            <li>
              <button onClick={() => setActiveTab("models")}>Models</button>
            </li>
            <li>
              <button onClick={() => setActiveTab("jarvis")}>Jarvis</button>
            </li>
            <li>
              <button onClick={() => setActiveTab("commodities")}>Commodities</button>
            </li>
          </ul>
        </nav>
      </header>

      <main className="flex-1 p-4">
        {activeTab === "models" && (
          <RunModelsTab strategies={STRATEGIES} runStrategy={runStrategy} />
        )}
        {activeTab === "jarvis" && <JarvisPanel />}
        {activeTab === "commodities" && (
          <CommoditiesPanel
            asOfISO={new Date().toISOString()}
            quotes={[
              { contract: "CLZ25", expiry: "2025-12-20", price: 72.3 },
              { contract: "CLF26", expiry: "2026-01-20", price: 73.1 }
            ]}
            chain={[
              { expiry: "2025-12-20", K: 70, iv: 0.25, call: true, F: 72.3, r: 0.01 },
              { expiry: "2025-12-20", K: 75, iv: 0.25, call: false, F: 72.3, r: 0.01 }
            ]}
          />
        )}
      </main>

      <footer className="bg-gray-100 text-center text-sm text-gray-600 p-2">
        © {new Date().getFullYear()} Hedge Fund Platform — Demo Build
      </footer>
    </div>
  );
}