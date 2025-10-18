// runtime/globalerrorboundary.tsx
// App-level Error Boundary (TypeScript, no deps).
// - Correct React typings (info is NOT optional in componentDidCatch)
// - Optional onError/onReset hooks
// - Pluggable fallback renderer; sensible default provided
// - Exposes a Root wrapper and a small hook for convenience

import React from "react";

/* --------------------------------- Types --------------------------------- */

export type ErrorDetails = { componentStack?: string };

export interface GlobalErrorBoundaryProps {
  /** Custom fallback UI. Receives the error, details, and a reset() fn. */
  fallback?: (args: {
    error: unknown;
    info: ErrorDetails;
    reset: () => void;
  }) => React.ReactNode;
  /** Called when an error is caught (client only). Safe-guarded. */
  onError?: (error: unknown, info: ErrorDetails) => void;
  /** Called when reset() is invoked (before state clears). */
  onReset?: () => void;
  /** Children to protect. */
  children: React.ReactNode;
  /** Optional id to identify this boundary in logs. */
  boundaryId?: string;
}

interface GlobalErrorBoundaryState {
  error: unknown | null;
  info: ErrorDetails;
  expanded: boolean;
}

/* --------------------------- Error Boundary --------------------------- */

export class GlobalErrorBoundary extends React.Component<
  GlobalErrorBoundaryProps,
  GlobalErrorBoundaryState
> {
  static displayName = "GlobalErrorBoundary";

  state: GlobalErrorBoundaryState = {
    error: null,
    info: {},
    expanded: false,
  };

  

  /** Reset the boundary (can also be called via ref). */
  reset = () => {
    try {
      this.props.onReset?.();
    } finally {
      this.setState({ error: null, info: {}, expanded: false });
    }
  };

  private toggle = () => this.setState((s) => ({ expanded: !s.expanded }));

  render() {
    const { children, fallback } = this.props;
    const { error, info, expanded } = this.state;

    if (!error) return children;

    if (typeof fallback === "function") {
      return <>{fallback({ error, info, reset: this.reset })}</>;
    }

    // Default fallback UI (minimal, accessible, dependency-free)
    const msg =
      error instanceof Error
        ? error.message
        : typeof error === "string"
        ? error
        : "Something went wrong.";

    return (
      <div role="alert" style={container} aria-live="assertive">
        <div style={card}>
          <div style={headerRow}>
            <span style={badge}>Error</span>
            <strong style={title}>Unexpected application error</strong>
          </div>

          <p style={muted}>{msg}</p>

          <div style={btnRow}>
            <button type="button" onClick={this.reset} style={btnPrimary}>
              Retry
            </button>
            <button type="button" onClick={this.toggle} style={btnGhost}>
              {expanded ? "Hide details" : "Show details"}
            </button>
          </div>

          {expanded && (
            <pre style={pre}>
              {formatError(error)}
              {info.componentStack ? `\n\nReact stack:\n${info.componentStack}` : ""}
            </pre>
          )}
        </div>
      </div>
    );
  }
}

/* ------------------------------ Convenience ------------------------------ */

export function GlobalErrorBoundaryRoot(
  props: Omit<GlobalErrorBoundaryProps, "children"> & { children: React.ReactNode }
) {
  return <GlobalErrorBoundary {...props} />;
}

/** Hook that returns a boundary component you can inline in FCs. */
export function useGlobalErrorBoundary(
  props?: Partial<GlobalErrorBoundaryProps>
) {
  return React.useMemo(
    () =>
      function Boundary({ children }: { children: React.ReactNode }) {
        return <GlobalErrorBoundary {...(props as any)}>{children}</GlobalErrorBoundary>;
      },
    // Only change when these identities change (keeps memo stable)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props?.fallback, props?.onError, props?.onReset, props?.boundaryId]
  );
}

/* --------------------------------- Styles -------------------------------- */

const container: React.CSSProperties = {
  display: "grid",
  placeItems: "center",
  minHeight: "40vh",
  padding: 16,
  background: "var(--bg,#fff)",
  color: "var(--text,#111827)",
};

const card: React.CSSProperties = {
  width: "min(720px, 100%)",
  background: "var(--surface,#fff)",
  border: "1px solid var(--border,#e5e7eb)",
  borderRadius: 12,
  padding: 16,
  boxShadow: "var(--shadow-sm,0 1px 2px rgba(0,0,0,0.06))",
};

const headerRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 6,
};

const badge: React.CSSProperties = {
  fontSize: 11,
  padding: "2px 6px",
  borderRadius: 999,
  color: "var(--danger,#ef4444)",
  background: "var(--danger-50,#fef2f2)",
  border: "1px solid var(--danger,#ef4444)",
};

const title: React.CSSProperties = { fontSize: 16 };

const muted: React.CSSProperties = { color: "var(--text-muted,#6b7280)" };

const btnRow: React.CSSProperties = { display: "flex", gap: 8, marginTop: 12 };

const btnBase: React.CSSProperties = {
  borderRadius: 10,
  padding: "8px 12px",
  cursor: "pointer",
  border: "1px solid var(--border,#e5e7eb)",
  background: "var(--bg,#fff)",
  color: "var(--text,#111827)",
  fontSize: 13,
};

const btnPrimary: React.CSSProperties = {
  ...btnBase,
  background: "var(--primary-50,#eef2ff)",
  color: "var(--primary,#6366f1)",
  borderColor: "var(--primary,#6366f1)",
  fontWeight: 600,
};

const btnGhost: React.CSSProperties = { ...btnBase, opacity: 0.95 };

const pre: React.CSSProperties = {
  marginTop: 12,
  whiteSpace: "pre-wrap",
  background: "var(--code-bg,#f8fafc)",
  borderRadius: 8,
  padding: 12,
  border: "1px solid var(--border,#e5e7eb)",
  fontSize: 12,
  overflow: "auto",
  maxHeight: 320,
};

/* -------------------------------- Utilities ------------------------------- */

function formatError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}\n${err.stack ?? ""}`.trim();
  try {
    return typeof err === "string" ? err : JSON.stringify(err, null, 2);
  } catch {
    return String(err);
  }
}

export default GlobalErrorBoundary;
