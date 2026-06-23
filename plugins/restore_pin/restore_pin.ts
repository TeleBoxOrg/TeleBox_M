import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { html } from "@mtcute/html-parser";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { logger } from "@utils/logger";
import { hasRawType, getRawType } from "@utils/entityTypeGuards";
import { getErrorMessage } from "@utils/errorHelpers";
import { tl } from "@mtcute/core";
import Long from "long";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// HTML转义函数（必需）
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 帮助文本
const helpText = `📌 <b>恢复置顶插件</b>

<b>功能：</b>自动恢复管理员误取消的置顶消息

<b>命令：</b>
• <code>${mainPrefix}restore_pin</code> - 自动恢复所有可恢复的置顶消息

<b>使用说明：</b>
1. 仅在群组中可用
2. 需要管理员权限
3. 自动扫描并恢复最近取消的置顶消息`;

class RestorePinPlugin extends Plugin {

  name = "restore_pin";
  description = helpText;

  cmdHandlers = {
    restore_pin: this.handleRestorePin.bind(this)
  };

  /**
   * 获取管理员日志
   */
  private async getAdminLog(channel: tl.TypeInputChannel): Promise<tl.channels.TypeAdminLogResults> {
    const client = await getGlobalClient();
    if (!client) throw new Error("客户端未初始化");

    const result = await client.call({
      _: 'channels.getAdminLog',
      channel: channel,
      q: "",
      maxId: Long.fromNumber(0),
      minId: Long.fromNumber(0),
      limit: 100,
      eventsFilter: {
        _: 'channelAdminLogEventsFilter',
        pinned: true,
      }
    });

    return result;
  }

  /**
   * 从管理员日志中提取取消置顶事件
   */
  private getUnpinMessages(events: tl.channels.RawAdminLogResults): number[] {
    const messageIds: number[] = [];

    for (const event of (events.events || [])) {
      // 检查是否为取消置顶事件
      const action = event.action as tl.RawChannelAdminLogEventActionUpdatePinned;
      if (action && action._ === 'channelAdminLogEventActionUpdatePinned') {
        const message = action.message as tl.RawMessage | undefined;
        if (message && !hasRawType(message, 'messageEmpty') && !message.pinned) { // 取消置顶
          const messageId = message.id;
          messageIds.push(messageId);
        }
      }
    }

    // 去重并返回
    return [...new Set(messageIds)];
  }

  /**
   * 恢复单条消息的置顶
   */
  private async pinMessage(chatId: tl.TypeInputPeer, messageId: number): Promise<boolean> {
    const client = await getGlobalClient();
    if (!client) return false;

    try {
      await client.call({
        _: 'messages.updatePinnedMessage',
        peer: chatId,
        id: messageId,
        silent: true,
        unpin: false,
      });
      return true;
    } catch (error: unknown) {
      logger.error(`[restore_pin] 置顶消息失败:`, error);
      return false;
    }
  }

  /**
   * 批量恢复置顶
   */
  private async restorePins(msg: MessageContext, chatId: tl.TypeInputPeer, messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) {
      await msg.edit({ text: html`✅ 没有需要恢复的置顶消息` });
      return;
    }

    await msg.edit({ 
      text: html`🔄 正在恢复 ${messageIds.length} 条置顶消息...`
    });

    let successCount = 0;
    let errorCount = 0;
    const errors: string[] = [];

    // 注意：必须按顺序逐条恢复置顶消息，每次操作之间有1秒延迟以避免触发Telegram速率限制
    for (let i = 0; i < messageIds.length; i++) {
      const messageId = messageIds[i];
      
      // 每3条更新一次进度
      if ((i + 1) % 3 === 0) {
        await msg.edit({ 
          text: html`🔄 正在恢复第 ${i + 1}/${messageIds.length} 条置顶消息...<br>✅ 成功: ${successCount} ❌ 失败: ${errorCount}` 
        });
      }

      const success = await this.pinMessage(chatId, messageId);
      if (success) {
        successCount++;
      } else {
        errorCount++;
        errors.push(`消息 ${messageId} 恢复失败`);
      }

      // 延迟避免触发限制（减少到1秒）
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    let resultText = `📊 <b>恢复完成</b><br><br>`;
    resultText += `✅ 成功恢复: ${successCount} 条<br>`;
    resultText += `❌ 恢复失败: ${errorCount} 条`;

    if (errors.length > 0) {
      resultText += `<br><br><b>失败详情：</b><br>`;
      errors.slice(0, 3).forEach(error => {
        resultText += `• ${htmlEscape(error)}<br>`;
      });
      if (errors.length > 3) {
        resultText += `• ... 还有 ${errors.length - 3} 个错误`;
      }
    }

    await msg.edit({ text: html(resultText) });
  }

  /**
   * 主命令处理器
   */
  private async handleRestorePin(msg: MessageContext): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: html`❌ 客户端未初始化` });
      return;
    }

    try {
      // 检查是否为群组
      const chat = await msg.getCompleteChat();
      const chatType = getRawType(chat);
      if (chatType !== 'channel' && chatType !== 'chat') {
        await msg.edit({ text: html`❌ 此命令仅在群组或频道中可用` });
        return;
      }

      // 检查管理员权限
      const sender = msg.sender;
      if (!sender) {
        await msg.edit({ text: html`❌ 无法获取发送者信息` });
        return;
      }

      // Get the chat to construct proper InputChannel
      const fullChat = await client.getChat(msg.chat.id);
      const chatRaw = fullChat.raw as tl.RawChannel;
      if (chatRaw._ !== 'channel') {
        await msg.edit({ text: html`❌ 无法获取频道信息` });
        return;
      }
      const inputChannel: tl.RawInputChannel = {
        _: 'inputChannel',
        channelId: chatRaw.id,
        accessHash: chatRaw.accessHash!,
      };

      const participant = await client.call({
        _: 'channels.getParticipant',
        channel: inputChannel,
        participant: await client.resolvePeer(sender.id),
      });

      const pType = getRawType(participant.participant);
      const isAdmin = pType === 'channelParticipantAdmin' || pType === 'channelParticipantCreator';

      if (!isAdmin) {
        await msg.edit({ text: html`❌ 需要管理员权限才能使用此命令` });
        return;
      }

      await msg.edit({ text: html`📋 正在获取管理员日志...` });

      // 获取管理员日志
      const adminLog = await this.getAdminLog(inputChannel);
      
      // 提取取消置顶的消息ID
      const messageIds = this.getUnpinMessages(adminLog);

      if (messageIds.length === 0) {
        await msg.edit({ text: html`✅ 未找到可恢复的置顶消息` });
        return;
      }

      await msg.edit({ 
        text: html`🔍 找到 ${messageIds.length} 条可恢复的置顶消息，开始自动恢复...` 
      });

      // 直接恢复所有置顶消息
      await this.restorePins(msg, fullChat.inputPeer, messageIds);

    } catch (error: unknown) {
      logger.error(`[restore_pin] 错误:`, error);

      const errMsg = getErrorMessage(error);
      let errorMessage = "❌ 操作失败";
      if (errMsg.includes("CHAT_ADMIN_REQUIRED")) {
        errorMessage = "❌ 需要管理员权限";
      } else if (errMsg.includes("USER_NOT_PARTICIPANT")) {
        errorMessage = "❌ 用户不是群组成员";
      } else if (errMsg.includes("AUTH_KEY_UNREGISTERED")) {
        errorMessage = "❌ 会话已失效，请重新登录";
      } else if (errMsg) {
        errorMessage += `: ${htmlEscape(errMsg)}`;
      }

      await msg.edit({ text: html(errorMessage) });
    }
  }
}

export default new RestorePinPlugin();