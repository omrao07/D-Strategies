/* ============================================================
   Catalog Loader – Registry
   ------------------------------------------------------------
   Purpose:
   - Hold validated catalog entities
   - Enforce uniqueness
   - Provide safe lookup & iteration
   ============================================================ */

/* ============================ Types ============================ */

export type CatalogEntity = {
  id: string;
  kind: string;
  spec: Record<string, unknown>;
};

export type CatalogRegistrySnapshot = {
  size: number;
  entities: CatalogEntity[];
};

/* ============================ Errors =========================== */

export class CatalogRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogRegistryError";
  }
}

/* ============================ Registry ========================= */

export class CatalogRegistry {
  private readonly byId: Map<string, CatalogEntity> = new Map();

  /* -------------------------- Mutations ----------------------- */

  /**
   * Register a single catalog entity
   */
  register(entity: CatalogEntity): void {
    if (!entity.id) {
      throw new CatalogRegistryError("Entity id is required");
    }

    if (this.byId.has(entity.id)) {
      throw new CatalogRegistryError(
        `Duplicate catalog entity id: ${entity.id}`
      );
    }

    this.byId.set(entity.id, entity);
  }

  /**
   * Register many entities at once
   */
  registerAll(entities: CatalogEntity[]): void {
    for (const entity of entities) {
      this.register(entity);
    }
  }

  /* --------------------------- Reads -------------------------- */

  /**
   * Get entity by id
   */
  get(id: string): CatalogEntity | undefined {
    return this.byId.get(id);
  }

  /**
   * Require entity by id (throws if missing)
   */
  require(id: string): CatalogEntity {
    const entity = this.byId.get(id);
    if (!entity) {
      throw new CatalogRegistryError(
        `Catalog entity not found: ${id}`
      );
    }
    return entity;
  }

  /**
   * Get all entities
   */
  list(): CatalogEntity[] {
    return Array.from(this.byId.values());
  }

  /**
   * Filter entities by kind
   */
  byKind(kind: string): CatalogEntity[] {
    const out: CatalogEntity[] = [];
    for (const entity of this.byId.values()) {
      if (entity.kind === kind) {
        out.push(entity);
      }
    }
    return out;
  }

  /**
   * Check existence
   */
  has(id: string): boolean {
    return this.byId.has(id);
  }

  /* -------------------------- Lifecycle ----------------------- */

  /**
   * Clear registry
   */
  clear(): void {
    this.byId.clear();
  }

  /**
   * Snapshot registry state
   */
  snapshot(): CatalogRegistrySnapshot {
    return {
      size: this.byId.size,
      entities: this.list(),
    };
  }
}

/* ========================== Factory ============================ */

/**
 * Convenience helper to build a registry from entities
 */
export function createCatalogRegistry(
  entities: CatalogEntity[]
): CatalogRegistry {
  const registry = new CatalogRegistry();
  registry.registerAll(entities);
  return registry;
}