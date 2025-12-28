// routes/v1/users.ts
// User CRUD routes (pure Node, no imports)

/* =========================
   Types
   ========================= */

interface User {
  id: string;
  email: string;
  name?: string;
  createdAt: string;
  updatedAt: string;
}

interface Request {
  body?: unknown;
  headers: Record<string, unknown>;
  params: Record<string, string>;
}

interface Response {
  writeHead(statusCode: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

type Handler = (req: Request, res: Response) => void;

interface Router {
  get(path: string, handler: Handler): void;
  post(path: string, handler: Handler): void;
  delete(path: string, handler: Handler): void;
}

/* =========================
   In-memory Store
   ========================= */

const users = new Map<string, User>();

/* =========================
   Helpers
   ========================= */

function makeUser(email: string, name?: string): User {
  const now = new Date().toISOString();

  return {
    id: Math.random().toString(36).slice(2, 10),
    email,
    name,
    createdAt: now,
    updatedAt: now,
  };
}

/* =========================
   Routes
   ========================= */

export function v1UserRoutes(router: Router): void {
  // GET /api/v1/users
  router.get("/api/v1/users", (_req, res) => {
    const payload = JSON.stringify(Array.from(users.values()));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(payload);
  });

  // POST /api/v1/users
  router.post("/api/v1/users", (req, res) => {
    const body = (req.body as Record<string, unknown>) || {};
    const email = typeof body.email === "string" ? body.email : "";
    const name = typeof body.name === "string" ? body.name : undefined;

    if (!email) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "email required" }));
      return;
    }

    // Check duplicate email
    for (const user of users.values()) {
      if (user.email === email) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "email exists" }));
        return;
      }
    }

    const user = makeUser(email, name);
    users.set(user.id, user);

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(user));
  });

  // GET /api/v1/users/:id
  router.get("/api/v1/users/:id", (req, res) => {
    const id = req.params.id;
    const user = users.get(id);

    if (!user) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "user not found" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(user));
  });

  // DELETE /api/v1/users/:id
  router.delete("/api/v1/users/:id", (req, res) => {
    const id = req.params.id;
    const ok = users.delete(id);

    if (!ok) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "user not found" }));
      return;
    }

    res.writeHead(204);
    res.end();
  });
}