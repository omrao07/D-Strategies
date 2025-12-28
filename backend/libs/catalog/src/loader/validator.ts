/* ============================================================
   Catalog Loader – Validator
   ------------------------------------------------------------
   Purpose:
   - Validate parsed catalog entities
   - Enforce structural + semantic rules
   - Fail fast before registry / resolve
   ============================================================ */

/* ============================ Types ============================ */

export type CatalogEntity = {
  id: string;
  kind: string;
  spec: Record<string, unknown>;
};

export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

/* ============================ Errors =========================== */

export class CatalogValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Catalog validation failed (${issues.length} issue(s))`);
    this.name = "CatalogValidationError";
    this.issues = issues;
  }
}

/* ============================ Entry ============================ */

/**
 * Validate a list of catalog entities.
 * Throws CatalogValidationError on failure.
 */
export function validateCatalog(
  entities: CatalogEntity[]
): void {
  const errors: string[] = [];

  validateIds(entities, errors);
  validateKinds(entities, errors);
  validateSpecs(entities, errors);

  if (errors.length > 0) {
    throw new CatalogValidationError(errors);
  }
}

/**
 * Non-throwing validation (optional use)
 */
export function validateCatalogSafe(
  entities: CatalogEntity[]
): ValidationResult {
  const errors: string[] = [];

  try {
    validateIds(entities, errors);
    validateKinds(entities, errors);
    validateSpecs(entities, errors);
  } catch (err) {
    errors.push("Unexpected validation error");
  }

  return { valid: errors.length === 0, errors };
}

/* ============================ Rules ============================ */

function validateIds(
  entities: CatalogEntity[],
  errors: string[]
): void {
  const seen = new Set<string>();

  for (let i = 0; i < entities.length; i++) {
    const e = entities[i]!;

    if (!e.id || typeof e.id !== "string") {
      errors.push(`Entity at index ${i} is missing a valid id`);
      continue;
    }

    if (seen.has(e.id)) {
      errors.push(`Duplicate entity id detected: '${e.id}'`);
    } else {
      seen.add(e.id);
    }
  }
}

function validateKinds(
  entities: CatalogEntity[],
  errors: string[]
): void {
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i]!;

    if (!e.kind || typeof e.kind !== "string") {
      errors.push(
        `Entity '${e.id}' has invalid or missing kind`
      );
    }
  }
}

function validateSpecs(
  entities: CatalogEntity[],
  errors: string[]
): void {
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i]!;

    if (!isRecord(e.spec)) {
      errors.push(
        `Entity '${e.id}' has invalid spec (must be object)`
      );
      continue;
    }

    // Optional convention checks
    validateDependsOn(e, errors);
  }
}

/* ===================== Spec Conventions ====================== */

function validateDependsOn(
  entity: CatalogEntity,
  errors: string[]
): void {
  const raw = entity.spec["dependsOn"];
  if (raw == null) return;

  if (!Array.isArray(raw)) {
    errors.push(
      `Entity '${entity.id}' has invalid dependsOn (expected string[])`
    );
    return;
  }

  for (let i = 0; i < raw.length; i++) {
    if (typeof raw[i] !== "string" || !raw[i]) {
      errors.push(
        `Entity '${entity.id}' has invalid dependsOn entry at index ${i}`
      );
    }
  }
}

/* ============================ Utils ============================ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}