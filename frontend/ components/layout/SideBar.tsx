"use client";

import React, { useState } from "react";

export type SidebarLink = {
  label: string;
  href: string;
  icon?: React.ReactNode;
};

export type SidebarProps = {
  brand?: string;
  links?: SidebarLink[];
  footer?: React.ReactNode;
};

/* Inline SVG icons (zero dependencies) */
const MenuIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="3" y1="18" x2="21" y2="18" />
  </svg>
);

const HomeIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
    <path d="M3 9l9-7 9 7" />
    <path d="M9 22V12h6v10" />
  </svg>
);

const ChartIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
    <line x1="12" y1="20" x2="12" y2="10" />
    <line x1="18" y1="20" x2="18" y2="4" />
    <line x1="6" y1="20" x2="6" y2="14" />
  </svg>
);

const LayersIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 17 12 22 22 17" />
    <polyline points="2 12 12 17 22 12" />
  </svg>
);

const SettingsIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c0 .69.41 1.31 1.04 1.58.16.07.33.11.51.11H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const Sidebar: React.FC<SidebarProps> = ({
  brand = "My Project",
  links = [
    { label: "Dashboard", href: "/", icon: <HomeIcon className="h-4 w-4" /> },
    { label: "Strategies", href: "/strategies", icon: <LayersIcon className="h-4 w-4" /> },
    { label: "Analytics", href: "/analytics", icon: <ChartIcon className="h-4 w-4" /> },
    { label: "Settings", href: "/settings", icon: <SettingsIcon className="h-4 w-4" /> },
  ],
  footer,
}) => {
  const [open, setOpen] = useState(true);

  return (
    <div className="flex h-screen">
      <aside
        className={`${
          open ? "w-56" : "w-16"
        } flex flex-col border-r border-neutral-200 bg-white transition-all duration-300`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3">
          {open && <span className="text-lg font-bold">{brand}</span>}
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            className="rounded-md p-1 hover:bg-neutral-100"
            aria-label="Toggle sidebar"
          >
            <MenuIcon className="h-5 w-5 text-neutral-600" />
          </button>
        </div>

        {/* Links */}
        <nav className="flex-1 space-y-1 px-2">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-100"
            >
              {link.icon}
              {open && <span>{link.label}</span>}
            </a>
          ))}
        </nav>

        {/* Footer */}
        {footer && (
          <div className="border-t border-neutral-200 px-3 py-2 text-sm text-neutral-600">
            {footer}
          </div>
        )}
      </aside>

      <main className="flex-1 overflow-y-auto bg-neutral-50 p-6" />
    </div>
  );
};

export default Sidebar;