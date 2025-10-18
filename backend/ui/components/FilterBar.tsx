// components/filterbar.tsx
// Lightweight, dependency-free FilterBar with composable subcomponents.
// - Works with your CSS tokens (var(--surface), --border, --text, etc.)
// - Includes Search, Chip, Select, Button, Divider, Spacer
// - Fully controlled props, no internal state required

import type { CSSProperties, ReactNode, ChangeEvent } from "react";

/* ------------------------------- Container -------------------------------- */

export interface FilterBarProps {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  dense?: boolean;              // tighter spacing
  sticky?: boolean;             // stick to top
  zIndex?: number;              // when sticky
  border?: boolean;             // show bottom border
  rounded?: boolean;            // rounded corners
  gap?: number;                 // horizontal gap between items (px)
}

export function FilterBar({
  children,
  className = "",
  style,
  dense = false,
  sticky = false,
  zIndex = 20,
  border = true,
  rounded = true,
  gap = 8,
}: FilterBarProps) {
  const padY = dense ? 6 : 10;
  const padX = dense ? 8 : 12;

  const box: CSSProperties = {
    position: sticky ? "sticky" : "relative",
    top: 0,
    zIndex,
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap,
    padding: `${padY}px ${padX}px`,
    background: "var(--surface, #fff)",
    color: "var(--text, #111827)",
    borderBottom: border ? "1px solid var(--border, #e5e7eb)" : "none",
    borderRadius: rounded ? "12px" : 0,
    boxShadow: "var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.06))",
    ...style,
  };

  return (
    <div className={className} style={box} role="region" aria-label="Filters">
      {children}
    </div>
  );
}

/* --------------------------------- Search --------------------------------- */

export interface FilterSearchProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  width?: number | string;     // e.g., 220 | "280px" | "min(40ch, 100%)"
  className?: string;
  style?: CSSProperties;
  clearable?: boolean;
  onClear?: () => void;
}

export function FilterSearch({
  value,
  onChange,
  placeholder = "Search…",
  width = 240,
  className = "",
  style,
  clearable = true,
  onClear,
}: FilterSearchProps) {
  const w = typeof width === "number" ? `${width}px` : width;
  return (
    <div
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        width: w,
        background: "var(--bg, #ffffff)",
        border: "1px solid var(--border, #e5e7eb)",
        borderRadius: "10px",
        padding: "6px 10px",
        ...style,
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 14, opacity: 0.75 }}>🔎</span>
      <input
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          flex: "1 1 auto",
          background: "transparent",
          border: "none",
          outline: "none",
          color: "inherit",
          fontSize: 14,
        }}
        aria-label="Search"
      />
      {clearable && value && (
        <button
          type="button"
          onClick={() => (onClear ? onClear() : onChange(""))}
          aria-label="Clear search"
          style={iconBtn}
        >
          ✕
        </button>
      )}
    </div>
  );
}

/* ---------------------------------- Chip ---------------------------------- */

export interface FilterChipProps {
  label: ReactNode;
  onRemove?: () => void;       // makes chip dismissible
  active?: boolean;
  className?: string;
  style?: CSSProperties;
  leading?: ReactNode;         // optional icon/element before label
}

export function FilterChip({
  label,
  onRemove,
  active = true,
  className = "",
  style,
  leading,
}: FilterChipProps) {
  const bg = active ? "var(--brand-100, #e0e7ff)" : "var(--gray-100, #f3f4f6)";
  const fg = active ? "var(--brand-700, #4338ca)" : "var(--text, #111827)";
  const bd = active ? "var(--brand-200, #c7d2fe)" : "var(--border, #e5e7eb)";

  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 8px",
        fontSize: 12,
        borderRadius: 9999,
        background: bg,
        color: fg,
        border: `1px solid ${bd}`,
        ...style,
      }}
    >
      {leading ? <span aria-hidden="true">{leading}</span> : null}
      <span>{label}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove filter"
          style={{ ...iconBtn, color: fg }}
        >
          ✕
        </button>
      )}
    </span>
  );
}

/* --------------------------------- Select --------------------------------- */

export interface FilterSelectOption<T = string> {
  value: T;
  label: string;
}

export interface FilterSelectProps<T = string> {
  label?: string;                 // visible label to the left
  value: T;
  onChange: (v: T) => void;
  options: FilterSelectOption<T>[];
  placeholder?: string;
  width?: number | string;
  className?: string;
  style?: CSSProperties;
}

export function FilterSelect<T = string>({
  label,
  value,
  onChange,
  options,
  placeholder = "Select…",
  width = 180,
  className = "",
  style,
}: FilterSelectProps<T>) {
  const w = typeof width === "number" ? `${width}px` : width;
  return (
    <label
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: 8, ...style }}
    >
      {label && <span style={{ fontSize: 12, color: "var(--text-muted, #6b7280)" }}>{label}</span>}
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          background: "var(--bg, #fff)",
          border: "1px solid var(--border, #e5e7eb)",
          borderRadius: 10,
          padding: "6px 10px",
          width: w,
          gap: 8,
        }}
      >
        <select
          value={value as any}
          onChange={(e) => onChange(e.target.value as unknown as T)}
          style={{
            flex: "1 1 auto",
            border: "none",
            outline: "none",
            background: "transparent",
            fontSize: 14,
            color: "var(--text, #111827)",
            WebkitAppearance: "none",
            MozAppearance: "none",
            appearance: "none",
          }}
          aria-label={typeof label === "string" ? label : "Filter select"}
        >
          {!value && <option value="">{placeholder}</option>}
          {options.map((o) => (
            <option key={String(o.value)} value={o.value as any}>
              {o.label}
            </option>
          ))}
        </select>
        <span aria-hidden="true" style={{ fontSize: 12, opacity: 0.6 }}>▾</span>
      </div>
    </label>
  );
}

/* --------------------------------- Button --------------------------------- */

export interface FilterButtonProps {
  children: ReactNode;
  onClick?: () => void;
  tone?: "neutral" | "primary";
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
}

export function FilterButton({
  children,
  onClick,
  tone = "neutral",
  className = "",
  style,
  disabled,
}: FilterButtonProps) {
  const isPrimary = tone === "primary";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={className}
      style={{
        padding: "6px 10px",
        fontSize: 13,
        borderRadius: 10,
        cursor: disabled ? "not-allowed" : "pointer",
        background: isPrimary ? "var(--primary, #6366f1)" : "transparent",
        color: isPrimary ? "var(--on-primary, #fff)" : "var(--text, #111827)",
        border: isPrimary ? "1px solid var(--primary, #6366f1)" : "1px solid var(--border, #e5e7eb)",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/* ----------------------------- Divider & Spacer ---------------------------- */

export function FilterDivider({ vertical = false }: { vertical?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: vertical ? "inline-block" : "block",
        width: vertical ? 1 : "100%",
        height: vertical ? 20 : 1,
        background: "var(--border, #e5e7eb)",
        margin: vertical ? "0 4px" : "6px 0",
      }}
    />
  );
}

export function FilterSpacer({ grow = 1 }: { grow?: number }) {
  return <span style={{ flexGrow: grow, minWidth: 8 }} />;
}

/* --------------------------------- Styles --------------------------------- */

const iconBtn: CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
  color: "var(--text-muted, #6b7280)",
};

/* --------------------------------- Examples --------------------------------
<FilterBar sticky rounded>
  <FilterSearch value={query} onChange={setQuery} onClear={() => setQuery("")} />
  <FilterSelect
    label="Status"
    value={status}
    onChange={setStatus}
    options={[{ value: "", label: "All" }, { value: "open", label: "Open" }, { value: "closed", label: "Closed" }]}
  />
  <FilterChip label="Assignee: You" onRemove={() => removeAssignee()} />
  <FilterSpacer />
  <FilterButton onClick={reset}>Reset</FilterButton>
  <FilterButton tone="primary" onClick={apply}>Apply</FilterButton>
</FilterBar>
---------------------------------------------------------------------------- */
