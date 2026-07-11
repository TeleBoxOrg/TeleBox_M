import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/runtimeManager";
import { TelegramClient, Message } from "@mtcute/node";
import { html } from "@mtcute/html-parser";
import type { MessageContext } from "@mtcute/dispatcher";
import type { Peer, User, Chat } from "@mtcute/node";
import { safeGetMessages, safeGetReplyMessage } from "@utils/safeGetMessages";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInTemp } from "@utils/pathHelpers";
import * as fs from "fs";
import * as path from "path";
import { safeGetMe } from "../utils/authGuards";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";
import { htmlEscape } from "@utils/htmlEscape";
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

/** Resolve a peer (user or chat) – replaces gramjs's getEntity */
async function resolvePeer(client: TelegramClient, input: string | number | Peer): Promise<Peer | null> {
  try {
    return await client.getPeer(input);
  } catch (e: unknown) {
    return null;
  }
}

/** Narrow a Peer to User if applicable */
function isUser(peer: Peer | null | undefined): peer is User {
  return peer !== null && peer !== undefined && peer.type === "user";
}

/** Narrow a Peer to Chat if applicable */
function isChat(peer: Peer | null | undefined): peer is Chat {
  return peer !== null && peer !== undefined && peer.type === "chat";
}

class DebugPlugin extends Plugin {

  description: string = `<code>${mainPrefix}id 回复一条消息 或 留空查看当前对话 或 消息链接 或 用户名 或 群组ID</code> - 获取详细的用户、群组或频道信息
<code>${mainPrefix}entity [id/@name] 或 回复一条消息 或 留空查看当前对话</code> - 获取 entity 信息
<code>${mainPrefix}msg 回复一条消息</code> - 获取 msg 信息
<code>${mainPrefix}echo 回复一条消息</code> - 尝试以原样回复
`;
  cmdHandlers: Record<
    string,
    (msg: MessageContext, trigger?: MessageContext) => Promise<void>
  > = {
    id: async (msg) => {
      const client = await getGlobalClient();
      let targetInfo = "";

      try {
        const [cmd, ...args] = msg.text.trim().split(/\s+/);
        const messageLink = args.join(" ");

        // 检查是否提供了参数（链接、用户名或群组ID）
        if (messageLink) {
          let parseResult: ParseResult | null = null;

          // 优先尝试解析Telegram链接
          if (messageLink.includes("t.me/")) {
            parseResult = await parseTelegramLink(client, messageLink);
          } 
          // 检查是否为群组ID（数字格式）
          else if (/^-?\d+$/.test(messageLink)) {
            const parsedInfo = await parseGroupId(client, messageLink);
            targetInfo = parsedInfo;
          } 
          else {
            // 直接输入用户名，尝试解析实体
            try {
              const username = messageLink.startsWith("@")
                ? messageLink
                : `@${messageLink}`;
              const entity = await client.getPeer(username);
              parseResult = {
                type: "entity",
                data: entity,
                info: `解析用户名成功 - ${username}`,
              };
            } catch (error: unknown) {
              parseResult = {
                type: "entity",
                data: null,
                info: `解析用户名失败: ${getErrorMessage(error)}`,
              };
            }
          }

          // 只有非群组ID的情况才处理parseResult
          if (!/^-?\d+$/.test(messageLink)) {
            if (parseResult && parseResult.data) {
              if (parseResult.type === "message") {
                // 消息链接解析结果
                const parsedMsg = parseResult.data as Message;
                targetInfo += `🔗 ${parseResult.info}<br><br>`;

                if (parsedMsg.sender) {
                  const [userInfo, msgInfo, chatInfo] = await Promise.all([
                    formatUserInfo(
                      client,
                      parsedMsg.sender.id,
                      "LINK MESSAGE SENDER",
                      true
                    ),
                    formatMessageInfo(parsedMsg),
                    formatChatInfo(client, parsedMsg),
                  ]);
                  targetInfo += userInfo;
                  targetInfo += "<br>";
                  targetInfo += msgInfo;
                  targetInfo += "<br>";
                  targetInfo += chatInfo;
                } else {
                  const [msgInfo, chatInfo] = await Promise.all([
                    formatMessageInfo(parsedMsg),
                    formatChatInfo(client, parsedMsg),
                  ]);
                  targetInfo += msgInfo;
                  targetInfo += "<br>";
                  targetInfo += chatInfo;
                }
              } else if (parseResult.type === "entity") {
                // 实体链接解析结果
                const entity = parseResult.data as Peer;
                targetInfo += `🔗 ${parseResult.info}<br><br>`;
                targetInfo += await formatEntityInfo(entity);
              }
            } else {
              targetInfo = `❌ ${parseResult?.info || "无法解析链接或用户名"}`;
            }
          }
        } else {
          // 原有逻辑：如果有回复消息，优先显示回复信息
          if (msg.replyToMessage) {
            const repliedMsg = await safeGetReplyMessage(msg);
            if (repliedMsg?.sender) {
              targetInfo += await formatUserInfo(
                client,
                repliedMsg.sender.id,
                "REPLIED USER",
                true
              );
              targetInfo += "<br>";
            }
          }

          // 显示消息详细信息 — 并行获取消息信息、自身信息和聊天信息
          const [msgInfo, selfInfo, chatInfo] = await Promise.all([
            formatMessageInfo(msg),
            !msg.replyToMessage ? formatSelfInfo(client) : Promise.resolve(""),
            formatChatInfo(client, msg),
          ]);
          targetInfo += msgInfo;
          targetInfo += "<br>";

          if (!msg.replyToMessage) {
            // 没有回复消息时，显示自己的信息
            targetInfo += selfInfo;
            targetInfo += "<br>";
          }

          // 显示聊天信息
          targetInfo += chatInfo;
        }

        await msg.edit({
          text: html(targetInfo),
        });
      } catch (error: unknown) {
        await msg.edit({
          text: `获取信息时出错: ${getErrorMessage(error)}`,
        });
      }
    },

    entity: async (msg, trigger) => {
      const [cmd, ...args] = msg.text.trim().split(/\s+/);
      const input = args.join("");
      const reply = await safeGetReplyMessage(msg);
      const peerInput = input || String(reply?.sender?.id || msg.chat.id);
      let entity: Peer | null = null;
      try {
        entity = await msg.client.getPeer(peerInput);
      } catch (e: unknown) {
        entity = null;
      }

      const txt = JSON.stringify(entity, null, 2);
      logger.info(txt);

      try {
        await msg.edit({
          text: html`<blockquote expandable>${htmlEscape(txt)}</blockquote>`,
        });
      } catch (error: unknown) {
        // 如果编辑失败且是因为消息过长，则发送文件
        if (
          getErrorMessage(error) &&
          (getErrorMessage(error).includes("MESSAGE_TOO_LONG") ||
            getErrorMessage(error).includes("too long"))
        ) {
          const buffer = Buffer.from(txt, "utf-8");
          const dir = createDirectoryInTemp("exit");

          const filename = `entity_${entity?.id ?? "unknown"}.json`;
          const filePath = path.join(dir, filename);
          fs.writeFileSync(filePath, buffer);
          await (trigger || msg).replyMedia({
            type: "document",
            file: filePath,
            caption: filename,
          });
          fs.unlinkSync(filePath);
        } else {
          // 其他错误则重新抛出
          throw error;
        }
      }
    },
    msg: async (msg, trigger) => {
      const reply = await safeGetReplyMessage(msg);
      if (!reply) {
        await msg.edit({
          text: `请回复一条消息以获取详细信息。`,
        });
        return;
      }
      const txt = JSON.stringify(reply, null, 2);
      logger.info(txt);

      try {
        await msg.edit({
          text: html`<blockquote expandable>${htmlEscape(txt)}</blockquote>`,
        });
      } catch (error: unknown) {
        // 如果编辑失败且是因为消息过长，则发送文件
        if (
          getErrorMessage(error) &&
          (getErrorMessage(error).includes("MESSAGE_TOO_LONG") ||
            getErrorMessage(error).includes("too long"))
        ) {
          const buffer = Buffer.from(txt, "utf-8");
          const dir = createDirectoryInTemp("exit");

          const filename = `msg_${reply.id}.json`;
          const filePath = path.join(dir, filename);
          fs.writeFileSync(filePath, buffer);
          await (trigger || msg).replyMedia({
            type: "document",
            file: filePath,
            caption: filename,
          });
          fs.unlinkSync(filePath);
        } else {
          // 其他错误则重新抛出
          throw error;
        }
      }
    },


    echo: async (msg, trigger) => {
      const reply = await safeGetReplyMessage(msg);
      if (!reply) {
        await msg.edit({
          text: `请回复一条消息以尝试原样发出`,
        });
        return;
      }

      // mtcute: use copy (re-send with original formatting) or sendText/sendMedia
      const target = trigger || msg;
      try {
        if (reply.media) {
          // Use copy to re-send media messages with original formatting
          await target.copy({
            toChatId: msg.chat.id,
          });
        } else {
          // Text-only message: send with original entities
          await target.replyText(reply.textWithEntities || reply.text);
        }
      } catch (e: unknown) {
        logger.warn("[debug.echo] 发送消息失败", e);
        // Fallback: just try plain text
        try {
          await target.replyText(reply.text || "");
        } catch (e2: unknown) {
          logger.warn("[debug.echo] 回退发送也失败", e2);
        }
      }
      await msg.delete();
    },
  };
}

// 解析结果接口
interface ParseResult {
  type: "message" | "entity";
  data: Message | Peer | null;
  info?: string;
}

// 深度解析Telegram链接（支持消息链接和实体链接）
async function parseTelegramLink(
  client: TelegramClient,
  link: string
): Promise<ParseResult | null> {
  try {
    const cleanLink = link.trim();

    // 消息链接格式: https://t.me/username/123 或 https://t.me/c/123456/789
    const messageRegex =
      /https?:\/\/t\.me\/(?:c\/)?([^\/]+)\/(\d+)(?:\?[^#]*)?(?:#.*)?$/;
    const messageMatch = cleanLink.match(messageRegex);

    if (messageMatch) {
      const [, chatIdentifier, messageId] = messageMatch;
      let chatId: string;

      if (cleanLink.includes("/c/")) {
        // 私有群组/频道链接: https://t.me/c/1272003941/940776
        chatId = `-100${chatIdentifier}`;
      } else {
        // 公开频道/群组链接: https://t.me/username/123
        chatId = chatIdentifier.startsWith("@")
          ? chatIdentifier
          : `@${chatIdentifier}`;
      }

      const messages = await safeGetMessages(client, chatId, {
        ids: [parseInt(messageId)],
      });

      if (messages.length > 0) {
        return {
          type: "message",
          data: messages[0],
          info: `解析消息链接成功 - Chat: ${chatId}, Message: ${messageId}`,
        };
      }
    }

    // 实体链接格式: https://t.me/username 或 https://t.me/joinchat/xxx
    const entityRegex = /https?:\/\/t\.me\/([^\/\?#]+)(?:\?[^#]*)?(?:#.*)?$/;
    const entityMatch = cleanLink.match(entityRegex);

    if (entityMatch) {
      const [, identifier] = entityMatch;

      // 处理 joinchat 链接
      if (identifier.startsWith("joinchat/")) {
        return {
          type: "entity",
          data: null,
          info: `暂不支持 joinchat 链接解析`,
        };
      }

      // 解析用户名或频道
      const username = identifier.startsWith("@")
        ? identifier
        : `@${identifier}`;
      const entity = await client.getPeer(username);

      return {
        type: "entity",
        data: entity,
        info: `解析实体链接成功 - ${username}`,
      };
    }

    return null;
  } catch (error: unknown) {
    logger.error("解析链接失败:", error);
    return {
      type: "entity",
      data: null,
      info: `解析失败: ${getErrorMessage(error)}`,
    };
  }
}

// 格式化实体信息
async function formatEntityInfo(entity: Peer): Promise<string> {
  try {
    let info = "";

    if (isUser(entity)) {
      info += `<b>USER</b><br>`;
      info +=
        `· Name: ${htmlEscape(entity.firstName || "")} ${htmlEscape(entity.lastName || "")}`.trim() +
        "<br>";
      info += `· Username: ${
        entity.username ? "@" + htmlEscape(entity.username) : "N/A"
      }<br>`;
      info += `· ID: <code>${entity.id}</code><br>`;
      if (entity.isBot) info += `· Type: Bot<br>`;
      if (entity.isVerified) info += `· Verified<br>`;
      if (entity.isPremium) info += `· Premium<br>`;
    } else if (isChat(entity)) {
      const isChannel = entity.chatType === "channel";
      info += `<b>${isChannel ? "CHANNEL" : "SUPERGROUP"}</b><br>`;
      info += `· Title: ${htmlEscape(entity.title)}<br>`;
      info += `· Username: ${
        entity.username ? "@" + htmlEscape(entity.username) : "N/A"
      }<br>`;
      const entityId = entity.id.toString();
      const fullId = entityId.startsWith("-100") ? entityId : `-100${entityId}`;
      info += `· ID: <code>${fullId}</code><br>`;
      if (entity.isVerified) info += `· Verified<br>`;
      if (entity.membersCount)
        info += `· Members: ${entity.membersCount}<br>`;
    } else {
      info += `<b>ENTITY</b><br>`;
      const genericEntity = entity as Peer;
      info += `· Type: ${genericEntity.type}<br>`;
      info += `· ID: <code>${genericEntity.id}</code><br>`;
    }

    return info;
  } catch (error: unknown) {
    return `❌ 格式化实体信息失败: ${getErrorMessage(error)}`;
  }
}

// 格式化消息信息
async function formatMessageInfo(msg: Message): Promise<string> {
  try {
    let info = `<b>MESSAGE</b><br>`;

    if (msg.replyToMessage?.id) {
      info += `· Reply to: <code>${msg.replyToMessage.id}</code><br>`;
    }

    info += `· ID: <code>${msg.id}</code><br>`;
    info += `· Sender: <code>${msg.sender?.id || "N/A"}</code><br>`;
    info += `· Chat: <code>${msg.chat?.id || "N/A"}</code><br>`;

    if (msg.date) {
      info += `· Time: ${msg.date.toLocaleString("zh-CN")}<br>`;
    }

    // 增强转发消息信息显示
    if (msg.forward) {
      const fwd = msg.forward;
      info += `<br><b>FORWARD INFO</b><br>`;
      
      // 原始发送者信息
      const fwdSender = fwd.sender;
      if (fwdSender) {
        if (isUser(fwdSender as Peer)) {
          const user = fwdSender as User;
          const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ") || "N/A";
          info += `· Original Name: ${htmlEscape(fullName)}<br>`;
          if (user.username) {
            info += `· Original Username: @${htmlEscape(user.username)}<br>`;
          }
          info += `· Original Sender ID: <code>${user.id}</code><br>`;
        } else if (isChat(fwdSender as Peer)) {
          const chat = fwdSender as Chat;
          info += `· Original Channel: ${htmlEscape(chat.title)}<br>`;
          if (chat.username) {
            info += `· Original Username: @${htmlEscape(chat.username)}<br>`;
          }
          const channelId = chat.id.toString();
          const fullChannelId = channelId.startsWith("-100") ? channelId : `-100${channelId}`;
          info += `· Original Chat ID: <code>${fullChannelId}</code><br>`;
        } else {
          // AnonymousSender
          if ('displayName' in fwdSender && typeof fwdSender.displayName === 'string') {
            info += `· Hidden User: ${htmlEscape(fwdSender.displayName)}<br>`;
          }
        }
      }
      
      // 原始消息ID（用于频道消息）
      if (fwd.fromMessageId) {
        info += `· Original Message ID: <code>${fwd.fromMessageId}</code><br>`;
      }
      
      // 转发时间
      info += `· Forward Time: ${fwd.date.toLocaleString("zh-CN")}<br>`;
      
      // 如果有签名
      if (fwd.signature) {
        info += `· Post Author: ${htmlEscape(fwd.signature)}<br>`;
      }
    }

    return info;
  } catch (error: unknown) {
    return `<b>MESSAGE</b><br>Error: ${getErrorMessage(error)}<br>`;
  }
}

// 格式化用户信息
async function formatUserInfo(
  client: TelegramClient,
  userId: number | string,
  title: string = "USER",
  showCommonGroups: boolean = true
): Promise<string> {
  try {
    const peer = await resolvePeer(client, userId);
    let info = `<b>${title}</b><br>`;

    if (peer && isUser(peer)) {
      const fullName =
        [peer.firstName, peer.lastName].filter(Boolean).join(" ") ||
        "N/A";

      info += `· Name: ${htmlEscape(fullName)}<br>`;
      info += `· Username: ${
        peer.username ? "@" + htmlEscape(peer.username) : "N/A"
      }<br>`;
      info += `· ID: <code>${peer.id}</code><br>`;

      if (peer.isBot) info += `· Type: Bot<br>`;
      if (peer.isVerified) info += `· Verified<br>`;
      if (peer.isPremium) info += `· Premium<br>`;
    } else if (peer && isChat(peer)) {
      info += `· ID: <code>${peer.id}</code><br>`;
      info += `· Type: ${peer.chatType}<br>`;
      info += `· Title: ${htmlEscape(peer.title)}<br>`;
    } else {
      info += `· ID: <code>${userId}</code><br>`;
      info += `· Type: Unknown<br>`;
    }

    return info;
  } catch (error: unknown) {
    return `<b>${title}</b><br>Error: ${getErrorMessage(error)}<br>`;
  }
}

// 格式化自己的信息
async function formatSelfInfo(client: TelegramClient): Promise<string> {
  try {
    const me = await safeGetMe(client);
    if (!me) return "";
    return await formatUserInfo(client, me.id, "SELF", false);
  } catch (error: unknown) {
    return `<b>SELF</b><br>Error: ${getErrorMessage(error)}<br>`;
  }
}

// 格式化聊天信息
async function formatChatInfo(
  client: TelegramClient,
  msg: Message
): Promise<string> {
  try {
    if (!msg.chat?.id) {
      return `<b>CHAT</b><br>Error: No chat ID<br>`;
    }

    const peer = await resolvePeer(client, msg.chat.id);
    if (!peer) {
      return `<b>CHAT</b><br>Error: Could not resolve chat<br>`;
    }
    let info = "";

    if (isUser(peer)) {
      info += await formatUserInfo(client, peer.id, "PRIVATE", false);
    } else if (isChat(peer)) {
      if (peer.chatType === "group") {
        info += `<b>GROUP</b><br>`;
        info += `· Title: ${htmlEscape(peer.title)}<br>`;
        const groupId = peer.id.toString();
        const fullGroupId = groupId.startsWith("-") ? groupId : `-${groupId}`;
        info += `· ID: <code>${fullGroupId}</code><br>`;
      } else {
        // channel or supergroup
        const isChannel = peer.chatType === "channel";
        info += `<b>${isChannel ? "CHANNEL" : "GROUP"}</b><br>`;
        info += `· Title: ${htmlEscape(peer.title)}<br>`;
        info += `· Username: ${
          peer.username ? "@" + htmlEscape(peer.username) : "N/A"
        }<br>`;
        const chatId = peer.id.toString();
        const fullChatId = chatId.startsWith("-100") ? chatId : `-100${chatId}`;
        info += `· ID: <code>${fullChatId}</code><br>`;

        if (peer.isVerified) {
          info += `· Verified<br>`;
        }
      }
    }

    return info;
  } catch (error: unknown) {
    return `<b>CHAT</b><br>Error: ${getErrorMessage(error)}<br>`;
  }
}

// 解析群组ID功能
async function parseGroupId(client: TelegramClient, chatId: string): Promise<string> {
  try {
    let info = `🆔 <b>群组ID解析结果</b><br><br>`;
    info += `· 输入ID: <code>${chatId}</code><br>`;

    // 尝试获取群组信息
    let entity: Peer | null = null;
    let entityFound = false;
    
    try {
      entity = await client.getPeer(chatId);
      entityFound = true;
    } catch (error: unknown) {
      info += `· 状态: ❌ 无法访问此群组<br>`;
      info += `· 错误: ${getErrorMessage(error)}<br><br>`;
    }

    if (entityFound && entity) {
      info += `· 状态: ✅ 群组信息获取成功<br><br>`;
      
      // 群组基本信息
      info += `<b>📋 群组信息</b><br>`;
      
      if (isChat(entity)) {
        if (entity.chatType === "channel" || entity.chatType === "supergroup") {
          const isChannel = entity.chatType === "channel";
          info += `· 类型: ${isChannel ? "频道" : "超级群组"}<br>`;
          info += `· 名称: ${htmlEscape(entity.title)}<br>`;
          
          if (entity.username) {
            info += `· 用户名: @${htmlEscape(entity.username)}<br>`;
            info += `· 公开链接: https://t.me/${htmlEscape(entity.username)}<br>`;
          } else {
            info += `· 用户名: 无（私有群组）<br>`;
          }
          
          // 生成跳转链接
          const numericId = entity.id.toString().replace("-100", "");
          info += `· 私有链接: https://t.me/c/${numericId}/1<br>`;
          
          if (entity.membersCount) {
            info += `· 成员数: ${entity.membersCount}<br>`;
          }
          
          if (entity.isVerified) {
            info += `· 已验证: ✅<br>`;
          }
          
        } else if (entity.chatType === "group") {
          info += `· 类型: 普通群组<br>`;
          info += `· 名称: ${htmlEscape(entity.title)}<br>`;
          info += `· 用户名: 无（普通群组无用户名）<br>`;
          
          if (entity.membersCount) {
            info += `· 成员数: ${entity.membersCount}<br>`;
          }
        }
      } else if (isUser(entity)) {
        info += `· 类型: 用户<br>`;
        info += `· 名称: ${htmlEscape(entity.displayName)}<br>`;
        if (entity.username) {
          info += `· 用户名: @${htmlEscape(entity.username)}<br>`;
        }
      }
      
    } else {
      // 即使无法访问，也提供一些基本的ID解析信息
      info += `<b>📋 ID格式分析</b><br>`;
      
      if (chatId.startsWith("-100")) {
        const numericId = chatId.replace("-100", "");
        info += `· 类型: 超级群组/频道ID<br>`;
        info += `· 数字ID: ${numericId}<br>`;
        info += `· 私有链接: https://t.me/c/${numericId}/1<br>`;
      } else if (chatId.startsWith("-")) {
        info += `· 类型: 普通群组ID<br>`;
      } else {
        info += `· 类型: 用户ID或其他<br>`;
      }
    }

    info += `<br><b>🔗 可用链接格式</b><br>`;
    if (entityFound && entity && isChat(entity) && entity.username) {
      info += `· 公开链接: https://t.me/${htmlEscape(entity.username)}<br>`;
    }
    
    if (chatId.startsWith("-100")) {
      const numericId = chatId.replace("-100", "");
      info += `· 私有链接: https://t.me/c/${numericId}/1<br>`;
      info += `· 邀请链接: 需要管理员权限生成<br>`;
    }

    return info;
    
  } catch (error: unknown) {
    return `❌ 解析群组ID时发生错误: ${getErrorMessage(error)}`;
  }
}

export default new DebugPlugin();