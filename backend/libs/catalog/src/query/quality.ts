/* ============================================================
   Catalog Query – Quality
   ------------------------------------------------------------
   Purpose:
   - Evaluate catalog quality signals
   - Detect structural & semantic risks
   - Provide scoring + diagnostics
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

export type QualityIssue = {
  level: "info" | "warning" | "error";
  message: string;
  entityId?: string;
};

export type QualityReport = {
  score: number;            // 0–100
  issues: QualityIssue[];
  stats: {
    entities: number;
    isolated: number;
    roots: number;
    leaves: number;
    maxDepth: number;
    cycles: number;
  };
};

/* ======================= Entry Point ========================== */

/**
 * Evaluate overall catalog quality
 */
export function evaluateQuality(
  entities: ResolvedCatalogEntity[],
  graph: LineageGraph
): QualityReport {
  const issues: QualityIssue[] = [];

  const entityCount = entities.length;
  const isolated = countIsolated(graph);
  const roots = countRoots(graph);
  const leaves = countLeaves(graph);
  const maxDepth = computeMaxDepth(graph);
  const cycles = detectCycles(graph);

  /* -------------------- Heuristics -------------------- */

  if (cycles > 0) {
    issues.push({
      level: "error",
      message: `Detected ${cycles} dependency cycle(s)`
    });
  }

  if (isolated > 0) {
    issues.push({
      level: "warning",
      message: `${isolated} isolated entity(s) with no dependencies or dependents`
    });
  }

  if (roots === 0 && entityCount > 0) {
    issues.push({
      level: "warning",
      message: "No root entities detected (everything depends on something)"
    });
  }

  if (maxDepth > 10) {
    issues.push({
      level: "warning",
      message: `Deep dependency chain detected (depth=${maxDepth})`
    });
  }

  /* ---------------------- Scoring ---------------------- */

  let score = 100;

  score -= cycles * 25;
  score -= isolated * 2;
  score -= Math.max(0, maxDepth - 6) * 3;

  score = clamp(score, 0, 100);

  return {
    score,
    issues,
    stats: {
      entities: entityCount,
      isolated,
      roots,
      leaves,
      maxDepth,
      cycles
    }
  };
}

/* ======================= Metrics ============================= */

function countIsolated(graph: LineageGraph): number {
  let count = 0;
  for (const [id, deps] of graph.entries()) {
    if (deps.size === 0 && !hasIncoming(graph, id)) {
      count++;
    }
  }
  return count;
}

function countRoots(graph: LineageGraph): number {
  let count = 0;
  for (const id of graph.keys()) {
    if (!hasIncoming(graph, id)) {
      count++;
    }
  }
  return count;
}

function countLeaves(graph: LineageGraph): number {
  let count = 0;
  for (const deps of graph.values()) {
    if (deps.size === 0) count++;
  }
  return count;
}

function hasIncoming(
  graph: LineageGraph,
  target: string
): boolean {
  for (const deps of graph.values()) {
    if (deps.has(target)) return true;
  }
  return false;
}

/* ======================= Depth =============================== */

function computeMaxDepth(graph: LineageGraph): number {
  let max = 0;
  const visiting = new Set<string>();

  function dfs(node: string, depth: number): void {
    max = Math.max(max, depth);

    if (visiting.has(node)) return; // cycle-safe
    visiting.add(node);

    const deps = graph.get(node);
    if (deps) {
      for (const d of deps) {
        dfs(d, depth + 1);
      }
    }

    visiting.delete(node);
  }

  for (const node of graph.keys()) {
    dfs(node, 1);
  }

  return max;
}

/* ======================= Cycles ============================== */

function detectCycles(graph: LineageGraph): number {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  let cycles = 0;

  function dfs(node: string): void {
    if (visiting.has(node)) {
      cycles++;
      return;
    }
    if (visited.has(node)) return;

    visiting.add(node);
    const deps = graph.get(node);
    if (deps) {
      for (const d of deps) {
        dfs(d);
      }
    }
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  return cycles;
}

/* ======================= Utils =============================== */

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}