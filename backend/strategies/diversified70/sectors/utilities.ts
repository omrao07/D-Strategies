// sectors/utilities.ts
// Pure TypeScript. No imports.
// Lightweight sector config for Utilities (GICS 55).
// Sub-sectors, regional universes, target weights, and utilities.

export type Ticker = string;

export type SubSector = {
  key: string;                // e.g., "ELECTRIC"
  displayName: string;        // "Electric Utilities (Gen & Dist)"
  targetWeight: number;       // 0..1 pre-normalization across sub-sectors
  tickers: Ticker[];          // representative namespaced tickers
};

export type SectorUniverse = {
  region: "US" | "EU" | "JP" | "CN" | "IN" | "GLOBAL";
  tickers: Ticker[];
};

export type SectorConfig = {
  sectorCode: "UTIL";
  gics: 55;
  name: "Utilities";
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
// Weights sum to 1.00 (normalized defensively at runtime).

const SUBSECTORS: SubSector[] = [
  {
    key: "ELECTRIC",
    displayName: "Electric Utilities (Generation & Distribution)",
    targetWeight: 0.30,
    tickers: [
      "NEE", "DUK", "SO", "AEP", "EXC", "XEL", "PEG", "ED", "EIX", "PCG",
      "RWE.DE", "EOAN.DE", "EDF.PA", "IBE.MC", "ENEL.MI",
      "9501.T", "9502.T", "9503.T",
      "600011.SH" /* Huaneng Power A */, "902.HK" /* Huaneng Power H */,
      "NTPC.NS", "NHPC.NS", "SJVN.NS", "TATAPOWER.NS"
    ],
  },
  {
    key: "IPP_RENEW",
    displayName: "IPPs & Renewable Electricity / Yieldcos",
    targetWeight: 0.22,
    tickers: [
      "CEG", "AES", "NRG", "AY", "BEPC", "NEP",
      "ORSTED.CO", "EDPR.LS", "ACCIONA.MC*ALT",
      "9509.T*ENETECH-ALT",
      "2380.HK" /* China Power */,
      "ADANIGREEN.NS", "RENEW.NS*ALT"
    ],
  },
  {
    key: "GAS_UTIL",
    displayName: "Gas Utilities & City Gas",
    targetWeight: 0.16,
    tickers: [
      "ATO", "OGS", "NI", "SWX", "NWN",
      "9531.T" /* Tokyo Gas */, "9532.T" /* Osaka Gas */,
      "2688.HK" /* ENN Energy */,
      "IGL.NS", "MGL.NS", "GUJGASLTD.NS"
    ],
  },
  {
    key: "MULTI_TX",
    displayName: "Transmission & Multi-Utilities",
    targetWeight: 0.14,
    tickers: [
      "SRE", "DTE", "FE", "PPL", "ES", "ETR", "AVA",
      "NG.L", "RED.MC*REDEIA", "NDA*ALT",
      "9504.T*Chugoku Elec (mix)",
      "POWERGRID.NS", "ADANIENSOL.NS" /* Adani Energy Solutions */
    ],
  },
  {
    key: "WATER",
    displayName: "Water Utilities",
    targetWeight: 0.10,
    tickers: [
      "AWK", "WTRG", "MSEX", "SJW",
      "SEV.PA*ALT", "SVT.L*ALT",
      "2751.T*Alt-Water",
      "VA TECH WABAG.NS*SERV" // services tilt
    ],
  },
  {
    key: "POWER_MKT",
    displayName: "Power Exchanges & Retail / Other",
    targetWeight: 0.08,
    tickers: [
      "NORDPOOL*PRIVATE", "APX*ALT",
      "IEX.NS", // India Energy Exchange
      "PXE*ALT"
    ],
  },
];

// ---------- Regional Universes (Representative) ----------

const UNI_US: SectorUniverse = {
  region: "US",
  tickers: [
    "NEE", "DUK", "SO", "AEP", "EXC", "XEL", "PEG", "ED", "EIX", "PCG",
    "SRE", "DTE", "FE", "PPL", "ES", "ETR",
    "CEG", "AES", "NRG", "BEPC", "AY", "NEP",
    "ATO", "OGS", "NI",
    "AWK", "WTRG", "MSEX", "SJW"
  ],
};

const UNI_EU: SectorUniverse = {
  region: "EU",
  tickers: [
    "NG.L", "RWE.DE", "EOAN.DE", "EDF.PA", "IBE.MC", "ENEL.MI",
    "ORSTED.CO", "EDPR.LS", "RED.MC",
    "SVT.L*ALT", "SEV.PA*ALT"
  ],
};

const UNI_JP: SectorUniverse = {
  region: "JP",
  tickers: [
    "9501.T", "9502.T", "9503.T", // TEPCO, Kansai, Chubu
    "9531.T", "9532.T"            // Tokyo Gas, Osaka Gas
  ],
};

const UNI_CN: SectorUniverse = {
  region: "CN",
  tickers: [
    "600011.SH", "601991.SH", "601985.SH", // Huaneng, Datang, CNNP
    "902.HK", "916.HK", "2380.HK",         // Huaneng H, Datang H, China Power
    "2688.HK"                              // ENN Energy (city gas)
  ],
};

const UNI_IN: SectorUniverse = {
  region: "IN",
  tickers: [
    "NTPC.NS", "NHPC.NS", "SJVN.NS", "TATAPOWER.NS",
    "POWERGRID.NS", "ADANIENSOL.NS",
    "IGL.NS", "MGL.NS", "GUJGASLTD.NS",
    "IEX.NS"
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

function rebalanceWeights(
  prices: { [t: string]: number },
  subWeights: { [k: string]: number },
  capHint?: { [t: string]: number }
): { [t: string]: number } {
  const group: { [k: string]: Ticker[] } = {};
  const all = Object.keys(prices);
  for (let i = 0; i < all.length; i++) {
    const t = norm(all[i]);
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

const UTILITIES: SectorConfig = {
  sectorCode: "UTIL",
  gics: 55,
  name: "Utilities",
  description:
    "Global utilities across electric generation & distribution, IPPs & renewables/yieldcos, gas utilities, transmission & multi-utilities, water utilities, and power market infrastructure.",
  subSectors: SUBSECTORS,
  universes: [UNI_US, UNI_EU, UNI_JP, UNI_CN, UNI_IN, UNI_GLOBAL],

  normalizeTicker: function (t: string): string {
    return norm(t);
  },

  classifyTicker: function (t: string): string {
    const k = SUB_REV[norm(t)];
    return k || "OTHER";
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

export default UTILITIES;
