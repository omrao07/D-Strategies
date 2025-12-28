export default function HomePage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="text-center max-w-xl">
        <h1 className="text-4xl font-semibold mb-4">
          Welcome
        </h1>
        <p className="text-gray-600 mb-8">
          This is the main entry point of the application.
        </p>

        <div className="flex items-center justify-center gap-4">
          <a
            href="/jobs"
            className="rounded-lg border border-gray-300 px-5 py-3 text-sm font-medium hover:bg-gray-50 transition"
          >
            Jobs
          </a>
          <a
            href="/reports"
            className="rounded-lg border border-gray-300 px-5 py-3 text-sm font-medium hover:bg-gray-50 transition"
          >
            Reports
          </a>
          <a
            href="/strategies"
            className="rounded-lg border border-gray-300 px-5 py-3 text-sm font-medium hover:bg-gray-50 transition"
          >
            Strategies
          </a>
        </div>
      </div>
    </div>
  );
}