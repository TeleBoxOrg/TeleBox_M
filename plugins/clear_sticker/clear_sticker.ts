import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import type { MessageContext } from "@mtcute/dispatcher";
import { getPrefixes } from "@utils/pluginManager";
import { logger } from "@utils/logger";
import type { tl } from "@mtcute/core";
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];



// Timer tracking for safe cleanup
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

function scheduleTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(() => {
    pendingTimers.delete(t);
    fn();
  }, ms);
  pendingTimers.add(t);
  return t;
}


class ClearStickerPlugin extends Plugin {

  description: string = `🧹 <b>清理群内贴纸消息</b><br/><br/>
<b>命令</b><br/>
• <code>${mainPrefix}clear_sticker [数量]</code> / <code>${mainPrefix}cs [数量]</code><br/><br/>
<b>说明</b><br/>
• 清理群内历史贴纸消息（仅群聊可用）<br/>
• 可选参数"数量"用于限制删除数量（默认清理全部）`;
  
  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    "clear_sticker": this.handleClearSticker.bind(this),
    "cs": this.handleClearSticker.bind(this),
  };

  private async handleClearSticker(msg: MessageContext): Promise<void> {
    const client = await getGlobalClient();
    
    if (!client) {
      await msg.edit({
        text: "❌ 客户端未初始化"
      });
      return;
    }
    
    try {

      // Check if we are in a group chat
      const chat = await msg.getCompleteChat();
      if (!chat || !('id' in chat)) {
        await msg.edit({
          text: "❌ 此命令只能在群组中使用。"
        });
        return;
      }

      const args = msg.text?.split(' ').slice(1) || [];
      let maxCount = 2000; // 安全上限，避免一次性过大
      
      if (args.length > 0) {
        const countArg = parseInt(args[0]);
        if (isNaN(countArg) || countArg < 1) {
          await msg.edit({
            text: `❌ 请输入有效的贴纸数量，例如：${mainPrefix}clear_sticker 100`
          });
          return;
        }
        maxCount = Math.min(countArg, 2000);
      }

      const chatId = msg.chat.id;
      
      await msg.edit({
        text: `🔍 Searching for sticker messages...\nTarget count: ${maxCount}`
      });

      let deletedCount = 0;
      const limit = 100;
      let hasMore = true;
      let offsetMsgId: number | undefined = undefined;

      while (hasMore && deletedCount < maxCount) {
        try {
  
          const history = await client.getHistory(chatId, {
            limit,
            ...(offsetMsgId !== undefined ? { offset: { id: offsetMsgId, date: 0 } } : {}),
          });

          if (!history || history.length === 0) {
            hasMore = false;
            break;
          }

          const stickerMessageIds: number[] = [];
          
          for (const message of history) {
            if (message.media) {
              // raw is RawMessage | RawMessageService; only RawMessage has .media
              const rawMsg = message.raw as tl.RawMessage | null;
              if (rawMsg?.media?._ === 'messageMediaDocument') {
                const document = rawMsg.media.document;
                if (document?._ === 'document') {
                  const isSticker = document.attributes?.some(
                    (attr: tl.TypeDocumentAttribute) => attr._ === 'documentAttributeSticker'
                  );
                  
                  if (isSticker) {
                    stickerMessageIds.push(message.id);
                  }
                }
              }
            }
          }


          if (stickerMessageIds.length > 0) {
            try {

              const messagesToDelete = deletedCount + stickerMessageIds.length > maxCount 
                ? stickerMessageIds.slice(0, maxCount - deletedCount)
                : stickerMessageIds;
              
              await client.deleteMessagesById(chatId, messagesToDelete, {
                revoke: true
              });
              deletedCount += messagesToDelete.length;
              

              const progressText = `🗑️ 正在清理贴纸消息...\n进度：${deletedCount}/${maxCount}`;
              await msg.edit({
                text: progressText
              });
            } catch (deleteError) {
              logger.error("Failed to delete sticker messages:", deleteError);
            }
          }


          // Set offset to the oldest message for next iteration
          offsetMsgId = history[history.length - 1].id;


          if (history.length < limit) {
            hasMore = false;
          }


          // 节流，避免触发限制
          await new Promise(resolve => setTimeout(resolve, 1200));
          
        } catch (historyError) {
          logger.error("Failed to get chat history:", historyError);
          hasMore = false;
        }
      }


      if (deletedCount > 0) {
        const resultText = maxCount === Number.MAX_SAFE_INTEGER 
          ? `✅ 清理完成！\n共删除了 ${deletedCount} 条贴纸消息。`
          : `✅ 清理完成！\n已删除 ${deletedCount} 条贴纸消息。`;
        
        try {
          const finalMsg = await msg.edit({
            text: resultText
          });
          

          scheduleTimer(async () => {
            try {
              await msg.delete();
            } catch (error: unknown) {
              logger.error("Failed to delete result message:", error);
            }
          }, 3000);
        } catch (error: unknown) {
          logger.error("Failed to edit final message:", error);
        }
      } else {
        await msg.edit({
          text: "ℹ️ 未找到贴纸消息。"
        });
      }
      
    } catch (error: unknown) {
      logger.error("ClearSticker plugin error:", error);
      await msg.edit({
        text: "❌ 清理贴纸消息时出现错误。"
      });
    }
  }
  cleanup(): void {
    for (const timer of pendingTimers) {
      clearTimeout(timer);
    }
    pendingTimers.clear();
  }
}
export default new ClearStickerPlugin();