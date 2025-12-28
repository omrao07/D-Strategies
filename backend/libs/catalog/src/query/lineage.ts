/* ============================================================
   Catalog Query – Lineage
   ------------------------------------------------------------
   Purpose:
   - Query upstream & downstream lineage
   - Traverse resolved dependency graphs
   - Detect cycles safely
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

export type LineageGraph = Map<string, Set<string>>;

/* ============================ Errors =========================== */

export class CatalogLineageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogLineageError";
  }
}

/* ======================= Graph Builders ======================= */

/**
 * Build a dependency graph (A → B means A depends on B)
 */
export function buildLineageGraph(
  entities: ResolvedCatalogEntity[]
): LineageGraph {
  const graph: LineageGraph = new Map();

  for (const e of entities) {
    const deps = new Set<string>();
    for (const d of e.resolved.dependsOn) {
      deps.add(d.id);
    }
    graph.set(e.id, deps);
  }

  return graph;
}

/**
 * Build reverse lineage graph (B → A means A depends on B)
 */
export function buildReverseLineageGraph(
  entities: ResolvedCatalogEntity[]
): LineageGraph {
  const graph: LineageGraph = new Map();

  for (const e of entities) {
    if (!graph.has(e.id)) {
      graph.set(e.id, new Set());
    }

    for (const d of e.resolved.dependsOn) {
      let set = graph.get(d.id);
      if (!set) {
        set = new Set();
        graph.set(d.id, set);
      }
      set.add(e.id);
    }
  }

  return graph;
}

/* ======================= Lineage Queries ====================== */

/**
 * Get all upstream dependencies (recursive)
 */
export function upstream(
  graph: LineageGraph,
  startId: string
): string[] {
  return traverse(graph, startId);
}

/**
 * Get all downstream dependents (recursive)
 */
export function downstream(
  reverseGraph: LineageGraph,
  startId: string
): string[] {
  return traverse(reverseGraph, startId);
}

/* ====================== Cycle Detection ======================= */

/**
 * Detect cycles in a lineage graph
 */
export function detectCycles(
  graph: LineageGraph
): string[][] {
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function dfs(node: string, path: string[]): void {
    if (visiting.has(node)) {
      const idx = path.indexOf(node);
      if (idx >= 0) {
        cycles.push(path.slice(idx));
      }
      return;
    }

    if (visited.has(node)) return;

    visiting.add(node);
    path.push(node);

    const deps = graph.get(node);
    if (deps) {
      for (const d of deps) {
        dfs(d, path);
      }
    }

    visiting.delete(node);
    visited.add(node);
    path.pop();
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      dfs(node, []);
    }
  }

  return cycles;
}

/* ======================= Internals ============================ */

function traverse(
  graph: LineageGraph,
  startId: string
): string[] {
  if (!graph.has(startId)) {
    throw new CatalogLineageError(
      `Unknown entity id: ${startId}`
    );
  }

  const out: string[] = [];
  const seen = new Set<string>();

  function dfs(node: string): void {
    const next = graph.get(node);
    if (!next) return;

    for (const id of next) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
        dfs(id);
      }
    }
  }

  dfs(startId);
  return out;
}