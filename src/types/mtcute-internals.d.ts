/**
 * Type definitions for mtcute TelegramClient internal methods.
 * These methods exist at runtime but are not exposed in the public type definitions.
 *
 * Use this type instead of `as any` when calling these internal APIs:
 *
 * ```ts
 * import type { TelegramClientInternals } from '@/types/mtcute-internals';
 * const dialogs = await (client as TelegramClientInternals).getDialogs({});
 * ```
 */

import type { Dialog } from '@mtcute/core';

/**
 * Internal TelegramClient methods used by plugins.
 * These are private/undocumented mtcute APIs that exist at runtime.
 */
export interface TelegramClientInternals {
    /**
     * Get dialogs (internal method, use iterDialogs() for public API).
     * Returns raw dialog objects at runtime.
     */
    getDialogs(params?: { folderId?: number; limit?: number; offset?: number }): Promise<Dialog[]>;

    /**
     * Delete a dialog (internal method - removes conversation from list).
     * @param inputPeer - The dialog's input entity
     */
    deleteDialog(inputPeer: unknown): Promise<void>;

    /**
     * Iterate over channel/supergroup participants (internal method).
     * @param chatId - The chat ID to iterate participants for
     * @param params - Optional parameters like limit
     */
    iterParticipants(chatId: unknown, params?: {
        limit?: number;
        query?: string;
    }): AsyncIterableIterator<unknown>;
}
