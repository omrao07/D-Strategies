// primitives/errorstate.tsx
import type { FC, ReactNode, CSSProperties, ElementType } from "react";

export interface ErrorStateProps {
  icon?: ReactNode;             // Error icon (emoji, SVG, etc.)
  title?: ReactNode;            // Headline
  description?: ReactNode;      // Message / explanation
  actions?: ReactNode;          // Recovery actions (button, link)
  className?: string;
  style?: CSSProperties;
  as?: ElementType;             // Container element type (default div)
}

export const ErrorState: FC<ErrorStateProps> = ({
  icon = "⚠️",
  title = "Something went wrong",
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
    gap: "var(--space-4)",
    color: "var(--danger)",
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
            color: "var(--danger)",
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
            color: "var(--text-muted)",
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

export default ErrorState;

// ---------- Example usage ----------
// <ErrorState
//   title="Network Error"
//   description="We couldn’t connect to the server. Please try again."
//   actions={<button style={{ padding: "8px 16px" }}>Retry</button>}
// />
