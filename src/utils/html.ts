/**
 * Compatibility wrapper for @mtcute/html-parser.
 *
 * mtcute's `html` tagged template follows the HTML spec and collapses all
 * whitespace (including `\n`) into single spaces.  Teleproto's
 * `parseMode: "html"` preserved `\n` as line breaks, so after migration
 * every plugin that used `\n` inside template literals lost its newlines.
 *
 * `thtml` is the whitespace-preserving variant that ships with mtcute — it
 * keeps `\n` intact while still parsing HTML tags/entities normally.
 *
 * By mapping `@mtcute/html-parser` to this file via tsconfig paths, every
 * existing `import { html } from "@mtcute/html-parser"` automatically gets
 * the newline-preserving behaviour with zero plugin code changes.
 */
// Direct file import to bypass our own tsconfig path alias (avoid circular).
export { thtml as html, thtml } from "../../node_modules/@mtcute/html-parser/index.js";
