/**
 * Common Telegram TL schema types used across plugins.
 *
 * These types represent raw TL objects that mtcute uses internally.
 * Using these instead of `as any` provides better type safety while
 * still being flexible enough for the dynamic TL schema.
 */

/** A TL object with a discriminator `_` field */
export interface TlObject {
  _: string;
  [key: string]: unknown;
}

/** Input peer types */
export interface InputPeerUser {
  _: 'inputPeerUser';
  userId: number | string;
  accessHash: number | string;
}

export interface InputPeerChannel {
  _: 'inputPeerChannel';
  channelId: number | string;
  accessHash: number | string;
}

export interface InputPeerChat {
  _: 'inputPeerChat';
  chatId: number | string;
}

export type InputPeer = InputPeerUser | InputPeerChannel | InputPeerChat;

/** Input channel / user types (for API calls) */
export interface InputChannel {
  _: 'inputChannel';
  channelId: number | string;
  accessHash: number | string;
}

export interface InputUser {
  _: 'inputUser';
  userId: number | string;
  accessHash: number | string;
}

/** Channel participant types */
export interface ChannelParticipantAdmin {
  _: 'channelParticipantAdmin';
  userId: number;
  adminRights?: Record<string, boolean>;
  rank?: string;
}

export interface ChannelParticipantCreator {
  _: 'channelParticipantCreator';
  userId: number;
}

export interface ChannelParticipant {
  _: 'channelParticipant';
  userId: number;
}

export type ChannelParticipantType = ChannelParticipantAdmin | ChannelParticipantCreator | ChannelParticipant;

/** Media types */
export interface MessageMediaDocument {
  _: 'messageMediaDocument';
  document?: TlObject;
}

export interface MessageMediaPhoto {
  _: 'messageMediaPhoto';
  photo?: TlObject;
}

export type MessageMedia = MessageMediaDocument | MessageMediaPhoto | TlObject;

/** Document attribute types */
export interface DocumentAttributeSticker {
  _: 'documentAttributeSticker';
  alt: string;
  stickerset: TlObject;
}

export interface DocumentAttributeFilename {
  _: 'documentAttributeFilename';
  fileName: string;
}

export type DocumentAttribute = DocumentAttributeSticker | DocumentAttributeFilename | TlObject;

/** Chat participant types for basic groups */
export interface ChatParticipants {
  _: 'chatParticipants';
  participants: TlObject[];
}

export interface ChatParticipantsForbidden {
  _: 'chatParticipantsForbidden';
}

/** Full chat info */
export interface MessagesChatFull {
  _: 'messages.chatFull';
  fullChat: {
    participants?: ChatParticipants | ChatParticipantsForbidden;
  };
  users?: TlObject[];
}

/** Channel participant result */
export interface ChannelsChannelParticipant {
  _: 'channels.channelParticipant';
  participant: ChannelParticipantType;
  users?: TlObject[];
}

/** User status types */
export interface UserStatusOnline {
  _: 'userStatusOnline';
  expires: number;
}

export interface UserStatusOffline {
  _: 'userStatusOffline';
  wasOnline: number | Date;
}

export type UserStatus = UserStatusOnline | UserStatusOffline | TlObject;

/** Common entity-like object */
export interface EntityLike {
  id?: number | string;
  title?: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  type?: string;
  isGroup?: boolean;
  isChannel?: boolean;
  deleted?: boolean;
  peerId?: TlObject;
  chatId?: number | string;
  accessHash?: number | string;
}

/** Message-like object */
export interface MessageLike {
  id?: number;
  text?: string;
  sender?: EntityLike;
  replyTo?: TlObject;
  replyToMsgId?: number;
  fwdFrom?: TlObject;
  entities?: TlObject[];
  groupedId?: string;
  media?: MessageMedia;
  document?: TlObject;
  isGroup?: boolean;
  isChannel?: boolean;
  peerId?: TlObject;
  chat?: EntityLike;
  client?: TlObject;
  senderId?: number | string;
}

/** Error with seconds field (FLOOD_WAIT) */
export interface FloodWaitError extends Error {
  seconds?: number;
}

/** Dialog-like object */
export interface DialogLike {
  isUser?: boolean;
  isGroup?: boolean;
  isChannel?: boolean;
  entity?: EntityLike;
  chatType?: string;
}

/** Participant-like object */
export interface ParticipantLike {
  _?: string;
  userId?: number;
  adminRights?: Record<string, boolean>;
  rank?: string;
  deleted?: boolean;
}
