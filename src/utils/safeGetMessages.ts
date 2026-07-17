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
 *
 * Optionally accepts the gramjs-style scan shape `{ offsetId, limit, reverse }`
 * (used by history-scan call sites such as the yvlu plugin). These are mapped
 * onto mtcute's `getHistory` pagination so batch fetches actually return data
 * instead of being silently dropped. `ids`, `offsetId`, `limit` and `reverse`
 * are mutually independent: if `ids` is provided the id-based path is used,
 * otherwise the history-scan path runs.
 */
export async function safeGetMessages(
  client: TelegramClient,
  entity: InputPeerLike,
  idsOrParams:
    | number
    | number[]
    | { ids?: number | number[]; offsetId?: number; limit?: number; reverse?: boolean },
): Promise<Message[]> {
  let ids: number | number[] | undefined;
  let offsetId: number | undefined;
  let limit: number | undefined;
  let reverse: boolean | undefined;

  if (
    typeof idsOrParams === "object" &&
    idsOrParams !== null &&
    !Array.isArray(idsOrParams)
  ) {
    const params = idsOrParams as {
      ids?: number | number[];
      offsetId?: number;
      limit?: number;
      reverse?: boolean;
    };
    ids = params.ids;
    offsetId = params.offsetId;
    limit = params.limit;
    reverse = params.reverse;
  } else {
    ids = idsOrParams as number | number[];
  }

  try {
    let result: Message[];
    if (ids !== undefined) {
      const fetched = await client.getMessages(entity, ids);
      result = fetched.filter((m): m is Message => m != null);
    } else if (offsetId !== undefined || limit !== undefined) {
      // History-scan path: paginate forward from the given offset.
      const fetched = await client.getHistory(entity, {
        ...(limit !== undefined ? { limit } : {}),
        ...(offsetId !== undefined
          ? { offset: { id: offsetId, date: 0 } }
          : {}),
        ...(reverse !== undefined ? { reverse } : {}),
      });
      result = fetched.filter((m): m is Message => m != null);
    } else {
      result = [];
    }
    return result;
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

  // MessageContext has a convenient getReplyTo() (uses inputMessageReplyTo)
  if (typeof (msg as MessageContext).getReplyTo === "function") {
    try {
      const replied = await (msg as MessageContext).getReplyTo();
      if (replied) return replied;
    } catch {
      // fall through to explicit id fetch
    }
  }

  const replyInfo = msg.replyToMessage;
  const replyToMsgId = replyInfo?.id;
  if (!replyToMsgId) return undefined;

  const client = (msg as MessageContext).client;
  if (!client) return undefined;

  try {
    // Explicit fetch by replied-to message id in the same chat
    const [replyMsg] = await safeGetMessages(client, msg.chat.id ?? msg.chat, {
      ids: [replyToMsgId],
    });
    return replyMsg;
  } catch {
    return undefined;
  }
}
