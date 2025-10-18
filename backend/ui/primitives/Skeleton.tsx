// primitives/skeleton.tsx
// Clean, dependency-free Skeleton loader with solid ergonomics.
// - Variants: "rect" | "text" | "circle" | "pill" | "avatar"
// - Count, shimmer, prefers-reduced-motion, custom sizes, line widths
// - Works with/without your CSS tokens; falls back to neutral grays.

type ElementType = keyof JSX.IntrinsicElements | ((props: any) => any);
type ReactNode = any;
type CSSProperties = any;

export type SkeletonVariant = "rect" | "text" | "circle" | "pill" | "avatar";

export interface SkeletonProps {
  as?: ElementType;                 // wrapper element (default: div)
  variant?: SkeletonVariant;

  // Sizes (accept number px or any CSS string)
  width?: number | string;
  height?: number | string;
  radius?: number | string;

  // Text variant controls
  lines?: number;                   // number of lines
  lineGap?: number | string;        // gap between lines
  lineHeight?: number | string;     // per-line height (default 14px)
  lineWidths?: Array<number | string> | number | string; // widths per line or single fallback

  // Behavior
  count?: number;                   // render multiple copies
  animated?: boolean;               // shimmer on/off
  shimmerDurationMs?: number;       // animation speed
  inline?: boolean;                 // inline-block vs block

  // Style hooks
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;            // optional a11y label
}

// ---------- Internal utilities ----------

function toLen(v?: number | string): string | undefined {
  if (v === undefined) return undefined;
  return typeof v === "number" ? `${v}px` : String(v);
}

function prefReducedMotion(): boolean {
  if (typeof window === "undefined" || !("matchMedia" in window)) return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function ensureKeyframes() {
  if (typeof document === "undefined") return;
  const ID = "sk-keyframes-style";
  if (document.getElementById(ID)) return;
  const style = document.createElement("style");
  style.id = ID;
  style.textContent = `
@keyframes sk-shimmer { 
  0% { background-position: -200% 0; } 
  100% { background-position: 200% 0; } 
}
`;
  document.head.appendChild(style);
}

function baseSurface(animated: boolean, durationMs: number) {
  // Token-friendly with fallbacks
  const base = "var(--gray-200, #e5e7eb)";
  const mid  = "var(--gray-100, #f3f4f6)";
  if (!animated) {
    return {
      backgroundColor: base,
    } as CSSProperties;
  }
  return {
    backgroundColor: base,
    backgroundImage: `linear-gradient(90deg, ${base} 0%, ${mid} 50%, ${base} 100%)`,
    backgroundSize: "200% 100%",
    animation: `sk-shimmer ${durationMs}ms linear infinite`,
  } as CSSProperties;
}

function resolveLineWidth(
  idx: number,
  lines: number,
  lineWidths?: Array<number | string> | number | string
): string {
  if (Array.isArray(lineWidths)) {
    const w = lineWidths[Math.min(idx, lineWidths.length - 1)];
    return toLen(w) ?? "100%";
  }
  if (lineWidths !== undefined) return toLen(lineWidths) ?? "100%";
  // Default: last line shorter for realistic text feel
  return idx === lines - 1 ? "70%" : "100%";
}

// ---------- Main component ----------

export function Skeleton({
  as = "div",
  variant = "rect",
  width,
  height,
  radius = 8,
  lines = 3,
  lineGap = 8,
  lineHeight = 14,
  lineWidths,
  count = 1,
  animated = true,
  shimmerDurationMs = 1100,
  inline = false,
  className = "",
  style,
  "aria-label": ariaLabel,
}: SkeletonProps) {
  const Tag = as as any;
  const reduced = prefReducedMotion();
  const doAnimate = animated && !reduced;

  if (doAnimate) ensureKeyframes();

  // Common box style
  const commonBlock: CSSProperties = {
    display: inline ? "inline-block" : "block",
    borderRadius: toLen(radius),
    ...baseSurface(doAnimate, shimmerDurationMs),
  };

  function renderTextWrapper(key?: string) {
    const rows: ReactNode[] = [];
    const gap = toLen(lineGap);
    const h = toLen(lineHeight) ?? "14px";

    for (let i = 0; i < Math.max(1, lines); i++) {
      rows.push(
        <div
          key={`sk-line-${i}`}
          style={{
            ...commonBlock,
            height: h,
            width: resolveLineWidth(i, Math.max(1, lines), lineWidths),
            marginTop: i === 0 ? undefined : gap,
          }}
        />
      );
    }

    return (
      <Tag
        key={key}
        className={className}
        style={{
          ...style,
          display: inline ? "inline-flex" : "flex",
          flexDirection: "column",
        }}
        aria-busy="true"
        aria-live="polite"
        aria-label={ariaLabel}
      >
        {rows}
      </Tag>
    );
  }

  function renderBlock(key?: string) {
    let w = toLen(width);
    let h = toLen(height);
    let br = toLen(radius);

    if (variant === "circle" || variant === "avatar") {
      const fallback = variant === "avatar" ? "40px" : "32px";
      const size = w || h || fallback;
      w = size;
      h = size;
      br = "9999px";
    } else if (variant === "pill") {
      h = h || "10px";
      w = w || "100%";
      br = "9999px";
    } else if (variant === "rect") {
      w = w || "100%";
      h = h || "16px";
    }

    return (
      <Tag
        key={key}
        className={className}
        style={{
          ...commonBlock,
          width: w,
          height: h,
          borderRadius: br,
          ...style,
        }}
        aria-busy="true"
        aria-live="polite"
        aria-label={ariaLabel}
      />
    );
  }

  // Render multiple if count > 1
  if (count > 1) {
    const items: ReactNode[] = [];
    for (let i = 0; i < count; i++) {
      items.push(
        variant === "text" ? renderTextWrapper(`sk-${i}`) : renderBlock(`sk-${i}`)
      );
    }
    return <>{items}</>;
  }

  return variant === "text" ? renderTextWrapper() : renderBlock();
}

export default Skeleton;

/*
Usage:

// Rect block
<Skeleton width="100%" height={16} />

// Text (auto-last-line shorter)
<Skeleton variant="text" lines={4} lineGap={10} />

// Avatar circle
<Skeleton variant="avatar" width={48} />

// Pill bar
<Skeleton variant="pill" width="60%" height={10} />

// Inline dots (multiple circles)
<Skeleton variant="circle" width={10} height={10} count={5} inline style={{ marginRight: 6 }} />
*/
