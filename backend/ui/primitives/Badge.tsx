// primitives/badge.tsx
// Minimal, dependency-free Badge component with variants, sizes, and theme tokens.
// Drop-in React (TSX). Uses CSS variables from ui/tokens.ts for colors.

import type { FC, ReactNode } from "react";

export type BadgeVariant =
  | "solid"
  | "subtle"
  | "outline";

export type BadgeTone =
  | "neutral"
  | "primary"
  | "success"
  | "warning"
  | "danger"
  | "info";

export type BadgeSize = "sm" | "md" | "lg";

export interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  tone?: BadgeTone;
  size?: BadgeSize;
  className?: string;
  style?: React.CSSProperties;
  rounded?: boolean;
}

const toneVars: Record<BadgeTone, { bg: string; fg: string; border: string }> = {
  neutral: {
    bg: "var(--gray-200)",
    fg: "var(--text)",
    border: "var(--border)",
  },
  primary: {
    bg: "var(--primary)",
    fg: "var(--on-primary)",
    border: "var(--primary)",
  },
  success: {
    bg: "var(--success)",
    fg: "var(--on-success)",
    border: "var(--success)",
  },
  warning: {
    bg: "var(--warning)",
    fg: "var(--on-warning)",
    border: "var(--warning)",
  },
  danger: {
    bg: "var(--danger)",
    fg: "var(--on-danger)",
    border: "var(--danger)",
  },
  info: {
    bg: "var(--info)",
    fg: "var(--on-info)",
    border: "var(--info)",
  },
};

const sizeVars: Record<BadgeSize, { fontSize: string; padding: string }> = {
  sm: { fontSize: "var(--text-xs)", padding: "0 var(--space-1.5)" },
  md: { fontSize: "var(--text-sm)", padding: "0 var(--space-2)" },
  lg: { fontSize: "var(--text-md)", padding: "0 var(--space-2.5)" },
};

export const Badge: FC<BadgeProps> = ({
  children,
  variant = "subtle",
  tone = "neutral",
  size = "md",
  className = "",
  style,
  rounded = true,
}) => {
  const t = toneVars[tone];
  const s = sizeVars[size];

  let bg = "transparent";
  let fg = t.fg;
  let border = "transparent";

  if (variant === "solid") {
    bg = t.bg;
    fg = t.fg;
    border = t.bg;
  } else if (variant === "subtle") {
    bg = t.bg + "22"; // translucent background
    fg = t.border;
    border = "transparent";
  } else if (variant === "outline") {
    bg = "transparent";
    fg = t.border;
    border = t.border;
  }

  const styles: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: s.fontSize,
    fontWeight: 500,
    lineHeight: 1.2,
    padding: s.padding,
    borderRadius: rounded ? "9999px" : "var(--radius-sm)",
    background: bg,
    color: fg,
    border: `1px solid ${border}`,
    whiteSpace: "nowrap",
    ...style,
  };

  return (
    <span style={styles} className={className}>
      {children}
    </span>
  );
};

export default Badge;

// ---------- Example usage ----------
// <Badge tone="primary" variant="solid">New</Badge>
// <Badge tone="danger" variant="outline" size="sm">Error</Badge>
