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
  return entity instanceof User || (entity as { type?: string } | null)?.type === 'user';
}

/**
 * Check if an entity is a Chat (group/channel/supergroup).
 * Replaces: `(entity as any)?._ === 'chat'`
 */
export function isChat(entity: unknown): entity is Chat {
  return entity instanceof Chat || (entity as { type?: string } | null)?.type === 'chat';
}

/**
 * Check if an entity is a Channel (broadcast channel).
 * Replaces: `(entity as any)?._ === 'channel' && !(entity as any).megagroup`
 */
export function isChannel(entity: unknown): boolean {
  if (!isChat(entity)) return false;
  // In mtcute, channels are Chat objects where raw._ is 'channel' and not a megagroup
  const raw = entity.raw as { _?: string; megagroup?: boolean; broadcast?: boolean };
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
    const raw = entity.raw as { _?: string };
    if (raw?._ === 'channel') return 'channel';
    return 'chat';
  }
  return 'unknown';
}

/**
 * Get the raw TL `_` discriminator from any object.
 * Replaces: `(obj as any)._` or `(obj as any)?._`
 */
export function getRawType(obj: unknown): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const raw = (obj as { raw?: { _?: string } }).raw;
  if (raw?._) return raw._;
  return (obj as { _?: string })._;
}

/**
 * Check if an object has a specific raw TL type.
 * Replaces: `(obj as any)._ === 'typeName'`
 */
export function hasRawType(obj: unknown, typeName: string): boolean {
  return getRawType(obj) === typeName;
}

/**
 * User status types from Telegram TL schema.
 */
export type UserStatusType = 
  | 'userStatusEmpty'
  | 'userStatusOnline'
  | 'userStatusOffline'
  | 'userStatusRecently'
  | 'userStatusLastWeek'
  | 'userStatusLastMonth';

/**
 * Get user status object from a User entity.
 * Replaces: `(user as any).status`
 */
export function getUserStatus(user: unknown): { _?: string; wasOnline?: Date | number } | undefined {
  if (!user || typeof user !== 'object') return undefined;
  return (user as { status?: { _?: string; wasOnline?: Date | number } }).status;
}

/**
 * Check if user has a specific status type.
 * Replaces: `(user as any).status?._ === 'userStatusOnline'`
 */
export function hasUserStatus(user: unknown, statusType: UserStatusType): boolean {
  const status = getUserStatus(user);
  return status?._ === statusType;
}

/**
 * Get the wasOnline timestamp from user status.
 * Replaces: `(user as any).status?.wasOnline`
 */
export function getUserWasOnline(user: unknown): Date | number | undefined {
  const status = getUserStatus(user);
  return status?.wasOnline;
}

/**
 * Check if user is deleted.
 * Replaces: `(user as any).deleted`
 */
export function isUserDeleted(user: unknown): boolean {
  if (!user || typeof user !== 'object') return false;
  return Boolean((user as { deleted?: boolean }).deleted);
}

/**
 * Get media object from a message.
 * Replaces: `(msg as any).media` or `(message as any).media`
 */
export function getMessageMedia(msg: unknown): any {
  if (!msg || typeof msg !== 'object') return undefined;
  // Try .media property first (mtcute Message)
  const media = (msg as { media?: any }).media;
  if (media) return media;
  // Try .raw.media (TL Message)
  const raw = (msg as { raw?: { media?: any } }).raw;
  return raw?.media;
}

/**
 * Get document from a message.
 * Replaces: `(msg as any).document` or `(msg as any).media?.document`
 */
export function getMessageDocument(msg: unknown): any {
  if (!msg || typeof msg !== 'object') return undefined;
  // Direct .document property
  const doc = (msg as { document?: any }).document;
  if (doc) return doc;
  // Via .media.document
  const media = getMessageMedia(msg);
  return media?.document;
}

/**
 * Get document attribute type.
 * Replaces: `(attr as any)._`
 */
export function getDocumentAttributeType(attr: unknown): string | undefined {
  return getRawType(attr);
}

/**
 * Check if document attribute is a specific type.
 * Replaces: `(attr as any)._ === 'documentAttributeSticker'`
 */
export function isDocumentAttribute(attr: unknown, attrType: string): boolean {
  return hasRawType(attr, attrType);
}

/**
 * Get the raw TL object from a message or entity.
 * Replaces: `(msg as any).raw`
 */
export function getRawObject(obj: unknown): any {
  if (!obj || typeof obj !== 'object') return undefined;
  return (obj as { raw?: any }).raw;
}
