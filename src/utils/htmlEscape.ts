/**
 * Shared HTML escaping utility for Telegram Bot API HTML parse mode.
 *
 * Use this instead of defining a local `htmlEscape` in every plugin.
 * Import via:
 *   import { htmlEscape } from "@utils/htmlEscape";
 *
 * Escapes: & < > " '
 */

/** Escape special HTML characters for safe inclusion in Telegram HTML messages. */
export function htmlEscape(text: string | number | unknown): string {
  if (text === null || text === undefined) return "";
  return String(text).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
  }[m] || m));
}
