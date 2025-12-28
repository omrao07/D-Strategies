// primitives/spinner.tsx
// Zero-dependency Spinner primitive: ring & dots variants, accessible, theme-aware.
// Uses CSS variables when present (e.g., --primary / --text-muted).

import { JSX } from "react";

type ElementType = keyof JSX.IntrinsicElements | ((props: any) => any);
type ReactNode = any;
type CSSProperties = any;

export type SpinnerVariant = "ring" | "dots";

export interface SpinnerProps {
  as?: ElementType;           // wrapper element (default: span)
  variant?: SpinnerVariant;   // "ring" | "dots"
  size?: number;              // px size of spinner box
  thickness?: number;         // ring stroke width (px)
  tone?: "primary" | "neutral" | "success" | "warning" | "danger" | "info";
  durationMs?: number;        // animation speed
  label?: ReactNode;          // accessible label (screen-reader)
  inline?: boolean;           // inline-block vs block
  style?: CSSProperties;
  className?: string;
}

function ensureSpinnerStyles() {
  if (typeof document === "undefined") return;
  const ID = "spinner-keyframes-style";
  if (document.getElementById(ID)) return;
  const style = document.createElement("style");
  style.id = ID;
  style.textContent = `
@keyframes sp-rotate { 100% { transform: rotate(360deg); } }
@keyframes sp-dots { 0%, 80%, 100% { opacity: 0.2; } 40% { opacity: 1; } }
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}
`;
  document.head.appendChild(style);
}

function colorForTone(tone?: SpinnerProps["tone"]): string {
  switch (tone) {
    case "primary": return "var(--primary, #6366f1)";
    case "success": return "var(--success, #10b981)";
    case "warning": return "var(--warning, #f59e0b)";
    case "danger": return "var(--danger, #ef4444)";
    case "info": return "var(--info, #3b82f6)";
    default: return "var(--text-muted, #64748b)";
  }
}

export function Spinner({
  as = "span",
  variant = "ring",
  size = 20,
  thickness = 3,
  tone = "primary",
  durationMs = 900,
  label = "Loading",
  inline = true,
  style,
  className = "",
}: SpinnerProps) {
  ensureSpinnerStyles();
  const Tag = as as any;
  const color = colorForTone(tone);

  const box: CSSProperties = {
    display: inline ? "inline-flex" : "flex",
    alignItems: "center",
    justifyContent: "center",
    width: size,
    height: size,
    ...style,
  };

  if (variant === "dots") {
    // 3-dot fading loader
    const dotSize = Math.max(3, Math.round(size / 5));
    const gap = Math.max(2, Math.round(size / 10));
    const baseDot: CSSProperties = {
      width: dotSize,
      height: dotSize,
      borderRadius: "9999px",
      background: color,
      animation: `sp-dots ${durationMs}ms infinite ease-in-out`,
    };
    return (
      <Tag role="status" aria-live="polite" className={className} style={box}>
        <span className="sr-only">{label}</span>
        <div style={{ ...baseDot, animationDelay: "0ms" }} />
        <div style={{ ...baseDot, marginLeft: gap, animationDelay: `${durationMs / 6}ms` }} />
        <div style={{ ...baseDot, marginLeft: gap, animationDelay: `${durationMs / 3}ms` }} />
      </Tag>
    );
  }

  // Default: SVG ring spinner
  const r = (size - thickness) / 2;
  const c = size / 2;
  const track = "var(--border, rgba(100,116,139,0.25))";

  return (
    <Tag role="status" aria-live="polite" className={className} style={box}>
      <span className="sr-only">{label}</span>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{
          display: "block",
          transformOrigin: "50% 50%",
          animation: `sp-rotate ${durationMs}ms linear infinite`,
        }}
        aria-hidden="true"
      >
        <circle
          cx={c}
          cy={c}
          r={r}
          stroke={track}
          strokeWidth={thickness}
          fill="none"
        />
        <circle
          cx={c}
          cy={c}
          r={r}
          stroke={color}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={`${Math.PI * r * 0.9} ${Math.PI * r * 0.6}`}
          strokeDashoffset="0"
          fill="none"
        />
      </svg>
    </Tag>
  );
}

export default Spinner;

/*
Usage:

<Spinner />                                        // primary ring, 20px
<Spinner size={28} tone="success" />               // bigger, green
<Spinner variant="dots" size={24} tone="warning"/> // three dots
<Spinner as="div" inline={false} label="Fetching data" />
*/
// primitives/Spinner.tsx