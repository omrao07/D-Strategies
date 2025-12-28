// routes/health.ts
// Health + readiness endpoints (pure Node, no imports)

export function healthRoutes(router: { get: (arg0: string, arg1: { (_req: any, res: { writeHead: (arg0: number, arg1: { "Content-Type": string; }) => void; end: (arg0: string) => void; }): void; (_req: any, res: any): void; (_req: any, res: any): void; }) => void; }) {
  // GET /health
  router.get("/health", (_req: any, res: { writeHead: (arg0: number, arg1: { "Content-Type": string; }) => void; end: (arg0: string) => void; }) => {
    const payload = JSON.stringify({ ok: true, ts: new Date().toISOString() });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(payload);
  });

  // GET /ready
  router.get("/ready", (_req, res) => {
    const payload = JSON.stringify({ ready: true });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(payload);
  });

  // GET /
  router.get("/", (_req, res) => {
    const payload = JSON.stringify({ name: "apps/api", version: 1 });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(payload);
  });
}