// frontend/tabs/CommoditiesPanel.tsx
// Drop-in, production-ready. No external imports. Works with React 17+ JSX runtime.

type Quote = { contract: string; expiry: string; price: number };
type ChainRow = { expiry: string; K: number; iv: number; call: boolean; F: number; r: number };
type Props = {
  asOfISO: string;
  quotes: Quote[];
  chain: ChainRow[];
  // optional margin settings
  riskFactor?: number;          // e.g., 0.08 means 8% of notional
  concentrationBps?: number;    // e.g., 50 bps = 0.50%
  positionQty?: number;         // used for margin preview per option row
};

type CurvePoint = { ttmYears: number; price: number; expiry: string; contract: string };
type Greeks = { price: number; delta: number; gamma: number; vega: number; theta: number; rho: number };

function fmt(n: number, d = 2) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: d }).format(n);
}
function pct(n: number, d = 2) {
  return `${(n * 100).toFixed(d)}%`;
}
function daysBetween(a: Date, b: Date) {
  return Math.max(0, Math.round((a.getTime() - b.getTime()) / 86400000));
}
function ttmYears(expiryISO: string, asOf: Date) {
  return Math.max(1e-6, (new Date(expiryISO).getTime() - asOf.getTime()) / (365.25 * 86400000));
}

/** Build forward curve points, sorted by time-to-maturity (years). */
function buildForwardCurve(quotes: Quote[], asOf: Date): CurvePoint[] {
  return quotes
    .filter(q => Number.isFinite(q.price))
    .map(q => ({ ttmYears: ttmYears(q.expiry, asOf), price: q.price, expiry: q.expiry, contract: q.contract }))
    .sort((a, b) => a.ttmYears - b.ttmYears);
}

/** Error function (Abramowitz–Stegun approximation). */
function erf(x: number) {
  const s = Math.sign(x);
  const ax = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return s * y;
}
function N(x: number) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function nPdf(x: number) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }

/** Black-76 pricing + greeks for options on futures. */
function black76(isCall: boolean, F: number, K: number, r: number, sigma: number, T: number): Greeks {
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(F / K) + (0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const df = Math.exp(-r * T);

  const price = df * (isCall ? (F * N(d1) - K * N(d2)) : (K * N(-d2) - F * N(-d1)));
  const delta = df * (isCall ? N(d1) : (N(d1) - 1));
  const gamma = df * nPdf(d1) / (F * sigma * sqrtT);
  const vega = (df * F * nPdf(d1) * sqrtT) / 100;                    // per 1% vol
  const theta = (-df * F * nPdf(d1) * sigma / (2 * sqrtT) + (isCall ? r * df * K * N(d2) : -r * df * K * N(-d2))) / 365;
  const rho = (isCall ? T * df * K * N(d2) : -T * df * K * N(-d2)) / 100; // per 1% rate

  return { price, delta, gamma, vega, theta, rho };
}

/** SPAN-lite initial margin estimate. */
function initialMargin(notional: number, riskFactor = 0.08, concentrationBps = 0, stressAdd = 0) {
  const base = Math.abs(notional) * riskFactor;
  const conc = Math.abs(notional) * (concentrationBps / 10000);
  return Math.max(0, base + conc + stressAdd);
}

/** Simple SVG line chart for the forward curve (no external libs). */
function CurveChart({ points }: { points: CurvePoint[] }) {
  if (!points.length) return null;
  const width = 560, height = 180, pad = 28;

  const xs = points.map(p => p.ttmYears);
  const ys = points.map(p => p.price);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const xScale = (x: number) => pad + ((x - minX) / (maxX - minX || 1)) * (width - 2 * pad);
  const yScale = (y: number) => height - pad - ((y - minY) / (maxY - minY || 1)) * (height - 2 * pad);

  const path = points.map((p, i) => `${i ? "L" : "M"}${xScale(p.ttmYears)},${yScale(p.price)}`).join(" ");

  // tick marks (0..maxX, 4 ticks)
  const ticks = 4;
  const xt: { x: number; label: string }[] = [];
  for (let i = 0; i <= ticks; i++) {
    const x = minX + (i / ticks) * (maxX - minX);
    xt.push({ x, label: `${x.toFixed(2)}y` });
  }

  return (
    <svg width={width} height={height} role="img" aria-label="Forward curve chart">
      <rect x="0" y="0" width={width} height={height} fill="none" stroke="#ddd" />
      {/* axes */}
      <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="#aaa" />
      <line x1={pad} y1={pad} x2={pad} y2={height - pad} stroke="#aaa" />
      {/* x ticks */}
      {xt.map((t, i) => (
        <g key={i}>
          <line x1={xScale(t.x)} x2={xScale(t.x)} y1={height - pad} y2={height - pad + 6} stroke="#aaa" />
          <text x={xScale(t.x)} y={height - pad + 18} textAnchor="middle" fontSize="10">{t.label}</text>
        </g>
      ))}
      {/* y min/max labels */}
      <text x={8} y={yScale(minY)} fontSize="10">{fmt(minY)}</text>
      <text x={8} y={yScale(maxY)} fontSize="10">{fmt(maxY)}</text>
      {/* curve */}
      <path d={path} fill="none" stroke="#2563eb" strokeWidth="2" />
      {/* points */}
      {points.map((p, i) => (
        <circle key={i} cx={xScale(p.ttmYears)} cy={yScale(p.price)} r="2.5" fill="#111827" />
      ))}
    </svg>
  );
}

export default function CommoditiesPanel({
  asOfISO,
  quotes,
  chain,
  riskFactor = 0.08,
  concentrationBps = 0,
  positionQty = 1
}: Props) {
  const asOf = new Date(asOfISO);
  const curve = buildForwardCurve(quotes, asOf);

  // compute chain with greeks, sorted by expiry then strike
  const chainWithGreeks = chain
    .map(row => {
      const T = ttmYears(row.expiry, asOf);
      const g = black76(row.call, row.F, row.K, row.r, row.iv, T);
      const notional = row.F * Math.abs(positionQty);
      const margin = initialMargin(notional, riskFactor, concentrationBps);
      return {
        ...row,
        T,
        days: daysBetween(new Date(row.expiry), asOf),
        ...g,
        margin
      };
    })
    .sort((a, b) => (a.expiry === b.expiry ? a.K - b.K : a.expiry.localeCompare(b.expiry)));

  return (
    <section aria-labelledby="comms-head">
      <h2 id="comms-head">Commodities</h2>
      <p className="text-sm" aria-live="polite">
        As of <time dateTime={asOfISO}>{asOf.toLocaleString()}</time>
      </p>

      {/* Forward Curve */}
      <div role="group" aria-labelledby="curve-head" className="mt-4">
        <h3 id="curve-head">Forward Curve</h3>
        {curve.length ? (
          <>
            <CurveChart points={curve} />
            <div className="overflow-auto">
              <table role="table" aria-label="Forward curve table">
                <thead>
                  <tr>
                    <th scope="col">Contract</th>
                    <th scope="col">Expiry</th>
                    <th scope="col">TTM (yrs)</th>
                    <th scope="col">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {curve.map(p => (
                    <tr key={p.contract}>
                      <td>{p.contract}</td>
                      <td>{p.expiry}</td>
                      <td>{p.ttmYears.toFixed(3)}</td>
                      <td>{fmt(p.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p>No quotes available.</p>
        )}
      </div>

      {/* Options Chain */}
      <div role="group" aria-labelledby="chain-head" className="mt-6">
        <h3 id="chain-head">Options Chain (Black-76)</h3>
        {chainWithGreeks.length ? (
          <div className="overflow-auto">
            <table role="table" aria-label="Options chain with greeks and margin">
              <thead>
                <tr>
                  <th scope="col">Expiry</th>
                  <th scope="col">DTE</th>
                  <th scope="col">K</th>
                  <th scope="col">Type</th>
                  <th scope="col">F</th>
                  <th scope="col">IV</th>
                  <th scope="col">Price</th>
                  <th scope="col">Delta</th>
                  <th scope="col">Gamma</th>
                  <th scope="col">Vega</th>
                  <th scope="col">Theta</th>
                  <th scope="col">Rho</th>
                  <th scope="col">Margin (pos x{positionQty})</th>
                </tr>
              </thead>
              <tbody>
                {chainWithGreeks.map((r, i) => (
                  <tr key={i}>
                    <td>{r.expiry}</td>
                    <td>{r.days}</td>
                    <td>{fmt(r.K, 2)}</td>
                    <td>{r.call ? "Call" : "Put"}</td>
                    <td>{fmt(r.F, 2)}</td>
                    <td>{pct(r.iv, 2)}</td>
                    <td>{fmt(r.price, 4)}</td>
                    <td>{fmt(r.delta, 4)}</td>
                    <td>{fmt(r.gamma, 6)}</td>
                    <td>{fmt(r.vega, 4)}</td>
                    <td>{fmt(r.theta, 4)}</td>
                    <td>{fmt(r.rho, 4)}</td>
                    <td>{fmt(r.margin, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>No option chain rows.</p>
        )}
        <p className="text-xs mt-2">
          Margin uses SPAN-lite: |notional| × riskFactor + concentration bps. RiskFactor={pct(riskFactor)}; Conc={concentrationBps} bps.
        </p>
      </div>
    </section>
  );
}