// middleware/error.ts
// Global error-handling middleware (Node / HTTP compatible)

type NextFunction = () => Promise<void> | void;

interface HttpResponse {
  writeHead: (
    statusCode: number,
    headers: {
      "Content-Type": string;
      "Content-Length": string;
    }
  ) => void;
  end: (body: string) => void;
}

export function errorBoundary() {
  return async (
    _req: unknown,
    res: HttpResponse,
    next: NextFunction
  ): Promise<void> => {
    try {
      await next();
    } catch (err: unknown) {
      const id = Math.random().toString(36).slice(2, 10);

      let message = "Unknown error";
      let stack = "";

      if (err instanceof Error) {
        message = err.message;
        stack = err.stack ?? "";
      } else {
        message = String(err);
        stack = String(err);
      }

      // Log safely
      try {
        console.error(`[error:${id}] ${message}\n${stack}`);
      } catch {
        // ignore logging failures
      }

      // Safe JSON response
      const payload = JSON.stringify({
        error: "Internal Server Error",
        id,
      });

      res.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload).toString(),
      });

      res.end(payload);
    }
  };
}