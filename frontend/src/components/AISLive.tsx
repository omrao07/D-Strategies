// frontend/src/components/AISlive.tsx
import React, { useEffect, useState } from "react";

type AISMessage = {
  mmsi: string;         // Ship ID
  lat: number;          // Latitude
  lon: number;          // Longitude
  sog?: number;         // Speed over ground
  cog?: number;         // Course over ground
  timestamp?: string;   // Timestamp
};

const AISlive: React.FC = () => {
  const [ships, setShips] = useState<AISMessage[]>([]);

  useEffect(() => {
    const eventSource = new EventSource("/api/ais/stream");

    eventSource.onmessage = (e) => {
      try {
        const data: AISMessage = JSON.parse(e.data);

        setShips((prev) => {
          // replace ship if already tracked, else add
          const idx = prev.findIndex((s) => s.mmsi === data.mmsi);
          if (idx !== -1) {
            const updated = [...prev];
            updated[idx] = data;
            return updated;
          }
          return [...prev, data];
        });
      } catch (err) {
        console.error("AIS parse error", err);
      }
    };

    eventSource.onerror = (err) => {
      console.error("AIS stream error", err);
      eventSource.close();
    };

    return () => eventSource.close();
  }, []);

  return (
    <div className="p-4">
      <h2 className="text-xl font-semibold mb-2">Live AIS Ship Tracking</h2>

      <div className="overflow-y-auto max-h-64 border rounded p-2">
        {ships.length === 0 && <p>No ships yet…</p>}
        {ships.map((s) => (
          <div key={s.mmsi} className="border-b py-1 text-sm">
            <strong>MMSI:</strong> {s.mmsi} | <strong>Lat:</strong>{" "}
            {s.lat.toFixed(3)}, <strong>Lon:</strong> {s.lon.toFixed(3)}{" "}
            | <strong>SOG:</strong> {s.sog ?? "-"} kn
          </div>
        ))}
      </div>

      <div className="mt-4">
        {/* Placeholder for a map — can integrate leaflet or mapbox */}
        <p className="text-gray-500 text-sm">
          (Map integration here: e.g. Leaflet/Mapbox for ship positions)
        </p>
      </div>
    </div>
  );
};

export default AISlive;