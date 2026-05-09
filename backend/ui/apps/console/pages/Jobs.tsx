import { useEffect, useState } from "react";

type Job = {
  id: string;
  title: string;
  department: string;
  location: string;
  type: string;
  description: string;
};

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchJobs = async () => {
      try {
        const res = await fetch("/api/jobs");
        if (!res.ok) {
          throw new Error("Failed to fetch jobs");
        }
        const data: Job[] = await res.json();
        setJobs(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    };

    fetchJobs();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-lg">Loading open positions…</p>
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
      <h1 className="text-3xl font-semibold mb-8">Careers</h1>

      {jobs.length === 0 ? (
        <p className="text-gray-600">No open positions at the moment.</p>
      ) : (
        <div className="space-y-6">
          {jobs.map((job) => (
            <div
              key={job.id}
              className="border border-gray-200 rounded-lg p-6 hover:shadow-sm transition"
            >
              <h2 className="text-xl font-medium mb-1">{job.title}</h2>
              <div className="text-sm text-gray-500 mb-3">
                {job.department} · {job.location} · {job.type}
              </div>
              <p className="text-gray-700 mb-4 line-clamp-3">
                {job.description}
              </p>
              <a
                href={`/jobs/${job.id}`}
                className="inline-block text-sm font-medium text-blue-600 hover:underline"
              >
                View details →
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}