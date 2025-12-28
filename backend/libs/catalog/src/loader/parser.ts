/* ============================================================
   Catalog Loader – Parser
   ------------------------------------------------------------
   Purpose:
   - Validate and normalize raw catalog inputs
   - Safely parse unknown objects into typed catalog entities
   - No imports, strict-safe
   ============================================================ */

/* ========================== Types ========================== */

export type UnknownRecord = Record<string, unknown>;

export interface CatalogMeta {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  tags: string[];
}

export interface CatalogSource {
  name: string;
  type: string;
  provider?: string;
  symbols: string[];
  interval?: string;
  fields: string[];
}

export interface CatalogConfig {
  meta: CatalogMeta;
  sources: CatalogSource[];
  raw: UnknownRecord;
}

/* ========================== Errors ========================== */

export class CatalogParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogParseError";
  }
}

/* ====================== Entry Point ======================== */

/**
 * Parse a raw catalog object into a validated CatalogConfig
 */
export function parseCatalog(input: unknown): CatalogConfig {
  if (!isRecord(input)) {
    throw new CatalogParseError("Catalog input must be an object");
  }

  const meta = parseMeta(input);
  const sources = parseSources(input.sources);

  return {
    meta,
    sources,
    raw: input
  };
}

/* ===================== Meta Parsing ======================== */

function parseMeta(obj: UnknownRecord): CatalogMeta {
  const id = readString(obj, "id") ?? readString(obj, "name");
  if (!id) {
    throw new CatalogParseError("Catalog must have an id or name");
  }

  return {
    id,
    name: readString(obj, "name") ?? id,
    description: readString(obj, "description"),
    enabled: readBoolean(obj, "enabled", true),
    tags: readStringArray(obj, "tags")
  };
}

/* ==================== Source Parsing ======================= */

function parseSources(value: unknown): CatalogSource[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new CatalogParseError("sources must be an array");
  }

  const out: CatalogSource[] = [];

  for (let i = 0; i < value.length; i++) {
    const src = value[i];
    if (!isRecord(src)) {
      throw new CatalogParseError(`source[${i}] must be an object`);
    }

    const name = readString(src, "name");
    const type = readString(src, "type");

    if (!name || !type) {
      throw new CatalogParseError(`source[${i}] requires name and type`);
    }

    out.push({
      name,
      type,
      provider: readString(src, "provider"),
      symbols: readStringArray(src, "symbols"),
      interval: readString(src, "interval"),
      fields: readStringArray(src, "fields")
    });
  }

  return out;
}

/* ===================== Safe Readers ======================== */

function readString(
  obj: UnknownRecord,
  key: string
): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function readBoolean(
  obj: UnknownRecord,
  key: string,
  defaultValue: boolean
): boolean {
  const v = obj[key];
  if (typeof v === "boolean") return v;
  return defaultValue;
}

function readStringArray(
  obj: UnknownRecord,
  key: string
): string[] {
  const v = obj[key];
  if (!Array.isArray(v)) return [];

  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] === "string") {
      out.push(v[i] as string);
    }
  }
  return out;
}

/* ===================== Utilities =========================== */

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}