import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { html } from "@mtcute/html-parser";
import type { MessageContext } from "@mtcute/dispatcher";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { logger } from "@utils/logger";
import { sleep } from "@utils/asyncHelpers";
import { SureDB, type MsgRecord } from "@utils/sureDB";
import { htmlEscape } from "@utils/htmlEscape";
import {
  dealCommandPluginWithMessage,
  getCommandFromMessage,
} from "@utils/pluginManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 简单缓存 sure 用户 ID，减少频繁 IO
let sureCache = {
  ids: [] as number[],
  cids: [] as number[],
  msgs: [] as MsgRecord[],
  ts: 0,
};
const SURE_CACHE_TTL = 10_000; // 10s

function withSureDB<T>(fn: (db: SureDB) => T): T {
  const db = new SureDB();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
function refreshSureCache() {
  sureCache.ids = withSureDB((db) => db.ls().map((u) => u.uid));
  sureCache.cids = withSureDB((db) => db.lsChats().map((u) => u.id));
  sureCache.msgs = withSureDB((db) => db.lsMsgs());
  sureCache.ts = Date.now();
}
function getSureIds() {
  if (Date.now() - sureCache.ts > SURE_CACHE_TTL) refreshSureCache();
  return sureCache.ids;
}
function getSureCids() {
  if (Date.now() - sureCache.ts > SURE_CACHE_TTL) refreshSureCache();
  return sureCache.cids;
}
function getSureMsgs() {
  if (Date.now() - sureCache.ts > SURE_CACHE_TTL) refreshSureCache();
  return sureCache.msgs;
}

interface DisplayEntity {
  id?: number;
  title?: string;
  firstName?: string;
  lastName?: string;
  username?: string | null;
  type?: string;
}

function buildDisplay(
  id: number,
  entity: DisplayEntity | null | undefined,
  isUser: boolean,
  mention?: boolean,
) {
  const parts: string[] = [];
  if (entity?.title) parts.push(htmlEscape(entity.title));
  if (entity?.firstName) parts.push(htmlEscape(entity.firstName));
  if (entity?.lastName) parts.push(htmlEscape(entity.lastName));
  if (entity?.username)
    parts.push(
      mention ? `@${htmlEscape(entity.username)}` : `<code>@${htmlEscape(entity.username)}</code>`,
    );
  parts.push(
    isUser
      ? `<a href="tg://user?id=${id}">${id}</a>`
      : `<a href="https://t.me/c/${id}">${id}</a>`,
  );
  return parts.join(" ").trim();
}

async function handleAddDel(
  msg: MessageContext,
  target: string,
  action: "add" | "del",
) {
  let entity: DisplayEntity | null | undefined;
  let uid: number | undefined;
  let display: string = "";
  if (target) {
    try {
      entity = await msg.client?.getChat(target);
      uid = entity?.id;
      if (!uid) {
        await msg.edit({ text: "无法获取用户 ID" });
        return;
      }
      uid = Number(uid);
      display = buildDisplay(uid, entity, entity?.type === "user");
    } catch (e: unknown) {
      await msg.edit({ text: "无法获取用户信息" });
      return;
    }
  } else {
    if (!msg.replyToMessage) {
      await msg.edit({ text: "请回复目标用户的消息或带上 uid/@username" });
      return;
    }
    const reply = await safeGetReplyMessage(msg);
    if (!reply) {
      await msg.edit({ text: "无法获取回复消息" });
      return;
    }
    uid = reply.sender?.id;
    if (!uid) {
      await msg.edit({ text: "无法获取用户 ID" });
      return;
    }
    try {
      entity = await msg.client?.getChat(uid);
    } catch (e: unknown) {
      logger.error("[sure] operation failed:", e);
    }
    display = buildDisplay(uid, entity, reply.sender?.type === "user");
  }

  withSureDB((db) => {
    if (action === "add") db.add(uid, display);
    else db.del(uid);
  });
  sureCache.ts = 0; // 失效缓存

  await msg.edit({
    text: html`已${action === "add" ? "添加" : "删除"}: ${display}`,
  });
  await msg.deleteWithDelay(5000);
}

async function handleList(msg: MessageContext) {
  const users = withSureDB((db) => db.ls());
  if (users.length === 0) {
    await msg.edit({ text: "当前没有任何用户" });
    return;
  }
  await msg.edit({
    text: html`当前用户列表：<br><br>
${users.map((u) => "- " + u.username).join("<br>")}`,
  });
}
async function handleChatAddDel(
  msg: MessageContext,
  target: string | undefined,
  action: "add" | "del",
) {
  let entity: DisplayEntity | null | undefined;
  let cid: number | undefined;
  let display: string = "";
  if (target) {
    try {
      entity = await msg.client?.getChat(target);
      cid = entity?.id;
      if (!cid) {
        await msg.edit({ text: "无法获取对话 ID" });
        return;
      }
      cid = Number(cid);
      display = buildDisplay(cid, entity, entity?.type === "user");
    } catch (e: unknown) {
      await msg.edit({ text: "无法获取对话信息" });
      return;
    }
  } else {
    cid = msg.chat.id;
    if (!cid) {
      await msg.edit({ text: "无法获取对话 ID" });
      return;
    }
    try {
      entity = await msg.client?.getChat(cid);
    } catch (e: unknown) {
      logger.error("[sure] operation failed:", e);
    }
    display = buildDisplay(cid, entity, msg.chat?.type === "user");
  }

  withSureDB((db) => {
    if (action === "add") db.addChat(cid, display);
    else db.delChat(cid);
  });
  sureCache.ts = 0; // 失效缓存

  await msg.edit({
    text: html`已${action === "add" ? "添加" : "删除"}: ${display}`,
  });
  await msg.deleteWithDelay(5000);
}
async function handleChatList(msg: MessageContext) {
  const chats = withSureDB((db) => db.lsChats());
  if (chats.length === 0) {
    await msg.edit({ text: "⚠️ 未设置对话白名单, 所有对话中均可使用" });
    return;
  }
  await msg.edit({
    text: html`对话白名单列表：<br><br>
${chats.map((c) => "- " + c.name).join("<br>")}`,
  });
}
async function handleMsgAddDel(
  msg: MessageContext,
  input: string,
  action: "add" | "del",
  id?: string,
) {
  let raw;
  withSureDB((db) => {
    if (action === "add") {
      if (id) {
        raw = db.lsMsgs().find((m) => m.id === Number(id))?.msg;
        if (!raw) throw new Error(`找不到 ID 为 ${id} 的消息`);
        db.addMsg(raw, input);
      } else {
        db.addMsg(input);
      }
    } else {
      const found = db.lsMsgs().find((m) => m.msg === input);
      if (found) {
        db.delMsg(found.id);
      } else {
        throw new Error(`找不到消息: ${input}`);
      }
    }
  });
  sureCache.ts = 0; // 失效缓存

  await msg.edit({
    text:
      raw && !input
        ? `已清除 ${raw} 的重定向`
        : html`已${action === "add" ? "添加" : "删除"}: <code>${raw ? `${htmlEscape(raw)} -> ${htmlEscape(input)}` : htmlEscape(input)}</code>`,
  });
  await msg.deleteWithDelay(5000);
}
async function handleMsgList(msg: MessageContext) {
  const msgs = withSureDB((db) => db.lsMsgs());
  if (msgs.length === 0) {
    await msg.edit({ text: "⚠️ 未设置消息白名单 需设置消息白名单方可使用" });
    return;
  }
  await msg.edit({
    text: html`消息白名单列表：<br><br>
${msgs
  .map(
    (m) =>
      `<code>${m.id}</code>: <code>${m.msg}</code>${
        m.redirect ? ` -> <code>${m.redirect}</code>` : ""
      }`,
  )
  .join("<br>")}`,
  });
}

class surePlugin extends Plugin {
  cleanup(): void {
    // 真实资源清理：清空模块级 sure 运行时缓存。
    sureCache.ids = [];
    sureCache.cids = [];
    sureCache.msgs = [];
    sureCache.ts = 0;
  }

  description: string = `赋予其他用户使用 bot 身份发送消息(支持重定向)的权限<br><code>${mainPrefix}sure add (回复目标用户的消息或带上 uid/@username)</code> - 添加用户<br><code>${mainPrefix}sure del (回复目标用户的消息或带上 uid/@username)</code> - 删除用户<br><code>${mainPrefix}sure ls</code> - 列出所有用户<br><br>⚠️ 若未设置对话白名单, 所有对话中均可使用<br><code>${mainPrefix}sure chat add (在当前对话中使用 或带上 id/@name)</code> - 添加对话到白名单<br><code>${mainPrefix}sure chat del (在当前对话中使用 或带上 id/@name)</code> - 从白名单删除对话<br><code>${mainPrefix}sure chat ls/list</code> - 列出对话白名单<br><br>⚠️ 需设置消息白名单方可使用<br><code>${mainPrefix}sure msg add 消息(使用原始字符串, 即可包含空格)</code> - 添加消息白名单<br>⚠️ 若以 <code>_command:</code> 开头, 认为此消息是命令, 即 <code>_command:/sb</code> 可匹配 <code>/sb</code> 和 <code>/sb uid</code>. 若设置了重定向为 <code>/spam</code>, 则会自动变成 <code>/spam</code> 和 <code>/spam uid</code><br><code>${mainPrefix}sure msg redirect ID 重定向消息(使用原始字符串, 即可包含空格)</code> - 使用消息的 ID 为消息设置重定向(设置空即为清除重定向)<br><code>${mainPrefix}sure msg del ID</code> - 使用消息的 ID 从白名单删除消息<br><code>${mainPrefix}sure msg ls/list</code> - 列出消息白名单<br><br>一个典型的使用场景:<br>设置 <code>_command:/sb</code> 重定向到 <code>${mainPrefix}ban</code>, 然后给普通群成员权限, 他们发送 /sb 时, 会自动调用 <code>${mainPrefix}ban</code> 命令`;
  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    sure: async (msg) => {
      const parts = msg.text.trim().split(/\s+/);
      let command = parts[1];
      if (command === "chat") {
        let subCommand = parts[2];
        if (subCommand === "add" || subCommand === "del") {
          await handleChatAddDel(msg, parts[3], subCommand);
          return;
        }
        if (subCommand === "ls" || subCommand === "list") {
          await handleChatList(msg);
          return;
        }
      }
      if (command === "msg") {
        let subCommand = parts[2];
        if ((subCommand === "add" || subCommand === "del") && parts[3]) {
          if (subCommand === "del" && (!parts[3] || isNaN(Number(parts[3])))) {
            await msg.edit({ text: "请提供正确的消息 ID" });
            return;
          }
          const subCommandTxt = ` ${subCommand} `;
          const input = msg.text.substring(
            msg.text.indexOf(subCommandTxt) + subCommandTxt.length,
          );
          if (input) {
            await handleMsgAddDel(msg, input, subCommand);
          }
          return;
        }
        if (subCommand === "redirect") {
          const id = parts[3];
          if (!id || isNaN(Number(id))) {
            await msg.edit({ text: "请提供正确的消息 ID" });
            return;
          }
          const subCommandTxt = ` ${id} `;
          const input = parts[4]
            ? msg.text.substring(
                msg.text.indexOf(subCommandTxt) + subCommandTxt.length,
              )
            : "";
          if (id) {
            await handleMsgAddDel(msg, input, "add", id);
          }
          return;
        }
        if (subCommand === "ls" || subCommand === "list") {
          await handleMsgList(msg);
          return;
        }
      }
      let target = parts[2];
      if (command === "add" || command === "del") {
        await handleAddDel(msg, target, command);
        return;
      }
      if (command === "ls" || command === "list") {
        await handleList(msg);
        return;
      }
      await msg.edit({
        text: html`未知命令, `,
      });
    },
  };

  listenMessageHandler?: (msg: MessageContext, options?: { isEdited?: boolean }) => Promise<void> =
    async (msg) => {
      if (msg.forward) return;
      const uid = msg.sender?.id;
      const cid = msg.chat.id;
      if (!uid || !cid) return;
      if (!getSureIds().includes(uid)) return;
      const cids = getSureCids();
      if (cids.length > 0 && !cids.includes(cid)) return;
      const msgs = getSureMsgs();
      let replacedMsg = null;
      const matchedMsg = msgs.find((m) => {
        if (m.msg.startsWith("_command:")) {
          const prefix = m.msg.replace("_command:", "");
          const isStartsWith = msg.text.startsWith(prefix);
          const suffix = msg.text.replace(prefix, "");
          const matched = isStartsWith && (!suffix || suffix.startsWith(" "));
          if (matched && m.redirect) {
            replacedMsg = msg.text.replace(prefix, m.redirect);
          }
          return matched;
        }
        return m.msg === msg.text;
      });
      if (!matchedMsg) return;

      const message = replacedMsg || matchedMsg.redirect || msg.text;
      const cmd = getCommandFromMessage(message);

      const replyInfo = msg.replyToMessage;
      const replyTo =
        replyInfo?.isForumTopic
          ? replyInfo.threadId
          : replyInfo?.id;

      const sudoMsg = await msg.client?.sendText(
        msg.chat.id,
        message,
        replyTo ? { replyTo } : undefined,
      );
      if (cmd && sudoMsg)
        await dealCommandPluginWithMessage({
          cmd,
          msg: sudoMsg as MessageContext,
          trigger: msg,
          isEdited: false,
        });
      await msg.deleteWithDelay(5000);
    };
}
const plugin = new surePlugin();

export default plugin;