// plugins/lu_bs.ts
import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { html } from "@mtcute/html-parser";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { JSONFilePreset } from "lowdb/node";
import type { Low } from "lowdb";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import * as path from "path";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// HTML转义函数
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 帮助文本
const HELP_TEXT = `🕒 <b>鲁小迅整点报时</b>

<b>功能说明：</b>
• 每小时整点自动发送鲁小迅贴纸报时
• 自动删除上一条报时消息（1小时后）
• 支持群组和私聊订阅

<b>可用命令：</b>
• <code>${mainPrefix}lu_bs sub</code> - 订阅整点报时
• <code>${mainPrefix}lu_bs unsub</code> - 退订整点报时
• <code>${mainPrefix}lu_bs list</code> - 查看订阅状态
• <code>${mainPrefix}lu_bs reload</code> - 重新加载贴纸包

<b>注意事项：</b>
• 需要管理员权限才能操作群组订阅
• 请先添加贴纸包: <code>https://t.me/addstickers/luxiaoxunbs</code>`;

class LuBsPlugin extends Plugin {
  cleanup(): void {
    this.stickerSet = null;
  }

  async setup(): Promise<void> {
    await this.initDB();
    await this.loadStickerSet();
  }

  private db!: Awaited<ReturnType<typeof JSONFilePreset<{ subscriptions: string[]; lastMessages: Record<string, number> }>>>;
  private stickerSet: any = null;
  private readonly PLUGIN_NAME = "lu_bs";
  
  description = HELP_TEXT;
  
  // 定时任务 - 每小时整点执行
  cronTasks = {
    hourlyReport: {
      cron: "0 * * * *", // 每小时整点
      description: "鲁小迅整点报时",
      handler: async (client: any) => {
        await this.sendHourlyStickers(client);
      }
    }
  };

  constructor() {
    super();
  }

  // 初始化数据库
  private async initDB() {
    const dbPath = path.join(createDirectoryInAssets(this.PLUGIN_NAME), "subscriptions.json");
    this.db = await JSONFilePreset(dbPath, {
      subscriptions: [] as string[],
      lastMessages: {} as Record<string, number>
    });
  }

  // 加载贴纸包
  private async loadStickerSet() {
    try {
      const client = await getGlobalClient();
      if (!client) return;

      // 使用mtcute raw API获取贴纸包
      this.stickerSet = await client.call({
        _: 'messages.getStickerSet',
        stickerset: {
          _: 'inputStickerSetShortName',
          shortName: "luxiaoxunbs"
        },
        hash: 0
      });
      
      logger.info(`[${this.PLUGIN_NAME}] 贴纸包加载成功`);
    } catch (error) {
      logger.error(`[${this.PLUGIN_NAME}] 贴纸包加载失败:`, error);
      this.stickerSet = null;
    }
  }

  // 获取当前小时对应的贴纸
  private async getHourSticker(): Promise<any> {
    if (!this.stickerSet) {
      await this.loadStickerSet();
    }
    
    if (!this.stickerSet || !this.stickerSet.documents || this.stickerSet.documents.length === 0) {
      return null;
    }

    const now = new Date();
    let hour = now.getHours() - 1;
    
    if (now.getMinutes() > 30) {
      hour += 1;
    }
    
    hour = hour % 12;
    if (hour === -1) {
      hour = 11;
    }

    // 确保索引在有效范围内
    const stickerIndex = hour % this.stickerSet.documents.length;
    return this.stickerSet.documents[stickerIndex];
  }

  // 发送整点贴纸
  private async sendHourlyStickers(client: any) {
    if (!this.db) await this.initDB();
    
    const sticker = await this.getHourSticker();
    if (!sticker) {
      logger.error(`[${this.PLUGIN_NAME}] 无法获取贴纸`);
      return;
    }

    const subscriptions = this.db.data.subscriptions;
    
    for (const chatId of subscriptions) {
      try {
        // 先删除上一条消息（如果存在）
        const lastMsgId = this.db.data.lastMessages[chatId];
        if (lastMsgId) {
          try {
            await client.deleteMessagesById(chatId, [lastMsgId], { revoke: true });
          } catch (error) { logger.warn(`[lu_bs] 忽略删除失败的情况（消息可能已过期）:`, error) }
        }

        // 发送新贴纸
        const message = await client.sendMedia(chatId, {
          _: 'inputMediaDocument',
          id: {
            _: 'inputDocument',
            id: sticker.id,
            access_hash: sticker.access_hash,
            file_reference: sticker.file_reference,
          }
        });

        // 记录新消息ID，用于下次删除
        this.db.data.lastMessages[chatId] = message.id;
        await this.db.write();

        logger.info(`[${this.PLUGIN_NAME}] 已发送整点报时到 ${chatId}`);
      } catch (error) {
        logger.error(`[${this.PLUGIN_NAME}] 发送失败到 ${chatId}:`, error);
        
        // 如果发送失败，可能是聊天不存在或没有权限，移除订阅
        const errMsg = (error as Error).message ?? String(error);
        if (errMsg.includes("CHAT_WRITE_FORBIDDEN") ||
            errMsg.includes("CHAT_NOT_FOUND")) {
          this.db.data.subscriptions = this.db.data.subscriptions.filter((id: string) => id !== chatId);
          delete this.db.data.lastMessages[chatId];
          await this.db.write();
          logger.info(`[${this.PLUGIN_NAME}] 已移除无效订阅: ${chatId}`);
        }
      }
    }
  }

  // 检查用户权限（简化版本，实际使用时可能需要更复杂的权限检查）
  private async checkPermission(msg: MessageContext): Promise<boolean> {
    try {
      const client = await getGlobalClient();
      if (!client) return false;

      const chat = msg.chat;
      const sender = msg.sender;
      
      // 检查chat和sender是否存在
      if (!chat || !sender) return false;
      
      // 私聊总是允许
      if (chat.type === "user") {
        return true;
      }
      
      // 群组/频道需要检查管理员权限（chat.type is already narrowed to "chat"）
      {
        const channelPeer = await client.resolvePeer(chat.id);
        const senderPeer = await client.resolvePeer(sender.id);
        const result = await client.call({
          _: 'channels.getParticipant',
          channel: channelPeer,
          participant: senderPeer
        } as never) as unknown as { participant?: { _?: string } };
        const participant = result?.participant;
        if (!participant) return false;
        const pType = participant._;
        return (
          pType === 'channelParticipantAdmin' ||
          pType === 'channelParticipantCreator' ||
          pType === 'chatParticipantAdmin' ||
          pType === 'chatParticipantCreator'
        );
      }
      
      return false;
    } catch (error) {
      logger.error(`[${this.PLUGIN_NAME}] 权限检查失败:`, error);
      return false;
    }
  }

  cmdHandlers = {
    lu_bs: async (msg: MessageContext) => {
      if (!this.db) await this.initDB();
      
      const parts = msg.text?.trim().split(/\s+/) || [];
      const subCommand = parts[1]?.toLowerCase() || "help";
      
      try {
        switch (subCommand) {
          case "sub":
          case "订阅":
            await this.handleSubscribe(msg);
            break;
            
          case "unsub":
          case "退订":
            await this.handleUnsubscribe(msg);
            break;
            
          case "list":
          case "列表":
            await this.handleList(msg);
            break;
            
          case "reload":
          case "重载":
            await this.handleReload(msg);
            break;
            
          case "help":
          case "帮助":
          default:
            await msg.edit({ text: html(HELP_TEXT) });
            break;
        }
      } catch (error: unknown) {
        await msg.edit({
          text: html`❌ <b>错误:</b> ${htmlEscape(getErrorMessage(error) || "未知错误")}`,
        });
      }
    }
  };

  // 处理订阅
  private async handleSubscribe(msg: MessageContext) {
    const chatId = msg.chat.id.toString();
    if (!chatId) {
      await msg.edit({ text: html`❌ 无法获取聊天ID` });
      return;
    }

    // 检查权限
    const hasPermission = await this.checkPermission(msg);
    if (!hasPermission) {
      await msg.edit({ 
        text: html`❌ 权限不足，无法操作整点报时`, 
      });
      return;
    }

    // 检查是否已订阅
    if (this.db.data.subscriptions.includes(chatId)) {
      await msg.edit({ 
        text: html`❌ 你已经订阅了整点报时`, 
      });
      return;
    }

    // 添加订阅
    this.db.data.subscriptions.push(chatId);
    await this.db.write();

    await msg.edit({ 
      text: html`✅ 你已经成功订阅了整点报时`, 
    });
  }

  // 处理退订
  private async handleUnsubscribe(msg: MessageContext) {
    const chatId = msg.chat.id.toString();
    if (!chatId) {
      await msg.edit({ text: html`❌ 无法获取聊天ID` });
      return;
    }

    // 检查权限
    const hasPermission = await this.checkPermission(msg);
    if (!hasPermission) {
      await msg.edit({ 
        text: html`❌ 权限不足，无法操作整点报时`, 
      });
      return;
    }

    // 检查是否已订阅
    if (!this.db.data.subscriptions.includes(chatId)) {
      await msg.edit({ 
        text: html`❌ 你还没有订阅整点报时`, 
      });
      return;
    }

    // 移除订阅
    this.db.data.subscriptions = this.db.data.subscriptions.filter((id: string) => id !== chatId);
    delete this.db.data.lastMessages[chatId];
    await this.db.write();

    await msg.edit({ 
      text: html`✅ 你已经成功退订了整点报时`, 
    });
  }

  // 处理列表查看
  private async handleList(msg: MessageContext) {
    const chatId = msg.chat.id.toString();
    if (!chatId) {
      await msg.edit({ text: html`❌ 无法获取聊天ID` });
      return;
    }

    const isSubscribed = this.db.data.subscriptions.includes(chatId);
    const totalSubscriptions = this.db.data.subscriptions.length;
    
    let text = `📊 <b>订阅状态</b>\n\n`;
    text += `• 当前聊天: <code>${isSubscribed ? "✅ 已订阅" : "❌ 未订阅"}</code>\n`;
    text += `• 总订阅数: <code>${totalSubscriptions}</code>\n\n`;
    
    if (isSubscribed) {
      text += `💡 使用 <code>${mainPrefix}lu_bs unsub</code> 退订`;
    } else {
      text += `💡 使用 <code>${mainPrefix}lu_bs sub</code> 订阅`;
    }

    await msg.edit({ text: html(text) });
  }

  // 处理重载贴纸包
  private async handleReload(msg: MessageContext) {
    await this.loadStickerSet();
    
    if (this.stickerSet) {
      await msg.edit({ 
        text: html`✅ 贴纸包重新加载成功`, 
      });
    } else {
      await msg.edit({ 
        text: html`❌ 贴纸包加载失败，请检查贴纸包名称是否正确`, 
      });
    }
  }
}

export default new LuBsPlugin();
