// primitives/emptystate.tsx
import type { FC, ReactNode, CSSProperties, ElementType } from "react";

export interface EmptyStateProps {
  icon?: ReactNode;             // Optional icon (emoji, SVG, etc.)
  title?: ReactNode;            // Main heading
  description?: ReactNode;      // Secondary text
  actions?: ReactNode;          // Buttons/links below
  className?: string;
  style?: CSSProperties;
  as?: ElementType;             // Container tag, default div
}

export const EmptyState: FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  actions,
  className = "",
  style,
  as: Tag = "div",
}) => {
  const styles: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    padding: "var(--space-10)",
    color: "var(--text-muted)",
    gap: "var(--space-4)",
    ...style,
  };

  return (
    <Tag className={className} style={styles}>
      {icon && <div style={{ fontSize: "48px", lineHeight: 1 }}>{icon}</div>}
      {title && (
        <h2
          style={{
            margin: 0,
            fontSize: "var(--text-xl)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--text)",
          }}
        >
          {title}
        </h2>
      )}
      {description && (
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-sm)",
            maxWidth: "40ch",
          }}
        >
          {description}
        </p>
      )}
      {actions && <div style={{ marginTop: "var(--space-4)" }}>{actions}</div>}
    </Tag>
  );
};

export default EmptyState;

// ---------- Example usage ----------
// <EmptyState
//   icon="📂"
//   title="No Files Found"
//   description="You don’t have any files here yet. Upload one to get started."
//   actions={<button style={{ padding: "8px 16px" }}>Upload File</button>}
// />
