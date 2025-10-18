// sectors/healthcare.ts
// Pure TypeScript. No imports.
// Lightweight sector config for Health Care (GICS 35).
// Static sub-sectors, regional universes, target weights, and utilities.

export type Ticker = string;

export type SubSector = {
  key: string;                // e.g., "PHARMA_BIG"
  displayName: string;        // "Pharmaceuticals — Big Cap"
  targetWeight: number;       // 0..1 pre-normalization across sub-sectors
  tickers: Ticker[];          // representative namespaced tickers
};

export type SectorUniverse = {
  region: "US" | "EU" | "JP" | "CN" | "IN" | "GLOBAL";
  tickers: Ticker[];
};

export type SectorConfig = {
  sectorCode: "HC";
  gics: 35;
  name: "Health Care";
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
    key: "PHARMA_BIG",
    displayName: "Pharmaceuticals — Big Cap",
    targetWeight: 0.24,
    tickers: [
      "JNJ", "PFE", "MRK", "BMY", "ABBV", "LLY",
      "NVS*ADR", "NVO", "ROG.SW", "SAN.PA", "GSK.L", "AZN.L", "BAYN.DE",
      "4502.T" /* Takeda */, "600276.SH" /* Hengrui */, "SUNPHARMA.NS", "DRREDDY.NS", "CIPLA.NS"
    ],
  },
  {
    key: "BIOTECH",
    displayName: "Biotechnology",
    targetWeight: 0.14,
    tickers: [
      "AMGN", "GILD", "REGN", "VRTX", "BIIB", "MRNA", "NVAX",
      "4568.T" /* Daiichi Sankyo */, "4503.T" /* Astellas */,
      "1177.HK" /* Sino Biopharm */, "1093.HK" /* CSPC */
    ],
  },
  {
    key: "TOOLS_DIAG",
    displayName: "Life Sci Tools & Diagnostics",
    targetWeight: 0.14,
    tickers: [
      "TMO", "DHR", "A", "MTD", "BIO", "ILMN", "IQV", "LH", "DGX",
      "SRT3.DE*HIST", "LONN.SW", "BIM.PA",
      "6869.T" /* Sysmex */, "7701.T" /* Shimadzu */
    ],
  },
  {
    key: "EQUIP_SUPPLIES",
    displayName: "Medical Equipment & Supplies",
    targetWeight: 0.16,
    tickers: [
      "ABT", "SYK", "MDT", "BDX", "EW", "BSX", "ISRG", "ZBH", "ALGN", "DXCM",
      "PHIA.AS", "SHL.DE" /* Siemens Healthineers */,
      "7733.T" /* Olympus */, "4543.T" /* Terumo */, "300760.SZ" /* Mindray */
    ],
  },
  {
    key: "MANAGED_CARE_PBM",
    displayName: "Managed Care & PBM",
    targetWeight: 0.12,
    tickers: [
      "UNH", "ELV", "HUM", "CI", "CNC", "CVS",
      "STARHEALTH.NS"
    ],
  },
  {
    key: "PROVIDERS_HOSP",
    displayName: "Providers, Hospitals & Services",
    targetWeight: 0.10,
    tickers: [
      "HCA", "UHS", "UHS*ALT", "AMED", "HIMS",
      "APOLLOHOSP.NS", "FORTIS.NS", "MAXHEALTH.NS"
    ],
  },
  {
    key: "CONSUMER_HEALTH",
    displayName: "Consumer Health & OTC",
    targetWeight: 0.05,
    tickers: [
      "KLG*HIST", "HSR*ALT", "HINDUNILVR.NS*HC", "RECKITT.L*HC"
    ],
  },
  {
    key: "CDMO_CRO",
    displayName: "CDMO & CRO",
    targetWeight: 0.05,
    tickers: [
      "CTLT", "IQV", "WUXI*ALT", "603259.SH" /* WuXi AppTec A */,
      "DIVISLAB.NS" /* API/CDMO tilt */
    ],
  },
];

// ---------- Regional Universes (Representative) ----------

const UNI_US: SectorUniverse = {
  region: "US",
  tickers: [
    "JNJ", "PFE", "MRK", "BMY", "ABBV", "LLY",
    "AMGN", "GILD", "REGN", "VRTX", "MRNA",
    "ABT", "SYK", "MDT", "BDX", "EW", "ISRG", "BSX", "ZBH", "DXCM", "ALGN",
    "TMO", "DHR", "A", "MTD", "ILMN", "IQV", "LH", "DGX",
    "UNH", "ELV", "HUM", "CI", "CNC", "CVS",
    "HCA", "UHS", "AMED"
  ],
};

const UNI_EU: SectorUniverse = {
  region: "EU",
  tickers: [
    "NVS*ADR", "ROG.SW", "SAN.PA", "GSK.L", "AZN.L", "BAYN.DE",
    "NOVN.SW", "LONN.SW", "BIM.PA", "PHIA.AS", "SHL.DE", "SART.DE*ALT",
    "GRF.MC", "FME.DE", "FRE.DE", "SN.L"
  ],
};

const UNI_JP: SectorUniverse = {
  region: "JP",
  tickers: [
    "4502.T", "4568.T", "4503.T",
    "7733.T", "4543.T", "6869.T", "7701.T"
  ],
};

const UNI_CN: SectorUniverse = {
  region: "CN",
  tickers: [
    "300760.SZ" /* Mindray */, "603259.SH" /* WuXi AppTec */,
    "600276.SH" /* Hengrui */, "2359.HK" /* WuXi Biologics */,
    "1093.HK" /* CSPC */, "2318.HK*PINGAN*HC"
  ],
};

const UNI_IN: SectorUniverse = {
  region: "IN",
  tickers: [
    "SUNPHARMA.NS", "DRREDDY.NS", "CIPLA.NS", "DIVISLAB.NS", "LUPIN.NS",
    "APOLLOHOSP.NS", "FORTIS.NS", "MAXHEALTH.NS", "LALPATHLAB.NS", "METROPOLIS.NS",
    "STARHEALTH.NS"
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

const HEALTH_CARE: SectorConfig = {
  sectorCode: "HC",
  gics: 35,
  name: "Health Care",
  description:
    "Global health care complex: big-cap pharma, biotech, life science tools & diagnostics, medical equipment/supplies, managed care/PBM, providers & hospitals, plus select consumer health and CDMO/CROs.",
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

export default HEALTH_CARE;
