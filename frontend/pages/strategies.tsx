// frontend/pages/strategies.tsx
// Strategies management page — list, search, filter, and toggle strategies.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";

// ---- Types ---------------------------------------------------------------

interface Strategy {
  name: string;
  region: string;
  tags: string[];
  signal_score: number;
  enabled: boolean;
  status?: string;
}

interface ApiStrategiesResponse {
  strategies?: Strategy[];
  data?: Strategy[];
}

// ---- Helpers -------------------------------------------------------------

function scoreColor(score: number): string {
  if (score > 0.3) return "#4ade80";
  if (score > 0.1) return "#86efac";
  if (score < -0.3) return "#f87171";
  if (score < -0.1) return "#fca5a5";
  return "#94a3b8";
}

function ScoreBadge({ score }: { score: number }) {
  const label = `${score >= 0 ? "+" : ""}${(score * 100).toFixed(1)}%`;
  return (
    <span
      style={{
        fontVariantNumeric: "tabular-nums",
        fontWeight: 700,
        fontSize: 13,
        color: scoreColor(score),
      }}
    >
      {label}
    </span>
  );
}

function SkeletonRow() {
  return (
    <tr>
      {[40, 16, 24, 10, 10].map((w, i) => (
        <td key={i} style={{ padding: "10px 14px" }}>
          <div
            style={{
              height: 14,
              borderRadius: 4,
              background: "#1e293b",
              width: `${w}%`,
              animation: "pulse 1.5s ease-in-out infinite",
            }}
          />
        </td>
      ))}
    </tr>
  );
}

// ---- Toggle Switch -------------------------------------------------------

function Toggle({
  enabled,
  onChange,
  disabled,
}: {
  enabled: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={() => !disabled && onChange(!enabled)}
      disabled={disabled}
      style={{
        width: 40,
        height: 22,
        borderRadius: 11,
        background: enabled ? "#6366f1" : "#1e293b",
        border: "1px solid " + (enabled ? "#6366f1" : "#334155"),
        position: "relative",
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 0.2s",
        flexShrink: 0,
      }}
      aria-label={enabled ? "Disable strategy" : "Enable strategy"}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: enabled ? 21 : 3,
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: "#e2e8f0",
          transition: "left 0.2s",
        }}
      />
    </button>
  );
}

// ---- Main Page -----------------------------------------------------------

export default function StrategiesPage() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [toggling, setToggling] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<ApiStrategiesResponse | Strategy[]>(
        "/api/strategies"
      );
      const arr: Strategy[] = Array.isArray(data)
        ? data
        : (data as ApiStrategiesResponse).strategies ??
          (data as ApiStrategiesResponse).data ??
          [];
      setStrategies(arr);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    strategies.forEach((s) => s.tags?.forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [strategies]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return strategies.filter((s) => {
      const nameMatch = !q || s.name.toLowerCase().includes(q);
      const tagMatch =
        !tagFilter || (s.tags ?? []).includes(tagFilter);
      return nameMatch && tagMatch;
    });
  }, [strategies, search, tagFilter]);

  const handleToggle = useCallback(
    async (name: string, enabled: boolean) => {
      setToggling((prev) => new Set(prev).add(name));
      // Optimistic update
      setStrategies((prev) =>
        prev.map((s) => (s.name === name ? { ...s, enabled } : s))
      );
      try {
        await apiFetch(`/api/strategy/${encodeURIComponent(name)}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled }),
        });
      } catch (e) {
        // Revert on error
        setStrategies((prev) =>
          prev.map((s) => (s.name === name ? { ...s, enabled: !enabled } : s))
        );
        setError(
          `Failed to update ${name}: ${e instanceof Error ? e.message : String(e)}`
        );
      } finally {
        setToggling((prev) => {
          const next = new Set(prev);
          next.delete(name);
          return next;
        });
      }
    },
    []
  );

  const enabledCount = strategies.filter((s) => s.enabled).length;

  return (
    <div
      style={{
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 20,
        color: "#e2e8f0",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1
            style={{ fontSize: 20, fontWeight: 800, margin: 0, color: "#f8fafc" }}
          >
            Strategies
          </h1>
          <p style={{ fontSize: 12, color: "#64748b", margin: "4px 0 0" }}>
            {enabledCount} of {strategies.length} enabled
          </p>
        </div>

        <div style={{ flex: 1, display: "flex", gap: 10, flexWrap: "wrap" }}>
          {/* Search */}
          <input
            type="text"
            placeholder="Search by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              background: "#0f172a",
              border: "1px solid #1e293b",
              borderRadius: 6,
              padding: "7px 12px",
              fontSize: 13,
              color: "#e2e8f0",
              width: 220,
            }}
          />

          {/* Tag filter */}
          <select
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            style={{
              background: "#0f172a",
              border: "1px solid #1e293b",
              borderRadius: 6,
              padding: "7px 12px",
              fontSize: 13,
              color: "#e2e8f0",
            }}
          >
            <option value="">All tags</option>
            {allTags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        {/* Refresh */}
        <button
          onClick={load}
          disabled={loading}
          style={{
            background: "#1e293b",
            border: "1px solid #334155",
            borderRadius: 6,
            padding: "7px 16px",
            fontSize: 13,
            color: loading ? "#475569" : "#94a3b8",
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div
          style={{
            background: "#ef444415",
            border: "1px solid #ef4444",
            borderRadius: 6,
            padding: "10px 14px",
            fontSize: 13,
            color: "#f87171",
          }}
        >
          {error}
        </div>
      )}

      {/* Table */}
      <div
        style={{
          background: "#0f172a",
          border: "1px solid #1e293b",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr
              style={{
                borderBottom: "1px solid #1e293b",
                background: "#020817",
              }}
            >
              {[
                "Name",
                "Region",
                "Tags",
                "Signal Score",
                "Status",
              ].map((h) => (
                <th
                  key={h}
                  style={{
                    padding: "10px 14px",
                    textAlign: "left",
                    fontSize: 11,
                    fontWeight: 700,
                    color: "#475569",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    whiteSpace: "nowrap",
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && strategies.length === 0
              ? Array.from({ length: 8 }).map((_, i) => (
                  <SkeletonRow key={i} />
                ))
              : filtered.map((s) => (
                  <tr
                    key={s.name}
                    style={{
                      borderBottom: "1px solid #0f172a",
                      background: "#0f172a",
                      transition: "background 0.1s",
                    }}
                    onMouseEnter={(e) =>
                      ((e.currentTarget as HTMLElement).style.background =
                        "#1e293b")
                    }
                    onMouseLeave={(e) =>
                      ((e.currentTarget as HTMLElement).style.background =
                        "#0f172a")
                    }
                  >
                    {/* Name */}
                    <td
                      style={{
                        padding: "10px 14px",
                        fontSize: 13,
                        fontWeight: 600,
                        color: "#e2e8f0",
                        fontFamily: "'Fira Code', monospace",
                        maxWidth: 320,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.name}
                    </td>

                    {/* Region */}
                    <td
                      style={{
                        padding: "10px 14px",
                        fontSize: 12,
                        color: "#64748b",
                      }}
                    >
                      {s.region || "—"}
                    </td>

                    {/* Tags */}
                    <td style={{ padding: "10px 14px" }}>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {(s.tags ?? []).slice(0, 4).map((tag) => (
                          <span
                            key={tag}
                            onClick={() =>
                              setTagFilter(tagFilter === tag ? "" : tag)
                            }
                            style={{
                              fontSize: 10,
                              fontWeight: 600,
                              background:
                                tagFilter === tag ? "#6366f120" : "#1e293b",
                              color:
                                tagFilter === tag ? "#818cf8" : "#64748b",
                              border:
                                "1px solid " +
                                (tagFilter === tag ? "#6366f1" : "#334155"),
                              borderRadius: 4,
                              padding: "2px 6px",
                              cursor: "pointer",
                              textTransform: "uppercase",
                              letterSpacing: "0.04em",
                            }}
                          >
                            {tag}
                          </span>
                        ))}
                        {(s.tags ?? []).length > 4 && (
                          <span
                            style={{
                              fontSize: 10,
                              color: "#475569",
                              padding: "2px 4px",
                            }}
                          >
                            +{s.tags.length - 4}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Score */}
                    <td style={{ padding: "10px 14px" }}>
                      <ScoreBadge score={s.signal_score ?? 0} />
                    </td>

                    {/* Toggle */}
                    <td style={{ padding: "10px 14px" }}>
                      <div
                        style={{ display: "flex", alignItems: "center", gap: 8 }}
                      >
                        <Toggle
                          enabled={s.enabled}
                          onChange={(v) => handleToggle(s.name, v)}
                          disabled={toggling.has(s.name)}
                        />
                        <span
                          style={{
                            fontSize: 11,
                            color: s.enabled ? "#4ade80" : "#475569",
                            fontWeight: 600,
                          }}
                        >
                          {toggling.has(s.name)
                            ? "…"
                            : s.enabled
                            ? "Enabled"
                            : "Disabled"}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}

            {!loading && filtered.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  style={{
                    padding: "32px 14px",
                    textAlign: "center",
                    fontSize: 13,
                    color: "#475569",
                  }}
                >
                  {search || tagFilter
                    ? "No strategies match your filter."
                    : "No strategies loaded."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <style>{`@keyframes pulse{0%,100%{opacity:1;}50%{opacity:.4;}}`}</style>
    </div>
  );
}
