// libs/table.ts
// Simple text table renderer for CLI/terminal output.
// ESM/NodeNext, no external deps.

type Align = "left" | "right" | "center";

export type TableOptions = {
  headers?: string[];
  align?: Align[];
  maxColWidth?: number;   // truncate long values
  pad?: number;           // spaces between columns
  border?: boolean;       // add ASCII border
};

/**
 * Render a 2D array into a formatted table string.
 * @param rows array of rows, each row is array of values
 * @param opts TableOptions
 */
export function renderTable(
  rows: (string | number | boolean | null | undefined)[][],
  opts: TableOptions = {}
): string {
  const { headers, align, maxColWidth = 32, pad = 2, border = false } = opts;

  const allRows = headers ? [headers, ...rows] : rows;
  if (!allRows.length) return "";

  // normalize to strings
  const sRows = allRows.map((row) =>
    row.map((x) => (x === null || x === undefined ? "" : String(x)))
  );

  // truncate
  for (let r = 0; r < sRows.length; r++) {
    for (let c = 0; c < sRows[r].length; c++) {
      let cell = sRows[r][c];
      if (cell.length > maxColWidth) {
        cell = cell.slice(0, maxColWidth - 1) + "…";
      }
      sRows[r][c] = cell;
    }
  }

  // compute column widths
  const nCols = Math.max(...sRows.map((r) => r.length));
  const colWidths: number[] = Array(nCols).fill(0);
  for (const r of sRows) {
    for (let c = 0; c < nCols; c++) {
      const v = r[c] ?? "";
      if (v.length > colWidths[c]) colWidths[c] = v.length;
    }
  }

  // pad right by default
  const colAlign: Align[] = [];
  for (let c = 0; c < nCols; c++) {
    colAlign[c] = align?.[c] ?? "left";
  }

  // format a cell with padding & alignment
  const fmt = (txt: string, width: number, al: Align) => {
    const padLen = width - txt.length;
    if (al === "right") return " ".repeat(padLen) + txt;
    if (al === "center") {
      const l = Math.floor(padLen / 2), r = padLen - l;
      return " ".repeat(l) + txt + " ".repeat(r);
    }
    return txt + " ".repeat(padLen);
  };

  // build lines
  const lines: string[] = [];
  const sepLine = border
    ? "+" +
      colWidths.map((w) => "-".repeat(w + pad)).join("+") +
      "+"
    : "";

  if (border && sepLine) lines.push(sepLine);

  for (let r = 0; r < sRows.length; r++) {
    const row = sRows[r];
    const cells: string[] = [];
    for (let c = 0; c < nCols; c++) {
      const v = row[c] ?? "";
      const cell = fmt(v, colWidths[c], colAlign[c]);
      cells.push(cell);
    }
    const line = border
      ? "| " + cells.join(" ".repeat(pad) + "| ") + " |"
      : cells.join(" ".repeat(pad));
    lines.push(line);

    if (r === 0 && headers && border && sepLine) {
      lines.push(sepLine);
    }
  }

  if (border && sepLine) lines.push(sepLine);

  return lines.join("\n");
}

// Quick demo if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = [
    ["AAPL", 189.32, "+1.2%"],
    ["TSLA", 255.12, "-0.8%"],
    ["GOOG", 138.45, "+0.5%"]
  ];
  console.log(
    renderTable(rows, {
      headers: ["Symbol", "Price", "Change"],
      align: ["left", "right", "right"],
      border: true
    })
  );
}