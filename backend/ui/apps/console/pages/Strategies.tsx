import { useEffect, useState } from "react";

type Strategy = {
  id: string;
  name: string;
  category: string;
  riskLevel: "Low" | "Medium" | "High";
  description: string;
};

export default function StrategiesPage() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStrategies = async () => {
      try {
        const res = await fetch("/api/strategies");
        if (!res.ok) {
          throw new Error("Failed to fetch strategies");
        }
        const data: Strategy[] = await res.json();
        setStrategies(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    };

    fetchStrategies();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-lg">Loading strategies…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-red-600">{error}</p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-semibold mb-8">Trading Strategies</h1>

      {strategies.length === 0 ? (
        <p className="text-gray-600">No strategies available.</p>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {strategies.map((strategy) => (
            <div
              key={strategy.id}
              className="border border-gray-200 rounded-lg p-6 hover:shadow-sm transition"
            >
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-lg font-medium">{strategy.name}</h2>
                <span
                  className={`text-xs px-2 py-1 rounded-full ${strategy.riskLevel === "Low"
                      ? "bg-green-100 text-green-700"
                      : strategy.riskLevel === "Medium"
                        ? "bg-yellow-100 text-yellow-700"
                        : "bg-red-100 text-red-700"
                    }`}
                >
                  {strategy.riskLevel}
                </span>
              </div>

              <p className="text-sm text-gray-500 mb-2">
                {strategy.category}
              </p>

              <p className="text-gray-700 text-sm mb-4 line-clamp-4">
                {strategy.description}
              </p>

              <a
                href={`/strategies/${strategy.id}`}
                className="text-sm font-medium text-blue-600 hover:underline"
              >
                View strategy →
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}