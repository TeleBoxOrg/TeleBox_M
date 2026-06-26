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
