// components/changehighlights.tsx
// React-based ChangeHighlights: computes & renders JSON diffs with real state (useState).
// Minimal UI, no external deps.

import React, { useState, type CSSProperties, type ReactNode } from "react";

/* --------------------------------- Types --------------------------------- */

export type JSONPrimitive = string | number | boolean | null;
export type JSONValue = JSONPrimitive | JSONObject | JSONArray;
export type JSONObject = { [k: string]: JSONValue };
export type JSONArray = JSONValue[];

export type ChangeKind = "add" | "remove" | "replace";
export type Path = string;

export interface Change {
  kind: ChangeKind;
  path: Path;
  prev?: JSONValue;
  next?: JSONValue;
}

export interface ChangeHighlightsProps {
  changes?: Change[];            // precomputed list
  prev?: JSONValue;              // or provide prev+next
  next?: JSONValue;

  numberTolerance?: number;      // for numeric equality, default 0
  showCounts?: boolean;          // default true

  className?: string;
  style?: CSSProperties;
  collapsedPaths?: (string | RegExp)[]; // initial collapsed rows by path match
  maxPreviewLength?: number;     // default 180
}

/* ------------------------------- Diff engine ------------------------------ */

function isPrimitive(v: any): v is JSONPrimitive {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}
function isObject(v: any): v is JSONObject {
  return v != null && typeof v === "object" && !Array.isArray(v);
}
function primEqual(a: JSONPrimitive, b: JSONPrimitive, tol: number): boolean {
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return Math.abs(a - b) <= tol;
  }
  return a === b;
}
function joinPath(base: string, key: string): string {
  if (!base) return key;
  if (/^[A-Za-z_]\w*$/.test(key)) return `${base}.${key}`;
  return `${base}["${key.replace(/"/g, '\\"')}"]`;
}
function joinIndex(base: string, idx: number): string {
  return `${base}[${idx}]`;
}
function cloneSmall<T extends JSONValue>(v: T): T {
  if (isPrimitive(v)) return v;
  try { return JSON.parse(JSON.stringify(v)); } catch { return v; }
}

function deepDiff(a: JSONValue, b: JSONValue, path: string, out: Change[], tol: number) {
  const aU = a === undefined, bU = b === undefined;
  if (aU && bU) return;
  if (aU && !bU) { out.push({ kind: "add", path, next: cloneSmall(b) }); return; }
  if (!aU && bU) { out.push({ kind: "remove", path, prev: cloneSmall(a) }); return; }

  if (isPrimitive(a) && isPrimitive(b)) {
    if (!primEqual(a, b, tol)) out.push({ kind: "replace", path, prev: a, next: b });
    return;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const p = joinIndex(path, i);
      if (i >= a.length) out.push({ kind: "add", path: p, next: cloneSmall(b[i]) });
      else if (i >= b.length) out.push({ kind: "remove", path: p, prev: cloneSmall(a[i]) });
      else deepDiff(a[i], b[i], p, out, tol);
    }
    return;
  }

  if (isObject(a) && isObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    const seen = new Set<string>();
    for (let i = 0; i < aKeys.length; i++) {
      const k = aKeys[i];
      const p = joinPath(path, k);
      if (!(k in b)) out.push({ kind: "remove", path: p, prev: cloneSmall(a[k]) });
      else deepDiff(a[k], b[k], p, out, tol);
      seen.add(k);
    }
    for (let i = 0; i < bKeys.length; i++) {
      const k = bKeys[i];
      if (seen.has(k)) continue;
      const p = joinPath(path, k);
      out.push({ kind: "add", path: p, next: cloneSmall(b[k]) });
    }
    return;
  }

  // Type change
  out.push({ kind: "replace", path, prev: cloneSmall(a), next: cloneSmall(b) });
}

function computeChanges(prev?: JSONValue, next?: JSONValue, tol = 0): Change[] {
  const out: Change[] = [];
  deepDiff(prev as any, next as any, "", out, Math.max(0, tol));
  for (let i = 0; i < out.length; i++) if (!out[i].path) out[i].path = "(root)";
  // Sort by path for stable UI
  out.sort((a, b) => a.path.localeCompare(b.path) || kindRank(a.kind) - kindRank(b.kind));
  return out;
}
function kindRank(k: ChangeKind) { return k === "replace" ? 0 : k === "add" ? 1 : 2; }

/* ---------------------------------- UI ---------------------------------- */

export function ChangeHighlights({
  changes,
  prev,
  next,
  numberTolerance = 0,
  showCounts = true,
  className = "",
  style,
  collapsedPaths = [],
  maxPreviewLength = 180,
}: ChangeHighlightsProps) {
  const list = Array.isArray(changes) ? changes : computeChanges(prev, next, numberTolerance);

  const groups = {
    replace: list.filter(c => c.kind === "replace"),
    add: list.filter(c => c.kind === "add"),
    remove: list.filter(c => c.kind === "remove"),
  };
  const counts = {
    replace: groups.replace.length,
    add: groups.add.length,
    remove: groups.remove.length,
    total: list.length,
  };

  const shouldCollapse = (path: string) =>
    collapsedPaths.some(p => (typeof p === "string" ? path.includes(p) : p.test(path)));

  const badge = (label: string, tone: "info" | "success" | "danger" | "warning", val: number) => (
    <span style={badgeStyle(tone)}>{label}{showCounts ? `: ${val}` : ""}</span>
  );

  return (
    <div className={className} style={{ ...containerStyle, ...style }}>
      <div style={headerStyle}>
        <strong style={{ color: "var(--text, #111827)" }}>Changes</strong>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {badge("~ Replace", "warning", counts.replace)}
          {badge("+ Add", "success", counts.add)}
          {badge("− Remove", "danger", counts.remove)}
          <span style={{ color: "var(--text-muted, #6b7280)", fontSize: 12 }}>Total: {counts.total}</span>
        </div>
      </div>

      {renderGroup("Replacements", groups.replace, "warning", maxPreviewLength, shouldCollapse)}
      {renderGroup("Additions", groups.add, "success", maxPreviewLength, shouldCollapse)}
      {renderGroup("Removals", groups.remove, "danger", maxPreviewLength, shouldCollapse)}

      {list.length === 0 && <div style={emptyStyle}>No changes.</div>}
    </div>
  );
}

export default ChangeHighlights;

/* ------------------------------ Render helpers ----------------------------- */

function renderGroup(
  title: string,
  items: Change[],
  tone: "success" | "danger" | "warning" | "info",
  maxPreviewLength: number,
  shouldCollapse: (p: string) => boolean
): ReactNode {
  if (!items.length) return null;
  return (
    <section style={{ marginTop: 10 }}>
      <div style={{ ...groupTitleStyle, borderLeftColor: toneColor(tone) }}>{title}</div>
      <div style={{ display: "grid", gap: 6 }}>
        {items.map((c, i) => (
          <ChangeRow
            key={`${c.kind}:${c.path}:${i}`}
            change={c}
            tone={tone}
            maxLen={maxPreviewLength}
            defaultCollapsed={shouldCollapse(c.path)}
          />
        ))}
      </div>
    </section>
  );
}

function ChangeRow(props: { change: Change; tone: "success" | "danger" | "warning" | "info"; maxLen: number; defaultCollapsed?: boolean; }) {
  const { change, tone, maxLen, defaultCollapsed } = props;
  const [open, setOpen] = useState<boolean>(!(defaultCollapsed ?? false));

  const symbol = change.kind === "add" ? "+" : change.kind === "remove" ? "−" : "~";
  const color = toneColor(tone);

  const prev = preview(change.prev, maxLen);
  const next = preview(change.next, maxLen);

  return (
    <div style={{ ...rowStyle, borderLeftColor: color }}>
      <div style={rowHeaderStyle}>
        <code style={pathStyle}>{symbol} {change.path}</code>
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          style={toggleBtnStyle}
          aria-expanded={open}
          aria-label={open ? "Collapse" : "Expand"}
        >
          {open ? "Hide" : "Show"}
        </button>
      </div>

      {open && (
        <div style={diffBoxStyle}>
          {change.kind !== "add" && (
            <div style={{ ...sideBoxStyle, borderColor: "var(--red-200, #fecaca)" }}>
              <div style={sideTitleStyle}>Prev</div>
              <pre style={preStyle}>{prev}</pre>
            </div>
          )}
          {change.kind !== "remove" && (
            <div style={{ ...sideBoxStyle, borderColor: "var(--green-200, #bbf7d0)" }}>
              <div style={sideTitleStyle}>Next</div>
              <pre style={preStyle}>{next}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* -------------------------------- Styling --------------------------------- */

const containerStyle: CSSProperties = {
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial',
  color: "var(--text, #111827)",
  background: "var(--surface, #fff)",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "12px",
  padding: "12px",
  boxShadow: "var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.06))",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 8,
};

function badgeStyle(tone: "info" | "success" | "danger" | "warning"): CSSProperties {
  const bg = tone === "success" ? "var(--green-100, #dcfce7)"
    : tone === "danger" ? "var(--red-100, #fee2e2)"
    : tone === "warning" ? "var(--yellow-100, #fef3c7)"
    : "var(--blue-100, #dbeafe)";
  const fg = tone === "success" ? "var(--green-700, #047857)"
    : tone === "danger" ? "var(--red-700, #b91c1c)"
    : tone === "warning" ? "var(--yellow-700, #b45309)"
    : "var(--blue-700, #1d4ed8)";
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "2px 8px",
    borderRadius: 9999,
    background: bg,
    color: fg,
    fontSize: 12,
    border: `1px solid ${fg}22`,
  };
}

const groupTitleStyle: CSSProperties = {
  fontWeight: 600,
  fontSize: 13,
  paddingLeft: 8,
  borderLeft: "3px solid var(--border, #e5e7eb)",
  margin: "6px 0",
  color: "var(--text-muted, #6b7280)",
};

const rowStyle: CSSProperties = {
  border: "1px solid var(--border, #e5e7eb)",
  borderLeft: "3px solid transparent",
  borderRadius: 10,
  padding: 8,
  background: "var(--bg, #ffffff)",
};

const rowHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const pathStyle: CSSProperties = {
  background: "var(--gray-100, #f3f4f6)",
  padding: "2px 6px",
  borderRadius: 6,
  fontSize: 12,
};

const toggleBtnStyle: CSSProperties = {
  fontSize: 12,
  padding: "2px 8px",
  borderRadius: 6,
  background: "transparent",
  border: "1px solid var(--border, #e5e7eb)",
  cursor: "pointer",
};

const diffBoxStyle: CSSProperties = {
  marginTop: 8,
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 8,
};

const sideBoxStyle: CSSProperties = {
  border: "1px dashed",
  borderRadius: 8,
  padding: 8,
  background: "var(--surface, #fff)",
};

const sideTitleStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-muted, #6b7280)",
  marginBottom: 4,
};

const preStyle: CSSProperties = {
  margin: 0,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  fontSize: 12,
  lineHeight: 1.5,
};

const emptyStyle: CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  color: "var(--text-muted, #6b7280)",
  textAlign: "center",
};

/* --------------------------------- Utils ---------------------------------- */

function preview(v: any, max = 180): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v, null, 0);
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  } catch {
    return String(v);
  }
}

function toneColor(t: "success" | "danger" | "warning" | "info"): string {
  if (t === "success") return "var(--success, #10b981)";
  if (t === "danger") return "var(--danger, #ef4444)";
  if (t === "warning") return "var(--warning, #f59e0b)";
  return "var(--info, #3b82f6)";
}
