import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import type { MessageContext } from "@mtcute/dispatcher";
import { html } from "@mtcute/html-parser";
import { safeGetReplyMessage } from "@utils/safeGetMessages";

import { safeGetMe } from "@utils/authGuards";
import { logger } from "@utils/logger";
import { hasRawType } from "@utils/entityTypeGuards";
import type { TelegramClient } from "@mtcute/node";
import type { tl } from "@mtcute/core";
import { getErrorMessage } from "@utils/errorHelpers";
// HTML转义工具
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

const codeTag = (text: string | number): string => `<code>${htmlEscape(String(text))}</code>`;

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 帮助文本定义
const help_text = `🆔 <b>用户信息查询插件</b>

<b>使用方式：</b>
• <code>${mainPrefix}ids</code> - 显示自己的信息
• <code>${mainPrefix}ids @用户名</code> - 查询指定用户信息
• <code>${mainPrefix}ids 用户ID</code> - 通过ID查询用户信息
• 回复消息后使用 <code>${mainPrefix}ids</code> - 查询被回复用户信息

<b>显示信息包括：</b>
• 用户名和显示名称
• 用户ID、注册时间、DC
• <b>入群时间</b>（仅群组有效）
• 共同群组数量
• 用户简介
• 三种跳转链接

<b>支持格式：</b>
• @用户名、用户ID、频道ID、回复消息`;

type UserInfo = {
  id: number;
  user: unknown;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  isBot: boolean;
  isVerified: boolean;
  isPremium: boolean;
  isScam: boolean;
  isFake: boolean;
  dc: string;
  bio: string | null;
  commonChats: number;
  regDate: string;
  joinedDate: string | null;
};

class IdsPlugin extends Plugin {

  description: string = `用户信息查询插件<br><br>${help_text}`;

  // 高精度采样点 (ID, Timestamp) - 2026最新校准
  private readonly ID_DATA_POINTS: [number, number][] = [
    [0, 1376438400], [50000000, 1400000000], [150000000, 1451606400],
    [350000000, 1483228800], [500000000, 1514764800], [900000000, 1559347200],
    [1100000000, 1585699200], [1450000000, 1609459200], [2150000000, 1640995200],
    [5100000000, 1654041600], [5600000000, 1672531200], [6800000000, 1704067200],
    [7800000000, 1735689600], [8500000000, 1767225600]
  ];

  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    ids: async (msg: MessageContext) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: html("❌ 客户端未初始化") });
        return;
      }

      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts;
      const target = args[0] || "";

      try {
        if (target === "help" || target === "h") {
          await msg.edit({ text: html(help_text) });
          return;
        }

        await msg.edit({ text: html("🔍 <b>正在查询用户信息...</b>") });

        let targetUser: unknown = null;
        let targetId: number | null = null;

        if (target) {
          const result = await this.parseTarget(client, target);
          targetUser = result.user; targetId = result.id;
        } else {
          try {
            const reply = await safeGetReplyMessage(msg);
            if (reply) {
              const replySender = (reply as { sender?: { id?: number } }).sender;
              const replySenderId = replySender?.id;
              if (replySenderId) {
                targetId = Number(replySenderId);
                targetUser = replySender;
              }
            }
          } catch (e: unknown) { logger.warn('[ids] get reply sender failed:', e) }
        }

        if (!targetUser && !targetId) {
          const me = await safeGetMe(client);
           if (!me) return;
          targetUser = me; targetId = Number(me.id);
        }

        if (!targetId) {
          await msg.edit({ text: html(`❌ 无法获取用户信息`) });
          return;
        }

        const userInfo = await this.getUserInfo(client, targetUser, targetId, msg);
        const result = this.formatUserInfo(userInfo);
        await this.sendLongMessage(msg, result);

      } catch (error: unknown) {
        await msg.edit({ text: html(`❌ <b>查询失败:</b> ${htmlEscape(getErrorMessage(error) || "未知错误")}`) });
      }
    }
  };

  private getPreciseRegDate(userId: number): string {
    if (userId < 0) return "频道/群组";
    let lower = this.ID_DATA_POINTS[0], upper = this.ID_DATA_POINTS[this.ID_DATA_POINTS.length - 1];
    for (let i = 0; i < this.ID_DATA_POINTS.length - 1; i++) {
      if (userId >= this.ID_DATA_POINTS[i][0] && userId <= this.ID_DATA_POINTS[i + 1][0]) {
        lower = this.ID_DATA_POINTS[i]; upper = this.ID_DATA_POINTS[i + 1]; break;
      }
    }
    const ts = lower[1] + (userId - lower[0]) * (upper[1] - lower[1]) / (upper[0] - lower[0]);
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}年${d.getMonth() + 1}月`;
  }

  private async getUserInfo(client: TelegramClient, user: unknown, userId: number, msg: MessageContext): Promise<UserInfo> {
    const info: UserInfo = {
      id: userId, user, username: (user as { username?: string })?.username || null,
      firstName: (user as { firstName?: string })?.firstName || (user as { first_name?: string })?.first_name || null,
      lastName: (user as { lastName?: string })?.lastName || (user as { last_name?: string })?.last_name || null,
      isBot: (user as { bot?: boolean })?.bot || false, isVerified: (user as { verified?: boolean })?.verified || false,
      isPremium: (user as { premium?: boolean })?.premium || false, isScam: (user as { scam?: boolean })?.scam || false,
      isFake: (user as { fake?: boolean })?.fake || false, dc: "未知", bio: null, commonChats: 0,
      regDate: this.getPreciseRegDate(userId), joinedDate: null
    };

    try {
      const full = await client.call({
        _: "users.getFullUser",
        id: await client.resolvePeer(userId) as unknown as tl.TypeInputUser,
      }) as { fullUser?: { about?: string; commonChatsCount?: number } };
      if (full.fullUser) {
        info.bio = full.fullUser.about || null;
        info.commonChats = full.fullUser.commonChatsCount || 0;
      }
    } catch (e: unknown) { logger.warn('[ids] get full user info failed:', e) }

    const chat = await msg.getCompleteChat();
    if (chat && (hasRawType(chat, 'channel') || hasRawType(chat, 'chat'))) {
      try {
        const p = await client.call({
          _: "channels.getParticipant",
          channel: await client.resolvePeer(msg.chat.id) as unknown as tl.TypeInputChannel,
          participant: await client.resolvePeer(userId),
        }) as { participant?: { date?: number } };
        if (p.participant?.date) {
          const jd = new Date(p.participant.date * 1000);
          info.joinedDate = `${jd.getFullYear()}-${(jd.getMonth()+1).toString().padStart(2,'0')}-${jd.getDate().toString().padStart(2,'0')} ${jd.getHours().toString().padStart(2,'0')}:${jd.getMinutes().toString().padStart(2,'0')}`;
        }
      } catch (e: unknown) { logger.warn('[ids] get participant info failed:', e) }
    }

    info.dc = await this.getUserDC(client, userId, user);
    return info;
  }

  private async getUserDC(client: TelegramClient, userId: number, user: unknown): Promise<string> {
    try {
      const full = await client.call({
        _: "users.getFullUser",
        id: await client.resolvePeer(userId) as unknown as tl.TypeInputUser,
      }) as { users?: Array<{ photo?: { _?: string; dcId?: number } }> };
      const u = full.users?.[0];
      if (u?.photo?._ !== "userProfilePhotoEmpty" && u?.photo) return `DC${u.photo.dcId}`;
      return "无头像";
    } catch (e: unknown) { logger.warn('ids: getDcId failed', e); return "未知"; }
  }

  private formatUserInfo(info: UserInfo): string {
    const userId = info.id;
    let displayName = info.firstName ? `${info.firstName}${info.lastName ? ' ' + info.lastName : ''}` : (info.username ? `@${info.username}` : `用户 ${userId}`);
    let usernameInfo = info.username ? `@${info.username}` : "无用户名";

    const statusTags = [];
    if (info.isBot) statusTags.push("🤖 机器人");
    if (info.isVerified) statusTags.push("✅ 已验证");
    if (info.isPremium) statusTags.push("⭐ Premium");
    if (info.isScam) statusTags.push("⚠️ 诈骗");
    if (info.isFake) statusTags.push("❌ 虚假");

    let bioText = info.bio || "无简介";
    if (bioText.length > 200) bioText = bioText.substring(0, 200) + "...";

    const link1 = `tg://user?id=${userId}`, link2 = info.username ? `https://t.me/${info.username}` : `https://t.me/@id${userId}`, link3 = `tg://openmessage?user_id=${userId}`;

    let result = `👤 <b>${htmlEscape(displayName)}</b>\n\n`;
    result += `<b>基本信息：</b>\n`;
    result += `• 用户名：${codeTag(usernameInfo)}\n`;
    result += `• 用户ID：${codeTag(userId)}\n`;
    result += `• 注册时间：${codeTag(`${info.regDate} (±2月)`)}\n`;
    if (info.joinedDate) result += `• 入群时间：${codeTag(info.joinedDate)}\n`;
    result += `• DC：${codeTag(info.dc)}\n`;
    result += `• 共同群：${codeTag(info.commonChats)} 个\n`;
    if (statusTags.length > 0) result += `• 状态：${statusTags.join(" ")}\n`;
    
    result += `\n<b>简介：</b>\n${codeTag(bioText)}\n`;
    result += `\n<b>跳转链接：</b>\n`;
    result += `• <a href="${htmlEscape(link1)}">用户资料</a>\n• <a href="${htmlEscape(link2)}">聊天链接</a>\n• <a href="${htmlEscape(link3)}">打开消息</a>\n`;
    result += `\n<b>链接文本：</b>\n`;
    result += `• ${codeTag(link1)}\n• ${codeTag(link2)}\n• ${codeTag(link3)}`;

    return result;
  }

  private async parseTarget(client: TelegramClient, target: string) {
    if (target.startsWith("@")) {
      const e = await client.getChat(target);
      return { user: e, id: Number(e.id) };
    }
    const id = parseInt(target);
    if (!isNaN(id)) {
      try { return { user: await client.getChat(id), id }; } catch (e: unknown) { logger.debug('[ids] getChat failed for id:', id, e); return { user: null, id }; }
    }
    throw new Error("无效格式");
  }

  private async sendLongMessage(msg: MessageContext, text: string) {
    if (text.length <= 4096) { await msg.edit({ text: html(text) }); return; }
    const parts = text.match(/[\s\S]{1,4000}/g) || [];
    for (let i = 0; i < parts.length; i++) {
      if (i === 0) await msg.edit({ text: html(parts[i] + `<br><br>📄 (1/${parts.length})`) });
      else await msg.replyText(html(parts[i] + `<br><br>📄 (${i + 1}/${parts.length})`));
    }
  }
}

export default new IdsPlugin();