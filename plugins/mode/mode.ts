/**
 * @file messageMode.ts
 * @description 消息格式化插件（支持 per-chat 模式、全局模式、白名单、黑名单、频道身份）
 */

"use strict";

import _ from "lodash";
import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { html } from "@mtcute/html-parser";
import { logger } from "@utils/logger";
import {
  createDirectoryInAssets,
} from "@utils/pathHelpers";
import { JSONFilePreset } from "lowdb/node";
import type { Low } from "lowdb";
import * as path from "path";

/* ===================== prefix ===================== */

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const pluginName = "mode";
const commandName = `${mainPrefix}${pluginName}`;

const htmlEscape = (text: string): string =>
  String(text).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#x27;",
  }[m] || m));

/* ===================== Help Menu ===================== */

const help_text = `
📌 <b>消息模式插件（支持 per-chat / 白名单 / 黑名单）</b>

🧭 查看当前会话模式
<code>${commandName}</code>

🎨 设置当前会话模式
<code>${commandName} del</code> 删除线  
<code>${commandName} bold</code> 加粗  
<code>${commandName} italic</code> 斜体  
<code>${commandName} underline</code> 下划线  
<code>${commandName} mask</code> 遮罩  
<code>${commandName} all</code> 全格式  
<code>${commandName} off</code> 关闭模式  

————————————————————

📍 白名单（仅这些聊天启用）
<code>${commandName} whitelist add</code>
<code>${commandName} whitelist remove</code>
<code>${commandName} whitelist list</code>

📍 黑名单（这些聊天禁用）
<code>${commandName} blacklist add</code>
<code>${commandName} blacklist remove</code>
<code>${commandName} blacklist list</code>

⚠ 白名单优先级 > 黑名单 > per-chat 模式 > 全局模式

————————————————————

🌐 全局模式（默认应用于未设置模式的会话）
查看：
<code>${commandName} global</code>

设置：
<code>${commandName} global del</code>
<code>${commandName} global off</code>
`;

/* ===================== 模式枚举 ===================== */

enum Mode {
  OFF = "off",
  DEL = "del",
  BOLD = "bold",
  ITALIC = "italic",
  UNDERLINE = "underline",
  MASK = "mask",
  ALL = "all",
}

/* ===================== MarkdownV2 转义 ===================== */

const escHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const escMd = (text: string): string =>
  text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");

/* ===================== 各种格式渲染器 ===================== */

const Renderers: Record<Mode, (t: string) => string> = {
  [Mode.OFF]: (t) => t,
  [Mode.DEL]: (t) => `<s>${t}</s>`,
  [Mode.BOLD]: (t) => `<b>${t}</b>`,
  [Mode.ITALIC]: (t) => `<i>${t}</i>`,
  [Mode.UNDERLINE]: (t) => `<u>${t}</u>`,
  [Mode.MASK]: (t) => `<span class="tg-spoiler">${t}</span>`,
  [Mode.ALL]: (t) => `<u><b><i><s>${t}</s></i></b></u>`,
};

/* ===================== 插件主体 ===================== */

class MessageModePlugin extends Plugin {
  name = "mode";
  description: string = `📌 消息模式插件<br><br>${help_text}`;
  private db!: Awaited<ReturnType<typeof JSONFilePreset<{
    chats: Record<string, Mode>;
    whitelist: string[];
    blacklist: string[];
    globalMode: Mode;
  }>>>;

  constructor() {
    super();
  }

  cleanup(): void {
    // 引用重置：db 由 reload 后重新初始化自动覆盖，无需显式清空。
  }

  async setup(): Promise<void> {
    await this.initDB();
  }

  /* ===================== 初始化数据库 ===================== */

  private async initDB() {
    const dir = createDirectoryInAssets("messageMode");
    const dbPath = path.join(dir, "config.json");

    this.db = await JSONFilePreset(dbPath, {
      chats: {} as Record<string, Mode>,
      whitelist: [] as string[],
      blacklist: [] as string[],
      globalMode: Mode.OFF as Mode,
    });
  }

  /* ===================== per-chat 模式读取与设置 ===================== */

  private getChatMode(chatId: string): Mode {
    return this.db.data.chats[chatId] || Mode.OFF;
  }

  private async setChatMode(chatId: string, mode: Mode) {
    this.db.data.chats[chatId] = mode;
    await this.db.write();
  }

  /* ===================== 白名单 / 黑名单 ===================== */

  private isWhite(chatId: string): boolean {
    return this.db.data.whitelist.includes(chatId);
  }

  private isBlack(chatId: string): boolean {
    return this.db.data.blacklist.includes(chatId);
  }

  /* ===================== 命令处理 ===================== */

  cmdHandlers: Record<string, (msg: MessageContext, trigger?: MessageContext) => Promise<void>> = {
    mode: async (msg: MessageContext) => {
      if (!this.db) await this.initDB();
      const args = msg.text.split(/\s+/);
      const chatId = msg.chat.id.toString();

      /* ======== 查询模式 ======== */
      if (args.length === 1) {
        const mode = this.getChatMode(chatId);
        const global = this.db.data.globalMode;
        const white = this.isWhite(chatId);
        const black = this.isBlack(chatId);

        await msg.edit({
          text: html`🔍 <b>当前会话模式：</b> <code>${mode}</code><br>🌐 <b>全局模式：</b> <code>${global}</code><br>⚪ <b>白名单：</b> ${white ? "✔ 是" : "✖ 否"}<br>⚫ <b>黑名单：</b> ${black ? "✔ 是" : "✖ 否"}`,
        });
        return;
      }

      /* ======== whitelist / blacklist ======== */

      if (args[1] === "whitelist") {
        await this.handleWhiteList(msg, args, chatId);
        return;
      }

      if (args[1] === "blacklist") {
        await this.handleBlackList(msg, args, chatId);
        return;
      }

      /* ======== global 模式 ======== */
      if (args[1] === "global") {
        await this.handleGlobalMode(msg, args);
        return;
      }

      /* ======== 设置当前聊天模式 ======== */

      const modeStr = args[1].toLowerCase();

      if (!Object.values(Mode).includes(modeStr as Mode)) {
        await msg.edit({ text: html(help_text) });
        return;
      }

      await this.setChatMode(chatId, modeStr as Mode);

      await msg.edit({
        text: html`✅ 已将本会话模式设置为： <b>${modeStr}</b>`,
      });
      return;
    },
  };

  /* ===================== 白名单处理 ===================== */

  private async handleWhiteList(msg: MessageContext, args: string[], chatId: string): Promise<void> {
    const list = this.db.data.whitelist;

    switch (args[2]) {
      case "add":
        if (!list.includes(chatId)) list.push(chatId);
        await this.db.write();
        await msg.edit({
          text: html`✔ 已将本会话加入白名单`,
        });
        return;

      case "remove":
        _.remove(list, (x) => x === chatId);
        await this.db.write();
        await msg.edit({
          text: html`✔ 已将本会话移出白名单`,
        });
        return;

      case "list":
        await msg.edit({
          text: html`⚪ 白名单列表：<br><code>${htmlEscape(list.join("<br>")) || "空"}</code>`,
        });
        return;

      default:
        await msg.edit({ text: html(help_text) });
        return;
    }
  }

  /* ===================== 黑名单处理 ===================== */

  private async handleBlackList(msg: MessageContext, args: string[], chatId: string): Promise<void> {
    const list = this.db.data.blacklist;

    switch (args[2]) {
      case "add":
        if (!list.includes(chatId)) list.push(chatId);
        await this.db.write();
        await msg.edit({
          text: html`✔ 已将本会话加入黑名单`,
        });
        return;

      case "remove":
        _.remove(list, (x) => x === chatId);
        await this.db.write();
        await msg.edit({
          text: html`✔ 已将本会话移出黑名单`,
        });
        return;

      case "list":
        await msg.edit({
          text: html`⚫ 黑名单列表：<br><code>${htmlEscape(list.join("<br>")) || "空"}</code>`,
        });
        return;

      default:
        await msg.edit({ text: html(help_text) });
        return;
    }
  }

  /* ===================== 全局模式处理 ===================== */

  private async handleGlobalMode(msg: MessageContext, args: string[]): Promise<void> {
    if (args.length === 2) {
      const g = this.db.data.globalMode;
      await msg.edit({
        text: html`🌐 <b>全局模式：</b> <code>${g}</code>`,
      });
      return;
    }

    const modeStr = args[2].toLowerCase();

    if (!Object.values(Mode).includes(modeStr as Mode)) {
      await msg.edit({ text: html(help_text) });
      return;
    }

    this.db.data.globalMode = modeStr as Mode;
    await this.db.write();

    await msg.edit({
      text: html`🌐 全局模式已更新为：<b>${modeStr}</b>`,
    });
    return;
  }

  /* ===================== 监听所有消息 ===================== */

  listenMessageHandler = async (msg: MessageContext) => {
    if (!this.db) await this.initDB();
    // 检查是否是自己的消息（支持 saved messages）
    const isOwnMessage = msg.isOutgoing;
    if (!isOwnMessage) return;
    if (!msg.text) return;

    const chatId = msg.chat.id.toString();

    /* ======== 白名单优先级（只处理白名单） ======== */
    if (this.db.data.whitelist.length > 0 && !this.isWhite(chatId)) {
      return;
    }

    /* ======== 黑名单 ======== */
    if (this.isBlack(chatId)) {
      return;
    }

    /* ======== 当前聊天模式 ======== */
    let mode = this.getChatMode(chatId);

    /* 如果当前模式为 off → 使用 globalMode */
    if (mode === Mode.OFF) {
      mode = this.db.data.globalMode;
      if (mode === Mode.OFF) return; // 全局也关闭
    }

    const raw = msg.text.trim();

    /* 跳过命令（动态前缀或 / 开头） */
    const dynamicPrefixes = getPrefixes();
    if (raw.startsWith("/") || dynamicPrefixes.some((p) => raw.startsWith(p))) return;

    // 遮罩模式使用 MarkdownV2，其它模式使用 HTML
    if (mode === Mode.MASK) {
      const escaped = escMd(raw);
      const styled = `||${escaped}||`;
      try {
        await msg.edit({ text: styled });
      } catch (err) {
        logger.error("消息编辑失败：", err);
      }
      return;
    }

    const escaped = escHtml(raw);
    const styled = Renderers[mode](escaped);

    try {
      /* Userbot 对自己消息可直接编辑 */
      await msg.edit({ text: html(styled) });
    } catch (err) {
      logger.error("消息编辑失败：", err);
    }
  };

  listenMessageHandlerIgnoreEdited = true;
}

export default new MessageModePlugin();
