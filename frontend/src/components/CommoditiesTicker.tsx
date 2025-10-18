// frontend/src/components/CommoditiesTicker.tsx
import React, { useEffect, useState } from "react";

type Commodity = {
  symbol: string;
  price: number;
  timestamp?: string;
};

const CommoditiesTicker: React.FC = () => {
  const [commodities, setCommodities] = useState<Commodity[]>([]);
  const symbols = ["gold", "silver", "crudeoil", "naturalgas", "corn", "wheat"];

  useEffect(() => {
    async function fetchCommodities() {
      try {
        const data: Commodity[] = await Promise.all(
          symbols.map(async (sym) => {
            const res = await fetch(`/api/commodities/${sym}`);
            if (!res.ok) throw new Error(`Failed for ${sym}`);
            return res.json();
          })
        );
        setCommodities(data);
      } catch (err) {
        console.error("Commodity fetch error:", err);
      }
    }

    fetchCommodities();
    const interval = setInterval(fetchCommodities, 60_000); // refresh every 60s
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="w-full bg-black text-white py-2 overflow-hidden">
      <div className="flex animate-marquee whitespace-nowrap">
        {commodities.map((c) => (
          <div
            key={c.symbol}
            className="mx-6 text-sm flex items-center space-x-2"
          >
            <span className="font-semibold uppercase">{c.symbol}</span>
            <span>${c.price.toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default CommoditiesTicker;