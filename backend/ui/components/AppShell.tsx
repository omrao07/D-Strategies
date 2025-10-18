// components/appshell.tsx
// Dependency-free AppShell layout primitive: sidebar + header + main content area.
// Provides flexible slots and responsive-friendly CSS variables.

import type { FC, ReactNode, CSSProperties } from "react";

export interface AppShellProps {
  sidebar?: ReactNode;          // Left sidebar content
  header?: ReactNode;           // Top header content
  footer?: ReactNode;           // Optional footer
  children?: ReactNode;         // Main content
  sidebarWidth?: number | string; // default "240px"
  headerHeight?: number | string; // default "56px"
  fixedHeader?: boolean;        // pin header
  fixedSidebar?: boolean;       // pin sidebar
  className?: string;
  style?: CSSProperties;
}

export const AppShell: FC<AppShellProps> = ({
  sidebar,
  header,
  footer,
  children,
  sidebarWidth = "240px",
  headerHeight = "56px",
  fixedHeader = true,
  fixedSidebar = true,
  className = "",
  style,
}) => {
  const layout: CSSProperties = {
    display: "grid",
    gridTemplateAreas: `
      "${sidebar ? "sidebar " : ""}${"header"}"
      "${sidebar ? "sidebar " : ""}main"
      "${sidebar ? "sidebar " : ""}${footer ? "footer" : "main"}"
    `,
    gridTemplateColumns: sidebar ? `${sidebarWidth} 1fr` : "1fr",
    gridTemplateRows: `${header ? headerHeight : "0px"} 1fr ${footer ? "auto" : "0px"}`,
    minHeight: "100vh",
    ...style,
  };

  const headerStyle: CSSProperties = {
    gridArea: "header",
    position: fixedHeader ? "sticky" : "relative",
    top: 0,
    zIndex: 10,
    height: headerHeight,
    background: "var(--surface, #fff)",
    borderBottom: "1px solid var(--border, #e5e7eb)",
    display: "flex",
    alignItems: "center",
    padding: "0 var(--space-4, 16px)",
  };

  const sidebarStyle: CSSProperties = {
    gridArea: "sidebar",
    position: fixedSidebar ? "sticky" : "relative",
    top: 0,
    alignSelf: "start",
    height: "100vh",
    background: "var(--surface, #fff)",
    borderRight: "1px solid var(--border, #e5e7eb)",
    padding: "var(--space-4, 16px)",
  };

  const mainStyle: CSSProperties = {
    gridArea: "main",
    padding: "var(--space-4, 16px)",
    background: "var(--background, #fafafa)",
  };

  const footerStyle: CSSProperties = {
    gridArea: "footer",
    borderTop: "1px solid var(--border, #e5e7eb)",
    padding: "var(--space-3, 12px) var(--space-4, 16px)",
    background: "var(--surface, #fff)",
    color: "var(--text-muted, #6b7280)",
  };

  return (
    <div style={layout} className={className}>
      {sidebar && <aside style={sidebarStyle}>{sidebar}</aside>}
      {header && <header style={headerStyle}>{header}</header>}
      <main style={mainStyle}>{children}</main>
      {footer && <footer style={footerStyle}>{footer}</footer>}
    </div>
  );
};

export default AppShell;

/*
Example:

<AppShell
  header={<div>My App</div>}
  sidebar={<nav>Sidebar nav</nav>}
  footer={<div>&copy; 2025</div>}
>
  <h1>Dashboard</h1>
  <p>Content goes here.</p>
</AppShell>
*/
