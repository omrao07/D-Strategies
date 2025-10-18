// sectors/energy.ts
// Pure TypeScript. No imports.
// Lightweight sector config for Energy (GICS 10).
// Static universes, sub-sector map, target weights, and simple utilities.

export type Ticker = string;

export type SubSector = {
  key: string;                // e.g., "INTEGRATED"
  displayName: string;        // "Integrated Oil & Gas"
  targetWeight: number;       // 0..1 pre-normalization across sub-sectors
  tickers: Ticker[];          // representative namespaced tickers
};

export type SectorUniverse = {
  region: "US" | "EU" | "JP" | "CN" | "IN" | "GLOBAL";
  tickers: Ticker[];
};

export type SectorConfig = {
  sectorCode: "EN";
  gics: 10;
  name: "Energy";
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
    key: "INTEGRATED",
    displayName: "Integrated Oil & Gas",
    targetWeight: 0.28,
    tickers: [
      "XOM", "CVX", "SHEL.L", "BP.L", "TTE.PA", "EQNR.OL", "ENI.MI", "OMV.VI",
      "REP.MC", "PTR*ADR", "SNP*ADR", "5020.T" /* ENEOS */
    ],
  },
  {
    key: "E_AND_P",
    displayName: "Exploration & Production (Upstream)",
    targetWeight: 0.22,
    tickers: [
      "COP", "OXY", "EOG", "PXD", "DVN", "MRO", "APA", "HES",
      "EQT", "CHK", "MUR", "1605.T" /* INPEX */, "601857.SH" /* PetroChina A */
    ],
  },
  {
    key: "SERVICES",
    displayName: "Oilfield Services & Drilling",
    targetWeight: 0.15,
    tickers: [
      "SLB", "HAL", "BKR", "FTI", "VAL", "RIG", "NESR", "OIS"
    ],
  },
  {
    key: "MIDSTREAM",
    displayName: "Pipelines, Storage & LNG",
    targetWeight: 0.14,
    tickers: [
      "KMI", "WMB", "ENB", "TRP", "EPD", "ET", "OKE", "PAA",
      "LNG", "TPL"
    ],
  },
  {
    key: "REFINING",
    displayName: "Refining & Marketing",
    targetWeight: 0.11,
    tickers: [
      "PSX", "VLO", "MPC", "PBF", "DK", "IOC.NS", "BPCL.NS", "HPCL.NS"
    ],
  },
  {
    key: "COAL",
    displayName: "Coal & Consumable Fuels",
    targetWeight: 0.05,
    tickers: [
      "BTU", "ARCH", "CEIX", "601088.SH" /* China Shenhua A */, "1088.HK" /* H-shares */
    ],
  },
  {
    key: "RENEWABLES",
    displayName: "Renewables & Clean Energy",
    targetWeight: 0.05,
    tickers: [
      "FSLR", "ENPH", "SEDG", "NEP", "ORA", "ADANIGREEN.NS", "5020.T*RENEW*ANCHOR"
    ],
  },
];

// ---------- Regional Universes (Representative) ----------

const UNI_US: SectorUniverse = {
  region: "US",
  tickers: [
    "XOM", "CVX", "COP", "OXY", "EOG", "PXD", "DVN", "MRO", "APA", "HES",
    "SLB", "HAL", "BKR", "KMI", "WMB", "EPD", "ET", "OKE",
    "PSX", "VLO", "MPC", "PBF", "LNG", "EQT", "CHK", "BTU", "ARCH", "CEIX",
    "FSLR", "ENPH", "SEDG", "ORA", "NEP"
  ],
};

const UNI_EU: SectorUniverse = {
  region: "EU",
  tickers: [
    "SHEL.L", "BP.L", "TTE.PA", "EQNR.OL", "ENI.MI", "OMV.VI", "REP.MC", "GALP.LS",
    "SBMO.AS*HIST", "VESTA*ALT"
  ],
};

const UNI_JP: SectorUniverse = {
  region: "JP",
  tickers: [
    "1605.T", // INPEX
    "1662.T", // JAPEX
    "5019.T", // Idemitsu
    "5020.T", // ENEOS
  ],
};

const UNI_CN: SectorUniverse = {
  region: "CN",
  tickers: [
    "601857.SH", // PetroChina
    "601988.SH*HIST",
    "600028.SH", // Sinopec
    "857.HK",    // PetroChina H
    "386.HK",    // Sinopec H
    "1088.HK",   // China Shenhua
    "601088.SH", // China Shenhua A
  ],
};

const UNI_IN: SectorUniverse = {
  region: "IN",
  tickers: [
    "RELIANCE.NS", "ONGC.NS", "OIL.NS", "IOC.NS", "BPCL.NS", "HPCL.NS", "GAIL.NS",
    "PETRONET.NS", "ADANIGREEN.NS", "NTPC.NS*UTILS"
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

const ENERGY: SectorConfig = {
  sectorCode: "EN",
  gics: 10,
  name: "Energy",
  description:
    "Hydrocarbons and clean energy value chains: integrated majors, upstream E&P, oilfield services, midstream/LNG, refining/marketing, coal, and renewables.",
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

export default ENERGY;
