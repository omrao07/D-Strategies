import React, { useEffect, useMemo, useState } from "react";

type Toggles = {
  ndvi: boolean;
  rain: boolean;
  era: boolean;
  fires: boolean;
  sar: boolean;
  crop: boolean;
};

type Props = {
  /** Initial center */
  lat?: number;
  lon?: number;
  /** Radius (km) around center */
  km?: number;
  /** YYYY-MM-DD (defaults to yesterday UTC) */
  date?: string;
  /** Show simple controls above the map */
  showControls?: boolean;
  /** Height of the iframe (css) */
  height?: string | number;
};

const yesterdayUTC = () => new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);

export default function GeeDashboard({
  lat = 29.37,
  lon = 48.03,
  km = 40,
  date = yesterdayUTC(),
  showControls = true,
  height = "75vh",
}: Props) {
  const [center, setCenter] = useState({ lat, lon, km });
  const [theDate, setTheDate] = useState(date);
  const [toggles, setToggles] = useState<Toggles>({
    ndvi: true,
    rain: true,
    era: true,
    fires: true,
    sar: true,
    crop: false,
  });
  const [geeUrl, setGeeUrl] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Build query string for /api/gee/url
  const query = useMemo(() => {
    const p = new URLSearchParams({
      lat: String(center.lat),
      lon: String(center.lon),
      km: String(center.km),
      date: theDate,
      ndvi: toggles.ndvi ? "1" : "0",
      rain: toggles.rain ? "1" : "0",
      era: toggles.era ? "1" : "0",
      fires: toggles.fires ? "1" : "0",
      sar: toggles.sar ? "1" : "0",
      crop: toggles.crop ? "1" : "0",
    });
    return p.toString();
  }, [center.lat, center.lon, center.km, theDate, toggles]);

  // Debounced fetch of GEE url whenever query changes
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);

    const timer = setTimeout(() => {
      fetch(`/api/gee/url?${query}`)
        .then((r) => r.json())
        .then((d) => {
          if (!alive) return;
          if (d?.ok && d?.url) setGeeUrl(d.url);
          else setErr(d?.error || "Failed to build GEE URL");
        })
        .catch((e) => alive && setErr(String(e)))
        .finally(() => alive && setLoading(false));
    }, 300); // debounce to avoid spamming while typing

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);

  const setNum = (s: (v: number) => void) => (e: React.ChangeEvent<HTMLInputElement>) =>
    s(Number(e.target.value));

  const controlGroup = (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))",
        gap: 12,
        alignItems: "end",
        marginBottom: 12,
      }}
    >
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span>Latitude</span>
        <input
          type="number"
          step="0.001"
          value={center.lat}
          onChange={setNum((v) => setCenter((c) => ({ ...c, lat: v })))}
        />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span>Longitude</span>
        <input
          type="number"
          step="0.001"
          value={center.lon}
          onChange={setNum((v) => setCenter((c) => ({ ...c, lon: v })))}
        />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span>Radius (km)</span>
        <input
          type="number"
          min={1}
          max={5000}
          value={center.km}
          onChange={setNum((v) => setCenter((c) => ({ ...c, km: v })))}
        />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span>Date (UTC)</span>
        <input type="date" value={theDate} onChange={(e) => setTheDate(e.target.value)} />
      </label>

      <fieldset style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {(
          [
            ["NDVI", "ndvi"],
            ["Rain", "rain"],
            ["ERA5", "era"],
            ["Fires", "fires"],
            ["SAR", "sar"],
            ["CropMask", "crop"],
          ] as const
        ).map(([label, key]) => (
          <label key={key} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={toggles[key]}
              onChange={(e) => setToggles((t) => ({ ...t, [key]: e.target.checked }))}
            />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
    </div>
  );

  return (
    <div style={{ width: "100%" }}>
      {showControls && controlGroup}

      {loading && <div style={{ padding: 8 }}>Building GEE view…</div>}
      {err && (
        <div style={{ padding: 8, color: "crimson" }}>
          Error: {err} — check backend `/api/gee/url`.
        </div>
      )}

      {geeUrl && (
        <iframe
          title="GEE Dashboard"
          src={geeUrl}
          style={{ width: "100%", height, border: 0, borderRadius: 8 }}
          allow="fullscreen; clipboard-read; clipboard-write"
        />
      )}
    </div>
  );
}