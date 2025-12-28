/* ============================================================
   Catalog Loader – Resolver
   ------------------------------------------------------------
   Purpose:
   - Resolve inter-entity references
   - Validate existence of dependencies
   - Produce a fully linked catalog graph
   ============================================================ */

/* ============================ Types ============================ */

export type CatalogEntity = {
  id: string;
  kind: string;
  spec: Record<string, unknown>;
};

export type ResolvedCatalogEntity = CatalogEntity & {
  resolved: {
    dependsOn: CatalogEntity[];
  };
};

export type CatalogRegistryLike = {
  get(id: string): CatalogEntity | undefined;
  require(id: string): CatalogEntity;
  list(): CatalogEntity[];
};

/* ============================ Errors =========================== */

export class CatalogResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogResolveError";
  }
}

/* ============================ Resolver ========================= */

/**
 * Resolve references for all catalog entities
 */
export function resolveCatalog(
  registry: CatalogRegistryLike
): ResolvedCatalogEntity[] {
  const out: ResolvedCatalogEntity[] = [];

  for (const entity of registry.list()) {
    out.push(resolveEntity(entity, registry));
  }

  return out;
}

/* ------------------------- Internals -------------------------- */

/**
 * Resolve a single entity
 */
function resolveEntity(
  entity: CatalogEntity,
  registry: CatalogRegistryLike
): ResolvedCatalogEntity {
  const dependsOnIds = extractDependencies(entity);

  const dependsOn: CatalogEntity[] = [];
  for (const id of dependsOnIds) {
    const dep = registry.get(id);
    if (!dep) {
      throw new CatalogResolveError(
        `Entity '${entity.id}' depends on missing entity '${id}'`
      );
    }
    dependsOn.push(dep);
  }

  return {
    ...entity,
    resolved: { dependsOn },
  };
}

/**
 * Extract dependency IDs from entity spec
 *
 * Convention:
 * - spec.dependsOn?: string[]
 */
function extractDependencies(entity: CatalogEntity): string[] {
  const raw = entity.spec["dependsOn"];

  if (!raw) return [];

  if (!Array.isArray(raw)) {
    throw new CatalogResolveError(
      `Entity '${entity.id}' has invalid dependsOn (expected string[])`
    );
  }

  const ids: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !v) {
      throw new CatalogResolveError(
        `Entity '${entity.id}' has invalid dependency value`
      );
    }
    ids.push(v);
  }

  return ids;
}