const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
const ENGINE_KEY = import.meta.env.VITE_ENGINE_API_KEY ?? "";

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (ENGINE_KEY) headers.set("X-Engine-Key", ENGINE_KEY);
  headers.set("Content-Type", "application/json");

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

export function wsUrl(path: string): string {
  const base = API_BASE.replace(/^http/, "ws");
  const sep = path.includes("?") ? "&" : "?";
  return ENGINE_KEY ? `${base}${path}${sep}token=${ENGINE_KEY}` : `${base}${path}`;
}
