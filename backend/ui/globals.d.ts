// ui/globals.d.ts
// Ambient declarations for UI/build setup. Zero imports, framework-agnostic.

// -------- Asset modules --------
declare module "*.png"   { const url: string; export default url; }
declare module "*.jpg"   { const url: string; export default url; }
declare module "*.jpeg"  { const url: string; export default url; }
declare module "*.gif"   { const url: string; export default url; }
declare module "*.webp"  { const url: string; export default url; }
declare module "*.avif"  { const url: string; export default url; }
declare module "*.mp4"   { const url: string; export default url; }
declare module "*.webm"  { const url: string; export default url; }
declare module "*.pdf"   { const url: string; export default url; }
declare module "*.md"    { const content: string; export default content; }
declare module "*.txt"   { const content: string; export default content; }

// SVG: URL default export + lightweight ReactComponent fallback (no react import)
declare module "*.svg" {
  const url: string;
  export default url;
  // Minimal function component type to avoid importing React types
  export type FC<P = any> = (props: P) => any;
  export const ReactComponent: FC<{
    title?: string;
    // allow any SVG attributes without pulling in @types/react
    [attr: string]: any;
  }>;
}

// CSS modules & plain CSS
declare module "*.module.css"  { const classes: Record<string, string>; export default classes; }
declare module "*.module.scss" { const classes: Record<string, string>; export default classes; }
declare module "*.module.sass" { const classes: Record<string, string>; export default classes; }
declare module "*.module.less" { const classes: Record<string, string>; export default classes; }
declare module "*.css"  { const css: string; export default css; }
declare module "*.scss" { const css: string; export default css; }
declare module "*.sass" { const css: string; export default css; }
declare module "*.less" { const css: string; export default css; }

// -------- Global build flags (optional) --------
declare const __DEV__: boolean;
declare const __TEST__: boolean;

// -------- UI Theme CSS variables (from ui/tokens.ts) --------
type CSSVarName =
  | "--bg" | "--surface" | "--overlay"
  | "--text" | "--text-muted" | "--border"
  | "--primary" | "--on-primary"
  | "--success" | "--on-success"
  | "--warning" | "--on-warning"
  | "--danger"  | "--on-danger"
  | "--info"    | "--on-info"
  | "--focus"
  // palettes (subset)
  | `--gray-${50|100|200|300|400|500|600|700|800|900}`
  | `--brand-${50|100|200|300|400|500|600|700|800|900}`
  | `--green-${50|100|200|300|400|500|600|700|800|900}`
  | `--yellow-${50|100|200|300|400|500|600|700|800|900}`
  | `--red-${50|100|200|300|400|500|600|700|800|900}`
  | `--blue-${50|100|200|300|400|500|600|700|800|900}`
  // spacing/radii/shadow/blur/z
  | `--space-${number|string}`
  | `--radius-${"none"|"xs"|"sm"|"md"|"lg"|"xl"|"2xl"|"3xl"|"full"}`
  | `--shadow-${"sm"|"md"|"lg"|"xl"|"inner"|"outline"}`
  | `--blur-${"none"|"xs"|"sm"|"md"|"lg"|"xl"|"2xl"}`
  | `--z-${"base"|"dropdown"|"sticky"|"overlay"|"modal"|"popover"|"toast"|"max"}`
  // motion & type
  | `--duration-${number|string}`
  | `--easing-${"linear"|"in"|"out"|"in-out"|"spring"}`
  | `--font-sans` | `--font-mono`
  | `--text-${"xs"|"sm"|"base"|"md"|"lg"|"xl"|"2xl"|"3xl"|"4xl"|"5xl"|"6xl"|"7xl"}`
  | `--leading-${"tight"|"snug"|"normal"|"relaxed"|"loose"}`
  | `--weight-${"thin"|"light"|"regular"|"medium"|"semibold"|"bold"|"extrabold"}`
  | `--tracking-${"tighter"|"tight"|"normal"|"wide"|"wider"}`
  // layout
  | `--bp-${"xs"|"sm"|"md"|"lg"|"xl"|"2xl"}`
  | `--container-${"sm"|"md"|"lg"|"xl"|"2xl"}`;

// Augment CSSStyleDeclaration for typed CSS variables (non-breaking)
interface CSSStyleDeclaration {
  getPropertyValue(property: CSSVarName | string): string;
  setProperty(property: CSSVarName | string, value: string, priority?: string): void;
}

// -------- Window/document helpers --------
interface Window {
  __theme__?: "light" | "dark";
}

interface Document {
  // allow using data-theme without TS complaints in some setups
  documentElement: HTMLElement & { dataset: { theme?: "light" | "dark" } };
}

// -------- Minimal JSX intrinsic data-theme attr (works without @types/react) --------
declare global {
  namespace JSX {
    interface IntrinsicAttributes {
      "data-theme"?: "light" | "dark";
    }
    interface IntrinsicElements {
      [elemName: string]: any; // keep flexible without tying to a framework
    }
  }
}
export {};