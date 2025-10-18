// reports/md.ts
// Tiny, dependency-free Markdown report builder/renderer.
// Pairs nicely with reports/html.ts but outputs plain Markdown.
// Works in Node or the browser (string-only; optional Node save helper).
//
// Highlights
// - Chainable builder API (sections: text, table, code, image, list, quote, mermaid)
// - Auto front matter (YAML) + optional Table of Contents
// - Helper renderers: tables, KPI blocks, badges, footnotes
// - Unicode sparklines (▁▂▃▄▅▆▇) for quick inline charts
// - Convenience `buildReport()` for one-shot creation
//
// Usage:
//   import { MdReport, renderMd, saveMd, asciiSpark, mdTable } from "./reports/md";
//   const rep = MdReport.create({ title: "Backtest", subtitle: "SMA(10/50)", tags:["backtest","demo"] })
//     .kpis({ Return: "24.3%", CAGR: "11.1%", Sharpe: 1.02, MaxDD: "12.7%" })
//     .text("Notes", "Run with **fee=1bps**, *slippage=1bps*.")
//     .table("Metrics", [["Return","24.3%"],["CAGR","11.1%"]])
//     .mermaid("Equity (Mermaid XY)", xychart({ title:"Equity", x:["2023-01","2023-02"], y:[100,110] }));
//   const md = renderMd(rep);
//   await saveMd(md, "report.md");

export type KV = Record<string, string | number | boolean | null | undefined>;

export type Section =
  | { kind: "text"; title?: string; body: string }                         // Markdown body
  | { kind: "table"; title?: string; rows: Array<Array<string | number>>; header?: string[] }
  | { kind: "code"; title?: string; lang?: string; code: string }
  | { kind: "image"; title?: string; alt?: string; url: string }
  | { kind: "list"; title?: string; items: Array<string | { text: string; children?: string[] }> }
  | { kind: "quote"; title?: string; body: string }
  | { kind: "mermaid"; title?: string; code: string }                       // ```mermaid fenced
  | { kind: "raw"; md: string };                                            // injected as-is

export interface Report {
  title: string;
  subtitle?: string;
  author?: string;
  createdAt?: string;         // ISO
  tags?: string[];
  badges?: Array<{ text: string; color?: string; link?: string }>;
  sections: Section[];
  footnote?: string;
  frontMatter?: boolean | Record<string, unknown>;  // true -> auto, object -> merge
  toc?: boolean;              // include Table of Contents
}

export const MdReport = {
  create(init: Partial<Report> & { title: string }): Report {
    return {
      title: init.title,
      subtitle: init.subtitle,
      author: init.author,
      createdAt: init.createdAt ?? new Date().toISOString(),
      tags: init.tags ?? [],
      badges: init.badges ?? [],
      sections: [],
      footnote: init.footnote,
      frontMatter: init.frontMatter ?? true,
      toc: init.toc ?? true,
    };
  },

  text(rep: Report, title: string | undefined, body: string): Report {
    rep.sections.push({ kind: "text", title, body });
    return rep;
  },

  table(rep: Report, title: string | undefined, rows: Array<Array<string|number>>, header?: string[]): Report {
    rep.sections.push({ kind: "table", title, rows, header });
    return rep;
  },

  code(rep: Report, title: string | undefined, code: string, lang?: string): Report {
    rep.sections.push({ kind: "code", title, lang, code });
    return rep;
  },

  image(rep: Report, title: string | undefined, url: string, alt?: string): Report {
    rep.sections.push({ kind: "image", title, url, alt });
    return rep;
  },

  list(rep: Report, title: string | undefined, items: Section extends infer _ ? any : never): Report {
    rep.sections.push({ kind: "list", title, items } as any);
    return rep;
  },

  quote(rep: Report, title: string | undefined, body: string): Report {
    rep.sections.push({ kind: "quote", title, body });
    return rep;
  },

  mermaid(rep: Report, title: string | undefined, code: string): Report {
    rep.sections.push({ kind: "mermaid", title, code });
    return rep;
  },

  raw(rep: Report, md: string): Report {
    rep.sections.push({ kind: "raw", md });
    return rep;
  },

  kpis(rep: Report, kv: KV, { columns = 2 }: { columns?: 1 | 2 | 3 } = {}): Report {
    const rows = Object.entries(kv ?? {}).map(([k, v]) => [k, vToStr(v)]);
    const header = ["Metric", "Value"];
    const block = [
      `> **KPIs**`,
      ``,
      mdTable(rows, header, { compact: true }),
    ].join("\n");
    rep.sections.push({ kind: "raw", md: block });
    return rep;
  },

  badges(rep: Report, badges: Array<{ text: string; color?: string; link?: string }>): Report {
    rep.badges = [...(rep.badges ?? []), ...badges];
    return rep;
  },
};

// ---------- Renderer ----------

export function renderMd(rep: Report): string {
  const parts: string[] = [];

  // Front matter (optional)
  if (rep.frontMatter) {
    const fm = typeof rep.frontMatter === "object" ? { ...rep.frontMatter } : {};
    parts.push(renderFrontMatter({
      title: rep.title,
      subtitle: rep.subtitle,
      author: rep.author,
      date: rep.createdAt,
      tags: rep.tags,
      ...fm,
    }));
  }

  // Header
  parts.push(`# ${escInline(rep.title)}`);
  if (rep.subtitle) parts.push(`*${escInline(rep.subtitle)}*`);
  if (rep.badges && rep.badges.length) {
    const line = rep.badges.map(b => badge(b.text, b.color, b.link)).join(" ");
    parts.push(line);
  }
  if (rep.author || rep.createdAt || (rep.tags && rep.tags.length)) {
    const meta: string[] = [];
    if (rep.author) meta.push(`**Author:** ${escInline(rep.author)}`);
    if (rep.createdAt) meta.push(`**Created:** ${escInline(rep.createdAt)}`);
    if (rep.tags?.length) meta.push(`**Tags:** ${rep.tags.map(t => `\`${escInline(t)}\``).join(", ")}`);
    parts.push(meta.join(" · "));
  }
  parts.push("");

  // TOC
  if (rep.toc) {
    const tocLines: string[] = [];
    const headings = rep.sections
      .map(s => ("title" in s ? (s as any).title : undefined))
      .map((t, i) => ({ t, i }))
      .filter(x => !!x.t) as Array<{ t: string; i: number }>;
    if (headings.length) {
      tocLines.push(`## Contents`);
      for (const { t } of headings) {
        tocLines.push(`- [${escInline(t)}](#${slug(t)})`);
      }
      parts.push(tocLines.join("\n"));
      parts.push("");
    }
  }

  // Sections
  for (const s of rep.sections) parts.push(renderSection(s));

  // Footnote
  if (rep.footnote) {
    parts.push(`\n---\n${rep.footnote.trim()}\n`);
  }

  return parts.join("\n").replace(/\n{3,}/g, "\n\n");
}

function renderSection(s: Section): string {
  switch (s.kind) {
    case "text":
      return [
        s.title ? `## ${escInline(s.title)}\n` : "",
        s.body.trim(),
        "",
      ].join("\n");
    case "table":
      return [
        s.title ? `## ${escInline(s.title)}\n` : "",
        mdTable(s.rows, s.header),
        "",
      ].join("\n");
    case "code":
      return [
        s.title ? `## ${escInline(s.title)}\n` : "",
        fence(s.code, s.lang),
        "",
      ].join("\n");
    case "image":
      return [
        s.title ? `## ${escInline(s.title)}\n` : "",
        `![${escInline(s.alt ?? s.title ?? "")}](${s.url})`,
        "",
      ].join("\n");
    case "list": {
      const items = (s.items || []).map((it: any) => {
        if (typeof it === "string") return `- ${it}`;
        const head = `- ${it.text}`;
        const children = (it.children || []).map((c: string) => `  - ${c}`).join("\n");
        return children ? `${head}\n${children}` : head;
      }).join("\n");
      return [s.title ? `## ${escInline(s.title)}\n` : "", items, ""].join("\n");
    }
    case "quote":
      return [
        s.title ? `## ${escInline(s.title)}\n` : "",
        blockQuote(s.body),
        "",
      ].join("\n");
    case "mermaid":
      return [
        s.title ? `## ${escInline(s.title)}\n` : "",
        fence(s.code.trim(), "mermaid"),
        "",
      ].join("\n");
    case "raw":
      return s.md;
    default:
      return "";
  }
}

// ---------- Helpers (Markdown generation) ----------

export function mdTable(rows: Array<Array<string | number>>, header?: string[], opts?: { compact?: boolean }): string {
  const esc = (x: any) => escInline(String(x ?? ""));
  const hdr = header && header.length ? header : undefined;
  const body = rows.map(r => `| ${r.map(esc).join(" | ")} |`).join("\n");
  const sep = hdr ? `| ${hdr.map(() => "---").join(" | ")} |` : "";
  const top = hdr ? `| ${hdr.map(esc).join(" | ")} |\n${sep}\n` : "";
  const table = top + body;
  return opts?.compact ? table : `\n${table}\n`;
}

export function fence(code: string, lang?: string): string {
  const safe = code.replace(/```/g, "``\\`");
  return `\n\`\`\`${lang || ""}\n${safe}\n\`\`\`\n`;
}

export function blockQuote(md: string): string {
  return md.split(/\r?\n/).map(l => `> ${l}`).join("\n");
}

export function badge(text: string, color?: string, link?: string): string {
  const base = `![${escInline(text)}](https://img.shields.io/badge/${encodeURIComponent(text)}-${encodeURIComponent(color || "black")}.svg)`;
  return link ? `[${base}](${link})` : base;
}

export function escInline(s: string): string {
  return String(s ?? "").replace(/([\\`*_{}\[\]()#+\-!.>|])/g, "\\$1");
}

export function slug(s: string): string {
  return String(s || "").toLowerCase().trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function renderFrontMatter(obj: Record<string, unknown>): string {
  const yaml = toYAML(obj);
  return `---\n${yaml}---\n`;
}

function toYAML(obj: Record<string, unknown>, indent = 0): string {
  const pad = "  ".repeat(indent);
  let out = "";
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      out += `${pad}${k}:\n`;
      for (const item of v) out += `${pad}- ${yamlVal(item)}\n`.replace(/^  -/, "  -");
    } else if (typeof v === "object") {
      out += `${pad}${k}:\n` + toYAML(v as any, indent + 1);
    } else {
      out += `${pad}${k}: ${yamlVal(v)}\n`;
    }
  }
  return out;
}
function yamlVal(v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  if (/^[A-Za-z0-9 _.-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function vToStr(v: any): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return prettyNum(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}
function prettyNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n/1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n/1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n/1e3).toFixed(2) + "K";
  if (abs === 0) return "0";
  if (abs < 0.001) return n.toExponential(2);
  return (Math.round(n*1000)/1000).toString();
}

// ---------- Sparklines & Mermaid helpers ----------

/** Tiny inline sparkline using block characters. */
export function asciiSpark(values: number[], { width = 24 }: { width?: number } = {}): string {
  if (!values?.length) return "";
  const vs = resample(values, Math.max(2, width));
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const bins = ["▁","▂","▃","▄","▅","▆","▇","█"];
  if (hi === lo) return bins[0].repeat(vs.length);
  return vs.map(v => {
    const norm = (v - lo) / (hi - lo);
    const idx = Math.min(bins.length - 1, Math.max(0, Math.floor(norm * (bins.length - 1))));
    return bins[idx];
  }).join("");
}

function resample(arr: number[], n: number): number[] {
  if (arr.length <= n) return arr.slice();
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * arr.length / n);
    const b = Math.floor((i + 1) * arr.length / n);
    const slice = arr.slice(a, Math.max(a + 1, b));
    const m = slice.reduce((s, x) => s + x, 0) / slice.length;
    out.push(m);
  }
  return out;
}

/** Build a Mermaid xychart-beta block (works on GitHub & newer Mermaid renderers). */
export function xychart(opts: { title?: string; x: (string|number|Date)[]; y: number[] }): string {
  const x = opts.x.map(v => (v instanceof Date ? v.toISOString().slice(0,10) : String(v)));
  const y = opts.y.map(v => Number(v));
  const lines = [
    "xychart-beta",
    opts.title ? `  title: ${escapeMermaid(opts.title)}` : "",
    "  x-axis: X",
    "  y-axis: Y",
    `  series:`,
    `    - label: series`,
    `      data:`,
    ...x.map((xi, i) => `        - x: ${escapeMermaid(xi)}\n          y: ${Number.isFinite(y[i]) ? y[i] : 0}`).join("\n").split("\n"),
  ].filter(Boolean);
  return lines.join("\n");
}
function escapeMermaid(s: string): string {
  return String(s).replace(/:/g, "\\:").replace(/\|/g, "\\|");
}

// ---------- One-shot builder ----------

export function buildReport(opts: {
  title: string;
  subtitle?: string;
  meta?: KV;
  kpis?: KV;
  table?: { title?: string; rows: Array<Array<string|number>>; header?: string[] };
  equity?: { x: Array<number|Date|string>; y: number[]; spark?: boolean; mermaid?: boolean };
  text?: Array<{ title?: string; body: string }>;
  footnote?: string;
  author?: string;
  tags?: string[];
  badges?: Array<{ text: string; color?: string; link?: string }>;
  toc?: boolean;
  frontMatter?: boolean | Record<string, unknown>;
}): string {
  const rep = MdReport.create({
    title: opts.title,
    subtitle: opts.subtitle,
    author: opts.author,
    tags: opts.tags,
    badges: opts.badges,
    footnote: opts.footnote,
    toc: opts.toc ?? true,
    frontMatter: opts.frontMatter ?? true,
  });

  if (opts.kpis) MdReport.kpis(rep, opts.kpis);
  if (opts.meta) {
    const rows = Object.entries(opts.meta).map(([k,v]) => [k, vToStr(v)]);
    MdReport.table(rep, "Summary", rows, ["Metric","Value"]);
  }
  if (opts.table) MdReport.table(rep, opts.table.title, opts.table.rows, opts.table.header);

  if (opts.equity) {
    const { x, y, spark, mermaid } = opts.equity;
    if (spark) {
      const sp = asciiSpark(y);
      MdReport.text(rep, "Equity Spark", `\`${sp}\``);
    }
    if (mermaid) {
      MdReport.mermaid(rep, "Equity (Mermaid XY)", xychart({ title: "Equity", x, y }));
    }
  }

  for (const t of opts.text ?? []) MdReport.text(rep, t.title, t.body);

  return renderMd(rep);
}

// ---------- Node-only save helper ----------

export async function saveMd(md: string, path: string): Promise<void> {
  if (!isNode()) throw new Error("saveMd: not in Node environment");
  const fs = await import("node:fs/promises");
  await fs.writeFile(path, md, "utf8");
}

function isNode(): boolean {
  return typeof (globalThis as any).process?.versions?.node === "string";
}
