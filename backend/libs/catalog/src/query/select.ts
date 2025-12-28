/* ============================================================
   Catalog Query – Select
   ------------------------------------------------------------
   Purpose:
   - Select / filter catalog entities
   - Provide composable query helpers
   - No mutation, no side effects
   ============================================================ */

/* ============================ Types ============================ */

export type CatalogEntity = {
  id: string;
  kind: string;
  spec: Record<string, unknown>;
};

export type ResolvedCatalogEntity = CatalogEntity & {
  resolved?: {
    dependsOn: CatalogEntity[];
  };
};

export type EntityPredicate = (entity: CatalogEntity) => boolean;

/* ======================= Core Select ========================= */

/**
 * Select entities by predicate
 */
export function select(
  entities: CatalogEntity[],
  predicate: EntityPredicate
): CatalogEntity[] {
  const out: CatalogEntity[] = [];
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i]!;
    if (predicate(e)) out.push(e);
  }
  return out;
}

/* ===================== Common Predicates ===================== */

export function byId(id: string): EntityPredicate {
  return (e) => e.id === id;
}

export function byKind(kind: string): EntityPredicate {
  return (e) => e.kind === kind;
}

export function byKinds(kinds: string[]): EntityPredicate {
  const set = new Set(kinds);
  return (e) => set.has(e.kind);
}

export function byTag(tag: string): EntityPredicate {
  return (e) => {
    const tags = e.spec["tags"];
    if (!Array.isArray(tags)) return false;
    return tags.includes(tag);
  };
}

export function enabledOnly(): EntityPredicate {
  return (e) => {
    const v = e.spec["enabled"];
    return v !== false;
  };
}

/* ===================== Dependency Predicates ================= */

export function hasDependencies(): EntityPredicate {
  return (e) => {
    const deps = (e as ResolvedCatalogEntity).resolved?.dependsOn;
    return Array.isArray(deps) && deps.length > 0;
  };
}

export function dependsOn(id: string): EntityPredicate {
  return (e) => {
    const deps = (e as ResolvedCatalogEntity).resolved?.dependsOn;
    if (!Array.isArray(deps)) return false;
    for (let i = 0; i < deps.length; i++) {
      if (deps[i]!.id === id) return true;
    }
    return false;
  };
}

/* ===================== Composition =========================== */

export function and(
  ...predicates: EntityPredicate[]
): EntityPredicate {
  return (e) => {
    for (let i = 0; i < predicates.length; i++) {
      if (!predicates[i]!(e)) return false;
    }
    return true;
  };
}

export function or(
  ...predicates: EntityPredicate[]
): EntityPredicate {
  return (e) => {
    for (let i = 0; i < predicates.length; i++) {
      if (predicates[i]!(e)) return true;
    }
    return false;
  };
}

export function not(
  predicate: EntityPredicate
): EntityPredicate {
  return (e) => !predicate(e);
}

/* ===================== Convenience =========================== */

/**
 * Select entities by kind directly
 */
export function selectByKind(
  entities: CatalogEntity[],
  kind: string
): CatalogEntity[] {
  return select(entities, byKind(kind));
}

/**
 * Select enabled entities only
 */
export function selectEnabled(
  entities: CatalogEntity[]
): CatalogEntity[] {
  return select(entities, enabledOnly());
}