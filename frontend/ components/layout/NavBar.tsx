"use client";

import React, { useState } from "react";

type NavLink = {
  label: string;
  href: string;
};

type NavbarProps = {
  brand?: string;
  links?: NavLink[];
  right?: React.ReactNode;
};

/* Icons (inline SVG — zero dependencies) */
const MenuIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className={className}
  >
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="3" y1="18" x2="21" y2="18" />
  </svg>
);

const CloseIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className={className}
  >
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const Navbar: React.FC<NavbarProps> = ({
  brand = "My Project",
  links = [],
  right,
}) => {
  const [open, setOpen] = useState(false);

  return (
    <nav className="w-full border-b border-neutral-200 bg-white">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
        {/* Brand */}
        <div className="text-lg font-bold">{brand}</div>

        {/* Desktop links */}
        <div className="hidden gap-6 md:flex">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-sm text-neutral-600 hover:text-neutral-900"
            >
              {link.label}
            </a>
          ))}
        </div>

        {/* Right slot */}
        <div className="hidden md:block">{right}</div>

        {/* Mobile toggle */}
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="md:hidden"
          aria-label="Toggle menu"
        >
          {open ? (
            <CloseIcon className="h-6 w-6" />
          ) : (
            <MenuIcon className="h-6 w-6" />
          )}
        </button>
      </div>

      {/* Mobile menu */}
      {open && (
        <div className="border-t border-neutral-200 bg-white px-4 py-3 md:hidden">
          <div className="flex flex-col gap-3">
            {links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="text-sm text-neutral-600 hover:text-neutral-900"
                onClick={() => setOpen(false)}
              >
                {link.label}
              </a>
            ))}
            {right && <div className="mt-2">{right}</div>}
          </div>
        </div>
      )}
    </nav>
  );
};

export default Navbar;