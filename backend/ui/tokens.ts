// ui/tokens.ts
// Zero-dependency design tokens with light/dark themes, CSS variable emitter,
// and tiny helpers for spacing, typography, elevation, and theming.

// ---------- Types ----------
export type Scale = Record<string | number, string | number>;
export type ColorScale = Record<string, string>;
export type SemanticColors = {
  bg: string;
  surface: string;
  overlay: string;
  text: string;
  textMuted: string;
  border: string;
  primary: string;
  primaryFg: string;
  success: string;
  successFg: string;
  warning: string;
  warningFg: string;
  danger: string;
  dangerFg: string;
  info: string;
  infoFg: string;
  focus: string;
};

export type Theme = {
  name: string;
  colors: SemanticColors & {
    // raw palettes (optional but handy)
    gray: ColorScale;
    brand: ColorScale;
    green: ColorScale;
    yellow: ColorScale;
    red: ColorScale;
    blue: ColorScale;
  };
  spacing: Scale;
  radii: Scale;
  shadow: Record<"sm"|"md"|"lg"|"xl"|"inner"|"outline", string>;
  blur: Scale;
  z: Scale;
  durations: Scale;
  easing: Scale;
  typography: {
    fontFamily: string;
    monoFamily: string;
    sizes: Scale;    // e.g., xs..7xl
    lineHeights: Scale;
    weights: Scale;
    letterSpacing: Scale;
  };
  breakpoints: Record<"xs"|"sm"|"md"|"lg"|"xl"|"2xl", number>; // px
  container: Record<"sm"|"md"|"lg"|"xl"|"2xl", number>; // px
};

// ---------- Base scales ----------
const spacing: Scale = {
  0: "0px",
  px: "1px",
  0.5: "2px",
  1: "4px",
  1.5: "6px",
  2: "8px",
  2.5: "10px",
  3: "12px",
  3.5: "14px",
  4: "16px",
  5: "20px",
  6: "24px",
  7: "28px",
  8: "32px",
  9: "36px",
  10: "40px",
  12: "48px",
  14: "56px",
  16: "64px",
  20: "80px",
  24: "96px",
  28: "112px",
  32: "128px",
  36: "144px",
  40: "160px",
  48: "192px",
  56: "224px",
  64: "256px",
};

const radii: Scale = {
  none: "0px",
  xs: "2px",
  sm: "4px",
  md: "8px",
  lg: "12px",
  xl: "16px",
  "2xl": "24px",
  "3xl": "32px",
  full: "9999px",
};

const shadow = {
  sm: "0 1px 2px rgba(0,0,0,0.06)",
  md: "0 4px 10px rgba(0,0,0,0.10)",
  lg: "0 10px 25px rgba(0,0,0,0.12)",
  xl: "0 20px 45px rgba(0,0,0,0.16)",
  inner: "inset 0 2px 6px rgba(0,0,0,0.08)",
  outline: "0 0 0 3px var(--focus)",
};

const blur: Scale = {
  none: "0px",
  xs: "2px",
  sm: "4px",
  md: "8px",
  lg: "12px",
  xl: "16px",
  "2xl": "24px",
};

const z: Scale = {
  base: 0,
  dropdown: 1000,
  sticky: 1100,
  overlay: 1200,
  modal: 1300,
  popover: 1400,
  toast: 1500,
  max: 2147483647,
};

const durations: Scale = {
  0: "0ms",
  75: "75ms",
  100: "100ms",
  150: "150ms",
  200: "200ms",
  300: "300ms",
  500: "500ms",
  700: "700ms",
  1000: "1000ms",
};

const easing: Scale = {
  linear: "cubic-bezier(0, 0, 1, 1)",
  in: "cubic-bezier(0.4, 0, 1, 1)",
  out: "cubic-bezier(0, 0, 0.2, 1)",
  "in-out": "cubic-bezier(0.4, 0, 0.2, 1)",
  spring: "cubic-bezier(0.2, 0.8, 0.2, 1)",
};

// Typography
const typography = {
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
  monoFamily:
    '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  sizes: {
    xs: "12px",
    sm: "13px",
    base: "14px",
    md: "16px",
    lg: "18px",
    xl: "20px",
    "2xl": "24px",
    "3xl": "30px",
    "4xl": "36px",
    "5xl": "48px",
    "6xl": "60px",
    "7xl": "72px",
  },
  lineHeights: {
    tight: 1.1,
    snug: 1.25,
    normal: 1.5,
    relaxed: 1.7,
    loose: 1.9,
  },
  weights: {
    thin: 100,
    light: 300,
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
    extrabold: 800,
  },
  letterSpacing: {
    tighter: "-0.02em",
    tight: "-0.01em",
    normal: "0em",
    wide: "0.01em",
    wider: "0.02em",
  },
};

// ---------- Palettes ----------
const gray: ColorScale = {
  50:  "#f8fafc",
  100: "#f1f5f9",
  200: "#e2e8f0",
  300: "#cbd5e1",
  400: "#94a3b8",
  500: "#64748b",
  600: "#475569",
  700: "#334155",
  800: "#1f2937",
  900: "#0f172a",
};

const brand: ColorScale = {
  50:  "#eef2ff",
  100: "#e0e7ff",
  200: "#c7d2fe",
  300: "#a5b4fc",
  400: "#818cf8",
  500: "#6366f1",
  600: "#4f46e5",
  700: "#4338ca",
  800: "#3730a3",
  900: "#312e81",
};

const green: ColorScale = {
  50:  "#ecfdf5",
  100: "#d1fae5",
  200: "#a7f3d0",
  300: "#6ee7b7",
  400: "#34d399",
  500: "#10b981",
  600: "#059669",
  700: "#047857",
  800: "#065f46",
  900: "#064e3b",
};

const yellow: ColorScale = {
  50:  "#fffbeb",
  100: "#fef3c7",
  200: "#fde68a",
  300: "#fcd34d",
  400: "#fbbf24",
  500: "#f59e0b",
  600: "#d97706",
  700: "#b45309",
  800: "#92400e",
  900: "#78350f",
};

const red: ColorScale = {
  50:  "#fef2f2",
  100: "#fee2e2",
  200: "#fecaca",
  300: "#fca5a5",
  400: "#f87171",
  500: "#ef4444",
  600: "#dc2626",
  700: "#b91c1c",
  800: "#991b1b",
  900: "#7f1d1d",
};

const blue: ColorScale = {
  50:  "#eff6ff",
  100: "#dbeafe",
  200: "#bfdbfe",
  300: "#93c5fd",
  400: "#60a5fa",
  500: "#3b82f6",
  600: "#2563eb",
  700: "#1d4ed8",
  800: "#1e40af",
  900: "#1e3a8a",
};

// ---------- Themes ----------
export const lightTheme: Theme = {
  name: "light",
  colors: {
    gray, brand, green, yellow, red, blue,
    bg: gray[50],
    surface: "#ffffff",
    overlay: "rgba(15, 23, 42, 0.4)",
    text: gray[900],
    textMuted: gray[600],
    border: gray[200],
    primary: brand[600],
    primaryFg: "#ffffff",
    success: green[600],
    successFg: "#ffffff",
    warning: yellow[600],
    warningFg: "#111827",
    danger: red[600],
    dangerFg: "#ffffff",
    info: blue[600],
    infoFg: "#ffffff",
    focus: "rgba(99,102,241,0.35)",
  },
  spacing,
  radii,
  shadow,
  blur,
  z,
  durations,
  easing,
  typography,
  breakpoints: { xs: 360, sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 },
  container:  { sm: 600, md: 720, lg: 960, xl: 1200, "2xl": 1320 },
};

export const darkTheme: Theme = {
  name: "dark",
  colors: {
    gray, brand, green, yellow, red, blue,
    bg: "#0b1020",
    surface: "#0f172a",
    overlay: "rgba(0,0,0,0.5)",
    text: "#e6e9f2",
    textMuted: gray[400],
    border: "#1f2a44",
    primary: brand[500],
    primaryFg: "#f6f7ff",
    success: "#0bbf8a",
    successFg: "#02110b",
    warning: "#f59e0b",
    warningFg: "#0b0a06",
    danger: "#ef4444",
    dangerFg: "#fff5f5",
    info: "#3b82f6",
    infoFg: "#041018",
    focus: "rgba(99,102,241,0.45)",
  },
  spacing,
  radii,
  shadow: {
    sm: "0 1px 2px rgba(0,0,0,0.35)",
    md: "0 4px 10px rgba(0,0,0,0.45)",
    lg: "0 10px 25px rgba(0,0,0,0.5)",
    xl: "0 20px 45px rgba(0,0,0,0.6)",
    inner: "inset 0 2px 8px rgba(0,0,0,0.45)",
    outline: "0 0 0 3px var(--focus)",
  },
  blur,
  z,
  durations,
  easing,
  typography,
  breakpoints: { xs: 360, sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 },
  container:  { sm: 600, md: 720, lg: 960, xl: 1200, "2xl": 1320 },
};

// ---------- Token access helpers ----------
export const tokens = {
  light: lightTheme,
  dark: darkTheme,
};

export type ThemeName = keyof typeof tokens;

// get a token by path, e.g., getToken("light", "colors.primary")
export function getToken<T = any>(theme: Theme | ThemeName, path: string, fallback?: T): T {
  const t = typeof theme === "string" ? tokens[theme] : theme;
  const parts = path.split(".");
  let cur: any = t;
  for (let i = 0; i < parts.length; i++) {
    if (cur == null) return (fallback as T);
    cur = cur[parts[i]];
  }
  return (cur ?? fallback) as T;
}

// ---------- CSS variable emitter ----------
function toCssVars(theme: Theme): Record<string, string> {
  const vars: Record<string, string> = {};

  // Colors (semantic)
  const c = theme.colors;
  vars["--bg"] = c.bg;
  vars["--surface"] = c.surface;
  vars["--overlay"] = c.overlay;
  vars["--text"] = c.text;
  vars["--text-muted"] = c.textMuted;
  vars["--border"] = c.border;
  vars["--primary"] = c.primary;
  vars["--on-primary"] = c.primaryFg;
  vars["--success"] = c.success;
  vars["--on-success"] = c.successFg;
  vars["--warning"] = c.warning;
  vars["--on-warning"] = c.warningFg;
  vars["--danger"] = c.danger;
  vars["--on-danger"] = c.dangerFg;
  vars["--info"] = c.info;
  vars["--on-info"] = c.infoFg;
  vars["--focus"] = c.focus;

  // Palettes (subset)
  for (const k in c.gray) vars[`--gray-${k}`] = c.gray[k];
  for (const k in c.brand) vars[`--brand-${k}`] = c.brand[k];
  for (const k in c.green) vars[`--green-${k}`] = c.green[k];
  for (const k in c.yellow) vars[`--yellow-${k}`] = c.yellow[k];
  for (const k in c.red) vars[`--red-${k}`] = c.red[k];
  for (const k in c.blue) vars[`--blue-${k}`] = c.blue[k];

  // Spacing
  for (const k in theme.spacing) vars[`--space-${k}`] = String(theme.spacing[k]);

  // Radius / shadow / blur / z
  for (const k in theme.radii) vars[`--radius-${k}`] = String(theme.radii[k]);
  for (const k in theme.shadow) vars[`--shadow-${k}`] = theme.shadow[k as keyof typeof theme.shadow];
  for (const k in theme.blur) vars[`--blur-${k}`] = String(theme.blur[k]);
  for (const k in theme.z) vars[`--z-${k}`] = String(theme.z[k]);

  // Motion
  for (const k in theme.durations) vars[`--duration-${k}`] = String(theme.durations[k]);
  for (const k in theme.easing) vars[`--easing-${k}`] = String(theme.easing[k]);

  // Type
  vars["--font-sans"] = theme.typography.fontFamily;
  vars["--font-mono"] = theme.typography.monoFamily;
  for (const k in theme.typography.sizes) vars[`--text-${k}`] = String(theme.typography.sizes[k]);
  for (const k in theme.typography.lineHeights) vars[`--leading-${k}`] = String(theme.typography.lineHeights[k]);
  for (const k in theme.typography.weights) vars[`--weight-${k}`] = String(theme.typography.weights[k]);
  for (const k in theme.typography.letterSpacing) vars[`--tracking-${k}`] = String(theme.typography.letterSpacing[k]);

  // Layout
  for (const k in theme.breakpoints) vars[`--bp-${k}`] = theme.breakpoints[k] + "px";
  for (const k in theme.container) vars[`--container-${k}`] = theme.container[k] + "px";

  return vars;
}

export function themeToCss(theme: Theme, selector = ":root"): string {
  const vars = toCssVars(theme);
  const body = Object.keys(vars).map(k => `  ${k}: ${vars[k]};`).join("\n");
  return `${selector} {\n${body}\n}`;
}

// Apply theme to document root (no-op in SSR)
export function applyTheme(theme: Theme | ThemeName, selector = ":root"): void {
  if (typeof document === "undefined") return;
  const t = typeof theme === "string" ? tokens[theme] : theme;
  const vars = toCssVars(t);
  const root = selector === ":root" ? document.documentElement : document.querySelector(selector);
  if (!root) return;
  const el = root as HTMLElement;
  for (const k in vars) el.style.setProperty(k, vars[k]);
  el.setAttribute("data-theme", t.name);
}

// Auto theme based on OS preference (call once on boot if you want)
export function applyPreferredTheme(): ThemeName {
  const prefersDark =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const t: ThemeName = prefersDark ? "dark" : "light";
  applyTheme(t);
  return t;
}

// ---------- Convenience shorthands ----------
export const s = (k: keyof typeof spacing | string) => String(spacing[k as any] ?? k);
export const r = (k: keyof typeof radii | string) => String(radii[k as any] ?? k);
export const dur = (k: keyof typeof durations | string) => String(durations[k as any] ?? k);
export const ease = (k: keyof typeof easing | string) => String(easing[k as any] ?? k);

// Component-level semantic defaults (can be extended per-app)
export const componentTokens = {
  button: {
    height: "40px",
    radius: "var(--radius-xl)",
    shadow: "var(--shadow-sm)",
    px: "var(--space-4)",
    gap: "var(--space-2)",
  },
  card: {
    radius: "var(--radius-2xl)",
    shadow: "var(--shadow-md)",
    padding: "var(--space-6)",
    border: "1px solid var(--border)",
    bg: "var(--surface)",
  },
  input: {
    height: "40px",
    radius: "var(--radius-lg)",
    border: "1px solid var(--border)",
    focus: "var(--focus)",
    paddingX: "var(--space-3)",
  },
};

// Example CSS string (optional): injectStyle(themeToCss(lightTheme))
export function injectStyle(css: string): void {
  if (typeof document === "undefined") return;
  const id = "ui-tokens-style";
  let style = document.getElementById(id) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = id;
    document.head.appendChild(style);
  }
  style.textContent = css;
}
