import axios from "axios";
import _ from "lodash";
import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { html } from "@mtcute/html-parser";
import { getGlobalClient } from "@utils/globalClient";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { logger } from "@utils/logger";
import { isUser, hasRawType } from "@utils/entityTypeGuards";
import { User, Chat } from "@mtcute/node";
import { Long } from "@mtcute/core";
import type { tl } from "@mtcute/core";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const pluginName = "manage_admin";

const commandName = `${mainPrefix}${pluginName}`;

const help_text = `
使用 <code>${commandName} add [头衔]</code> 回复一条消息, <code>${commandName} add 用户ID/用户名 [头衔]</code> 提升用户为管理员(若之前不是)并设置/更新/清空头衔(可选), 权限默认只有 ban
使用 <code>${commandName} rm/remove</code> 回复一条消息, <code>${commandName} rm/remove 用户ID/用户名</code> 将用户移除管理员
<code>${commandName} ls/list</code> 查看当前对话所有管理员
`;

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function codeTag(text: string | number): string {
  return `<code>${htmlEscape(String(text))}</code>`;
}
async function formatEntity(
  target: unknown,
  mention?: boolean,
  throwErrorIfFailed?: boolean
) {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");
  if (!target) throw new Error("无效的目标");
  let id: number | undefined;
  let entity: User | Chat | undefined;
  try {
    entity = target instanceof User || target instanceof Chat
      ? target
      : await client?.getChat(target as string | number);
    if (!entity) throw new Error("无法获取 entity");
    id = entity.id;
    if (!id) throw new Error("无法获取 entity id");
  } catch (e: unknown) {
    logger.error(e);
    if (throwErrorIfFailed)
      throw new Error(
        `无法获取 ${target} 的 entity: ${e instanceof Error ? e.message : "未知错误"}`
      );
  }
  const displayParts: string[] = [];

  if (entity) {
    if ((entity as Chat).title) displayParts.push((entity as Chat).title!);
    if ((entity as User).firstName) displayParts.push((entity as User).firstName!);
    if ((entity as User).lastName) displayParts.push((entity as User).lastName!);
    if (entity.username)
      displayParts.push(
        mention ? `@${htmlEscape(entity.username)}` : codeTag(`@${entity.username}`)
      );
  }

  if (id) {
    displayParts.push(
      isUser(entity)
        ? `<a href="tg://user?id=${id}">${id}</a>`
        : `<a href="https://t.me/c/${id}">${id}</a>`
    );
  } else if (!(target instanceof User) && !(target instanceof Chat)) {
    displayParts.push(codeTag(target as string | number));
  }

  return {
    id,
    entity,
    display: displayParts.join(" ").trim(),
  };
}
function getTxtFromMsg(msg: MessageContext | string, n: number): string {
  return (typeof msg === "string" ? msg : msg?.text || "")
    .replace(new RegExp(`^\\S+${Array(n).fill("\\s+\\S+").join("")}`), "")
    .trim();
}
class ManageAdminPlugin extends Plugin {

  description: string = `<br>管理管理员<br><br>${help_text}`;
  cmdHandlers: Record<
    string,
    (msg: MessageContext, trigger?: MessageContext) => Promise<void>
  > = {
    manage_admin: async (msg: MessageContext, trigger?: MessageContext) => {
      const parts = (msg.text || "").trim().split(/\s+/);
      const sub = (parts[1] || "").toLowerCase();

      const chat = msg.chat;
      const isInGroup = chat instanceof Chat;
      if (!isInGroup) {
        await msg.edit({
          text: html(`请在群组/频道对话中使用 <code>${commandName}</code> 命令`),
        });
        return;
      }

      const client = await getGlobalClient();
      if (!client) return;
      const channel = await client.resolvePeer(msg.chat.id);
      const chatEntity = await msg.getCompleteChat();
      if (!channel || !chatEntity) {
        await msg.edit({ text: "无法获取当前对话实体" });
        return;
      }

      async function resolveUserFromReplyOrArg(arg?: string): Promise<{ id: number | undefined; entity: unknown }> {
        if (msg.replyToMessage) {
          const r = await safeGetReplyMessage(msg);
          if (!r) return { id: undefined, entity: undefined };
          // Prefer real sender entity and ensure it's a user
          let sender: unknown;
          try {
            sender = await (r as MessageContext).getCompleteSender?.();
          } catch (e: unknown) { logger.warn('操作失败', e) }
          if (sender && !isUser(sender)) {
            // Fallback to senderId
            const uid = Number((r.sender as { id?: number })?.id);
            if (uid && client) {
              try {
                const input = client.resolvePeer(uid);
                return { id: uid, entity: input };
              } catch (e: unknown) { logger.warn('操作失败', e) }
            }
            return { id: undefined, entity: undefined };
          }
          if (!sender) return { id: undefined, entity: undefined };
          const senderUser = sender as User;
          const input = client.resolvePeer(senderUser.id);
          return { id: Number(senderUser.id), entity: input };
        } else if (arg) {
          try {
            const full = await client.getChat(arg);
            if (!isUser(full)) {
              return { id: undefined, entity: undefined };
            }
            const fullUser = full as User;
            const input = client.resolvePeer(fullUser.id);
            return { id: Number(fullUser.id), entity: input };
          } catch (e: unknown) {
            // Fallback: if arg is numeric and current chat is channel, scan participants to resolve access hash
            const numericId = Number(arg);
            if (msg.chat instanceof Chat && (msg.chat as Chat).isGroup && Number.isFinite(numericId)) {
              try {
                let offset = 0;
                const limit = 200;
                for (let i = 0; i < 5; i++) {
                  // scan up to 1000 participants
                  const res = await client.call({
                    _: 'channels.getParticipants',
                    channel: channel as unknown as tl.TypeInputChannel,
                    filter: { _: 'channelParticipantsRecent' },
                    offset,
                    limit,
                    hash: 0 as unknown as Long,
                  });
                  const participants: Array<{ userId: number }> = (res as { participants?: Array<{ userId: number }> })?.participants || [];
                  const users: Array<{ id: number }> = (res as { users?: Array<{ id: number }> })?.users || [];
                  const found = participants.find(
                    (p) => Number(p.userId) === numericId
                  );
                  if (found) {
                    const user = users.find(
                      (u) => Number(u.id) === numericId
                    );
                    if (user) {
                      const input = client.resolvePeer(user.id);
                      return { id: Number(user.id), entity: input };
                    }
                  }
                  if (!participants.length) break;
                  offset += participants.length;
                }
              } catch (e: unknown) { logger.warn('操作失败', e) }
            }
            return { id: undefined, entity: undefined };
          }
        }
        return { id: undefined, entity: undefined };
      }

      async function getCurrentParticipant(targetEntity: unknown) {
        try {
          const info = await client.call({
            _: 'channels.getParticipant',
            channel: channel as unknown as tl.TypeInputChannel,
            participant: targetEntity as unknown as tl.TypeInputPeer,
          });
          return (info as { participant?: unknown })?.participant;
        } catch (e: unknown) {
          return undefined;
        }
      }

      async function getSelfIsCreator(): Promise<boolean> {
        try {
          const me = await client.getMe();
          if (!me) return false;
          const info = await client.call({
            _: 'channels.getParticipant',
            channel: channel as unknown as tl.TypeInputChannel,
            participant: await client.resolvePeer(me.id),
          });
          const part = (info as { participant?: unknown })?.participant;
          return hasRawType(part, 'channelParticipantCreator');
        } catch (e: unknown) {
          return false;
        }
      }

      function extractRights(rights?: Record<string, unknown>): Record<string, unknown> {
        if (!rights) return { _: 'chatAdminRights', banUsers: true };
        // Copy all known flags; undefined flags are treated as false.
        return {
          _: 'chatAdminRights',
          changeInfo: !!rights.changeInfo,
          postMessages: !!rights.postMessages,
          editMessages: !!rights.editMessages,
          deleteMessages: !!rights.deleteMessages,
          banUsers: rights.banUsers !== undefined ? !!rights.banUsers : true,
          inviteUsers: !!rights.inviteUsers,
          pinMessages: !!rights.pinMessages,
          addAdmins: !!rights.addAdmins,
          anonymous: !!rights.anonymous,
          manageCall: !!rights.manageCall,
          other: !!rights.other,
          manageTopics: !!rights.manageTopics,
          postStories: !!rights.postStories,
          editStories: !!rights.editStories,
          deleteStories: !!rights.deleteStories,
        };
      }

      async function addOrUpdateAdmin(targetArg?: string, titleArg?: string) {
        const targetLike = targetArg;
        const title = titleArg;

        const { entity: userEntity, id: userId } =
          await resolveUserFromReplyOrArg(targetLike);
        if (!userEntity) {
          await msg.edit({ text: "请回复一条消息或提供 用户ID/用户名" });
          return;
        }

        // Normalize title (support clear keywords)
        const rawTitle = (title || "").trim();
        const titleIsProvided = title !== undefined;
        const normalizedTitle = [""].includes(rawTitle.toLowerCase())
          ? ""
          : rawTitle;
        // Telegram 限制头衔最长 16 字符
        const limitedTitle =
          normalizedTitle.length > 16
            ? normalizedTitle.slice(0, 16)
            : normalizedTitle;

        // Per spec: 权限默认只有 ban。无论此前是否为管理员，均设置为仅 ban 权限。
        const participant = await getCurrentParticipant(userEntity);
        // 不传头衔 = 清空
        let rankToUse = limitedTitle; // empty string clears
        const adminRightsToUse = { _: 'chatAdminRights', banUsers: true };

        try {
          const isChannelChat = hasRawType(chatEntity, 'channel');
          if (isChannelChat) {
            await client.call({
              _: 'channels.editAdmin',
              channel: channel as unknown as tl.TypeInputChannel,
              userId: userEntity as unknown as tl.TypeInputUser,
              adminRights: adminRightsToUse as unknown as tl.RawChatAdminRights,
              rank: rankToUse,
            });
            // 等待服务器状态同步
            await sleep(1200);
          } else {
            // Basic group fallback: cannot set title/rights granularity
            await client.call({
              _: 'messages.editChatAdmin',
              chatId: msg.chat.id,
              userId: userEntity as unknown as tl.TypeInputUser,
              isAdmin: true,
            });
          }

          // Verify rank actually updated
          let appliedRank = rankToUse;
          let selfIsCreator = false;
          try {
            selfIsCreator = await getSelfIsCreator();
            const refreshed = await getCurrentParticipant(userEntity);
            if (
              hasRawType(refreshed, 'channelParticipantAdmin') ||
              hasRawType(refreshed, 'channelParticipantCreator')
            ) {
              appliedRank = (refreshed as { rank?: string }).rank || "";
            }
          } catch (e: unknown) { logger.warn('操作失败', e) }

          const u = await formatEntity(userId || userEntity, true);
          const rankOk = appliedRank === rankToUse;
          await msg.edit({
            text: html(
              `已设置管理员: ${u.display}` +
              (rankToUse
                ? rankOk
                  ? `，头衔：${codeTag(rankToUse)}`
                  : `，但头衔未更新。` +
                    (selfIsCreator
                      ? `可能原因：非超级群或系统暂未同步。`
                      : `可能原因：仅群主可设置头衔；或非超级群；或系统暂未同步。`)
                : "")
            ),
          });
        } catch (e: unknown) {
          const errMsg = e instanceof Error ? e.message : String(e);
          const extra =
            typeof errMsg === "string" &&
            errMsg.includes("USER_ID_INVALID")
              ? "\n可能原因：目标不是当前对话中的用户、匿名管理员、或仅提供了数字ID且无法解析。请改为回复该用户的消息或使用 @用户名。"
              : "";
          await msg.edit({
            text: html(`设置管理员失败：${codeTag(errMsg)}${extra}`),
          });
        }
      }

      async function removeAdmin(targetArg?: string) {
        const targetLike = targetArg;
        const { entity: userEntity, id: userId } =
          await resolveUserFromReplyOrArg(targetLike);
        if (!userEntity) {
          await msg.edit({ text: "请回复一条消息或提供 用户ID/用户名" });
          return;
        }
        try {
          if (msg.chat instanceof Chat && msg.chat.isGroup) {
            await client.call({
              _: 'channels.editAdmin',
              channel: channel as unknown as tl.TypeInputChannel,
              userId: userEntity as unknown as tl.TypeInputUser,
              adminRights: { _: 'chatAdminRights' } as unknown as tl.RawChatAdminRights,
              rank: "",
            });
          } else {
            await client.call({
              _: 'messages.editChatAdmin',
              chatId: msg.chat.id,
              userId: userEntity as unknown as tl.TypeInputUser,
              isAdmin: false,
            });
          }
          const u = await formatEntity(userId || userEntity, true);
          await msg.edit({
            text: html(`已移除管理员: ${u.display}`),
          });
        } catch (e: unknown) {
          const errMsg = e instanceof Error ? e.message : String(e);
          const extra =
            typeof errMsg === "string" &&
            errMsg.includes("USER_ID_INVALID")
              ? "\n可能原因：目标不是当前对话中的用户、匿名管理员、或仅提供了数字ID且无法解析。请改为回复该用户的消息或使用 @用户名。"
              : "";
          await msg.edit({
            text: html(`移除管理员失败：${codeTag(errMsg)}${extra}`),
          });
        }
      }

      async function listAdmins() {
        try {
          if (!(msg.chat instanceof Chat)) {
            await msg.edit({ text: "仅支持超级群/频道列出管理员" });
            return;
          }
          const result = await client.call({
            _: 'channels.getParticipants',
            channel: channel as unknown as tl.TypeInputChannel,
            filter: { _: 'channelParticipantsAdmins' },
            offset: 0,
            limit: 200,
            hash: 0 as unknown as Long,
          });

          const participants: Array<{ userId: number; rank?: string }> = (result as { participants?: Array<{ userId: number; rank?: string }> })?.participants || [];
          const users: Array<{ id: number; firstName?: string; lastName?: string; username?: string }> = (result as { users?: Array<{ id: number; firstName?: string; lastName?: string; username?: string }> })?.users || [];
          if (!participants.length) {
            await msg.edit({ text: "当前对话没有管理员或无法获取" });
            return;
          }

          const lines: string[] = [];
          for (const p of participants) {
            let uid: number = p.userId;
            if (typeof uid !== "number") uid = Number(uid);
            const user = users.find((u) => Number(u.id) === Number(uid));
            const rank = p.rank || "";
            // Build display
            let display = "";
            if (user) {
              const parts: string[] = [];
              if (user.firstName) parts.push(htmlEscape(user.firstName));
              if (user.lastName) parts.push(htmlEscape(user.lastName));
              if (user.username) parts.push(codeTag(`@${user.username}`));
              parts.push(`<a href="tg://user?id=${uid}">${uid}</a>`);
              display = parts.join(" ");
            } else {
              display = `<a href=\"tg://user?id=${uid}\">${uid}</a>`;
            }
            lines.push(
              `- ${display}${rank ? ` | 头衔: ${codeTag(rank)}` : ""}`
            );
          }

          await msg.edit({
            text: html(`当前管理员列表：<br>${lines.join("<br>")}`),
          });
        } catch (e: unknown) {
          const errMsg = e instanceof Error ? e.message : String(e);
          await msg.edit({
            text: html(`获取管理员列表失败：${codeTag(errMsg)}`),
          });
        }
      }

      if (["ls", "list"].includes(sub)) {
        await listAdmins();
        return;
      }
      if (["rm", "remove", "del"].includes(sub)) {
        const targetArg = msg.replyToMessage ? undefined : parts[2];
        await removeAdmin(targetArg);
        return;
      }
      if (["add", "set"].includes(sub)) {
        const targetArg = msg.replyToMessage ? undefined : parts[2];
        let titleArg = msg.replyToMessage
          ? getTxtFromMsg(msg, 1)
          : getTxtFromMsg(msg, 2);

        await addOrUpdateAdmin(targetArg, titleArg);
        return;
      }
      await msg.edit({
        text: html(help_text),
      });
    },
  };
}

export default new ManageAdminPlugin();
