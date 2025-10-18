// sectors/industrials.ts
// Pure TypeScript. No imports.
// Lightweight sector config for Industrials (GICS 20).
// Static sub-sectors, regional universes, target weights, and utilities.

export type Ticker = string;

export type SubSector = {
  key: string;                // e.g., "AERO_DEF"
  displayName: string;        // "Aerospace & Defense"
  targetWeight: number;       // 0..1 pre-normalization across sub-sectors
  tickers: Ticker[];          // representative namespaced tickers
};

export type SectorUniverse = {
  region: "US" | "EU" | "JP" | "CN" | "IN" | "GLOBAL";
  tickers: Ticker[];
};

export type SectorConfig = {
  sectorCode: "INDS";
  gics: 20;
  name: "Industrials";
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
    key: "AERO_DEF",
    displayName: "Aerospace & Defense",
    targetWeight: 0.20,
    tickers: [
      "BA", "LMT", "NOC", "RTX", "GD", "HII",
      "AIR.PA", "BAES.L", "SAF.PA", "MTX.DE*HENSOLDT",
      "7011.T", "7203.T*DEF*ALT",
      "000768.SZ*AVIC", "600893.SH*AVIC", "HAL.NS", "BDL.NS", "BEL.NS"
    ],
  },
  {
    key: "MACHINERY",
    displayName: "Industrial Machinery & Equipment",
    targetWeight: 0.18,
    tickers: [
      "CAT", "DE", "CMI", "PCAR", "TT", "IR", "ETN", "EMR", "PH", "ROK",
      "ABBN.SW", "SIEMENS.DE", "ATCO-A.ST", "VOLV-B.ST",
      "6501.T", "6301.T", "6367.T",
      "600031.SH" /* Sany Heavy */, "000425.SZ" /* XCMG */,
      "L&T.NS", "ABB.NS", "SIEMENS.NS"
    ],
  },
  {
    key: "ELECTRICAL",
    displayName: "Electrical Equipment & Automation",
    targetWeight: 0.12,
    tickers: [
      "ETN", "ROK", "EMR", "ABBV*ALT", "ENPH*ALT",
      "ABB.N", "SCHN.PA" /* Schneider Electric */, "LEGR.PA*LEGRAND",
      "6503.T" /* Mitsubishi Electric */, "6645.T" /* OMRON */,
      "RECLTD.NS*UTILS-ADJ", "HAVELLS.NS", "VOLTAS.NS"
    ],
  },
  {
    key: "BUILDING",
    displayName: "Building Products & Construction Services",
    targetWeight: 0.10,
    tickers: [
      "MAS", "MLM", "VMC", "JCI", "TT", "CSL", "ALLE", "AOS",
      "SAINT-GO.PA", "CRH.L", "FER.MC",
      "5938.T" /* LIXIL */, "5232.T" /* Sumitomo Osaka Cement */,
      "ULTRACEMCO.NS", "AMBUJACEM.NS", "SHREECEM.NS"
    ],
  },
  {
    key: "TRANSPORT_AIR",
    displayName: "Airlines & Airports",
    targetWeight: 0.08,
    tickers: [
      "DAL", "AAL", "UAL", "LUV", "JBLU", "ALK",
      "IAG.L", "AF.PA", "LHA.DE", "RYAAY*ADR", "EZJ.L",
      "9202.T" /* ANA */, "9201.T" /* JAL */,
      "600004.SH" /* Baiyun Airport */, "SAS*ALT",
      "INDIGO*INTERGLOBE.NS", "SPICEJET.NS*ALT"
    ],
  },
  {
    key: "TRANSPORT_RAIL",
    displayName: "Railroads",
    targetWeight: 0.08,
    tickers: [
      "UNP", "CSX", "NSC", "CNI", "CP", "KSU*HIST",
      "DBK.DE*ALT-RAIL", "SBB*PRIVATE",
      "9020.T" /* JR East */, "9021.T" /* JR West */, "9022.T" /* JR Central */,
      "601006.SH" /* Daqin Railway */,
      "IRCTC.NS"
    ],
  },
  {
    key: "TRANSPORT_TRUCK_LOG",
    displayName: "Trucking, Logistics & Parcel",
    targetWeight: 0.08,
    tickers: [
      "UPS", "FDX", "XPO", "ODFL", "SAIA", "CHRW", "EXPD",
      "DPW.DE" /* Deutsche Post DHL */, "KUEHN.SW", "DSV.CO",
      "9064.T" /* Yamato */, "9076.T" /* Seino */,
      "BLUE DART.NS*BLUEDART.NS", "TCIEXP.NS", "MAHLOG.NS"
    ],
  },
  {
    key: "MARINE_PORTS",
    displayName: "Marine, Shipping & Ports",
    targetWeight: 0.06,
    tickers: [
      "ZIM", "SBLK", "DAC", "EGLE", "NMM", "MATX",
      "MAERSK-B.CO", "HMM.KS*ALT",
      "9107.T" /* Kawasaki Kisen (K Line) */, "9104.T" /* NS United */,
      "601866.SH" /* COSCO Shipping */,
      "ADANIPORTS.NS"
    ],
  },
  {
    key: "CAP_GOODS_CONG",
    displayName: "Capital Goods Conglomerates",
    targetWeight: 0.06,
    tickers: [
      "HON", "GE", "MMM", "ITW", "DOV",
      "SIEMENS.DE", "SCHN.PA", "ABB.N",
      "6501.T", "7011.T",
      "RELIANCE.NS*DIVERSIFIED", "L&T.NS"
    ],
  },
  {
    key: "PRO_SERVICES",
    displayName: "Professional & Commercial Services",
    targetWeight: 0.07,
    tickers: [
      "URI", "ASH", "CTAS", "ROL", "PAYX*ALT",
      "REL.L" /* RELX (info/services tilt) */, "ADECCO.SW", "RAND.AS",
      "6098.T" /* Recruit */, "9783.T" /* Benesse */,
      "TEAMLEASE.NS", "QUESS.NS", "APOLLO*IND_SERV*ALT"
    ],
  },
  {
    key: "WASTE_ENV",
    displayName: "Waste, Environmental & Utilities-Adj",
    targetWeight: 0.07,
    tickers: [
      "WM", "RSG", "WCN", "CWST", "CLH",
      "VE.PA" /* Veolia */, "SVT.L" /* Severn Trent (adj) */,
      "5713.T" /* Sumitomo Metal Mining*ENV tilt */,
      "THERMAX.NS", "VA TECH WABAG.NS"
    ],
  },
];

// ---------- Regional Universes (Representative) ----------

const UNI_US: SectorUniverse = {
  region: "US",
  tickers: [
    "BA", "LMT", "NOC", "RTX", "GD", "HII",
    "CAT", "DE", "CMI", "PCAR", "ETN", "EMR", "PH", "ROK", "TT", "IR",
    "MAS", "MLM", "VMC", "JCI", "CSL", "ALLE",
    "UPS", "FDX", "XPO", "ODFL", "SAIA", "CHRW", "EXPD",
    "UNP", "CSX", "NSC",
    "WM", "RSG", "WCN",
    "HON", "GE", "MMM", "ITW", "DOV",
    "MATX", "SBLK"
  ],
};

const UNI_EU: SectorUniverse = {
  region: "EU",
  tickers: [
    "AIR.PA", "BAES.L", "SAF.PA",
    "SIEMENS.DE", "ABB.N", "SCHN.PA", "ATCO-A.ST", "VOLV-B.ST",
    "CRH.L", "FER.MC", "SAINT-GO.PA",
    "DPW.DE", "DSV.CO", "KUEHN.SW",
    "MAERSK-B.CO", "VE.PA", "REL.L"
  ],
};

const UNI_JP: SectorUniverse = {
  region: "JP",
  tickers: [
    "7011.T", "6501.T", "6503.T", "6645.T",
    "6301.T", "6367.T",
    "9201.T", "9202.T",
    "9020.T", "9021.T", "9022.T",
    "9107.T", "9104.T",
    "9064.T", "9076.T"
  ],
};

const UNI_CN: SectorUniverse = {
  region: "CN",
  tickers: [
    "000768.SZ", "600893.SH",
    "600031.SH", "000425.SZ",
    "601006.SH", "601866.SH",
    "600004.SH"
  ],
};

const UNI_IN: SectorUniverse = {
  region: "IN",
  tickers: [
    "L&T.NS", "ABB.NS", "SIEMENS.NS", "HAVELLS.NS", "VOLTAS.NS",
    "ADANIPORTS.NS", "INDIGO*INTERGLOBE.NS",
    "ULTRACEMCO.NS", "AMBUJACEM.NS", "SHREECEM.NS",
    "THERMAX.NS", "WABAG.NS", "BEL.NS", "HAL.NS", "BDL.NS"
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

const INDUSTRIALS: SectorConfig = {
  sectorCode: "INDS",
  gics: 20,
  name: "Industrials",
  description:
    "Capital goods and transportation: aero/defense, machinery, electrical equipment, building products, airlines/airports, rails, trucking/logistics, marine/ports, conglomerates, professional services, and waste/environmental services.",
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

export default INDUSTRIALS;
