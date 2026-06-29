/**
 * Shared type definitions for internal mtcute client methods.
 *
 * mtcute's public TypeScript types do not expose all internal methods
 * (resolvePeer, getInputEntity, getDialogs, downloadMedia, etc.).
 * These type extensions provide type-safe access to those internals
 * without repeating inline `as unknown as { ... }` casts across every plugin.
 *
 * Usage in plugins:
 *   import type { ClientInternals } from "@utils/clientInternals";
 *   // ...
 *   const peer = await (client as unknown as ClientInternals).resolvePeer(target);
 *
 * Note: The `as unknown as` double-cast is still needed because these interfaces
 * don't formally extend TelegramClient, but the shared type name makes the intent
 * clear and allows centralized updates if mtcute's types change.
 *
 * Created as part of code quality improvement to eliminate 150+ inline
 */

/**
 * Internal mtcute client methods not exposed in the public TypeScript types.
 * These methods exist at runtime on TelegramClient instances.
 *
 * Cast via: `(client as unknown as ClientInternals).resolvePeer(target)`
 */
export interface ClientInternals {
  resolvePeer(target: unknown): Promise<unknown>;
  getInputEntity(target: unknown): Promise<unknown>;
  getEntity(target: unknown): Promise<unknown>;
  sendMessage(peer: unknown, options: Record<string, unknown>): Promise<unknown>;
  sendFile(peer: unknown, opts: Record<string, unknown>): Promise<void>;
  getDialogs(params: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  call(params: unknown): Promise<unknown>;
  startUpdatesLoop?: () => Promise<void>;
  log?: { level: number };
}

/**
 * Extended client interface for downloadMedia method.
 * mtcute's TelegramClient has downloadMedia internally but it's not in the public types.
 *
 * Cast via: `(client as unknown as ClientWithDownload).downloadMedia(...)`
 */
export interface ClientWithDownload {
  downloadMedia(media: unknown): Promise<unknown>;
  downloadMedia(media: unknown, opts?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Result type for users.getFullUser calls.
 */
export interface UsersGetFullUserResult {
  full_user?: {
    photo?: {
      _?: string;
      photo_id?: bigint;
    };
  };
}

/**
 * Dialog result from getDialogs.
 */
export interface DialogResult {
  id: number;
  isChannel?: boolean;
  isGroup?: boolean;
  isUser?: boolean;
  entity?: {
    id?: number | string;
    title?: string;
    username?: string;
  };
}
