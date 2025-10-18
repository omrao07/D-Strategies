// smokeemptysets.ts
// Simple "smoke test" helpers to ensure arrays, maps, and sets you expect to be populated
// are not accidentally empty. Designed for unit test or quick runtime checks.
// Zero dependencies, pure TypeScript.

export type SmokeResult = {
  name: string;
  ok: boolean;
  size: number;
  message: string;
};

/** Check a generic array for emptiness. */
export function smokeArray<T>(arr: readonly T[], name = "array"): SmokeResult {
  const size = arr.length;
  const ok = size > 0;
  return {
    name,
    ok,
    size,
    message: ok
      ? `✅ [${name}] has ${size} item(s).`
      : `❌ [${name}] is empty.`,
  };
}

/** Check a Set for emptiness. */
export function smokeSet<T>(set: ReadonlySet<T>, name = "set"): SmokeResult {
  const size = set.size;
  const ok = size > 0;
  return {
    name,
    ok,
    size,
    message: ok
      ? `✅ [${name}] has ${size} item(s).`
      : `❌ [${name}] is empty.`,
  };
}

/** Check a Map for emptiness. */
export function smokeMap<K, V>(map: ReadonlyMap<K, V>, name = "map"): SmokeResult {
  const size = map.size;
  const ok = size > 0;
  return {
    name,
    ok,
    size,
    message: ok
      ? `✅ [${name}] has ${size} entry(ies).`
      : `❌ [${name}] is empty.`,
  };
}

/** Run multiple smoke tests in a batch, logging results. */
export function runSmokeBatch(tests: SmokeResult[], log = true): { allOk: boolean; results: SmokeResult[] } {
  let allOk = true;
  for (let i = 0; i < tests.length; i++) {
    if (!tests[i].ok) allOk = false;
    if (log) console.log(tests[i].message);
  }
  return { allOk, results: tests };
}

/** One-liner to assert non-empty; throws if empty. */
export function assertNonEmpty<T>(arr: readonly T[], name = "array"): T[] {
  if (!arr.length) {
    throw new Error(`Smoke test failed: [${name}] is empty.`);
  }
  return arr as T[];
}

// ---------- Example usage ----------
// const users: string[] = [];
// const ids = new Set<number>([1,2,3]);
// const dict = new Map<string,string>();

// runSmokeBatch([
//   smokeArray(users, "users"),
//   smokeSet(ids, "ids"),
//   smokeMap(dict, "dict"),
// ]);

// assertNonEmpty(users, "users"); // will throw if empty
