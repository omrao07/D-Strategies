// middleware/json.ts
// Minimal JSON body parser middleware (no imports)

/* =========================
   Types
   ========================= */

type NextFunction = () => void | Promise<void>;

interface JsonRequest {
  method: string;
  headers: Record<string, unknown>;
  setEncoding(encoding: string): void;

  on(event: "data", listener: (chunk: string) => void): void;
  on(event: "end", listener: () => void): void;

  destroy(): void;
  body?: unknown;
}

interface JsonResponse {
  writeHead(statusCode: number, headers: Record<string, string>): void;
  end(body: string): void;
}

/* =========================
   Middleware
   ========================= */

export function json() {
  return (
    req: JsonRequest,
    res: JsonResponse,
    next: NextFunction
  ): void => {
    // Only parse JSON for POST / PUT / PATCH
    if (!["POST", "PUT", "PATCH"].includes(req.method)) {
      next();
      return;
    }

    const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
    if (!contentType.includes("application/json")) {
      next();
      return;
    }

    let data = "";

    req.setEncoding("utf8");

    req.on("data", (chunk) => {
      data += chunk;

      // Guard: max 1MB payload
      if (data.length > 1_000_000) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload too large" }));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!data) {
        req.body = {};
        next();
        return;
      }

      try {
        req.body = JSON.parse(data);
        next();
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
  };
}