import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { TelegramClient, Message, type InputPeerLike } from "@mtcute/node";
import { getGlobalClient } from "@utils/globalClient";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { logger } from "@utils/logger";
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

class RePlugin extends Plugin {

  description: string = `复读\n回复一条消息即可复读\n<code>${mainPrefix}re [消息数] [复读次数]</code>`;
  cmdHandlers: Record<
    string,
    (msg: MessageContext, trigger?: MessageContext) => Promise<void>
  > = {
    re: async (msg, trigger) => {
      const [, ...args] = msg.text.slice(1).split(" ");
      const count = parseInt(args[0]) || 1;
      const repeat = parseInt(args[1]) || 1;

      const client = await getGlobalClient();

      try {
        if (!msg.replyToMessage) {
          await msg.edit({ text: "你必须回复一条消息才能够进行复读" });
          return;
        }
        let replied = await safeGetReplyMessage(msg);
        if (!replied?.chat) {
          await client.sendText(msg.chat.id, "无法获取被回复的消息，请重试。");
          return;
        }

        // 获取从被回复消息开始的消息
        const messages = await client.getHistory(replied.chat.id, {
          offset: { id: replied.id, date: 0 },
          limit: count,
          reverse: true,
        });

        // 双向删除命令消息
        await msg.safeDelete({ revoke: true });
        
        // 尝试使用转发方式复读
        let forwardFailed = false;
        for (let i = 0; i < repeat; i++) {
          if (messages && messages.length > 0) {
            try {
              // 使用 mtcute forwardMessagesById 以支持论坛话题 (threadId)
              const toPeer = msg.chat.id;
              const fromPeer = replied.chat.id;
              const ids = messages.map((m) => m.id);
              const threadId: number | undefined =
                replied.replyToMessage?.threadId ?? replied.replyToMessage?.id ?? undefined;

              await client.forwardMessagesById({
                fromChatId: fromPeer,
                messages: ids,
                toChatId: toPeer,
                // 如果在论坛话题中，指定话题的线程 ID
                ...(threadId ? { toThreadId: threadId } : {}),
              });
            } catch (error: unknown) {
              if (error instanceof Error && error.message.includes("CHAT_FORWARDS_RESTRICTED")) {
                forwardFailed = true;
                break;
              } else {
                throw error;
              }
            }
          }
        }
        
        // 如果转发失败（群组禁止转发），使用复制方式
        if (forwardFailed && messages && messages.length > 0) {
          for (let i = 0; i < repeat; i++) {
            await Promise.all(
              messages.map((message) =>
                this.copyMessage(client, msg.chat.id, message, replied.replyToMessage?.threadId ?? replied.replyToMessage?.id ?? undefined)
              )
            );
          }
        }
      } catch (error: unknown) {
        if (error instanceof Error) {
          await client.sendText(msg.chat.id, error.message || "发生错误，无法复读消息。请稍后再试。");
        } else {
          await client.sendText(msg.chat.id, "发生未知错误，无法复读消息。请稍后再试。");
        }
      }
      if (trigger) {
        await trigger.safeDelete({ revoke: true });
      }
    },
  };

  // 复制消息内容并发送（用于禁止转发的群组）
  private async copyMessage(
    client: TelegramClient,
    peerId: InputPeerLike,
    message: Message,
    topMsgId?: number
  ): Promise<void> {
    try {
      // 使用 mtcute sendCopy API 复制消息
      await client.sendCopy({
        fromChatId: message.chat.id,
        message: message.id,
        toChatId: peerId,
        ...(topMsgId ? { replyTo: topMsgId } : {}),
      });
    } catch (error: unknown) {
      logger.error("复制消息失败:", error);
      throw error;
    }
  }
}

const plugin = new RePlugin();

export default plugin;