/**
 * Shared mtcute type aliases for commonly-used complex types.
 *
 * These aliases replace inline `as unknown as import("@mtcute/core").Xxx`
 * patterns that are repeated across many plugins, improving readability
 * and maintainability.
 *
 * Usage in plugins:
 *   import type { MtcuteFileLocation, MtcuteFileDownloadLocation } from "@utils/mtcuteTypes";
 *   // ...
 *   const buffer = await client.downloadAsBuffer(media as MtcuteFileLocation);
 */

import type { FileLocation, tl, Long, InputPeerLike, InputMediaLike } from "@mtcute/core";
import type { MessageContext } from "@mtcute/dispatcher";

/**
 * FileLocation type from @mtcute/core.
 * Used with client.downloadAsBuffer() when the media object's type
 * is not directly assignable to FileLocation.
 *
 * Replaces: `as unknown as import("@mtcute/core").FileLocation`
 */
export type MtcuteFileLocation = FileLocation;

/**
 * FileDownloadLocation type from @mtcute/core.
 * Used with client.downloadAsBuffer() for download operations.
 *
 * Replaces: `as unknown as import("@mtcute/core").FileDownloadLocation`
 */
export type MtcuteFileDownloadLocation = FileLocation;

/**
 * MessageContext type from @mtcute/dispatcher.
 * Used when a constructed object needs to be cast to MessageContext.
 *
 * Replaces: `as unknown as import("@mtcute/dispatcher").MessageContext`
 */
export type MtcuteMessageContext = MessageContext;

/**
 * TL TypeInputChannel from @mtcute/core.
 * Used when resolvePeer result needs to be cast to InputChannel.
 *
 * Replaces: `as unknown as import("@mtcute/core").tl.TypeInputChannel`
 */
export type MtcuteInputChannel = tl.TypeInputChannel;

/**
 * TL TypeInputPeer from @mtcute/core.
 * Used when resolvePeer result needs to be cast to InputPeer.
 *
 * Replaces: `as unknown as import("@mtcute/core").tl.TypeInputPeer`
 */
export type MtcuteInputPeer = tl.TypeInputPeer;

/**
 * Long type from @mtcute/core.
 * Used for hash parameters that require Long type.
 *
 * Replaces: `as unknown as import("@mtcute/core").Long`
 */
export type MtcuteLong = Long;

/**
 * InputPeerLike type from @mtcute/core.
 * Used for getChat/resolvePeer parameters.
 *
 * Replaces: `as unknown as import("@mtcute/core").InputPeerLike`
 */
export type MtcuteInputPeerLike = InputPeerLike;

/**
 * InputMediaLike type from @mtcute/core.
 * Used for sendMedia parameters.
 *
 * Replaces: `as unknown as import("@mtcute/core").InputMediaLike`
 */
export type MtcuteInputMediaLike = InputMediaLike;

/**
 * TL TypeReaction array from @mtcute/core.
 * Used for reaction parameters.
 *
 * Replaces: `as unknown as import("@mtcute/core").tl.TypeReaction[]`
 */
export type MtcuteReactions = tl.TypeReaction[];

/**
 * TL TypeInputUser from @mtcute/core.
 * Used when resolvePeer result needs to be cast to InputUser.
 *
 * Replaces: `as unknown as import("@mtcute/core").tl.TypeInputUser`
 */
export type MtcuteInputUser = tl.TypeInputUser;

/**
 * TL TypeMessageEntity array from @mtcute/core.
 * Used when entities need to be cast to TypeMessageEntity[].
 *
 * Replaces: `as unknown as import("@mtcute/core").tl.TypeMessageEntity[]`
 */
export type MtcuteMessageEntities = tl.TypeMessageEntity[];

/**
 * Entity-like object used for display name extraction.
 * Matches the shape of common Telegram entity objects with username/firstName/title/id fields.
 */
export type DisplayableEntity = {
    username?: string;
    firstName?: string;
    title?: string;
    id?: number | string;
};

/** Entity with numeric id property (common for mtcute User/Peer objects) */
export type EntityWithId = {
    id?: number | bigint;
    raw?: { id?: number | bigint };
};
