import type { Message, InputPeerLike } from "@mtcute/core";
import type { TelegramClient } from "@mtcute/core/highlevel/client";
import type { MessageContext } from "@mtcute/dispatcher";

function isUndefinedDateCrash(error: unknown): boolean {
  const message = String(error && typeof error === 'object' && 'message' in error ? (error as { message?: string }).message : error || "");
  return (
    message.includes("Cannot read properties of undefined") &&
    message.includes("reading 'date'")
  );
}

/**
 * Safely fetch messages by id.
 *
 * mtcute's `getMessages(chatId, ids)` takes message ids positionally (a single
 * number or an array) and returns `(Message | null)[]`. The legacy gramjs call
 * sites pass a params object `{ ids: number[] }`, so this helper accepts either
 * a raw id / id array or that legacy `{ ids }` shape and normalizes it. Nulls
 * (messages not found) are filtered out so callers get a clean `Message[]`.
 */
export async function safeGetMessages(
  client: TelegramClient,
  entity: InputPeerLike,
  idsOrParams: number | number[] | { ids?: number | number[] },
): Promise<Message[]> {
  let ids: number | number[];
  if (
    typeof idsOrParams === "object" &&
    idsOrParams !== null &&
    !Array.isArray(idsOrParams)
  ) {
    ids = (idsOrParams as { ids?: number | number[] }).ids ?? [];
  } else {
    ids = idsOrParams as number | number[];
  }

  try {
    const result = await client.getMessages(entity, ids);
    return result.filter((m): m is Message => m != null);
  } catch (error: unknown) {
    if (isUndefinedDateCrash(error)) {
      return [];
    }
    throw error;
  }
}

/**
 * Fetch the message a given message is replying to.
 *
 * mtcute exposes `MessageContext.getReplyTo()` which resolves the replied-to
 * message directly. For a plain `Message` we fall back to fetching by
 * `replyToMessage.id` within the same chat.
 */
export async function safeGetReplyMessage(
  msg?: MessageContext | Message | null,
): Promise<Message | undefined> {
  if (!msg) return undefined;

  // MessageContext has a convenient getReplyTo()
  if (typeof (msg as MessageContext).getReplyTo === "function") {
    try {
      const replied = await (msg as MessageContext).getReplyTo();
      return replied ?? undefined;
    } catch (e: unknown) {
      return undefined;
    }
  }

  const replyInfo = msg.replyToMessage;
  const replyToMsgId = replyInfo?.id;
  if (!replyToMsgId) return undefined;

  const client = (msg as MessageContext).client;
  if (!client) return undefined;

  const [replyMsg] = await safeGetMessages(client, msg.chat, { ids: [replyToMsgId] });
  return replyMsg;
}
