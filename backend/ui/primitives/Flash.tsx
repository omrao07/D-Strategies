// primitives/flash.tsx
import type { FC, ReactNode, CSSProperties } from "react";

export type FlashTone = "neutral" | "info" | "success" | "warning" | "danger";
export type FlashVariant = "solid" | "subtle" | "outline";

export interface FlashProps {
  tone?: FlashTone;
  variant?: FlashVariant;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  dismissible?: boolean;
  onDismiss?: () => void;
}

const toneColors: Record<FlashTone, { bg: string; fg: string; border: string }> = {
  neutral: {
    bg: "var(--gray-200)",
    fg: "var(--text)",
    border: "var(--border)",
  },
  info: {
    bg: "var(--info)",
    fg: "var(--on-info)",
    border: "var(--info)",
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
};

export const Flash: FC<FlashProps> = ({
  tone = "neutral",
  variant = "subtle",
  children,
  className = "",
  style,
  dismissible = false,
  onDismiss,
}) => {
  const t = toneColors[tone];

  let bg = "transparent";
  let fg = t.fg;
  let border = "transparent";

  if (variant === "solid") {
    bg = t.bg;
    fg = t.fg;
    border = t.bg;
  } else if (variant === "subtle") {
    bg = t.bg + "22"; // translucent
    fg = t.border;
    border = "transparent";
  } else if (variant === "outline") {
    bg = "transparent";
    fg = t.border;
    border = t.border;
  }

  const styles: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    fontSize: "var(--text-sm)",
    padding: "var(--space-2) var(--space-3)",
    borderRadius: "var(--radius-md)",
    background: bg,
    color: fg,
    border: `1px solid ${border}`,
    ...style,
  };

  return (
    <div className={className} style={styles} role="alert">
      <div style={{ flex: "1 1 auto" }}>{children}</div>
      {dismissible && (
        <button
          onClick={onDismiss}
          style={{
            border: "none",
            background: "transparent",
            color: fg,
            cursor: "pointer",
            fontSize: "16px",
            lineHeight: 1,
          }}
          aria-label="Dismiss"
        >
          ×
        </button>
      )}
    </div>
  );
};

export default Flash;

// ---------- Example usage ----------
// <Flash tone="success" variant="solid" dismissible onDismiss={() => alert("Closed!")}>
//   Successfully saved changes!
// </Flash>
