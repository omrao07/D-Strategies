// damodaran/hook.ts

// --- Types ---
export type Citation = {
  sourceId: string;
  page: number;
  snippet: string;
};

export type ExtractOut = {
  wacc?: number;
  taxRate?: number;
  growth?: number;
  shares?: number;
  citations: Citation[];
};

// --- Regex helpers ---
const PATTERN = /(\d+(?:\.\d+)?)(\s*%?)/g;

// --- Extractor ---
function tryMatch(text: string): { key: keyof ExtractOut; value: number } | null {
  let m: RegExpExecArray | null;
  while ((m = PATTERN.exec(text))) {
    const raw = m[1];
    if (!raw) continue;
    let val = parseFloat(raw.replace(/,/g, ""));
    if (m[2].includes("%")) val /= 100;

    const ctx = text
      .slice(Math.max(0, (m.index || 0) - 24), Math.min(text.length, (m.index || 0) + 24))
      .toLowerCase();

    if (ctx.includes("wacc")) return { key: "wacc", value: val };
    if (ctx.includes("tax")) return { key: "taxRate", value: val };
    if (ctx.includes("growth")) return { key: "growth", value: val };
    if (ctx.includes("share")) return { key: "shares", value: val };
  }
  return null;
}

// --- Main API ---
export function extract(
  query: string,
  hits: Array<{ text: string; sourceId: string; page: number }>
): ExtractOut {
  const out: ExtractOut = { citations: [] };

  for (const h of hits) {
    const kv = tryMatch(h.text);
    if (kv && out[kv.key] == null) {

    }
    out.citations.push({
      sourceId: h.sourceId,
      page: h.page,
      snippet: h.text.slice(0, 140),
    });
  }

  return out;
}