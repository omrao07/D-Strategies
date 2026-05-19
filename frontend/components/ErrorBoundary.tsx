import React, { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          style={{
            padding: 24,
            background: "#1e1e2e",
            border: "1px solid #ef4444",
            borderRadius: 8,
            color: "#f87171",
            fontFamily: "monospace",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Something went wrong</div>
          <pre style={{ fontSize: 12, whiteSpace: "pre-wrap", marginBottom: 12 }}>
            {this.state.error?.message}
          </pre>
          <button
            onClick={this.handleReset}
            style={{
              padding: "4px 12px",
              background: "#ef4444",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
