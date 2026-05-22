// frontend/pages/compliance.tsx
// Compliance & risk monitoring page — risk gates, F&O ban list, surveillance alerts.

import React, { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useTradingStore } from "@/store/useTradingStore";

// ---- Types ---------------------------------------------------------------

interface RiskKpi {
  gate?: string;
  label?: string;
  key?: string;
  ok: boolean;
  value?: number | string;
  limit?: number | string;
  reason?: string;
}

interface RiskKpisResponse {
  gates?: RiskKpi[];
  kpis?: RiskKpi[];
  data?: RiskKpi[];
}

interface ScenarioAlert {
  id?: string;
  scenario?: string;
  name?: string;
  severity?: "low" | "medium" | "high" | "critical";
  message?: string;
  ts?: number;
}

interface ScenariosResponse {
  scenarios?: ScenarioAlert[];
  alerts?: ScenarioAlert[];
  data?: ScenarioAlert[];
}

// ---- Helpers -------------------------------------------------------------

function severityColor(
  severity: string | undefined
): { bg: string; border: string; text: string } {
  switch (severity) {
    case "critical":
      return { bg: "#ef444415", border: "#ef4444", text: "#f87171" };
    case "high":
      return { bg: "#f9731615", border: "#f97316", text: "#fb923c" };
    case "medium":
      return { bg: "#f59e0b15", border: "#f59e0b", text: "#fbbf24" };
    default:
      return { bg: "#3b82f615", border: "#3b82f6", text: "#60a5fa" };
  }
}

function GateCard({
  gate,
  label,
  ok,
  reason,
  value,
  limit,
}: {
  gate?: string;
  label?: string;
  ok: boolean;
  reason?: string;
  value?: number | string;
  limit?: number | string;
}) {
  const name = label ?? gate ?? "Gate";
  return (
    <div
      style={{
        background: ok ? "#0f172a" : "#ef444410",
        border: `1px solid ${ok ? "#1e293b" : "#ef4444"}`,
        borderRadius: 8,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: ok ? "#4ade80" : "#ef4444",
            boxShadow: `0 0 6px ${ok ? "#4ade80" : "#ef4444"}`,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: ok ? "#94a3b8" : "#f87171",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          {name}
        </span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 10,
            fontWeight: 700,
            color: ok ? "#4ade80" : "#ef4444",
            background: ok ? "#4ade8015" : "#ef444415",
            border: `1px solid ${ok ? "#4ade80" : "#ef4444"}`,
            borderRadius: 4,
            padding: "1px 6px",
          }}
        >
          {ok ? "OK" : "BREACH"}
        </span>
      </div>

      {(value !== undefined || limit !== undefined) && (
        <div style={{ fontSize: 11, color: "#64748b" }}>
          {value !== undefined && <span>Value: {value} </span>}
          {limit !== undefined && <span>/ Limit: {limit}</span>}
        </div>
      )}

      {reason && (
        <div style={{ fontSize: 11, color: "#f87171", marginTop: 2 }}>
          {reason}
        </div>
      )}
    </div>
  );
}

// ---- Main Page -----------------------------------------------------------

export default function CompliancePage() {
  const [gates, setGates] = useState<RiskKpi[]>([]);
  const [alerts, setAlerts] = useState<ScenarioAlert[]>([]);
  const [loadingKpis, setLoadingKpis] = useState(false);
  const [loadingAlerts, setLoadingAlerts] = useState(false);
  const [kpiError, setKpiError] = useState<string | null>(null);
  const [alertError, setAlertError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // F&O ban from store
  const indiaStore = useTradingStore((s) => s.india);
  const storeRiskGates = useTradingStore((s) => s.riskGates);

  const loadKpis = useCallback(async () => {
    setLoadingKpis(true);
    setKpiError(null);
    try {
      const data = await apiFetch<RiskKpisResponse>("/api/risk/kpis");
      const arr: RiskKpi[] =
        data.gates ?? data.kpis ?? (Array.isArray(data.data) ? data.data : []);
      setGates(arr.length ? arr : storeRiskGates);
      setLastRefresh(new Date());
    } catch {
      // Fall back to store data on error
      setGates(storeRiskGates);
      setKpiError(null); // silently use store data
    } finally {
      setLoadingKpis(false);
    }
  }, [storeRiskGates]);

  const loadAlerts = useCallback(async () => {
    setLoadingAlerts(true);
    setAlertError(null);
    try {
      const data = await apiFetch<ScenariosResponse>("/api/risk/scenarios");
      const arr: ScenarioAlert[] =
        data.scenarios ??
        data.alerts ??
        (Array.isArray(data.data) ? data.data : []);
      setAlerts(arr);
    } catch (e) {
      setAlertError(
        e instanceof Error ? e.message : "Failed to load alerts"
      );
    } finally {
      setLoadingAlerts(false);
    }
  }, []);

  const refresh = useCallback(() => {
    loadKpis();
    loadAlerts();
  }, [loadKpis, loadAlerts]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  // Merge store gates if API returned nothing
  const displayGates: RiskKpi[] =
    gates.length > 0
      ? gates
      : storeRiskGates.map((g) => ({
          gate: g.gate,
          ok: g.ok,
          reason: g.reason,
        }));

  const breaches = displayGates.filter((g) => !g.ok);
  const foBanList = indiaStore.foBanList ?? [];

  return (
    <div
      style={{
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 24,
        color: "#e2e8f0",
        maxWidth: 1200,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div>
          <h1
            style={{
              fontSize: 20,
              fontWeight: 800,
              margin: 0,
              color: "#f8fafc",
            }}
          >
            Compliance & Risk
          </h1>
          <p style={{ fontSize: 12, color: "#64748b", margin: "4px 0 0" }}>
            {breaches.length > 0 ? (
              <span style={{ color: "#f87171" }}>
                {breaches.length} breach{breaches.length !== 1 ? "es" : ""}{" "}
                detected
              </span>
            ) : (
              <span style={{ color: "#4ade80" }}>All gates passing</span>
            )}
            {lastRefresh && (
              <span style={{ color: "#475569" }}>
                {" "}
                &mdash; refreshed {lastRefresh.toLocaleTimeString()}
              </span>
            )}
          </p>
        </div>

        <button
          onClick={refresh}
          disabled={loadingKpis || loadingAlerts}
          style={{
            marginLeft: "auto",
            background: "#1e293b",
            border: "1px solid #334155",
            borderRadius: 6,
            padding: "7px 16px",
            fontSize: 13,
            color: loadingKpis || loadingAlerts ? "#475569" : "#94a3b8",
            cursor:
              loadingKpis || loadingAlerts ? "not-allowed" : "pointer",
          }}
        >
          {loadingKpis || loadingAlerts ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Risk gates grid */}
      <section>
        <h2
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: "#475569",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            marginBottom: 12,
          }}
        >
          Risk Gates
        </h2>
        {kpiError && (
          <div
            style={{
              fontSize: 12,
              color: "#f87171",
              marginBottom: 8,
            }}
          >
            {kpiError}
          </div>
        )}
        {displayGates.length === 0 && !loadingKpis ? (
          <div style={{ fontSize: 13, color: "#475569" }}>
            No risk gate data available.
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 10,
            }}
          >
            {loadingKpis && displayGates.length === 0
              ? Array.from({ length: 11 }).map((_, i) => (
                  <div
                    key={i}
                    style={{
                      height: 72,
                      borderRadius: 8,
                      background: "#1e293b",
                      animation: "pulse 1.5s ease-in-out infinite",
                    }}
                  />
                ))
              : displayGates.map((g, i) => (
                  <GateCard
                    key={g.gate ?? g.label ?? g.key ?? i}
                    gate={g.gate ?? g.key}
                    label={g.label}
                    ok={g.ok}
                    reason={g.reason}
                    value={g.value}
                    limit={g.limit}
                  />
                ))}
          </div>
        )}
      </section>

      {/* F&O Ban list */}
      <section>
        <h2
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: "#475569",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            marginBottom: 12,
          }}
        >
          F&O Ban List
          {foBanList.length > 0 && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 11,
                color: "#f87171",
                background: "#ef444415",
                border: "1px solid #ef4444",
                borderRadius: 4,
                padding: "1px 6px",
              }}
            >
              {foBanList.length} banned
            </span>
          )}
        </h2>

        {foBanList.length === 0 ? (
          <div style={{ fontSize: 13, color: "#475569" }}>
            No F&O bans currently active.
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {foBanList.map((sym) => (
              <span
                key={sym}
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  background: "#ef444415",
                  border: "1px solid #ef4444",
                  borderRadius: 4,
                  padding: "4px 10px",
                  color: "#f87171",
                  fontFamily: "'Fira Code', monospace",
                }}
              >
                {sym}
              </span>
            ))}
          </div>
        )}
      </section>

      {/* Surveillance alerts */}
      <section>
        <h2
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: "#475569",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            marginBottom: 12,
          }}
        >
          Surveillance Alerts
        </h2>

        {alertError && (
          <div style={{ fontSize: 12, color: "#f87171", marginBottom: 8 }}>
            {alertError}
          </div>
        )}

        {loadingAlerts && alerts.length === 0 ? (
          <div style={{ fontSize: 13, color: "#475569" }}>Loading alerts…</div>
        ) : alerts.length === 0 ? (
          <div
            style={{
              background: "#0f172a",
              border: "1px solid #1e293b",
              borderRadius: 8,
              padding: "20px 16px",
              fontSize: 13,
              color: "#4ade80",
              textAlign: "center",
            }}
          >
            No active surveillance alerts.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {alerts.map((a, i) => {
              const colors = severityColor(a.severity);
              return (
                <div
                  key={a.id ?? i}
                  style={{
                    background: colors.bg,
                    border: `1px solid ${colors.border}`,
                    borderRadius: 8,
                    padding: "12px 16px",
                    display: "flex",
                    gap: 12,
                    alignItems: "flex-start",
                  }}
                >
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: colors.border,
                      flexShrink: 0,
                      marginTop: 4,
                    }}
                  />
                  <div style={{ flex: 1 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: colors.text,
                        marginBottom: 4,
                      }}
                    >
                      {a.scenario ?? a.name ?? "Alert"}
                      {a.severity && (
                        <span
                          style={{
                            marginLeft: 8,
                            fontSize: 10,
                            background: colors.bg,
                            border: `1px solid ${colors.border}`,
                            borderRadius: 3,
                            padding: "1px 5px",
                          }}
                        >
                          {a.severity.toUpperCase()}
                        </span>
                      )}
                    </div>
                    {a.message && (
                      <div style={{ fontSize: 12, color: "#94a3b8" }}>
                        {a.message}
                      </div>
                    )}
                    {a.ts && (
                      <div
                        style={{
                          fontSize: 11,
                          color: "#475569",
                          marginTop: 4,
                        }}
                      >
                        {new Date(a.ts).toLocaleTimeString()}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <style>{`@keyframes pulse{0%,100%{opacity:1;}50%{opacity:.4;}}`}</style>
    </div>
  );
}
