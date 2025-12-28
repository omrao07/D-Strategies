// utils/router.ts
// Minimal router + middleware pipeline (pure Node, no imports)

export function compose(stack: { [x: string]: any; }) {
  return (req: any, res: any) => {
    let i = -1;
    const run = (idx: number) => {
      if (idx <= i) return;
      i = idx;
      const fn = stack[idx];
      if (!fn) return;
      return fn(req, res, () => run(idx + 1));
    };
    run(0);
  };
}

function toRegex(path: string) {
  const keys: any[] = [];
  const pat = path
    .replace(/\/+$/, "")
    .replace(/\/:([\w-]+)/g, (_m, k) => {
      keys.push(k);
      return "/([^/]+)";
    })
    .replace(/\*/g, ".*");
  return { pattern: new RegExp("^" + pat + "/?$"), keys };
}

export class Router {
  routes: any[];
  constructor() {
    this.routes = [];
  }

  get(path: any, h: any) { this.add("GET", path, h); }
  post(path: any, h: any) { this.add("POST", path, h); }
  put(path: any, h: any) { this.add("PUT", path, h); }
  patch(path: any, h: any) { this.add("PATCH", path, h); }
  delete(path: any, h: any) { this.add("DELETE", path, h); }
  any(path: any, h: any) { this.add("*", path, h); }

  handle() {
    return (req: { method: any; url: string | URL; path: string; query: { [k: string]: string; }; params: { [x: string]: string; }; }, res: any, next: () => any) => {
      const method = (req.method || "GET").toUpperCase();
      const url = new URL(req.url, "http://localhost");
      req.path = url.pathname;
      req.query = Object.fromEntries(url.searchParams.entries());
      req.params = {};

      for (const r of this.routes) {
        if (r.method !== "*" && r.method !== method) continue;
        const m = r.pattern.exec(req.path);
        if (!m) continue;
        req.params = {};
        r.keys.forEach((k: string | number, i: number) => (req.params[k] = decodeURIComponent(m[i + 1] || "")));
        return r.handler(req, res);
      }

      return next();
    };
  }

  add(method: string, path: string, handler: any) {
    const { pattern, keys } = toRegex(path);
    this.routes.push({ method, pattern, keys, handler });
  }
}