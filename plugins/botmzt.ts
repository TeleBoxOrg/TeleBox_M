import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import type { MessageContext } from "@mtcute/dispatcher";
import type { TelegramClient } from "@mtcute/node";
import { html } from "@mtcute/html-parser";
import { Conversation } from "@mtcute/node";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";
import { sleep } from "@utils/asyncHelpers";
import { htmlEscape } from "@utils/htmlEscape";

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 机器人用户名
const BOT_USERNAME = "FinelyGirlsBot";

const runtime = {
  pendingDeleteTimers: new Set<NodeJS.Timeout>(),
};

// 帮助文本
const help_text = `🎨 <b>妹子图片插件</b>

<b>命令：</b>
• <code>${mainPrefix}botmzt</code> - 显示插件设置和帮助
• <code>${mainPrefix}rand</code> - 随机图片
• <code>${mainPrefix}pic</code> - 妹子图片
• <code>${mainPrefix}leg</code> - 腿部图片
• <code>${mainPrefix}ass</code> - 臀部图片
• <code>${mainPrefix}chest</code> - 胸部图片
• <code>${mainPrefix}coser</code> - Cosplay图片
• <code>${mainPrefix}nsfw</code> - NSFW图片
• <code>${mainPrefix}naizi</code> - 奶子图片
• <code>${mainPrefix}qd</code> - 签到命令

<b>说明：</b>
所有图片都会以剧透模式发送，需要点击查看。`;

/**
 * 与机器人对话并获取响应（使用 mtcute Conversation）
 * @param client Telegram客户端
 * @param command 发送给机器人的命令
 * @returns 机器人的响应消息
 */
async function getBotResponse(client: TelegramClient, command: string): Promise<import("@mtcute/core").Message | null> {
  try {
    const botPeer = await client.resolvePeer(BOT_USERNAME);
    
    // 解除对机器人的屏蔽（如果有的话）
    try {
      await client.call({ _: 'contacts.unblock', id: botPeer });
    } catch (error: unknown) { logger.warn(`[botmzt] 忽略解除屏蔽的错误，可能本来就没有屏蔽:`, error) }

    // 检查是否有对话历史，如果没有先发送 /start
    const history = await client.getHistory(botPeer, { limit: 3 });
    const hasConversation = history.length > 0;
    
    if (!hasConversation) {
      await client.sendText(botPeer, "/start");
      await sleep(1000);
    }

    // 使用 Conversation 等待机器人回复
    const conv = new Conversation(client, botPeer);
    await conv.start();
    
    try {
      // 发送命令给机器人
      await client.sendText(botPeer, `/${command}`);
      
      // 等待机器人响应
      const botResponse = await conv.waitForNewMessage(undefined, 15000);
      return botResponse;
    } catch (_e: unknown) {
      return null;
    } finally {
      conv.stop();
    }
  } catch (error: unknown) {
    logger.error(`[mztnew] 获取机器人响应失败:`, error);
    throw error;
  }
}

/**
 * 发送签到命令给机器人
 * @param msg 原始消息
 */
async function sendCheckinCommand(msg: MessageContext): Promise<void> {
  const client = await getGlobalClient();
  if (!client) {
    await msg.edit({ 
      text: html`❌ 客户端未初始化`
    });
    return;
  }

  try {
    // 显示处理中状态
    await msg.edit({ 
      text: html`📅 正在执行签到...`
    });

    // 获取机器人响应（getBotResponse 内部处理解除屏蔽和 /start）
    const botResponse = await getBotResponse(client, "checkin");
    
    if (botResponse) {
      // 获取机器人回复内容
      const responseText = botResponse.text || "签到成功";
      
      await msg.edit({
        text: html`✅ <b>签到完成</b><br><br>${htmlEscape(responseText)}`
      });
    } else {
      await msg.edit({
        text: html`❌ 签到超时，机器人可能暂时无响应，请稍后重试`
      });
    }

  } catch (error: unknown) {
    logger.error(`[mztnew] 签到失败:`, error);
    const errMsg = getErrorMessage(error);

    // 处理特定错误
    if (errMsg.includes("FLOOD_WAIT")) {
      const waitTime = parseInt(errMsg.match(/\d+/)?.[0] || "60");
      await msg.edit({
        text: html`⏳ <b>请求过于频繁</b><br><br>需要等待 ${waitTime} 秒后重试`
      });
      return;
    }

    if (errMsg.includes("USER_BLOCKED")) {
      await msg.edit({
        text: html`❌ <b>无法访问机器人</b><br><br>请先私聊 @${BOT_USERNAME} 并发送 /start`
      });
      return;
    }

    // 通用错误处理
    await msg.edit({
      text: html`❌ <b>签到失败:</b> ${htmlEscape(errMsg) || "未知错误"}`
    });
  }
}

/**
 * 发送带剧透效果的图片
 * @param msg 原始消息
 * @param command 机器人命令
 */
async function sendImageWithSpoiler(msg: MessageContext, command: string): Promise<void> {
  const client = await getGlobalClient();
  if (!client) {
    await msg.edit({ 
      text: html`❌ 客户端未初始化`
    });
    return;
  }

  try {
    // 显示处理中状态
    await msg.edit({ 
      text: html`🔄 正在获取图片...`
    });

    // 获取机器人响应
    const botResponse = await getBotResponse(client, command);
    
    if (!botResponse) {
      await msg.edit({
        text: html`❌ 机器人没有响应，请稍后重试`
      });
      return;
    }

    // 检查是否有图片或文档
    const rawMedia = (botResponse.raw as { media?: { _?: string; photo?: { id: number; accessHash: number; fileReference: Buffer }; document?: { id: number; accessHash: number; fileReference: Buffer } } } | undefined)?.media;
    let inputMedia: any;
    
    if (rawMedia?._ === 'messageMediaPhoto' && rawMedia.photo) {
      // 处理图片
      inputMedia = {
        _: 'inputMediaPhoto',
        id: {
          _: 'inputPhoto',
          id: rawMedia.photo.id,
          accessHash: rawMedia.photo.accessHash,
          fileReference: rawMedia.photo.fileReference,
        },
        spoiler: true, // 添加剧透效果
      };
    } else if (rawMedia?._ === 'messageMediaDocument' && rawMedia.document) {
      // 处理文档（可能是动图等）
      inputMedia = {
        _: 'inputMediaDocument',
        id: {
          _: 'inputDocument',
          id: rawMedia.document.id,
          accessHash: rawMedia.document.accessHash,
          fileReference: rawMedia.document.fileReference,
        },
        spoiler: true, // 添加剧透效果
      };
    } else {
      // 检查是否是错误消息
      const messageText = botResponse.text?.toLowerCase() || '';
      const errorKeywords = ['没有找到', '错误', 'error', '失败', '不存在', '无法', '无效'];
      const hasErrorKeyword = errorKeywords.some(keyword => messageText.includes(keyword));
      
      if (hasErrorKeyword) {
        await msg.edit({
          text: html`❌ <b>机器人返回错误:</b> ${htmlEscape(botResponse.text || "未知错误")}`
        });
      } else {
        await msg.edit({
          text: html`❌ 机器人没有返回图片，请稍后重试`
        });
      }
      return;
    }

    // 使用 SendMedia API 发送带剧透效果的图片
    const peer = await client.resolvePeer(msg.chat.id);
    const randomId = Math.floor(Math.random() * 9007199254740991);
    
    const sendParams: any = {
      _: 'messages.sendMedia',
      peer,
      media: inputMedia,
      message: "", // 不添加文字内容
      randomId,
    };
    
    if (msg.replyToMessage?.id) {
      sendParams.replyTo = {
        _: 'inputReplyToMessage',
        replyToMsgId: msg.replyToMessage.id,
      };
    }
    
    await client.call(sendParams);

    // 将机器人的消息标记为已读
    try {
      const botPeer = await client.resolvePeer(BOT_USERNAME);
      // TL-layer: messages.readHistory needs raw InputPeer
      await client.call({ _: 'messages.readHistory', peer: botPeer } as never);
    } catch (readError: unknown) {
      logger.error('[mztnew] 标记已读失败:', readError);
    }

    // 删除原始命令消息
    await msg.delete();

  } catch (error: unknown) {
    logger.error(`[mztnew] 发送图片失败:`, error);
    const errMsg = getErrorMessage(error);

    // 处理特定错误
    if (errMsg.includes("FLOOD_WAIT")) {
      const waitTime = parseInt(errMsg.match(/\d+/)?.[0] || "60");
      await msg.edit({
        text: html`⏳ <b>请求过于频繁</b><br><br>需要等待 ${waitTime} 秒后重试`
      });
      return;
    }

    if (errMsg.includes("USER_BLOCKED")) {
      await msg.edit({
        text: html`❌ <b>无法访问机器人</b><br><br>请先私聊 @${BOT_USERNAME} 并发送 /start`
      });
      return;
    }

    // 通用错误处理
    await msg.edit({
      text: html`❌ <b>获取图片失败:</b> ${htmlEscape(errMsg) || "未知错误"}`
    });
  }
}

class MztNewPlugin extends Plugin {
  cleanup(): void {
    // 真实资源清理：释放插件持有的定时器和运行时状态
    for (const timer of runtime.pendingDeleteTimers) {
      clearTimeout(timer);
    }
    runtime.pendingDeleteTimers.clear();
  }
  description: string = `妹子图片插件 - 从 ${BOT_USERNAME} 获取各类图片<br><br>${help_text}`;

  cmdHandlers = {
    // 主命令 - 显示帮助和设置
    botmzt: async (msg: MessageContext) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: html`❌ 客户端未初始化` });
        return;
      }

      try {
        const settingsText = html`🎨 <b>妹子图片插件设置</b><br><br>
<br><br>
<b>当前配置：</b><br><br>
• 机器人: @${BOT_USERNAME}<br>
• 剧透模式: 已启用<br>
• 自动删除命令: 已启用<br>
<br>
<b>可用命令：</b><br>
• <code>${mainPrefix}rand</code> - 随机图片<br>
• <code>${mainPrefix}pic</code> - 妹子图片  <br>
• <code>${mainPrefix}leg</code> - 腿部图片<br>
• <code>${mainPrefix}ass</code> - 臀部图片<br>
• <code>${mainPrefix}chest</code> - 胸部图片<br>
• <code>${mainPrefix}coser</code> - Cosplay图片<br>
• <code>${mainPrefix}nsfw</code> - NSFW图片<br>
• <code>${mainPrefix}naizi</code> - 奶子图片<br>
<br>
<b>使用说明：</b><br>
所有图片都会以剧透模式发送，点击查看。<br>
此消息将在30秒后自动删除。`;

        const statusMsg = await msg.edit({ 
          text: settingsText
        });

        // 30秒后删除消息
        const deleteTimer = setTimeout(async () => {
          try {
            if (statusMsg) {
              await (statusMsg as { delete?: () => Promise<unknown> }).delete?.();
            }
          } catch (error: unknown) { logger.warn(`[botmzt] 忽略删除错误:`, error) } finally {
            runtime.pendingDeleteTimers.delete(deleteTimer);
          }
        }, 30000);
        runtime.pendingDeleteTimers.add(deleteTimer);

      } catch (error: unknown) {
        logger.error("[mztnew] 显示设置失败:", error);
        await msg.edit({
          text: html`❌ <b>显示设置失败:</b> ${htmlEscape(getErrorMessage(error))}`
        });
      }
    },

    // 随机图片
    rand: async (msg: MessageContext) => {
      await sendImageWithSpoiler(msg, "rand");
    },

    // 妹子图片
    pic: async (msg: MessageContext) => {
      await sendImageWithSpoiler(msg, "pic");
    },

    // 腿部图片
    leg: async (msg: MessageContext) => {
      await sendImageWithSpoiler(msg, "leg");
    },

    // 臀部图片
    ass: async (msg: MessageContext) => {
      await sendImageWithSpoiler(msg, "ass");
    },

    // 胸部图片
    chest: async (msg: MessageContext) => {
      await sendImageWithSpoiler(msg, "chest");
    },

    // Cosplay图片（重命名为coser）
    coser: async (msg: MessageContext) => {
      await sendImageWithSpoiler(msg, "cos");
    },

    // NSFW图片
    nsfw: async (msg: MessageContext) => {
      await sendImageWithSpoiler(msg, "nsfw");
    },

    // 奶子图片
    naizi: async (msg: MessageContext) => {
      await sendImageWithSpoiler(msg, "naizi");
    },

    // 签到命令
    qd: async (msg: MessageContext) => {
      await sendCheckinCommand(msg);
    }
  };
}

export default new MztNewPlugin();
