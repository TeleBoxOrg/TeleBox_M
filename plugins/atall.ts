import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { html } from "@mtcute/html-parser";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";

// HTML转义函数
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 消息分割函数（限制调整为4000字符）
const splitMessagesByMention = (mentions: string[], maxLength = 4000): string[] => {
  const messages: string[] = [];
  let currentMessage = "";
  
  for (const mention of mentions) {
    if (currentMessage === "") {
      currentMessage = mention;
    } 
    else if (currentMessage.length + 1 + mention.length <= maxLength) {
      currentMessage += " " + mention;
    } 
    else {
      messages.push(currentMessage);
      currentMessage = mention;
    }
  }
  
  if (currentMessage) {
    messages.push(currentMessage);
  }
  
  return messages;
};

// 帮助文本
const help_text = `📢 <b>AtAll</b>

📝 <b>功能描述:</b>
• 一键@群组中的所有成员
• 自动处理无用户名用户
• 智能消息分割

🔧 <b>使用方法:</b>
• <code>${getPrefixes()[0]}atall</code> - @群组中的所有成员

⚠️ <b>注意事项:</b>
• 极大封号风险，后果自负
• 大群组中可能会生成很多条消息
• 一般来说你可以通过置顶消息来提醒所有人的`;

class AtAllPlugin extends Plugin {

  description = help_text;
  
  cmdHandlers = {
    atall: async (msg: MessageContext) => {
      try {
        const client = await getGlobalClient();
        if (!client) {
          await msg.edit({ text: "❌ 无法获取客户端" });
          return;
        }

        // 获取当前聊天
        const chat = await msg.getCompleteChat();
        if (!chat) {
          await msg.edit({ text: "❌ 此命令只能在群组中使用" });
          return;
        }

        const chatId = msg.chat.id;
        
        // 显示处理中
        await msg.edit({
          text: "🔄 正在获取群组成员列表...",
        });

        // 获取所有群组成员
        const participants: any[] = [];
        for await (const member of client.iterChatMembers(chatId, {})) {
          participants.push(member);
        }
        
        if (!participants || participants.length === 0) {
          await msg.edit({ 
            text: "❌ 无法获取群组成员或群组为空", 
          });
          return;
        }

        // 生成@列表
        let mentionList: string[] = [];
        
        for (const member of participants) {
          const user = member.user;
          if (user.isBot) continue;
          
          if (user.username) {
            mentionList.push(`@${user.username}`);
          } else {
            let displayName = "";
            if (user.firstName) {
              displayName = user.firstName;
              if (user.lastName) {
                displayName += ` ${user.lastName}`;
              }
            } else {
              continue;
            }
            
            mentionList.push(`<a href="tg://user?id=${user.id}">${htmlEscape(displayName)}</a>`);
          }
        }

        if (mentionList.length === 0) {
          await msg.edit({ 
            text: "❌ 没有可@的成员", 
          });
          return;
        }

        // 更新处理状态
        await msg.edit({
          text: `🔄 正在生成@列表... (${mentionList.length} 个成员)`,
        });

        // 分割消息
        const messageParts = splitMessagesByMention(mentionList, 4000);
        
        // 删除处理中消息
        await msg.delete().catch((e) => { console.error(e) });
        
        // 发送所有消息部分
        for (let i = 0; i < messageParts.length; i++) {
          const part = messageParts[i];
          const messageContent = `<b>@所有人:</b>\n${part}`;
          
          const sendOpts: any = {};
          if (i === 0 && msg.id) sendOpts.replyTo = msg.id;
          await client.sendText(chatId, html(messageContent), sendOpts);
          
          if (i < messageParts.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }

      } catch (error: any) {
        console.error("[AtAll Plugin] Error:", error);
        
        let errorMessage = "❌ <b>发生错误:</b> ";
        if (error.message?.includes("CHAT_ADMIN_REQUIRED")) {
          errorMessage += "需要管理员权限来获取成员列表";
        } else if (error.message?.includes("USER_NOT_PARTICIPANT")) {
          errorMessage += "不是群组成员";
        } else if (error.message?.includes("CHANNEL_PRIVATE")) {
          errorMessage += "无法访问私有频道";
        } else {
          errorMessage += htmlEscape(error.message || "未知错误");
        }
        
        await msg.edit({ 
          text: html(errorMessage), 
        });
      }
    }
  };
}

export default new AtAllPlugin();