import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import type { ChatMember, User } from "@mtcute/core/highlevel/types/index.js";
import { html } from "@mtcute/html-parser";
import { getGlobalClient } from "@utils/globalClient";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";
import { hasRawType, isParticipantAdmin, isParticipantCreator } from "@utils/entityTypeGuards";
import { htmlEscape } from "@utils/htmlEscape";

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 帮助文档
const help_text = `👮 <b>一键 AT 管理员</b>

<b>📝 功能描述:</b>
• 🔔 <b>管理员召唤</b>：一键艾特群组内所有管理员
• 💬 <b>自定义消息</b>：可附带自定义召唤消息
• 📦 <b>智能分片</b>：自动分片避免消息过长
• 🤖 <b>过滤机器人</b>：自动排除机器人和已删除用户

<b>🔧 使用方法:</b>
• <code>${mainPrefix}atadmins</code> - 使用默认消息召唤管理员
• <code>${mainPrefix}atadmins [消息内容]</code> - 附带自定义消息召唤

<b>💡 示例:</b>
• <code>${mainPrefix}atadmins</code> - 默认召唤
• <code>${mainPrefix}atadmins 请查看置顶消息</code> - 自定义消息召唤
• <code>${mainPrefix}atadmins 紧急情况需要处理</code> - 紧急召唤

<b>⚠️ 注意事项:</b>
• 仅限群组使用，私聊无效
• 需要获取群组管理员权限
• 自动删除召唤命令消息
• 支持回复消息时召唤管理员`;

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


class AtAdminsPlugin extends Plugin {

  description: string = help_text;
  
  cmdHandlers: Record<string, (msg: MessageContext, trigger?: MessageContext) => Promise<void>> = {
    atadmins: async (msg: MessageContext) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: html("❌ 客户端未初始化") });
        return;
      }

      // 参数解析（严格按acron.ts模式）
      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts; // 跳过命令本身
      const sub = (args[0] || "").toLowerCase();

      try {
        // 明确请求帮助时才显示
        if (sub === "help" || sub === "h") {
          await msg.edit({ text: html(help_text) });
          return;
        }

        // 执行AT管理员功能
        await this.handleAtAdmins(msg, args);
        
      } catch (error: unknown) {
        logger.error("[atadmins] 插件执行失败:", error);
        await msg.edit({
          text: html(`❌ <b>操作失败:</b> ${htmlEscape(getErrorMessage(error))}`),
        });
      }
    }
  };

  // 将管理员 mention 分片，控制单条消息的最大字数与最大 mention 数
  private chunkMentions(mentions: string[], header: string, maxLen = 3500, maxCount = 25): string[] {
    const chunks: string[] = [];
    let current = header;
    let count = 0;
    for (const m of mentions) {
      const toAdd = (count === 0 ? "" : " , ") + m;
      if (count >= maxCount || (current.length + toAdd.length) > maxLen) {
        chunks.push(current);
        current = header + m; // 新开一条
        count = 1;
      } else {
        current += toAdd;
        count++;
      }
    }
    if (count > 0) chunks.push(current);
    return chunks;
  }

  private async handleAtAdmins(msg: MessageContext, args: string[]): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: html("❌ 客户端未初始化") });
      return;
    }

    try {
      // 检查是否在群组中
      const chat = await msg.getCompleteChat();
      if (!chat || (!hasRawType(chat, 'channel') && !hasRawType(chat, 'chat'))) {
        await msg.edit({ 
          text: html(`❌ <b>此命令只能在群组中使用</b><br><br>💡 请在群组中使用 <code>${mainPrefix}atadmins</code> 命令`), 
        });
        return;
      }

      // 获取管理员列表
      const participants: Array<ChatMember | User> = [];
      for await (const member of client.iterChatMembers(msg.chat.id, {})) {
        if (isParticipantAdmin(member) || isParticipantCreator(member)) {
          participants.push(member);
        }
      }

      const admins: string[] = [];
      let adminCount = 0;
      let botCount = 0;
       
      for (const participant of participants) {
        const member = ((participant as { user?: User }).user || participant) as User;
        if (member && !member.isDeleted) {
          if (member.isBot) {
            botCount++;
            continue; // 跳过机器人
          }
          
          adminCount++;
          if (member.username) {
            admins.push(`@${member.username}`);
          } else {
            const firstName = member.firstName || "";
            const lastName = member.lastName || "";
            const fullName = `${firstName} ${lastName}`.trim() || "用户";
            // HTML转义用户名
            const escapedName = htmlEscape(fullName);
            admins.push(`<a href="tg://user?id=${member.id}">${escapedName}</a>`);
          }
        }
      }

      if (admins.length === 0) {
        await msg.edit({ 
          text: html(`❌ <b>未找到可召唤的管理员</b><br><br>📊 统计信息:<br>• 总管理员: ${adminCount}<br>• 机器人管理员: ${botCount}<br>• 可召唤: 0<br><br>💡 可能原因：所有管理员都是机器人或已删除账户`), 
        });
        return;
      }

      // 获取自定义消息内容（HTML转义）
      const customMessage = args.join(" ").trim();
      const say = customMessage ? htmlEscape(customMessage) : "召唤本群所有管理员";
      
      const header = `${say}：<br><br>`;
      const chunks = this.chunkMentions(admins, header);

      // 逐条发送
      const replyToId = msg.replyToMessage?.id;
      for (const part of chunks) {
        await client.sendText(msg.chat.id, html(part), {
          disableWebPreview: true,
          ...(replyToId ? { replyTo: replyToId } : {}),
        });
        // 小间隔，避免触发频控
        await new Promise((r) => setTimeout(r, 800));
      }

      // 延迟删除命令消息
      scheduleTimer(async () => {
        try {
          await msg.delete({ revoke: true });
        } catch (deleteError: unknown) {
          logger.warn("[atadmins] 删除原消息失败:", deleteError);
        }
      }, 3000); // 3秒后删除
      
    } catch (error: unknown) {
      logger.error("[atadmins] 获取管理员列表失败:", error);

      // 详细错误处理
      const errMsg = getErrorMessage(error);
      let errorText = "❌ <b>获取管理员列表失败</b>\n\n";

      if (errMsg.includes("CHAT_ADMIN_REQUIRED")) {
        errorText += "💡 <b>原因:</b> 机器人需要管理员权限才能获取管理员列表";
      } else if (errMsg.includes("CHANNEL_PRIVATE")) {
        errorText += "💡 <b>原因:</b> 无法访问此群组的管理员信息";
      } else if (errMsg.includes("FLOOD_WAIT")) {
        const waitTime = errMsg.match(/\d+/)?.[0] || "60";
        errorText += `💡 <b>原因:</b> 请求过于频繁，请等待 ${waitTime} 秒后重试`;
      } else {
        errorText += `💡 <b>错误详情:</b> ${htmlEscape(errMsg || "未知错误")}`;
      }

      await msg.edit({
        text: html(errorText),
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

export default new AtAdminsPlugin();