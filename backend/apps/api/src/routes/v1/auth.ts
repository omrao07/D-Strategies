// routes/v1/auth.ts
// Demo auth endpoints (no imports, no deps)

/* =========================
   Types
   ========================= */

interface Request {
  body?: unknown;
  headers: Record<string, unknown>;
}

interface Response {
  writeHead(statusCode: number, headers: Record<string, string>): void;
  end(body: string): void;
}

type Handler = (req: Request, res: Response) => void;

interface Router {
  post(path: string, handler: Handler): void;
  get(path: string, handler: Handler): void;
}

/* =========================
   Routes
   ========================= */

export function v1AuthRoutes(router: Router): void {
  // POST /api/v1/auth/login
  router.post("/api/v1/auth/login", (req, res) => {
    const body = (req.body as Record<string, unknown>) || {};
    const email = typeof body.email === "string" ? body.email : "";

    if (!email) {
      const payload = JSON.stringify({ error: "email required" });
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(payload);
      return;
    }

    // Simple demo token (NOT secure)
    const token = Buffer.from(`${email}|${Date.now()}`).toString("base64");
    const payload = JSON.stringify({
      token,
      user: { email },
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(payload);
  });

  // POST /api/v1/auth/logout
  router.post("/api/v1/auth/logout", (_req, res) => {
    const payload = JSON.stringify({ ok: true });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(payload);
  });

  // GET /api/v1/auth/me
  router.get("/api/v1/auth/me", (req, res) => {
    const authHeader =
      typeof req.headers["authorization"] === "string"
        ? req.headers["authorization"]
        : "";

    const token = authHeader.replace(/^Bearer\s+/i, "");

    if (!token) {
      const payload = JSON.stringify({ error: "missing token" });
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(payload);
      return;
    }

    try {
      const decoded = Buffer.from(token, "base64").toString("utf8");
      const email = decoded.split("|")[0];

      if (!email) {
        throw new Error("invalid token");
      }

      const payload = JSON.stringify({
        user: { email },
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(payload);
    } catch {
      const payload = JSON.stringify({ error: "invalid token" });
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(payload);
    }
  });
}