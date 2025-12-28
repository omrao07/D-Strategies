export default function NotFoundPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <h1 className="text-5xl font-semibold mb-4">404</h1>
      <h2 className="text-xl font-medium mb-2">Page not found</h2>
      <p className="text-gray-600 mb-8 max-w-md">
        The page you are looking for does not exist, may have been moved, or is
        temporarily unavailable.
      </p>

      <a
        href="/"
        className="inline-flex items-center rounded-lg bg-black px-6 py-3 text-sm font-medium text-white hover:bg-gray-800 transition"
      >
        Go back home
      </a>
    </div>
  );
}