// observability/sentry.ts
// Zero-dep wrapper around Sentry that safely no-ops if SDK isn't installed.
// No type imports from @sentry/* so TS won't complain in projects without it.

export type Level = "fatal" | "error" | "warning" | "log" | "info" | "debug";

// Minimal structural shape we actually use
type SdkLike = {
  init?: (opts: Record<string, unknown>) => void;
  withScope?: (fn: (scope: any) => void) => void;
  setUser?: (u: any) => void;
  setTags?: (t: Record<string, string>) => void;
  setExtras?: (e: Record<string, unknown>) => void;
  addBreadcrumb?: (b: any) => void;
  captureMessage?: (msg: string, level?: Level, cb?: any) => void;
  captureException?: (err: unknown, cb?: any) => void;
  flush?: (timeoutMs?: number) => Promise<boolean> | boolean;

  // tracing bits (best-effort)
  getCurrentHub?: () => { getScope?: () => { getSpan?: () => any } };
  startTransaction?: (opts: any) => any;
};

export type InitOptions = {
  dsn?: string;
  environment?: string;
  tracesSampleRate?: number;
  release?: string;
  debug?: boolean;
  enabled?: boolean;
  // passthrough
  [k: string]: unknown;
};

export interface SpanLike {
  setData?(k: string, v: unknown): void;
  setAttribute?(k: string, v: unknown): void;
  setStatus?(s: string): void;
  finish(): void;
}

let sdk: SdkLike | null = null;
let inited = false;

// small queue pre-init
type Pending =
  | { kind: "msg"; message: string; level?: Level; context?: Record<string, unknown> }
  | { kind: "err"; error: unknown; context?: Record<string, unknown> }
  | { kind: "crumb"; breadcrumb: { message?: string; category?: string; level?: Level; data?: any } };
const queue: Pending[] = [];
const enqueue = (p: Pending) => { if (queue.length < 50) queue.push(p); };

// Try to load either SDK at runtime (no type imports)
function detectSdk(): SdkLike | null {
  // Node first
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const m = require("@sentry/node");
    return m as SdkLike;
  } catch {}
  // Browser (bundlers can alias this)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const m = require("@sentry/browser");
    return m as SdkLike;
  } catch {}
  return null;
}

/* -------------------------------- init ---------------------------------- */

export function init(opts: InitOptions = {}): boolean {
  if (inited) return !!sdk;
  sdk = detectSdk();

  const enabled = opts.enabled ?? Boolean(opts.dsn);
  if (!sdk || !enabled) { inited = true; return false; }

  const common = {
    dsn: opts.dsn,
    environment: opts.environment ?? (typeof process !== "undefined" ? process.env?.NODE_ENV : "dev") ?? "dev",
    tracesSampleRate: opts.tracesSampleRate ?? 0,
    release: opts.release,
    debug: opts.debug ?? false,
    ...opts,
  };

  sdk.init?.(common);

  // drain queue
  for (const p of queue.splice(0)) {
    if (p.kind === "msg") captureMessage(p.message, p.level, p.context);
    else if (p.kind === "err") captureError(p.error, p.context);
    else addBreadcrumb(p.breadcrumb);
  }

  inited = true;
  return true;
}

export function isEnabled() { return !!sdk && inited; }

/* ---------------------------- scope utilities --------------------------- */

export function withScope<T>(fn: (scope: {
  setTag: (k: string, v: string) => void;
  setTags: (t: Record<string, string>) => void;
  setUser: (u: { id?: string; email?: string; username?: string; [k: string]: any } | null) => void;
  setExtra: (k: string, v: unknown) => void;
  setExtras: (e: Record<string, unknown>) => void;
}) => T): T | undefined {
  if (!sdk?.withScope) {
    return fn(noopScope());
  }
    let out: T;
}

export function setUser(u: { id?: string; email?: string; username?: string; [k: string]: any } | null) {
  sdk?.setUser?.(u);
}
export function setTags(t: Record<string, string>) { sdk?.setTags?.(t); }
export function setExtras(e: Record<string, unknown>) { sdk?.setExtras?.(e); }

export function addBreadcrumb(breadcrumb: {
  message?: string; category?: string; level?: Level; data?: any;
}) {
  if (!sdk) return enqueue({ kind: "crumb", breadcrumb });
  sdk.addBreadcrumb?.(breadcrumb);
}

/* ------------------------------ capture --------------------------------- */

export function captureMessage(message: string, level: Level = "info", context?: Record<string, unknown>) {
  if (!sdk?.captureMessage) return enqueue({ kind: "msg", message, level, context });
  sdk.captureMessage(message, level, scopeCallback(context));
}

export function captureError(error: unknown, context?: Record<string, unknown>) {
  if (!sdk?.captureException) return enqueue({ kind: "err", error, context });
  sdk.captureException(error, scopeCallback(context));
}

function scopeCallback(context?: Record<string, unknown>) {
  if (!context) return undefined;
  return (scope: any) => {
    for (const [k, v] of Object.entries(context)) scope.setExtra?.(k, v);
  };
}

/* ------------------------------ tracing --------------------------------- */

export function startSpan(name: string, data?: Record<string, unknown>): SpanLike | null {
  if (!sdk) return null;
  try {
    const parent = sdk.getCurrentHub?.()?.getScope?.()?.getSpan?.();
    // parent.startChild (node/browser), or startTransaction as fallback
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const span: any = parent?.startChild?.({ description: name }) || sdk.startTransaction?.({ name });
    if (!span) return null;
    if (data) {
      for (const [k, v] of Object.entries(data)) {
        span.setData?.(k, v);
        span.setAttribute?.(k, v);
      }
    }
    return span as SpanLike;
  } catch {
    return null;
  }
}

/* ------------------------------ wrappers -------------------------------- */

export function wrap<TArgs extends any[], TRes>(
  fn: (...a: TArgs) => TRes,
  name = fn.name || "wrapped"
) {
  return (...a: TArgs): TRes => {
    const span = startSpan(name);
    try {
      const res = fn(...a);
      if (res && typeof (res as any)?.then === "function") {
        return (res as any)
          .then((v: any) => { span?.finish(); return v; })
          .catch((e: any) => { captureError(e, { wrapper: name }); span?.finish(); throw e; });
      }
      span?.finish();
      return res;
    } catch (e) {
      captureError(e, { wrapper: name });
      span?.finish();
      throw e;
    }
  };
}

export function wrapAsync<TArgs extends any[], TRes>(
  fn: (...a: TArgs) => Promise<TRes>,
  name = fn.name || "wrappedAsync"
) {
  return async (...a: TArgs): Promise<TRes> => {
    const span = startSpan(name);
    try {
      const res = await fn(...a);
      span?.finish();
      return res;
    } catch (e) {
      captureError(e, { wrapper: name });
      span?.finish();
      throw e;
    }
  };
}

/* -------------------------------- flush --------------------------------- */

export async function flush(timeoutMs = 2000): Promise<boolean> {
  if (!sdk?.flush) return true;
  try {
    const ok = await sdk.flush(timeoutMs);
    return ok !== false;
  } catch {
    return false;
  }
}

/* -------------------------------- helpers -------------------------------- */

function noopScope() {
  return {
    setTag: () => void 0,
    setTags: () => void 0,
    setUser: () => void 0,
    setExtra: () => void 0,
    setExtras: () => void 0,
  };
}
function scopeApi(scope: any) {
  return {
    setTag: (k: string, v: string) => scope.setTag?.(k, v),
    setTags: (t: Record<string, string>) => scope.setTags?.(t),
    setUser: (u: any) => scope.setUser?.(u),
    setExtra: (k: string, v: unknown) => scope.setExtra?.(k, v),
    setExtras: (e: Record<string, unknown>) => scope.setExtras?.(e),
  };
}

export default {
  init,
  isEnabled,
  withScope,
  setUser,
  setTags,
  setExtras,
  addBreadcrumb,
  captureMessage,
  captureError,
  startSpan,
  wrap,
  wrapAsync,
  flush,
};
