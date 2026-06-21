import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { html } from "@mtcute/html-parser";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { JSONFilePreset } from "lowdb/node";
import type { Low } from "lowdb";
import * as path from "path";
import * as fs from "fs";
import axios from "axios";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";

const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

async function getAllDialogs(client: any): Promise<any[]> {
  const dialogMap = new Map<string, any>();

  const collectDialogs = async (params: Record<string, any>) => {
    try {
      const dialogs = await client.getDialogs(params);
      for (const dialog of dialogs || []) {
        const key = `${dialog.id}`;
        if (!dialogMap.has(key)) {
          dialogMap.set(key, dialog);
        }
      }
    } catch (error) {
      logger.error("[AnnualReport] 获取对话列表失败:", error);
    }
  };

  await collectDialogs({});
  await collectDialogs({ folderId: 1 });

  return Array.from(dialogMap.values());
}

class AnnualReportPlugin extends Plugin {
  cleanup(): void {
    // 引用重置：db 由 reload 后重新初始化自动覆盖，无需显式清空。
  }

  async setup(): Promise<void> {
    await this.initDB();
  }

  private readonly PLUGIN_NAME = "annualreport";
  private db!: Awaited<ReturnType<typeof JSONFilePreset<{ startTime: number; reportCount: number }>>>;
  private configPath: string;

  constructor() {
    super();
    this.configPath = path.join(createDirectoryInAssets(this.PLUGIN_NAME), "stats.json");
  }

  private async initDB() {
    this.db = await JSONFilePreset(this.configPath, {
      startTime: Date.now(), // 记录插件首次运行时间
      reportCount: 0
    });
  }

  description = `📊 年度报告插件<br><br>使用 ${getPrefixes()[0]}annualreport 生成您的Telegram年度报告`;

  cmdHandlers = {
    annualreport: this.handleAnnualReport.bind(this)
  };

  private async getChatCount(client: any): Promise<{private: number, group: number, bots: number, channel: number}> {
    let privateCount = 0, groupCount = 0, botsCount = 0, channelCount = 0;
    
    try {
      const dialogs = await getAllDialogs(client);
      
      for (const dialog of dialogs) {
        if (dialog.isUser) {
          if (dialog.entity && dialog.entity.bot) {
            botsCount++;
          } else {
            privateCount++;
          }
        } else if (dialog.isGroup) {
          groupCount++;
        } else if (dialog.isChannel) {
          channelCount++;
        }
      }
    } catch (error) {
      logger.error("[AnnualReport] 获取对话统计失败:", error);
    }
    
    return { private: privateCount, group: groupCount, bots: botsCount, channel: channelCount };
  }

  private async getBlockedCount(client: any): Promise<number> {
    try {
      // 使用原始API获取黑名单数量
      const result: any = await client.call({
        _: 'contacts.getBlocked',
        offset: 0,
        limit: 1,
      });
      
      if (result._ === 'contacts.blockedSlice') {
        return result.count;
      } else if (result.users && result.users.length > 0) {
        return result.users.length;
      }
    } catch (error) {
      logger.error("[AnnualReport] 获取黑名单失败:", error);
    }
    
    return 0;
  }

  private getRunDays(): number {
    try {
      // 尝试读取LICENSE文件，如果不存在则使用插件安装时间
      const licensePath = path.join(process.cwd(), "LICENSE");
      if (fs.existsSync(licensePath)) {
        const stats = fs.statSync(licensePath);
        const days = Math.floor((Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24));
        return days;
      }
    } catch (error) {
      logger.error("[AnnualReport] 读取LICENSE文件失败:", error);
    }
    
    // 使用插件安装时间作为备选
    const installTime = this.db?.data?.startTime || Date.now();
    const days = Math.floor((Date.now() - installTime) / (1000 * 60 * 60 * 24));
    return days;
  }

  private getPluginCount(): number {
    try {
      // 统计用户插件
      const userPluginPath = path.join(process.cwd(), "plugins");
      let userPlugins = 0;
      if (fs.existsSync(userPluginPath)) {
        userPlugins = fs.readdirSync(userPluginPath)
          .filter(file => file.endsWith('.ts') && !file.startsWith('.'))
          .length;
      }

      // 统计系统插件
      const systemPluginPath = path.join(process.cwd(), "src", "plugin");
      let systemPlugins = 0;
      if (fs.existsSync(systemPluginPath)) {
        systemPlugins = fs.readdirSync(systemPluginPath)
          .filter(file => file.endsWith('.ts') && !file.startsWith('.'))
          .length;
      }

      return userPlugins + systemPlugins;
    } catch (error) {
      logger.error("[AnnualReport] 统计插件数量失败:", error);
      return 0;
    }
  }

  private async getHitokoto(): Promise<string> {
    try {
      const response = await axios.get("https://v1.hitokoto.cn/?charset=utf-8");
      const data = response.data;
      
      let text = `"${htmlEscape(data.hitokoto)}" —— `;
      if (data.from_who) {
        text += htmlEscape(data.from_who);
      }
      if (data.from) {
        text += `「${htmlEscape(data.from)}」`;
      }
      return text;
    } catch (error) {
      logger.error("[AnnualReport] 获取一言失败:", error);
      return '"用代码表达言语的魅力，用代码书写山河的壮丽。" —— 一言「一言开发者中心」';
    }
  }

  private getYear(): string {
    const now = new Date();
    let year = now.getFullYear();
    if (now.getMonth() === 0) { // 1月
      year -= 1;
    }
    return year.toString();
  }

  private async handleAnnualReport(msg: MessageContext): Promise<void> {
    if (!this.db) return;
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: html`❌ 无法获取客户端` });
      return;
    }

    await msg.edit({ text: html`🔄 加载中请稍候。。。` });

    try {
      // 更新报告计数
      if (this.db) {
        this.db.data.reportCount += 1;
        await this.db.write();
      }

      const year = this.getYear();
      const chatStats = await this.getChatCount(client);
      const days = this.getRunDays();
      const pluginCount = this.getPluginCount();
      const blockedCount = await this.getBlockedCount(client);
      
      // 获取用户信息
      const user = await client.getMe();
      let userName = "";
      if (user.username) {
        userName = `@${user.username}`;
      } else if (user.firstName && user.lastName) {
        userName = `${user.firstName} ${user.lastName}`;
      } else {
        userName = user.firstName || "未知用户";
      }

      const isPremium = user.isPremium || false;
      const premiumText = isPremium ? "你已成为TG大会员用户，愿新一年继续享受专属特权" : "";
      
      const blockedText = blockedCount < 20 ? "你的账户真的很干净" : "愿明年的spam少一些";
      
      const hitokotoText = await this.getHitokoto();

      // 构建报告消息
      const reportText = `
<b>${htmlEscape(userName)} 的 ${year} 年度报告</b>

📅 <b>陪伴时光</b>
TeleBox 已陪伴你的 TG ${days} 天
安装了 ${pluginCount} 个插件，为你的使用体验增光添彩

👥 <b>社交网络</b>
你邂逅了 ${chatStats.channel} 个频道，${chatStats.group} 个群组
遇见了 ${chatStats.private} 个有趣的灵魂，使用了 ${chatStats.bots} 个机器人
愿你的生活每天都像庆典一样开心

🛡️ <b>安全守护</b>
你的黑名单里有 ${blockedCount} 人
${blockedText}
${premiumText ? `\n⭐ <b>会员特权</b>\n${premiumText}\n` : ''}
💫 <b>年度寄语</b>
${hitokotoText}

<code>#${year}年度报告</code>`.trim();

      await msg.edit({ text: html(reportText) });

    } catch (error: unknown) {
      logger.error("[AnnualReport] 生成报告失败:", error);
      await msg.edit({ 
        text: html`❌ <b>生成报告失败:</b> ${htmlEscape(getErrorMessage(error) || "未知错误")}`
      });
    }
  }
}

export default new AnnualReportPlugin();