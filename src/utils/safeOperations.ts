/**
 * Shared utility functions for common type operations in plugins.
 */

/**
 * Safely convert a cron date result (which may have a toJSDate method) to a Date.
 * The cron library returns objects that may be Date-like with a toJSDate() method
 * (Luxon DateTime) or may already be a Date or a number.
 */
export function safeToJSDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (value && typeof value === 'object' && typeof (value as { toJSDate?: () => Date }).toJSDate === 'function') {
    return (value as { toJSDate: () => Date }).toJSDate();
  }
  return new Date(Number(value));
}
