// sectors/technology.ts
// Pure TypeScript. No imports.
// Lightweight sector config for Information Technology (GICS 45).
// Sub-sectors, regional universes, target weights, and utilities.

export type Ticker = string;

export type SubSector = {
  key: string;                // e.g., "SEMIS"
  displayName: string;        // "Semiconductors"
  targetWeight: number;       // 0..1 pre-normalization across sub-sectors
  tickers: Ticker[];          // representative namespaced tickers
};

export type SectorUniverse = {
  region: "US" | "EU" | "JP" | "CN" | "IN" | "GLOBAL";
  tickers: Ticker[];
};

export type SectorConfig = {
  sectorCode: "TECH";
  gics: 45;
  name: "Information Technology";
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
    key: "SEMIS",
    displayName: "Semiconductors",
    targetWeight: 0.25,
    tickers: [
      "NVDA", "AVGO", "AMD", "INTC", "MU", "QCOM", "TXN", "NXPI",
      "TSM*ADR", "ARM", // ADR/US-list
      "6857.T*ADVANTEST-ALT", "6723.T" /* Renesas */,
      "688981.SH" /* SMIC A */, "603986.SH" /* GigaDevice */,
    ],
  },
  {
    key: "SEMI_CAP_EQP",
    displayName: "Semi Cap Equipment & Materials",
    targetWeight: 0.12,
    tickers: [
      "ASML.AS", "AMAT", "LRCX", "KLAC", "TER", "ONTO",
      "8035.T" /* Tokyo Electron */, "7735.T*SCREEN-ALT",
      "688012.SH*HuaHong-ALT"
    ],
  },
  {
    key: "EDA_DESIGN",
    displayName: "EDA & Design Software",
    targetWeight: 0.06,
    tickers: [
      "SNPS", "CDNS", "ANSS",
      "3683.T*ALT", "002401.SZ*HLMC-ALT"
    ],
  },
  {
    key: "SOFTWARE_APP",
    displayName: "Application Software & SaaS",
    targetWeight: 0.18,
    tickers: [
      "MSFT", "ADBE", "CRM", "ORCL", "NOW", "SHOP", "MDB", "SNOW", "DDOG", "TEAM",
      "SAP.DE", "IFX.DE*ALT-SW", "ZS*ALT"
    ],
  },
  {
    key: "SOFTWARE_INFRA",
    displayName: "Infrastructure & Database/DevOps",
    targetWeight: 0.10,
    tickers: [
      "MSFT*AZURE-ADJ", "ORCL*CLOUD-ADJ", "SNOW", "MDB", "DDOG", "PLTR",
      "VMW*HIST", "AKAM",
      "AlibabaCloud*ALT"
    ],
  },
  {
    key: "CYBERSEC",
    displayName: "Cybersecurity",
    targetWeight: 0.08,
    tickers: [
      "PANW", "CRWD", "FTNT", "ZS", "OKTA", "S", "NET",
    ],
  },
  {
    key: "HARDWARE_DEVICES",
    displayName: "Hardware, Devices & Peripherals",
    targetWeight: 0.08,
    tickers: [
      "AAPL", "DELL", "HPQ", "CSCO", "ANET", "LOGI", "SONY*ADR",
      "6758.T" /* Sony */, "6753.T" /* Sharp */,
      "002475.SZ" /* Luxshare */, "002415.SZ" /* Hikvision */
    ],
  },
  {
    key: "IT_SERVICES",
    displayName: "IT Services & Consulting",
    targetWeight: 0.13,
    tickers: [
      "ACN", "CTSH", "GLOB", "EPAM",
      "INFY.NS", "TCS.NS", "WIPRO.NS", "HCLTECH.NS", "TECHM.NS", "LTIM.NS",
      "CAP.PA*CAPGEMINI", "SOPH*ALT"
    ],
  },
];

// ---------- Regional Universes (Representative) ----------

const UNI_US: SectorUniverse = {
  region: "US",
  tickers: [
    "AAPL", "MSFT",
    "NVDA", "AVGO", "AMD", "INTC", "MU", "QCOM", "TXN", "NXPI",
    "ASML.AS", "AMAT", "LRCX", "KLAC", "TER",
    "SNPS", "CDNS", "ANSS",
    "ADBE", "CRM", "ORCL", "NOW", "MDB", "SNOW", "DDOG", "PLTR",
    "PANW", "CRWD", "FTNT", "ZS", "OKTA", "S",
    "CSCO", "ANET", "DELL", "HPQ",
    "ACN", "CTSH", "EPAM", "GLOB"
  ],
};

const UNI_EU: SectorUniverse = {
  region: "EU",
  tickers: [
    "ASML.AS", "SAP.DE", "IFX.DE", "STM.PA", "NOKIA.HE", "ERIC-B.ST",
    "PRX.AS*ALT", "CAP.PA", "DARK.L*ALT"
  ],
};

const UNI_JP: SectorUniverse = {
  region: "JP",
  tickers: [
    "8035.T", "6857.T", "6723.T",
    "6758.T", "6753.T", "6501.T*ALT",
    "7735.T"
  ],
};

const UNI_CN: SectorUniverse = {
  region: "CN",
  tickers: [
    "688981.SH", // SMIC A
    "603986.SH", // GigaDevice
    "002475.SZ", // Luxshare
    "002415.SZ", // Hikvision
    "300033.SZ*360SEC-ALT", "688041.SH*AMC-ALT"
  ],
};

const UNI_IN: SectorUniverse = {
  region: "IN",
  tickers: [
    "TCS.NS", "INFY.NS", "WIPRO.NS", "HCLTECH.NS", "TECHM.NS", "LTIM.NS",
    "PERSISTENT.NS*PERSISTENT", "NAUKRI.NS*INFOEDGE-ADJ"
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

const TECHNOLOGY: SectorConfig = {
  sectorCode: "TECH",
  gics: 45,
  name: "Information Technology",
  description:
    "Semis & equipment, EDA/design, application & infrastructure software, cybersecurity, hardware/devices/networking, and global IT services/consulting.",
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

export default TECHNOLOGY;
