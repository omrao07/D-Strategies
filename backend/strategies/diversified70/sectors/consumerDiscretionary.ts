// sectors/consumerdiscretionary.ts
// Pure TypeScript. No imports.
// Lightweight sector config for Consumer Discretionary (GICS 25).
// Includes static universes, sub-sector map, target weights, and utilities.

export type Ticker = string;

export type SubSector = {
  key: string;                // e.g., "E_COM"
  displayName: string;        // "E-Commerce & Online Retail"
  targetWeight: number;       // 0..1 pre-normalization across sub-sectors
  tickers: Ticker[];          // representative namespaced tickers
};

export type SectorUniverse = {
  region: "US" | "EU" | "JP" | "CN" | "IN" | "GLOBAL";
  tickers: Ticker[];
};

export type SectorConfig = {
  sectorCode: "CD";
  gics: 25;
  name: "Consumer Discretionary";
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

// ---------- Static Sub-Sector Structure ----------
// Target weights are rough anchors for a balanced discretionary sleeve.
// They’ll be re-normalized by sectorWeightMap().

const SUBSECTORS: SubSector[] = [
  {
    key: "E_COM",
    displayName: "E-Commerce & Online Retail",
    targetWeight: 0.18,
    tickers: [
      "AMZN", "MELI", "BABA", "PDD", "JD", "SE", "CPNG", "RZT.DE", // Zalando
      "FLIPKART*PRIVATE", // placeholder
    ],
  },
  {
    key: "AUTOS_EV",
    displayName: "Autos & EV",
    targetWeight: 0.17,
    tickers: [
      "TSLA", "TM", "HMC", "F", "GM", "RIVN", "NIO", "LI", "XPEV",
      "7267.T", "7203.T", "BMW.DE", "VOW3.DE", "STLA"
    ],
  },
  {
    key: "HARDLINES_HOME",
    displayName: "Hardlines & Home Improvement",
    targetWeight: 0.13,
    tickers: [
      "HD", "LOW", "BBY", "RH", "W", "LULU", "NKE", "DECK"
    ],
  },
  {
    key: "LEISURE_TRAVEL",
    displayName: "Leisure, Travel & Experiences",
    targetWeight: 0.12,
    tickers: [
      "BKNG", "ABNB", "EXPE", "CCL", "RCL", "NCLH", "MAR", "HLT",
      "DIS", "SIX", "SEAS"
    ],
  },
  {
    key: "APPAREL_ACCESS",
    displayName: "Apparel, Footwear & Accessories",
    targetWeight: 0.12,
    tickers: [
      "NKE", "LULU", "ADS.DE", "PUMA.DE", "TPR", "CPRI", "HMB.ST", "ZARA*INDITEX.MC",
      "BUR.L", "KER.PA", "MC.PA", "RMS.PA"
    ],
  },
  {
    key: "RESTAURANTS",
    displayName: "Restaurants",
    targetWeight: 0.10,
    tickers: [
      "MCD", "SBUX", "YUM", "YUMC", "CMG", "DPZ", "DRI", "QSR", "WEN"
    ],
  },
  {
    key: "MEDIA_GAMING",
    displayName: "Media, Streaming & Gaming",
    targetWeight: 0.10,
    tickers: [
      "NFLX", "ROBLX", "TTWO", "EA", "DIS", "PARA", "WBD", "SONY", "HUYA"
    ],
  },
  {
    key: "DURABLES_LUX",
    displayName: "Consumer Durables & Luxury",
    targetWeight: 0.08,
    tickers: [
      "EL", "TIF*HIST", "RMS.PA", "MC.PA", "KER.PA", "CPR.MI", "PRTP.PA", "FOSL"
    ],
  },
  {
    key: "AUTO_PARTS",
    displayName: "Auto Parts & Aftermarket",
    targetWeight: 0.05,
    tickers: [
      "BWA", "ALV", "APTV", "LEA", "GNTX", "MGA", "DLPH*HIST", "ORLY", "AZO", "AAP"
    ],
  },
  {
    key: "EDU_SERV",
    displayName: "Education & Other Services",
    targetWeight: 0.05,
    tickers: [
      "TAL", "EDU", "COE", "CHGG", "LRN"
    ],
  },
];

// ---------- Regional Universes (Representative) ----------

const UNI_US: SectorUniverse = {
  region: "US",
  tickers: [
    "AMZN", "TSLA", "HD", "LOW", "MCD", "SBUX", "NFLX", "DIS", "NKE", "LULU",
    "BKNG", "ABNB", "CMG", "RIVN", "ORLY", "AZO", "AAP", "QSR", "DPZ", "RH", "ROBLX"
  ],
};

const UNI_EU: SectorUniverse = {
  region: "EU",
  tickers: [
    "DGE.L*HIST", "ADS.DE", "PUMA.DE", "RMS.PA", "MC.PA", "KER.PA", "CPR.MI",
    "BMW.DE", "VOW3.DE", "STLA", "ZAL.DE"
  ],
};

const UNI_JP: SectorUniverse = {
  region: "JP",
  tickers: ["7203.T", "7267.T", "6758.T", "9983.T", "7832.T"], // Toyota, Subaru, Sony, Fast Retailing, Bandai Namco
};

const UNI_CN: SectorUniverse = {
  region: "CN",
  tickers: ["BABA", "PDD", "JD", "NIO", "LI", "XPEV", "YUMC", "TAL", "EDU"],
};

const UNI_IN: SectorUniverse = {
  region: "IN",
  tickers: [
    "TATAMOTORS.NS", "MARUTI.NS", "M&M.NS", "BAJAJ-AUTO.NS", "EICHERMOT.NS",
    "TITAN.NS", "TRENT.NS", "PAGEIND.NS", "JUBLFOOD.NS", "BURGERKING.NS*HIST", "INDIGO*INTERGLOBE.NS"
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

// Build a reverse map ticker -> subKey
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

// Return one diversified basket respecting sub-sector spread.
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

// Simple mean-variance-style rebalance proxy:
// If capHint provided, weight ~ sectorSubWeight * (capHint / sumCap in sub).
// Else equal within sub-sector, scaled by sub-sector target weight.
function rebalanceWeights(
  prices: { [t: string]: number },
  subWeights: { [k: string]: number },
  capHint?: { [t: string]: number }
): { [t: string]: number } {
  // Group by sub
  const group: { [k: string]: Ticker[] } = {};
  const allTickers = Object.keys(prices);
  for (let i = 0; i < allTickers.length; i++) {
    const t = norm(allTickers[i]);
    const k = SUB_REV[t] || "OTHER";
    if (!group[k]) group[k] = [];
    group[k].push(t);
  }

  const w: { [t: string]: number } = {};
  // sub allocation then within-sub distribution
  const subKeys = Object.keys(group);
  for (let i = 0; i < subKeys.length; i++) {
    const k = subKeys[i];
    const names = group[k];
    const sw = subWeights[k] !== undefined ? subWeights[k] : 0; // if OTHER -> potentially 0
    if (names.length === 0 || sw <= 0) continue;

    if (capHint) {
      // cap-proportional within sub
      let sumCap = 0;
      for (let j = 0; j < names.length; j++) sumCap += Math.max(0, capHint[names[j]] || 0);
      if (sumCap <= 0) {
        // fallback to equal within sub
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

const CONSUMER_DISCRETIONARY: SectorConfig = {
  sectorCode: "CD",
  gics: 25,
  name: "Consumer Discretionary",
  description:
    "Cyclical consumer goods & services: e-commerce, autos/EV, apparel/footwear, restaurants, leisure/travel, media/gaming, durables/luxury, and parts/aftermarket.",
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

export default CONSUMER_DISCRETIONARY;
