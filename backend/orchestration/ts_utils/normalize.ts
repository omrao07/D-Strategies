// utils/normalize.ts

// Ensure a number is finite, else return 0
export function safeNumber(x: any): number {
  return Number.isFinite(x) ? Number(x) : 0;
}

// Normalize array values to [0, 1]
export function minMaxScale(arr: number[]): number[] {
  if (!arr.length) return [];
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  if (min === max) return arr.map(() => 0.5);
  return arr.map(v => (v - min) / (max - min));
}

// Standardize array values to mean = 0, std = 1
export function zScore(arr: number[]): number[] {
  if (!arr.length) return [];
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  const std = Math.sqrt(variance) || 1;
  return arr.map(v => (v - mean) / std);
}

// Normalize vector so that sum = 1
export function l1Normalize(arr: number[]): number[] {
  const sum = arr.reduce((a, b) => a + Math.abs(b), 0);
  if (sum === 0) return arr.map(() => 0);
  return arr.map(v => v / sum);
}

// Normalize vector to unit length (L2 norm)
export function l2Normalize(arr: number[]): number[] {
  const norm = Math.sqrt(arr.reduce((a, b) => a + b * b, 0));
  if (norm === 0) return arr.map(() => 0);
  return arr.map(v => v / norm);
}

// Clip values to range [min, max]
export function clip(arr: number[], min: number, max: number): number[] {
  return arr.map(v => Math.min(max, Math.max(min, v)));
}