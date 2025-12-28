import { useEffect, useState } from "react";

type Report = {
  id: string;
  title: string;
  category: string;
  publishedAt: string;
  summary: string;
};

export default function ReportsPage() {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchReports = async () => {
      try {
        const res = await fetch("/api/reports");
        if (!res.ok) {
          throw new Error("Failed to fetch reports");
        }
        const data: Report[] = await res.json();
        setReports(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    };

    fetchReports();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-lg">Loading reports…</p>
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
    <div className="max-w-5xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-semibold mb-8">Reports</h1>

      {reports.length === 0 ? (
        <p className="text-gray-600">No reports available.</p>
      ) : (
        <div className="space-y-6">
          {reports.map((report) => (
            <div
              key={report.id}
              className="border border-gray-200 rounded-lg p-6 hover:shadow-sm transition"
            >
              <h2 className="text-xl font-medium mb-1">{report.title}</h2>
              <div className="text-sm text-gray-500 mb-3">
                {report.category} ·{" "}
                {new Date(report.publishedAt).toLocaleDateString()}
              </div>
              <p className="text-gray-700 mb-4 line-clamp-3">
                {report.summary}
              </p>
              <a
                href={`/reports/${report.id}`}
                className="inline-block text-sm font-medium text-blue-600 hover:underline"
              >
                View report →
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}