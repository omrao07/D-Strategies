// sectors/consumerstaples.ts
// Pure TypeScript. No imports.
// Lightweight sector config for Consumer Staples (GICS 30).
// Static universes, sub-sector map, target weights, and simple utilities.

export type Ticker = string;

export type SubSector = {
  key: string;                // e.g., "FOOD_BEV"
  displayName: string;        // "Food & Beverage"
  targetWeight: number;       // 0..1 pre-normalization across sub-sectors
  tickers: Ticker[];          // representative namespaced tickers
};

export type SectorUniverse = {
  region: "US" | "EU" | "JP" | "CN" | "IN" | "GLOBAL";
  tickers: Ticker[];
};

export type SectorConfig = {
  sectorCode: "CS";
  gics: 30;
  name: "Consumer Staples";
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

const SUBSECTORS: SubSector[] = [
  {
    key: "FOOD_BEV",
    displayName: "Food & Beverage (Packaged)",
    targetWeight: 0.28,
    tickers: [
      "PEP", "KO", "MNST", "KDP", "KHC", "GIS", "CPB", "SJM",
      "NSRGY*ADR", "NESN.SW", "ULVR.L", "DANOY*ADR", "BN.PA", "HEIA.AS",
      "MDLZ",
    ],
  },
  {
    key: "HHP",
    displayName: "Household & Personal Products",
    targetWeight: 0.22,
    tickers: [
      "PG", "CL", "KMB", "CHD", "ULVR.L", "HNZ*HIST",
      "REGL.PA*HIST", "BEI.DE", "HEN3.DE", "EL"
    ],
  },
  {
    key: "FOOD_RETAIL",
    displayName: "Food Retail & Hypermarkets",
    targetWeight: 0.18,
    tickers: [
      "WMT", "COST", "KR", "ACI", "TGT",
      "AD.AS", "TSCO.L", "SBRY.L", "CARREFOUR.PA", "A1G.DE*ALDI*PRIVATE",
      "JUMPNL.AS*JUMBO", "MRW.L*HIST"
    ],
  },
  {
    key: "TOBACCO",
    displayName: "Tobacco",
    targetWeight: 0.12,
    tickers: [
      "PM", "MO", "BTI", "IMB.L", "SWMA.ST"
    ],
  },
  {
    key: "AGRI_ING",
    displayName: "Ingredients, Flavors & Agri Supply",
    targetWeight: 0.10,
    tickers: [
      "INGR", "TATE.L", "KERRY.IR*KRZ", "DSM.AS*HIST", "IFF"
    ],
  },
  {
    key: "BEV_ALC",
    displayName: "Alcoholic Beverages",
    targetWeight: 0.10,
    tickers: [
      "DEO", "BUD", "STZ", "SAM", "HEIA.AS", "PERP.PA*PERNOD", "CARL-B.CO"
    ],
  },
];

// ---------- Regional Universes (Representative) ----------

const UNI_US: SectorUniverse = {
  region: "US",
  tickers: [
    "PG", "KO", "PEP", "CL", "KMB", "WMT", "COST", "KR", "TGT",
    "MDLZ", "KHC", "GIS", "CPB", "SJM", "CHD", "STZ", "MNST", "IFF"
  ],
};

const UNI_EU: SectorUniverse = {
  region: "EU",
  tickers: [
    "NESN.SW", "ULVR.L", "BN.PA", "DANOY*ADR", "HEIA.AS", "CARREFOUR.PA",
    "TSCO.L", "SBRY.L", "BEI.DE", "HEN3.DE", "DEO", "BUD", "CARL-B.CO"
  ],
};

const UNI_JP: SectorUniverse = {
  region: "JP",
  tickers: [
    "2503.T", // Kirin
    "2502.T", // Asahi
    "2593.T", // Ito En
    "4452.T", // Kao
    "4911.T", // Shiseido
  ],
};

const UNI_CN: SectorUniverse = {
  region: "CN",
  tickers: [
    "603288.SH", // Haidilao*HIST alt 6862.HK (restaurants, borderline discretionary)
    "600519.SH", // Kweichow Moutai (baijiu - alc)
    "000858.SZ", // Wuliangye
    "600887.SH", // Yili
    "600573.SH", // Huafu/Arawana oils*alt 300999.SZ
  ],
};

const UNI_IN: SectorUniverse = {
  region: "IN",
  tickers: [
    "HINDUNILVR.NS", "ITC.NS", "TATACONSUM.NS", "NESTLEIND.NS", "DABUR.NS",
    "MARICO.NS", "BRITANNIA.NS", "VBL.NS", "UBL.NS", "UNITEDSPIR.NS"
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

  let s = 0;
  const keys = Object.keys(w);
  for (let i = 0; i < keys.length; i++) s += w[keys[i]];
  if (s > 0) {
    for (let i = 0; i < keys.length; i++) w[keys[i]] = w[keys[i]] / s;
  }
  return w;
}

// ---------- Exported Object ----------

const CONSUMER_STAPLES: SectorConfig = {
  sectorCode: "CS",
  gics: 30,
  name: "Consumer Staples",
  description:
    "Defensive consumer categories: packaged food & beverage, household & personal products, food retail, tobacco, ingredients, and alcoholic beverages.",
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

export default CONSUMER_STAPLES;
