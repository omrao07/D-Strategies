/**
 * Retry utilities with exponential backoff and jitter.
 */

export interface RetryOptions {
  retries?: number;          // max attempts (default 3)
  minDelayMs?: number;       // starting delay (default 100ms)
  maxDelayMs?: number;       // maximum delay (default 5s)
  factor?: number;           // backoff factor (default 2)
  jitter?: boolean;          // add random jitter (default true)
  onRetry?: (err: any, attempt: number) => void; // hook called on failure
}

export async function retry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const {
    retries = 3,
    minDelayMs = 100,
    maxDelayMs = 5000,
    factor = 2,
    jitter = true,
    onRetry,
  } = opts;

  let attempt = 0;
  let delay = minDelayMs;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > retries) throw err;

      if (onRetry) onRetry(err, attempt);

      let sleep = delay;
      if (jitter) {
        const rand = Math.random() + 0.5; // [0.5, 1.5)
        sleep = Math.min(maxDelayMs, delay * rand);
      }

      await new Promise(res => setTimeout(res, sleep));
      delay = Math.min(maxDelayMs, delay * factor);
    }
  }
}

/**
 * Simple circuit breaker wrapper.
 */
export function circuitBreaker<T>(
  fn: (...args: any[]) => Promise<T>,
  failureThreshold = 5,
  cooldownMs = 10_000
) {
  let failures = 0;
  let lastFailure = 0;

  return async (...args: any[]): Promise<T> => {
    const now = Date.now();
    if (failures >= failureThreshold && now - lastFailure < cooldownMs) {
      throw new Error("Circuit breaker: temporarily open");
    }

    try {
      const result = await fn(...args);
      failures = 0; // reset on success
      return result;
    } catch (err) {
      failures++;
      lastFailure = now;
      throw err;
    }
  };
}