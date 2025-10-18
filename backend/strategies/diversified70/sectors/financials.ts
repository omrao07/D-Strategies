// sectors/financials.ts
// Pure TypeScript. No imports.
// Lightweight sector config for Financials (GICS 40).
// Static sub-sectors, regional universes, target weights, and utilities.

export type Ticker = string;

export type SubSector = {
  key: string;                // e.g., "BANKS_GLOBAL"
  displayName: string;        // "Global/Diversified Banks"
  targetWeight: number;       // 0..1 pre-normalization across sub-sectors
  tickers: Ticker[];          // representative namespaced tickers
};

export type SectorUniverse = {
  region: "US" | "EU" | "JP" | "CN" | "IN" | "GLOBAL";
  tickers: Ticker[];
};

export type SectorConfig = {
  sectorCode: "FN";
  gics: 40;
  name: "Financials";
  description: string;
  subSectors: SubSector[];
  universes: SectorUniverse[];
  // --- helpers ---
  normalizeTicker: (t: string) => string;
  classifyTicker: (t: string) => string; // returns SubSector.key or "OTHER"
  sectorWeightMap: () => { [subKey: string]: number }; // normalized weights
  basket: (region?: SectorUniverse["region"], maxPerSub?: number) => Ticker[]; // diversified list
  rebalance: (px: { [t: string]: number }, capHint?: { [t: string]: number }) => { [t: string]: number };
};

// ---------- Sub-Sectors ----------
// Weights sum to 1.00 (will be re-normalized defensively).

const SUBSECTORS: SubSector[] = [
  {
    key: "BANKS_GLOBAL",
    displayName: "Global/Diversified Banks",
    targetWeight: 0.20,
    tickers: [
      "JPM", "BAC", "C", "WFC",
      "HSBA.L", "BNP.PA", "ACA.PA", "GLE.PA", "DBK.DE", "UBSG.SW",
      "8306.T", "8316.T", "8411.T",
      "601398.SH", "601939.SH", "601288.SH", "3988.HK",
      "HDFCBANK.NS", "ICICIBANK.NS", "KOTAKBANK.NS", "AXISBANK.NS", "SBIN.NS"
    ],
  },
  {
    key: "BANKS_REGIONAL",
    displayName: "Regional & Community Banks",
    targetWeight: 0.12,
    tickers: [
      "PNC", "USB", "TFC", "FITB", "KEY", "RF", "HBAN", "CFG",
      "NWG.L", "LLOY.L", "ISP.MI", "SAN.MC", "BBVA.MC",
      "601166.SH" /* Industrial Bank A */, "600016.SH" /* Minsheng */
    ],
  },
  {
    key: "INSURANCE_LIFE_HEALTH",
    displayName: "Insurance — Life & Health",
    targetWeight: 0.14,
    tickers: [
      "MET", "PRU", "LNC", "AFL",
      "AXA.PA", "ZURN.SW", "AV.L",
      "8750.T" /* Dai-ichi Life */, "8766.T" /* Tokio Marine (mixed) */,
      "601628.SH" /* China Life */, "1339.HK" /* PICC Group */,
      "HDFCLIFE.NS", "ICICIPRULI.NS", "SBILIFE.NS"
    ],
  },
  {
    key: "INSURANCE_PNC_RE",
    displayName: "Insurance — P&C & Reinsurance",
    targetWeight: 0.12,
    tickers: [
      "ALL", "PGR", "TRV", "CB", "AIG",
      "MUV2.DE" /* Munich Re */, "SREN.SW" /* Swiss Re */,
      "8750.T", "8766.T",
    ],
  },
  {
    key: "ASSET_MGMT_ALT",
    displayName: "Asset Managers & Alternatives",
    targetWeight: 0.10,
    tickers: [
      "BLK", "TROW", "BEN",
      "BX", "KKR", "APO", "ARES",
      "AMP", "AB", "IVZ",
      "3V64.DE*DBX", "AMUN.PA*AMUNDI"
    ],
  },
  {
    key: "EXCHANGES_INFRA",
    displayName: "Exchanges & Market Infrastructure",
    targetWeight: 0.10,
    tickers: [
      "ICE", "CME", "NDAQ", "CBOE",
      "DB1.DE", "LSEG.L", "ENX.PA",
      "8697.T" /* JPX */, "BSE.NS", "MCX.NS"
    ],
  },
  {
    key: "PAYMENTS_FINTECH",
    displayName: "Payments & FinTech",
    targetWeight: 0.12,
    tickers: [
      "V", "MA", "AXP", "COF", "DFS", "PYPL", "SQ",
      "ADYEN.AS", "WDI.DE*HIST",
      "PAYTM.NS", "PBFINTECH.NS", "CAMS.NS", "SOFI"
    ],
  },
  {
    key: "BROKERS_CAPMKTS",
    displayName: "Brokers, Dealers & Capital Markets",
    targetWeight: 0.06,
    tickers: [
      "GS", "MS", "SCHW", "BK", "NTRS", "STT",
      "600030.SH" /* CITIC Sec */, "601688.SH" /* Huatai Sec */,
      "ANGELONE.NS", "IIFL.NS*ALT"
    ],
  },
  {
    key: "NBFC_EM",
    displayName: "Non-Bank Financials (EM/India Heavy)",
    targetWeight: 0.04,
    tickers: [
      "BAJFINANCE.NS", "BAJAJFINSV.NS", "HDFC*HIST", "LICHSGFIN.NS",
      "MUTHOOTFIN.NS", "SRTRANSFIN.NS"
    ],
  },
];

// ---------- Regional Universes (Representative) ----------

const UNI_US: SectorUniverse = {
  region: "US",
  tickers: [
    "JPM", "BAC", "C", "WFC",
    "GS", "MS", "SCHW", "BK",
    "BLK", "BX", "KKR", "APO",
    "V", "MA", "AXP", "COF", "DFS", "PYPL", "SQ",
    "ICE", "CME", "NDAQ", "CBOE",
    "ALL", "PGR", "TRV", "CB", "AIG",
    "PNC", "USB", "TFC", "HBAN", "KEY"
  ],
};

const UNI_EU: SectorUniverse = {
  region: "EU",
  tickers: [
    "HSBA.L", "LLOY.L", "NWG.L",
    "BNP.PA", "ACA.PA", "GLE.PA",
    "DBK.DE", "UBSG.SW", "SAN.MC", "BBVA.MC", "INGA.AS",
    "AXA.PA", "MUV2.DE", "ZURN.SW", "SREN.SW",
    "LSEG.L", "DB1.DE", "ENX.PA", "ADYEN.AS"
  ],
};

const UNI_JP: SectorUniverse = {
  region: "JP",
  tickers: [
    "8306.T", "8316.T", "8411.T",
    "8697.T", // JPX
    "8750.T", "8766.T"
  ],
};

const UNI_CN: SectorUniverse = {
  region: "CN",
  tickers: [
    "601398.SH", "601939.SH", "601288.SH", "600036.SH", "600000.SH",
    "3988.HK", "2318.HK", "601318.SH", "601628.SH",
    "600030.SH", "601688.SH"
  ],
};

const UNI_IN: SectorUniverse = {
  region: "IN",
  tickers: [
    "HDFCBANK.NS", "ICICIBANK.NS", "KOTAKBANK.NS", "AXISBANK.NS", "SBIN.NS",
    "BAJFINANCE.NS", "BAJAJFINSV.NS", "HDFCLIFE.NS", "ICICIPRULI.NS", "SBILIFE.NS",
    "BSE.NS", "MCX.NS", "ANGELONE.NS", "PAYTM.NS", "CAMS.NS", "PBFINTECH.NS"
  ],
};

const UNI_GLOBAL: SectorUniverse = {
  region: "GLOBAL",
  tickers: Array.from(
    new Set([
      ...UNI_US.tickers,
      ...UNI_EU.tickers,
      ...UNI_JP.tickers,
      ...UNI_CN.tickers,
      ...UNI_IN.tickers,
    ])
  ),
};

// ---------- Utilities ----------

function norm(t: string): string {
  return (t || "").trim().toUpperCase();
}

function buildReverse(subs: SubSector[]): { [t: string]: string } {
  const m: { [t: string]: string } = {};
  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];
    for (let j = 0; j < s.tickers.length; j++) {
      m[norm(s.tickers[j])] = s.key;
    }
  }
  return m;
}
const SUB_REV = buildReverse(SUBSECTORS);

function normalizedWeights(): { [k: string]: number } {
  let sum = 0;
  for (let i = 0; i < SUBSECTORS.length; i++) sum += Math.max(0, SUBSECTORS[i].targetWeight);
  const out: { [k: string]: number } = {};
  for (let i = 0; i < SUBSECTORS.length; i++) {
    const s = SUBSECTORS[i];
    out[s.key] = sum > 0 ? Math.max(0, s.targetWeight) / sum : 0;
  }
  return out;
}

// Build a diversified basket respecting sub-sector spread
function diversifiedBasket(region?: SectorUniverse["region"], maxPerSub: number = 3): Ticker[] {
  const uni = region === "US" ? UNI_US
    : region === "EU" ? UNI_EU
    : region === "JP" ? UNI_JP
    : region === "CN" ? UNI_CN
    : region === "IN" ? UNI_IN
    : UNI_GLOBAL;

  const out: Ticker[] = [];
  const counts: { [k: string]: number } = {};
  for (let i = 0; i < uni.tickers.length; i++) {
    const t = norm(uni.tickers[i]);
    const key = SUB_REV[t] || "OTHER";
    const c = counts[key] || 0;
    if (c < maxPerSub) {
      out.push(t);
      counts[key] = c + 1;
    }
  }
  return out;
}

// Within-sub allocation equals or cap-proportional, scaled by sub-sector weights
function rebalanceWeights(
  prices: { [t: string]: number },
  subWeights: { [k: string]: number },
  capHint?: { [t: string]: number }
): { [t: string]: number } {
  const group: { [k: string]: Ticker[] } = {};
  const allTickers = Object.keys(prices);
  for (let i = 0; i < allTickers.length; i++) {
    const t = norm(allTickers[i]);
    const k = SUB_REV[t] || "OTHER";
    if (!group[k]) group[k] = [];
    group[k].push(t);
  }

  const w: { [t: string]: number } = {};
  const subKeys = Object.keys(group);
  for (let i = 0; i < subKeys.length; i++) {
    const k = subKeys[i];
    const names = group[k];
    const sw = subWeights[k] !== undefined ? subWeights[k] : 0;
    if (names.length === 0 || sw <= 0) continue;

    if (capHint) {
      let sumCap = 0;
      for (let j = 0; j < names.length; j++) sumCap += Math.max(0, capHint[names[j]] || 0);
      if (sumCap <= 0) {
        const eq = sw / names.length;
        for (let j = 0; j < names.length; j++) w[names[j]] = eq;
      } else {
        for (let j = 0; j < names.length; j++) {
          const c = Math.max(0, capHint[names[j]] || 0);
          w[names[j]] = sw * (c / sumCap);
        }
      }
    } else {
      const eq = sw / names.length;
      for (let j = 0; j < names.length; j++) w[names[j]] = eq;
    }
  }

  // Normalize to 1
  let s = 0;
  const keys = Object.keys(w);
  for (let i = 0; i < keys.length; i++) s += w[keys[i]];
  if (s > 0) {
    for (let i = 0; i < keys.length; i++) w[keys[i]] = w[keys[i]] / s;
  }
  return w;
}

// ---------- Exported Object ----------

const FINANCIALS: SectorConfig = {
  sectorCode: "FN",
  gics: 40,
  name: "Financials",
  description:
    "Banks, insurance, asset/wealth managers, exchanges & market infra, payments/fintech, brokers/dealers, and select NBFCs.",
  subSectors: SUBSECTORS,
  universes: [UNI_US, UNI_EU, UNI_JP, UNI_CN, UNI_IN, UNI_GLOBAL],

  normalizeTicker: function (t: string): string {
    return norm(t);
  },

  classifyTicker: function (t: string): string {
    const k = SUB_REV[norm(t)];
    return k || "OTHER";
    // Note: REITs are not included here (GICS Real Estate).
  },

  sectorWeightMap: function (): { [subKey: string]: number } {
    return normalizedWeights();
  },

  basket: function (region?: SectorUniverse["region"], maxPerSub: number = 3): Ticker[] {
    return diversifiedBasket(region, maxPerSub);
  },

  rebalance: function (
    px: { [t: string]: number },
    capHint?: { [t: string]: number }
  ): { [t: string]: number } {
    const subW = this.sectorWeightMap();
    return rebalanceWeights(px, subW, capHint);
  },
};

export default FINANCIALS;
