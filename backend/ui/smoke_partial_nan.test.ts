// smoke partial nan.test.ts
// Quick smoke tests to catch unexpected NaN values in arrays, objects, or number sets.
// Pure TS, no dependencies. Designed for unit tests or ad-hoc validation.

export type NaNCheckResult = {
  name: string;
  countNaN: number;
  total: number;
  ok: boolean;
  message: string;
};

/** Check an array of numbers for NaN. */
export function smokeArrayNaN(arr: readonly number[], name = "array"): NaNCheckResult {
  const total = arr.length;
  let count = 0;
  for (let i = 0; i < total; i++) {
    if (Number.isNaN(arr[i])) count++;
  }
  const ok = count === 0;
  return {
    name,
    countNaN: count,
    total,
    ok,
    message: ok
      ? `✅ [${name}] has no NaN values (length ${total}).`
      : `❌ [${name}] has ${count} NaN value(s) out of ${total}.`,
  };
}

/** Check an object with numeric values for NaN. */
export function smokeObjectNaN(obj: Record<string, any>, name = "object"): NaNCheckResult {
  const keys = Object.keys(obj);
  let count = 0;
  for (let i = 0; i < keys.length; i++) {
    const v = obj[keys[i]];
    if (typeof v === "number" && Number.isNaN(v)) count++;
  }
  const total = keys.length;
  const ok = count === 0;
  return {
    name,
    countNaN: count,
    total,
    ok,
    message: ok
      ? `✅ [${name}] has no NaN numeric values (keys ${total}).`
      : `❌ [${name}] has ${count} NaN numeric value(s) among ${total} keys.`,
  };
}

/** Check a Set of numbers for NaN. */
export function smokeSetNaN(set: ReadonlySet<number>, name = "set"): NaNCheckResult {
  let count = 0;
  set.forEach((v) => { if (Number.isNaN(v)) count++; });
  const total = set.size;
  const ok = count === 0;
  return {
    name,
    countNaN: count,
    total,
    ok,
    message: ok
      ? `✅ [${name}] has no NaN values (size ${total}).`
      : `❌ [${name}] has ${count} NaN value(s) out of ${total}.`,
  };
}

/** Run multiple NaN smoke checks and log them. */
export function runNaNSuite(results: NaNCheckResult[], log = true): { allOk: boolean; results: NaNCheckResult[] } {
  let allOk = true;
  for (let i = 0; i < results.length; i++) {
    if (!results[i].ok) allOk = false;
    if (log) console.log(results[i].message);
  }
  return { allOk, results };
}

// ---------- Example usage ----------
// const arr = [1, 2, NaN, 4];
// const obj = { a: 1, b: NaN, c: 3 };
// const set = new Set([1, 2, 3, NaN]);
//
// runNaNSuite([
//   smokeArrayNaN(arr, "arr"),
//   smokeObjectNaN(obj, "obj"),
//   smokeSetNaN(set, "set"),
// ]);
