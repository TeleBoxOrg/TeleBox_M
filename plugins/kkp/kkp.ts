import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import type { TelegramClient } from "@mtcute/node";
import type { Message } from "@mtcute/core";
import { tl, Long } from "@mtcute/core";
import { html } from "@mtcute/html-parser";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";


// HTML转义函数
const htmlEscape = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#x27;",
      }[m] || m),
  );

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 帮助文本
const help_text = `🎲 <b>随机色色视频获取</b>

<b>命令：</b>
• <code>${mainPrefix}kkp</code> - 从SeSe3000Bot获取随机视频并转发


<b>说明：</b>
该插件会自动与SeSe3000Bot交互获取随机视频内容`;

class KkpPlugin extends Plugin {

  description: string = `🎲 随机色色视频获取<br><br>${help_text}`;

  // 存储等待回复的消息监听器
  private messageListeners: Map<
    string,
    {
      resolve: (message: Message | null) => void;
      timeout: ReturnType<typeof setTimeout>;
      startTime: number;
      handler: (message: Message) => void;
    }
  > = new Map();

  cmdHandlers: Record<string, (msg: MessageContext, trigger?: MessageContext) => Promise<void>> = {
    kkp: async (msg: MessageContext) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: html`❌ 客户端未初始化` });
        return;
      }

      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts;
      const sub = (args[0] || "").toLowerCase();

      try {
        if (sub === "help" || sub === "h") {
          await msg.edit({ text: html(help_text) });
          return;
        }

        if (sub && sub !== "help" && sub !== "h") {
          await msg.edit({
            text: html`❌ <b>未知命令:</b> <code>${htmlEscape(sub)}</code>`,
          });
          return;
        }

        await this.getRandomVideo(msg, client);
      } catch (error: unknown) {
        logger.error("[kkp] 插件执行失败:", error);
        await msg.edit({
          text: html`❌ <b>插件执行失败:</b> ${htmlEscape(getErrorMessage(error) || "未知错误")}`,
        });
      }
    },
  };

  private extractPlainText(message: Message): string {
    const fullText = message.text || "";
    if (!fullText) return "";

    const entities = message.entities;
    if (!entities || entities.length === 0) return fullText;

    const excludedRanges: Array<{ offset: number; length: number }> = [];
    for (const entity of entities) {
      const eType = entity.kind;
      if (
        ["hashtag", "text_url", "url"].includes(eType)
      ) {
        excludedRanges.push({ offset: entity.offset, length: entity.length });
      }
    }

    if (excludedRanges.length === 0) return fullText;
    excludedRanges.sort((a, b) => a.offset - b.offset);

    let result = "";
    let lastEnd = 0;
    for (const range of excludedRanges) {
      if (range.offset > lastEnd)
        result += fullText.substring(lastEnd, range.offset);
      lastEnd = range.offset + range.length;
    }
    if (lastEnd < fullText.length) result += fullText.substring(lastEnd);

    return result.trim();
  }

  private isVideoMessage(message: Message): boolean {
    // mtcute: message.media is a typed MessageMedia union; use type narrowing
    const media = message.media;
    if (!media) return false;

    // Check for video/document media using mtcute's type discriminator
    if (media.type === 'video' || media.type === 'document') {
      const doc = media;
      if (doc.mimeType && doc.mimeType.startsWith("video/")) return true;

      // Check file name for video extension
      if (doc.fileName) {
        return [".mp4", ".avi", ".mov", ".mkv", ".webm", ".flv", ".wmv", ".m4v"]
          .some((ext) => doc.fileName!.toLowerCase().endsWith(ext));
      }
    }

    return false;
  }

  private async waitForBotReply(
    client: TelegramClient,
    botEntity:tl.TypeInputPeer,
    timeoutMs: number = 15000,
  ): Promise<Message | null> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const listenerId = `${(botEntity as { id?: unknown }).id}_${startTime}_${Math.random()}`;
      let isResolved = false;

      const cleanup = (result: Message | null) => {
        if (isResolved) return;
        isResolved = true;

        const listener = this.messageListeners.get(listenerId);
        if (listener) {
          clearTimeout(listener.timeout);
          try {
            client.onNewMessage.remove(listener.handler);
          } catch (error: unknown) {
            logger.warn("[kkp] 移除事件监听器失败:", error);
          }
          this.messageListeners.delete(listenerId);
        }
        resolve(result);
      };

      const timeout = setTimeout(() => cleanup(null), timeoutMs);

      const messageHandler = (message: Message) => {
        try {
          if (!message) return;
          const senderId = String(message.sender?.id || "");
          const botId = String((botEntity as { id?: unknown }).id);

          // mtcute: message.date is Date object
          const messageDate = message.date instanceof Date
            ? message.date.getTime()
            : 0;

          if (senderId === botId && messageDate >= startTime - 1000) {
            if (this.isVideoMessage(message)) cleanup(message);
          }
        } catch (error: unknown) {
          logger.error("[kkp] 消息处理失败:", error);
          cleanup(null);
        }
      };

      this.messageListeners.set(listenerId, {
        resolve,
        timeout,
        startTime,
        handler: messageHandler,
      });
      try {
        client.onNewMessage.add(messageHandler);
      } catch (error: unknown) {
        logger.error("[kkp] 添加事件监听器失败:", error);
        cleanup(null);
      }
    });
  }

  private async getRandomVideo(msg: MessageContext, client: TelegramClient): Promise<void> {
    await msg.edit({ text: html`🎲 正在获取随机视频...` });

    const botUsername = "SeSe3000Bot";
    try {
      const botEntity = await client.resolvePeer(botUsername);
      const recentMessages = await client.getHistory(botEntity, { limit: 3 });

      if (!recentMessages || recentMessages.length === 0) {
        await client.sendText(botUsername, "/start");
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      const replyPromise = this.waitForBotReply(client, botEntity, 20000);
      await client.sendText(botUsername, "随机色色");
      const videoMessage = await replyPromise;

      if (videoMessage && this.isVideoMessage(videoMessage)) {
        const mediaToSend = videoMessage.media;

        if (mediaToSend) {
          const plainTextCaption = this.extractPlainText(videoMessage);

          await msg.edit({ text: html`📥 正在转发视频...` });

          // 构造带剧透的媒体发送
          // 使用 client.sendMedia 发送带 spoiler 的视频
          const mediaDoc = mediaToSend.type === 'video' || mediaToSend.type === 'document'
            ? (mediaToSend as { raw: tl.RawDocument }).raw
            : null;

          if (mediaDoc) {
            // 使用 InputMediaDocument with spoiler
            const fileInput: tl.RawInputMediaDocument = {
              _: 'inputMediaDocument',
              id: {
                _: 'inputDocument',
                id: mediaDoc.id,
                accessHash: mediaDoc.accessHash,
                fileReference: mediaDoc.fileReference,
              },
              spoiler: true,
            };

            // 创建剧透实体覆盖整个文本
            const spoilerEntities: tl.TypeMessageEntity[] = plainTextCaption.length > 0 ? [{
              _: 'messageEntitySpoiler' as const,
              offset: 0,
              length: plainTextCaption.length,
            }] : [];

            // 使用 call 直接发送带剧透的文件
            const peerId = await client.resolvePeer(msg.chat.id);
            await client.call({
              _: 'messages.sendMedia',
              peer: peerId,
              media: fileInput,
              message: plainTextCaption,
              entities: spoilerEntities,
              randomId: new Long(Date.now() * 1000000 + Math.floor(Math.random() * 1000000)),
            });

            try {
              await client.readHistory(peerId);
            } catch (e: unknown) { logger.error('[kkp] markAsRead failed:', e); }
            await msg.delete();
          } else {
            await msg.edit({ text: html`❌ 无法提取视频文件` });
          }
        } else {
          await msg.edit({ text: html`❌ 无法提取视频文件` });
        }
      } else {
        await msg.edit({ text: html`❌ 获取视频超时` });
      }
    } catch (botError: unknown) {
      logger.error("[kkp] 错误:", botError);
      await msg.edit({
        text: html`❌ 错误: ${htmlEscape(getErrorMessage(botError) || "未知")}`,
      });
    }
  }

  async cleanup(): Promise<void> {
    const client = await getGlobalClient().catch(() => null);

    for (const [listenerId, listener] of this.messageListeners) {
      clearTimeout(listener.timeout);
      if (client) {
        try {
          client.onNewMessage.remove(listener.handler);
        } catch (error: unknown) {
          logger.warn("[kkp] cleanup 移除监听器失败:", error);
        }
      }
    }
    this.messageListeners.clear();
  }
}

export default new KkpPlugin();
