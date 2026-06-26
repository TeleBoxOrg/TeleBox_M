// Type stub for teleproto - legacy compatibility layer for mtcute migration
// This provides type definitions to satisfy TypeScript compilation
// while the codebase is gradually migrated from teleproto to mtcute

declare module "teleproto" {
    import type { MessageContext } from "@mtcute/dispatcher";

    export class TelegramClient {
        getEntity: (id: string | number) => Promise<unknown>;
        sendMessage: (peer: unknown, text: string, opts?: unknown) => Promise<unknown>;
        sendFile: (peer: unknown, file: unknown, opts?: unknown) => Promise<unknown>;
        sendText: (peer: unknown, text: string, opts?: unknown) => Promise<unknown>;
        editMessage: (peer: unknown, opts?: unknown) => Promise<unknown>;
        resolvePeer: (peerId: unknown, force?: boolean) => Promise<unknown>;
        [key: string]: any;
    }

    export namespace Api {
        export class User {
            id?: number;
            firstName?: string;
            lastName?: string;
            username?: string;
            className?: string;
        }

        export class Message {
            id?: number;
            chatId?: number;
            text?: string;
            message?: string;
            peerId?: { userId?: number; chatId?: number; channelId?: number };
            fromId?: { userId?: number; chatId?: number; channelId?: number };
            sender?: User;
            fwdFrom?: { senderId?: number; senderName?: string };
            media?: unknown;
            chat?: { id?: number; title?: string };
            client?: TelegramClient;
            replyTo?: { replyToMsgId?: number; topMsgId?: number };
            isReply?: boolean;
            out?: boolean;
            action?: MessageAction;
            getInputChat?: () => unknown;
            raw?: {
                id?: number;
                peerId?: { userId?: number; chatId?: number; channelId?: number };
                message?: string;
            };
            className?: string;
            edit(opts: unknown): Promise<unknown>;
            delete(opts?: unknown): Promise<unknown>;
            reply(text: string, opts?: unknown): Promise<unknown>;
        }

        export interface MessageActionPinMessage {
            className: "MessageActionPinMessage";
            message?: Message;
        }

        export interface MessageActionChatEditTitle {
            className: "MessageActionChatEditTitle";
            title?: string;
        }

        export interface MessageActionGeneric {
            className: string;
            [key: string]: unknown;
        }

        export type MessageAction = MessageActionPinMessage | MessageActionChatEditTitle | MessageActionGeneric;

        export class InputReplyToMessage {
            constructor(opts: { replyToMsgId?: number; topMsgId?: number });
            replyToMsgId?: number;
            topMsgId?: number;
        }

        export class InputPeerUser {
            constructor(opts: { userId?: number; accessHash?: number });
        }

        export class InputPeerChannel {
            constructor(opts: { channelId?: number; accessHash?: number });
        }

        export class DocumentAttributeSticker {
            constructor(opts?: Record<string, unknown>);
        }

        export class InputStickerSetEmpty {
            constructor();
        }

        export namespace messages {
            export class ForwardMessages {
                constructor(opts: Record<string, unknown>);
            }
            export class SendMessage {
                constructor(opts: Record<string, unknown>);
            }
        }

        export class UpdateNewMessage {
            message?: Message;
            className?: string;
        }

        export class UpdateNewChannelMessage {
            message?: Message;
            className?: string;
        }

        export type TypeUpdates = UpdateNewMessage | UpdateNewChannelMessage | Array<UpdateNewMessage | UpdateNewChannelMessage>;

        export type TypeInputPeer = InputPeerUser | InputPeerChannel | Record<string, unknown>;
        export type TypeInputUser = Record<string, unknown>;
        export type TypeInputChannel = Record<string, unknown>;
    }
}

declare module "teleproto/Helpers" {
    export function sleep(ms: number): Promise<void>;
}

declare module "teleproto/errors" {
    export class RPCError extends Error {
        errorMessage: string;
        code?: number;
        constructor(message: string, code?: number);
    }
}
