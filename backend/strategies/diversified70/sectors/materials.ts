// sectors/materials.ts
// Pure TypeScript. No imports.
// Lightweight sector config for Materials (GICS 15).
// Static sub-sectors, regional universes, target weights, and utilities.

export type Ticker = string;

export type SubSector = {
  key: string;                // e.g., "CHEM"
  displayName: string;        // "Chemicals (Commodity & Specialty)"
  targetWeight: number;       // 0..1 pre-normalization across sub-sectors
  tickers: Ticker[];          // representative namespaced tickers
};

export type SectorUniverse = {
  region: "US" | "EU" | "JP" | "CN" | "IN" | "GLOBAL";
  tickers: Ticker[];
};

export type SectorConfig = {
  sectorCode: "MAT";
  gics: 15;
  name: "Materials";
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
    key: "CHEM",
    displayName: "Chemicals (Commodity & Specialty)",
    targetWeight: 0.24,
    tickers: [
      "LIN", "APD", "DOW", "DD", "CE", "EMN",
      "AI.PA" /* Air Liquide */, "BAS.DE", "LXS.DE", "SIKA.SW", "DSM-FIR*ALT", "AKZA.AS",
      "4063.T" /* Shin-Etsu */, "4188.T" /* Mitsubishi Chemical */, "4005.T" /* Sumitomo Chem */,
      "SRF.NS", "DEEPAKNTR.NS", "ATUL.NS",
    ],
  },
  {
    key: "METALS_MINING",
    displayName: "Metals & Mining (Base/Bulk)",
    targetWeight: 0.22,
    tickers: [
      "FCX", "SCCO", "AA", "NUE", "X", "CLF",
      "RIO.L", "GLEN.L", "AAL.L", "NHY.OL", "BOL.ST",
      "5401.T" /* Nippon Steel */, "5411.T" /* JFE */,
      "600019.SH" /* Baoshan Steel */, "601600.SH" /* Chalco */, "600362.SH" /* Jiangxi Copper */,
      "TATASTEEL.NS", "JSWSTEEL.NS", "HINDALCO.NS", "VEDL.NS", "JINDALSTEL.NS"
    ],
  },
  {
    key: "CONSTR_MATS",
    displayName: "Construction Materials (Cement & Aggregates)",
    targetWeight: 0.16,
    tickers: [
      "MLM", "VMC", "EXP", "SUM",
      "HOLN.SW" /* Holcim */, "HEI.DE" /* Heidelberg Materials */, "CRH.L",
      "5233.T" /* Taiheiyo Cement */,
      "600585.SH" /* Anhui Conch Cement */,
      "ULTRACEMCO.NS", "AMBUJACEM.NS", "SHREECEM.NS", "ACC.NS", "RAMCOCEM.NS"
    ],
  },
  {
    key: "PAPER_PACK",
    displayName: "Paper, Forest & Packaging",
    targetWeight: 0.10,
    tickers: [
      "IP", "PKG", "WRK", "BALL", "CCK",
      "SKG.L" /* Smurfit Kappa */, "MNDI.L", "SMDS.L",
      "3863.T" /* Oji Paper */,
      "JKPAPER.NS", "WESTCOASTPPR.NS"
    ],
  },
  {
    key: "FERT_AG",
    displayName: "Fertilizers & Ag Chemicals",
    targetWeight: 0.10,
    tickers: [
      "CF", "MOS", "NTR", "IPI",
      "YAR.OL", "OCI.AS",
      "UPL.NS", "PIIND.NS", "COROMANDEL.NS", "CHAMBLFERT.NS", "GNFC.NS"
    ],
  },
  {
    key: "PRECIOUS",
    displayName: "Precious Metals (Gold & Silver Miners)",
    targetWeight: 0.10,
    tickers: [
      "NEM", "GOLD", "AEM", "PAAS", "AG",
      "POLY*ALT", "FRES.L",
      "5713.T*ALT", // (JP precious/metal tilt)
      "601899.SH" /* Zijin Mining */,
      "HINDZINC.NS"
    ],
  },
  {
    key: "BATTERY_MATS",
    displayName: "Lithium & Battery Materials",
    targetWeight: 0.08,
    tickers: [
      "ALB", "LTHM", "PLL",
      "002466.SZ" /* Tianqi Lithium */, "002460.SZ" /* Ganfeng (A) */,
      "LI*ALT", // placeholder/alt tickers if needed
      "NAVA.NS*ALT"
    ],
  },
];

// ---------- Regional Universes (Representative) ----------

const UNI_US: SectorUniverse = {
  region: "US",
  tickers: [
    "LIN", "APD", "DOW", "DD", "CE", "EMN",
    "FCX", "AA", "NUE", "CLF", "X",
    "NEM", "GOLD", "AEM",
    "MLM", "VMC", "EXP", "SUM",
    "IP", "PKG", "WRK", "BALL", "CCK",
    "CF", "MOS", "NTR",
    "ALB", "LTHM", "PLL"
  ],
};

const UNI_EU: SectorUniverse = {
  region: "EU",
  tickers: [
    "AI.PA", "BAS.DE", "LXS.DE", "SIKA.SW", "AKZA.AS",
    "RIO.L", "GLEN.L", "AAL.L", "NHY.OL", "BOL.ST",
    "HOLN.SW", "HEI.DE", "CRH.L",
    "SKG.L", "MNDI.L", "SMDS.L",
    "YAR.OL", "OCI.AS", "FRES.L"
  ],
};

const UNI_JP: SectorUniverse = {
  region: "JP",
  tickers: [
    "4063.T", "4188.T", "4005.T",
    "5401.T", "5411.T",
    "5233.T",
    "3863.T"
  ],
};

const UNI_CN: SectorUniverse = {
  region: "CN",
  tickers: [
    "600019.SH", "601600.SH", "600362.SH",
    "601899.SH",
    "600585.SH",
    "002466.SZ", "002460.SZ"
  ],
};

const UNI_IN: SectorUniverse = {
  region: "IN",
  tickers: [
    "TATASTEEL.NS", "JSWSTEEL.NS", "HINDALCO.NS", "VEDL.NS", "JINDALSTEL.NS",
    "ULTRACEMCO.NS", "AMBUJACEM.NS", "SHREECEM.NS", "ACC.NS", "RAMCOCEM.NS",
    "UPL.NS", "PIIND.NS", "COROMANDEL.NS", "CHAMBLFERT.NS", "GNFC.NS",
    "JKPAPER.NS", "WESTCOASTPPR.NS", "HINDZINC.NS"
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

const MATERIALS: SectorConfig = {
  sectorCode: "MAT",
  gics: 15,
  name: "Materials",
  description:
    "Global materials complex: chemicals, metals & mining, construction materials, paper/packaging, fertilizers/ag chemicals, precious metals, and lithium/battery materials.",
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

export default MATERIALS;
