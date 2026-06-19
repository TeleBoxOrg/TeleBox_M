/**
 * Type guards and helpers for mtcute entity types.
 * 
 * mtcute uses a different type system than gramjs. Instead of the TL `_` discriminator,
 * mtcute entities have a `type` property and helper methods like `isGroup`, `isChannel`, etc.
 * 
 * These helpers provide a bridge for code that needs to check entity types.
 */

import { Chat, User } from "@mtcute/node";

/**
 * Check if an entity is a User.
 * Replaces: `(entity as any)?._ === 'user'`
 */
export function isUser(entity: unknown): entity is User {
  return entity instanceof User || (entity as any)?.type === 'user';
}

/**
 * Check if an entity is a Chat (group/channel/supergroup).
 * Replaces: `(entity as any)?._ === 'chat'`
 */
export function isChat(entity: unknown): entity is Chat {
  return entity instanceof Chat || (entity as any)?.type === 'chat';
}

/**
 * Check if an entity is a Channel (broadcast channel).
 * Replaces: `(entity as any)?._ === 'channel' && !(entity as any).megagroup`
 */
export function isChannel(entity: unknown): boolean {
  if (!isChat(entity)) return false;
  // In mtcute, channels are Chat objects where raw._ is 'channel' and not a megagroup
  const raw = entity.raw as any;
  return raw?._ === 'channel' && !raw?.megagroup && !raw?.broadcast;
}

/**
 * Check if an entity is a Group (basic group).
 * Replaces: `(entity as any)?._ === 'chat'`
 */
export function isGroup(entity: unknown): boolean {
  if (!isChat(entity)) return false;
  return entity.isGroup;
}

/**
 * Check if an entity is a Supergroup (megagroup).
 * Replaces: `(entity as any)?._ === 'channel' && (entity as any).megagroup`
 */
export function isSupergroup(entity: unknown): boolean {
  if (!isChat(entity)) return false;
  return entity.isGroup;
}

/**
 * Get the entity type as a string for debugging/logging.
 */
export function getEntityType(entity: unknown): string {
  if (isUser(entity)) return 'user';
  if (isChat(entity)) {
    if (entity.isGroup) return 'group';
    const raw = entity.raw as any;
    if (raw?._ === 'channel') return 'channel';
    return 'chat';
  }
  return 'unknown';
}
