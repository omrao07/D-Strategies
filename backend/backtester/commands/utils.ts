// commands/utils.ts
// Shared helpers for CLI / command handlers (no external deps)

/* ============================== Types ============================== */

export type CommandArgs = Record<string, string | number | boolean | undefined>;

export type ParsedCommand = {
  command: string;
  args: CommandArgs;
  flags: Record<string, boolean>;
  raw: string;
};

/* ============================ Parsing ============================== */

/**
 * Parse a CLI-style command string.
 * Examples:
 *  "run --dry --limit=10 --name test"
 *  "backtest AAPL --from 2020-01-01 --to 2024-01-01"
 */
export function parseCommand(input: string): ParsedCommand {
  const raw = input.trim();
  const tokens = tokenize(raw);

  const command = tokens.shift() ?? "";
  const args: CommandArgs = {};
  const flags: Record<string, boolean> = {};

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];

    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      if (eq > -1) {
        const k = t.slice(2, eq);
        const v = t.slice(eq + 1);
        args[k] = coerce(v);
      } else {
        const k = t.slice(2);
        const next = tokens[i + 1];
        if (next != null && !next.startsWith("-")) {
          args[k] = coerce(next);
          i++;
        } else {
          flags[k] = true;
        }
      }
    } else if (t.startsWith("-") && t.length > 1) {
      // short flags: -abc => a,b,c
      for (const ch of t.slice(1)) flags[ch] = true;
    } else {
      // positional args
      args[`$${Object.keys(args).length}`] = coerce(t);
    }

    i++;
  }

  return { command, args, flags, raw };
}

/* ============================= Output ============================== */

export function printTable<T extends Record<string, unknown>>(
  rows: T[],
  columns?: (keyof T)[]
): string {
  if (!rows.length) return "";

  const cols = columns ?? (Object.keys(rows[0]) as (keyof T)[]);
  const widths = cols.map((c) =>
    Math.max(
      String(c).length,
      ...rows.map((r) => String(r[c] ?? "").length)
    )
  );

  const pad = (s: string, w: number) => s + " ".repeat(w - s.length);

  const header =
    cols.map((c, i) => pad(String(c), widths[i])).join(" | ") + "\n" +
    widths.map((w) => "-".repeat(w)).join("-+-");

  const body = rows
    .map((r) =>
      cols.map((c, i) => pad(String(r[c] ?? ""), widths[i])).join(" | ")
    )
    .join("\n");

  return `${header}\n${body}`;
}

export function color(
  s: string,
  c: "red" | "green" | "yellow" | "blue" | "gray"
): string {
  const map: Record<string, string> = {
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    gray: "\x1b[90m"
  };
  return `${map[c] ?? ""}${s}\x1b[0m`;
}

/* ============================== Guards ============================== */

export function requireArg<T = string>(
  args: CommandArgs,
  key: string
): T {
  if (args[key] == null) {
    throw new Error(`Missing required argument: ${key}`);
  }
  return args[key] as T;
}

export function optionalArg<T = string>(
  args: CommandArgs,
  key: string,
  def?: T
): T | undefined {
  return (args[key] as T) ?? def;
}

/* ============================== Helpers ============================ */

function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: '"' | "'" | null = null;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else {
      if (ch === '"' || ch === "'") q = ch;
      else if (/\s/.test(ch)) {
        if (cur) out.push(cur), (cur = "");
      } else {
        cur += ch;
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

function coerce(v: string): string | number | boolean {
  if (v === "true") return true;
  if (v === "false") return false;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}