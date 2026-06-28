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
