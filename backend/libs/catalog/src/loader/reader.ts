/* ============================================================
   Catalog Loader – Reader
   ------------------------------------------------------------
   Purpose:
   - Read raw catalog input
   - Accept string or object
   - Safely parse JSON
   - Hand off to parser.ts
   ============================================================ */

/* ========================== Types ========================== */

export type CatalogInput = unknown;

/* ========================== Errors ========================= */

export class CatalogReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogReadError";
  }
}

/* ======================= Entry ============================ */

/**
 * Read catalog input into a raw object suitable for parsing
 */
export function readCatalog(input: CatalogInput): Record<string, unknown> {
  if (isRecord(input)) {
    return input;
  }

  if (typeof input === "string") {
    return readFromString(input);
  }

  throw new CatalogReadError(
    "Catalog input must be an object or a JSON string"
  );
}

/* ===================== String Handling ==================== */

function readFromString(text: string): Record<string, unknown> {
  const trimmed = text.trim();

  if (!trimmed) {
    throw new CatalogReadError("Catalog string is empty");
  }

  // JSON detection
  if (looksLikeJSON(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!isRecord(parsed)) {
        throw new CatalogReadError("JSON root must be an object");
      }
      return parsed;
    } catch (err) {
      throw new CatalogReadError(
        "Invalid JSON catalog input"
      );
    }
  }

  throw new CatalogReadError(
    "Unsupported catalog format (only JSON strings or objects are supported)"
  );
}

/* ===================== Utilities ========================== */

function looksLikeJSON(s: string): boolean {
  const c = s[0];
  return c === "{" || c === "[";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}