/**
 * Shared utility functions for async operations.
 */

/**
 * Returns a promise that resolves after the specified number of milliseconds.
 * Used for rate-limiting, backoff delays, and polling intervals.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Race a promise against a wall-clock deadline.
 * Does NOT cancel the underlying work — pair with AbortSignal at call sites
 * when cancellation is required (teleproto RPC cancel is still limited).
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
        if (typeof timer.unref === "function") {
          timer.unref();
        }
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Safely parse a JSON string, returning undefined on failure.
 * Avoids the common pattern of empty catch blocks for JSON.parse.
 */
export function safeJsonParse<T = unknown>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  label: string;
}

/**
 * Retry a function with exponential backoff.
 * Retries on any error; the last error is thrown after maxRetries attempts.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const isLastAttempt = attempt === options.maxRetries;
      if (!isLastAttempt) {
        const delay = options.baseDelayMs * Math.pow(2, attempt - 1);
        console.warn(
          `[${options.label}] Attempt ${attempt}/${options.maxRetries} failed:`,
          err instanceof Error ? err.message : String(err),
          `— retrying in ${delay}ms...`
        );
        await sleep(delay);
      }
    }
  }
  throw lastError;
}
