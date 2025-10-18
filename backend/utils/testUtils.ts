// utils/testutils.ts

// Compare two number arrays with tolerance
export function arraysClose(a: number[], b: number[], tol = 1e-6): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

// Generate random number array
export function randomArray(len: number, min = 0, max = 1): number[] {
  return Array.from({ length: len }, () => min + Math.random() * (max - min));
}

// Deep equality check (objects, arrays, primitives)
export function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(k => deepEqual(a[k], b[k]));
  }

  return false;
}

// Assert helper for testing
export function assert(condition: boolean, message = "Assertion failed"): void {
  if (!condition) {
    throw new Error(message);
  }
}

// Run test suite
export function runTests(tests: Record<string, () => void>): void {
  let passed = 0;
  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try {
      fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`✗ ${name}: ${err.message}`);
      failed++;
    }
  }
  console.log(`\nSummary: ${passed} passed, ${failed} failed`);
}