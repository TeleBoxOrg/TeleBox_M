import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { html } from "@mtcute/html-parser";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/globalClient";
import { safeGetMe } from "@utils/authGuards";
import { logger } from "@utils/logger";
import { getRawType } from "@utils/entityTypeGuards";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// HTML转义工具（每个插件必须实现）
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 帮助文档常量
const help_text = `<b>⚠️ 一键跑路</b>

<code>${mainPrefix}paolu</code> - 删除群内所有消息并禁言所有成员

<b>警告：</b>此操作不可逆，请谨慎使用！`;

// 工具函数
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

class PaoluPlugin extends Plugin {

  description: string = `群组一键跑路插件 - 删除消息并禁言所有成员<br><br>${help_text}`;
  
  cmdHandlers: Record<string, (msg: MessageContext, trigger?: MessageContext) => Promise<void>> = {
    paolu: this.handlePaolu.bind(this),
  };

  private async handlePaolu(msg: MessageContext): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: html`❌ 客户端错误` });
      return;
    }

    // 检查是否群组（非私聊）
    const chatType = getRawType(msg.chat);
    if (chatType === "user") {
      await msg.edit({ text: html`❌ 仅群组可用` });
      return;
    }

    const chatId = msg.chat.id;

    try {
      // 检查管理员权限
      const me = await safeGetMe(client);
      if (!me) return;
      let isAdmin = false;
      
      try {
        const chat = await client.getChat(chatId);
        const ct = getRawType(chat);
        if (ct === "channel") {
          try {
            const result: any = await client.call({
              _: 'channels.getParticipant',
              channel: await client.resolvePeer(chatId) as any,
              participant: me.id as any,
            });
            const pType = result?.participant?._;
            isAdmin =
              pType === "channelParticipantAdmin" ||
              pType === "channelParticipantCreator";
          } catch (permError) {
            logger.info("权限检查失败，尝试备用方法:", permError);
            try {
              const adminResult: any = await client.call({
                _: 'channels.getParticipants',
                channel: await client.resolvePeer(chatId) as any,
                filter: { _: 'channelParticipantsAdmins' },
                offset: 0,
                limit: 100,
                hash: 0 as any,
              });
              if ("users" in adminResult) {
                const admins = adminResult.users as any[];
                isAdmin = admins.some(
                  (admin) => String(admin.id) === String(me.id)
                );
              }
            } catch (adminListError) {
              logger.info("管理员列表获取失败:", adminListError);
              isAdmin = false;
            }
          }
        }
      } catch (e) {
        logger.error("权限检查失败:", e);
        isAdmin = false;
      }

      if (!isAdmin) {
        await msg.edit({ 
          text: html`❌ 需要管理员权限才能执行此操作`, 
        });
        return;
      }

      // 开始执行跑路操作
      await msg.edit({ 
        text: html`🚨 <b>一键跑路</b><br><br>正在处理中...`, 
      });

      // 1. 禁言所有成员
      try {
        await client.call({
          _: 'channels.editBanned',
          channel: await client.resolvePeer(chatId) as any,
          participant: "all" as any,
          bannedRights: {
            _: 'chatBannedRights',
            untilDate: 0,
            viewMessages: true,
            sendMessages: true,
            sendMedia: true,
            sendStickers: true,
            sendGifs: true,
            sendGames: true,
            sendInline: true,
            sendPolls: true,
            changeInfo: true,
            inviteUsers: true,
            pinMessages: true,
          } as any,
        });
        logger.info(`[PAOLU] 已禁言群组 ${chatId}`);
      } catch (banError) {
        logger.error("[PAOLU] 禁言操作失败:", banError);
      }

      // 2. 批量删除消息
      let deletedCount = 0;
      const BATCH_SIZE = 100;
      
      try {
        let chatName = "未知群组";
        try {
          const chat = await client.getChat(chatId);
          if ("title" in chat) {
            chatName = (chat as any).title || "未知群组";
          }
        } catch (error) {
          logger.error("获取群聊信息失败:", error);
        }

        logger.info(`[PAOLU] 开始删除群组 ${chatName} 的消息`);

        let offsetId = 0;
        let hasMore = true;
        
        while (hasMore) {
          const history: any[] = await client.getHistory(chatId, {
            limit: BATCH_SIZE,
            ...(offsetId ? { offsetId } : {}),
          });
          
          if (!history || history.length === 0) {
            hasMore = false;
            break;
          }
          
          // 过滤掉当前命令消息
          const messagesToDelete = history.filter((m: any) => m.id !== msg.id);
          
          if (messagesToDelete.length > 0) {
            try {
              await client.deleteMessagesById(chatId, messagesToDelete.map((m: any) => m.id), { revoke: true });
              deletedCount += messagesToDelete.length;
            } catch (delErr) {
              // 逐个删除
              for (const m of messagesToDelete) {
                try {
                  await client.deleteMessagesById(chatId, [m.id], { revoke: true });
                  deletedCount++;
                  await sleep(100);
                } catch (individualError) {
                  logger.error(`[PAOLU] 删除单条消息失败 (ID: ${m.id}):`, individualError);
                }
              }
            }
          }
          
          // 更新进度
          await msg.edit({
            text: html`🚨 <b>一键跑路</b><br><br>正在删除消息...<br>已删除: ${deletedCount} 条`,
          });
          
          if (history.length < BATCH_SIZE) {
            hasMore = false;
          } else {
            offsetId = history[history.length - 1].id;
          }
        }

        logger.info(`[PAOLU] 删除完成，共删除 ${deletedCount} 条消息`);

      } catch (deleteError) {
        logger.error("[PAOLU] 删除消息失败:", deleteError);
      }

      // 3. 删除命令消息本身
      try {
        await msg.delete();
      } catch (deleteError) {
        logger.error("[PAOLU] 删除命令消息失败:", deleteError);
      }

      // 4. 发送完成提示（自动删除）
      try {
        const completionMsg: any = await client.sendText(chatId, html`✅ <b>跑路完成</b><br><br>• 已禁言所有成员<br>• 已删除 ${deletedCount} 条消息<br><br>此消息将在10秒后自动删除`);

        scheduleTimer(async () => {
          try {
            await completionMsg?.delete();
          } catch (e) {
            logger.error("[PAOLU] 自动删除完成提示失败:", e);
          }
        }, 10000);

      } catch (sendError) {
        logger.error("[PAOLU] 发送完成提示失败:", sendError);
      }

    } catch (error: any) {
      logger.error("[PAOLU] 插件执行失败:", error);
      
      let errorMsg = "❌ 操作失败";
      if (error.message?.includes("FLOOD_WAIT")) {
        const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
        errorMsg = `⏳ 操作过于频繁，请等待 ${waitTime} 秒后重试`;
      } else if (error.message) {
        errorMsg += `: ${htmlEscape(error.message)}`;
      }
      
      await msg.edit({ text: errorMsg });
    }
  }

  private static readonly MAX_FLOOD_WAIT_RETRIES = 3;

  cleanup(): void {
    for (const timer of pendingTimers) {
      clearTimeout(timer);
    }
    pendingTimers.clear();
  }
}

export default new PaoluPlugin();
