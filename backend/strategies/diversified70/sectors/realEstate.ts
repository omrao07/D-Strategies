// sectors/realestate.ts
// Pure TypeScript. No imports.
// Lightweight sector config for Real Estate (GICS 60).
// Focus on listed REITs/REOCs: data centers, towers, industrial/logistics,
// residential, retail, office, healthcare, hospitality, diversified/alt.

export type Ticker = string;

export type SubSector = {
  key: string;                // e.g., "DATA_CTR"
  displayName: string;        // "Data Centers"
  targetWeight: number;       // 0..1 pre-normalization across sub-sectors
  tickers: Ticker[];          // representative tickers (namespaced when useful)
};

export type SectorUniverse = {
  region: "US" | "EU" | "JP" | "CN" | "IN" | "GLOBAL";
  tickers: Ticker[];
};

export type SectorConfig = {
  sectorCode: "RE";
  gics: 60;
  name: "Real Estate";
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
// Weights are balanced to growth (DC/towers/industrial) vs income (residential/healthcare/retail).

const SUBSECTORS: SubSector[] = [
  {
    key: "DATA_CTR",
    displayName: "Data Centers",
    targetWeight: 0.18,
    tickers: [
      "EQIX", "DLR",
      "GDS", "VNET",         // China ADRs
      "NEXTDC.AX*ALT", "CONE*HIST", "COR*HIST",
      "4216.T*JRIT*ALT"     // JP alt
    ],
  },
  {
    key: "TOWERS",
    displayName: "Cell Towers & Digital Infra",
    targetWeight: 0.14,
    tickers: [
      "AMT", "CCI", "SBA*SBAC",
      "INW.L*INWIT*ALT", "GLBX.SM*CELLNEX", "RATL.NS*INDUS TOWERS"
    ],
  },
  {
    key: "IND_LOG",
    displayName: "Industrial & Logistics",
    targetWeight: 0.16,
    tickers: [
      "PLD", "STAG", "TRNO", "REXR",
      "BNL*ALT", "WDP.BR", "SEGRO.L",
      "3281.T" /* GLP J-REIT */, "2974.T" /* Prologis J-REIT */,
      "1212.HK*LOGOS*ALT"
    ],
  },
  {
    key: "RESIDENTIAL",
    displayName: "Residential (MF, SF, MH, SFR)",
    targetWeight: 0.14,
    tickers: [
      "AVB", "EQR", "ESS", "MAA", "CPT", "UDR", "INVH", "AMH",
      "RPT*HIST", "SUN", "ELS",
      "8951.T" /* Nippon Building Fund (mixed) */, "3249.T" /* Daiwa House REIT */,
      "DLF.NS*DEV", "GODREJPROP.NS*DEV"
    ],
  },
  {
    key: "RETAIL",
    displayName: "Retail (Strip, Mall, Grocery-Anchored)",
    targetWeight: 0.10,
    tickers: [
      "SPG", "MAC", "FRT", "REG", "KIM", "ROIC",
      "URW.AS", "INTU*HIST",
      "3222.T" /* Japan Retail Fund REIT */,
      "PHNX*ALT"
    ],
  },
  {
    key: "OFFICE",
    displayName: "Office",
    targetWeight: 0.08,
    tickers: [
      "BXP", "VNO", "SLG", "HIW", "CUZ", "KRC",
      "LAND.L*ALT", "URW.AS*OFFICE MIX",
      "8952.T" /* Japan Real Estate REIT */
    ],
  },
  {
    key: "HEALTHCARE",
    displayName: "Healthcare REITs (Med Office, SNF, Senior)",
    targetWeight: 0.08,
    tickers: [
      "WELL", "VTR", "OHI", "DOC", "HR",
      "HCP*HIST",
      "3283.T" /* Nippon Healthcare Investment */,
    ],
  },
  {
    key: "HOSPITALITY",
    displayName: "Hotels & Lodging",
    targetWeight: 0.06,
    tickers: [
      "HST", "APLE", "PK", "RHP", "DRH",
      "MLCO*ALT", "HTG.L*ALT",
      "8963.T" /* Invincible Investment */
    ],
  },
  {
    key: "DIVERS_ALT",
    displayName: "Diversified & Alternatives (Self-Storage, Net Lease, Specialty)",
    targetWeight: 0.06,
    tickers: [
      "PSA", "EXR", "CUBE", // self-storage
      "O", "NNN", "WPC",    // net lease
      "SAFE", "LAND",       // specialty ground/land
      "GOOD"                // preferreds REIT alt
    ],
  },
];

// ---------- Regional Universes (Representative) ----------

const UNI_US: SectorUniverse = {
  region: "US",
  tickers: [
    "EQIX", "DLR",
    "AMT", "CCI", "SBAC",
    "PLD", "STAG", "TRNO", "REXR",
    "AVB", "EQR", "ESS", "MAA", "CPT", "INVH", "AMH", "UDR", "ELS", "SUN",
    "SPG", "FRT", "REG", "KIM",
    "BXP", "SLG", "VNO", "HIW",
    "WELL", "VTR", "OHI", "DOC",
    "HST", "APLE", "PK", "RHP",
    "PSA", "EXR", "CUBE", "O", "NNN", "WPC", "SAFE", "LAND", "GOOD"
  ],
};

const UNI_EU: SectorUniverse = {
  region: "EU",
  tickers: [
    "URW.AS", "UNITE.L", "LXI.L", "WDP.BR", "SEGRO.L", "GLBX.SM*CELLNEX", "INW.L*INWIT*ALT",
    "KLEP.PA", "HMB*ALT", "MERC.L"
  ],
};

const UNI_JP: SectorUniverse = {
  region: "JP",
  tickers: [
    "3281.T", "2974.T", "8951.T", "8952.T", "3222.T", "3283.T", "8963.T"
  ],
};

const UNI_CN: SectorUniverse = {
  region: "CN",
  tickers: [
    "GDS", "VNET", // DC ADRs
    "1997.HK" /* Wharf REIC (retail/office HK) */,
    "1113.HK" /* CK Asset (REOC) */,
    "1209.HK*ALT"
  ],
};

const UNI_IN: SectorUniverse = {
  region: "IN",
  tickers: [
    "EMBASSY*REIT", "MINDSPACE*REIT", "BROOKS*REIT", // India REITs (non-standard tickers)
    "DLF.NS", "GODREJPROP.NS", "PHOENIXLTD.NS", "OBEROIRLTY.NS"
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

const REAL_ESTATE: SectorConfig = {
  sectorCode: "RE",
  gics: 60,
  name: "Real Estate",
  description:
    "Listed real assets across data centers, towers, industrial & logistics, residential, retail, office, healthcare, hospitality, and diversified/specialty REITs.",
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

export default REAL_ESTATE;
