
import _ from "lodash";
import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { html } from "@mtcute/html-parser";
import { getGlobalClient } from "@utils/globalClient";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { getRawType, getUserId } from "@utils/entityTypeGuards";

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
  target: any,
  mention?: boolean,
  throwErrorIfFailed?: boolean
) {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");
  if (!target) throw new Error("无效的目标");
  let id: any;
  let entity: any;
  try {
    entity = target?.className
      ? target
      : ((await client?.getChat(target)) as any);
    if (!entity) throw new Error("无法获取 entity");
    id = entity.id;
    if (!id) throw new Error("无法获取 entity id");
  } catch (e: any) {
    console.error(e);
    if (throwErrorIfFailed)
      throw new Error(
        `无法获取 ${target} 的 entity: ${e?.message || "未知错误"}`
      );
  }
  const displayParts: string[] = [];

  if (entity?.title) displayParts.push(entity.title);
  if (entity?.firstName) displayParts.push(entity.firstName);
  if (entity?.lastName) displayParts.push(entity.lastName);
  if (entity?.username)
    displayParts.push(
      mention ? `@${htmlEscape(entity.username)}` : codeTag(`@${entity.username}`)
    );

  if (id) {
    displayParts.push(
      getRawType(entity) === 'user' || (entity as any).className === 'User'
        ? `<a href="tg://user?id=${id}">${id}</a>`
        : `<a href="https://t.me/c/${id}">${id}</a>`
    );
  } else if (!target?.className) {
    displayParts.push(codeTag(target));
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

  description: string = `\n管理管理员\n\n${help_text}`;
  cmdHandlers: Record<
    string,
    (msg: MessageContext, trigger?: MessageContext) => Promise<void>
  > = {
    manage_admin: async (msg: MessageContext, trigger?: MessageContext) => {
      const parts = (msg.text || "").trim().split(/\s+/);
      const sub = (parts[1] || "").toLowerCase();

      const isInGroup = (msg as any).isGroup || (msg as any).isChannel;
      if (!isInGroup) {
        await msg.edit({
          text: html(`请在群组/频道对话中使用 <code>${commandName}</code> 命令`),
        });
        return;
      }

      const client = await getGlobalClient();
      if (!client) return;
      const channel = client.resolvePeer(msg.chat.id) as any;
      const chatEntity = await msg.getCompleteChat();
      if (!channel || !chatEntity) {
        await msg.edit({ text: "无法获取当前对话实体" });
        return;
      }

      async function resolveUserFromReplyOrArg(arg?: string) {
        if (msg.replyToMessage) {
          const r = await safeGetReplyMessage(msg);
          if (!r) return { id: undefined as any, entity: undefined as any };
          // Prefer real sender entity and ensure it's a user
          let sender: any;
          try {
            sender = await (r as any).getCompleteSender?.();
            /* ignored */
          } catch { /* ignored */ }
          if (getRawType(sender) !== 'user' && (sender as any)?.className !== 'User') {
            // Fallback to senderId
            const uid = Number((r as any).sender?.id);
            if (uid && client) {
              try {
                const input = client.resolvePeer(uid);
                return { id: uid, entity: input };
                /* ignored */
              } catch { /* ignored */ }
            }
            return { id: undefined as any, entity: undefined as any };
          }
          const input = client.resolvePeer((sender as any).id);
          return { id: Number((sender as any).id), entity: input };
        } else if (arg) {
          try {
            const full = await client.getChat(arg);
            if (getRawType(full) !== 'user' && (full as any)?.className !== 'User') {
              return { id: undefined as any, entity: undefined as any };
            }
            const input = client.resolvePeer(getUserId(full) ?? Number((full as any).id));
            return { id: Number(getUserId(full) ?? (full as any).id), entity: input };
          } catch (e) {
            // Fallback: if arg is numeric and current chat is channel, scan participants to resolve access hash
            const numericId = Number(arg);
            if ((msg as any).isChannel && Number.isFinite(numericId)) {
              try {
                let offset = 0;
                const limit = 200;
                for (let i = 0; i < 5; i++) {
                  // scan up to 1000 participants
                  const res: any = await client.call({
                    _: 'channels.getParticipants',
                    channel,
                    filter: { _: 'channelParticipantsRecent' } as any,
                    offset,
                    limit,
                    hash: 0 as any,
                  } as any);
                  const participants: any[] = res?.participants || [];
                  const users: any[] = res?.users || [];
                  const found = participants.find(
                    (p: any) => Number(p.userId) === numericId
                  );
                  if (found) {
                    const user = users.find(
                      (u: any) => Number(u.id) === numericId
                    );
                    if (user) {
                      const input = client.resolvePeer(user.id);
                      return { id: Number(user.id), entity: input };
                    }
                  }
                  if (!participants.length) break;
                  offset += participants.length;
                }
                /* ignored */
              } catch { /* ignored */ }
            }
            return { id: undefined as any, entity: undefined as any };
          }
        }
        return { id: undefined as any, entity: undefined as any };
      }

      async function getCurrentParticipant(targetEntity: any) {
        try {
          const info = await client.call({
            _: 'channels.getParticipant',
            channel,
            participant: targetEntity,
          } as any);
          return (info as any)?.participant;
        } catch (e) {
          return undefined;
        }
      }

      async function getSelfIsCreator(): Promise<boolean> {
        try {
          const me = await client.getMe();
          if (!me) return false;
          const info = await client.call({
            _: 'channels.getParticipant',
            channel,
            participant: client.resolvePeer((me as any).id),
          } as any);
          const part = (info as any)?.participant;
          return part?._ === 'channelParticipantCreator';
        } catch {
          return false;
        }
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

        const normalizedTitle = [""].includes(rawTitle.toLowerCase())
          ? ""
          : rawTitle;
        // Telegram 限制头衔最长 16 字符
        const limitedTitle =
          normalizedTitle.length > 16
            ? normalizedTitle.slice(0, 16)
            : normalizedTitle;

        // Per spec: 权限默认只有 ban。无论此前是否为管理员，均设置为仅 ban 权限。

        // 不传头衔 = 清空
        let rankToUse = limitedTitle; // empty string clears
        let adminRightsToUse: any = { _: 'chatAdminRights', banUsers: true } as any;

        try {
          const isChannelChat = (chatEntity as any)._ === 'channel' || (chatEntity as any).className === 'Channel';
          if (isChannelChat) {
            await client.call({
              _: 'channels.editAdmin',
              channel,
              userId: userEntity,
              adminRights: adminRightsToUse,
              rank: rankToUse,
            } as any);
            // 等待服务器状态同步
            await sleep(1200);
          } else {
            // Basic group fallback: cannot set title/rights granularity
            await client.call({
              _: 'messages.editChatAdmin',
              chatId: msg.chat.id,
              userId: userEntity,
              isAdmin: true as any,
            } as any);
          }

          // Verify rank actually updated
          let appliedRank = rankToUse;
          let selfIsCreator = false;
          try {
            selfIsCreator = await getSelfIsCreator();
            const refreshed = await getCurrentParticipant(userEntity);
            if (
              refreshed?._ === 'channelParticipantAdmin' ||
              refreshed?._ === 'channelParticipantCreator'
            ) {
              appliedRank = (refreshed as any).rank || "";
            }
            /* ignored */
          } catch { /* ignored */ }

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
        } catch (e: any) {
          const extra =
            typeof e?.message === "string" &&
            e.message.includes("USER_ID_INVALID")
              ? "\n可能原因：目标不是当前对话中的用户、匿名管理员、或仅提供了数字ID且无法解析。请改为回复该用户的消息或使用 @用户名。"
              : "";
          await msg.edit({
            text: html(`设置管理员失败：${codeTag(e?.message || e)}${extra}`),
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
          if ((msg as any).isChannel) {
            await client.call({
              _: 'channels.editAdmin',
              channel,
              userId: userEntity,
              adminRights: { _: 'chatAdminRights' } as any,
              rank: "",
            } as any);
          } else {
            await client.call({
              _: 'messages.editChatAdmin',
              chatId: msg.chat.id,
              userId: userEntity,
              isAdmin: false as any,
            } as any);
          }
          const u = await formatEntity(userId || userEntity, true);
          await msg.edit({
            text: html(`已移除管理员: ${u.display}`),
          });
        } catch (e: any) {
          const extra =
            typeof e?.message === "string" &&
            e.message.includes("USER_ID_INVALID")
              ? "\n可能原因：目标不是当前对话中的用户、匿名管理员、或仅提供了数字ID且无法解析。请改为回复该用户的消息或使用 @用户名。"
              : "";
          await msg.edit({
            text: html(`移除管理员失败：${codeTag(e?.message || e)}${extra}`),
          });
        }
      }

      async function listAdmins() {
        try {
          if (!(msg as any).isChannel) {
            await msg.edit({ text: "仅支持超级群/频道列出管理员" });
            return;
          }
          const result = await client.call({
            _: 'channels.getParticipants',
            channel,
            filter: { _: 'channelParticipantsAdmins' } as any,
            offset: 0,
            limit: 200,
            hash: 0 as any,
          } as any);

          const participants: any[] = (result as any)?.participants || [];
          const users: any[] = (result as any)?.users || [];
          if (!participants.length) {
            await msg.edit({ text: "当前对话没有管理员或无法获取" });
            return;
          }

          const lines: string[] = [];
          for (const p of participants) {
            let uid: any = (p as any).userId;
            if (typeof uid !== "number") uid = Number(uid);
            const user = users.find((u) => Number(u.id) === Number(uid));
            const rank = (p as any).rank || "";
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
        } catch (e: any) {
          await msg.edit({
            text: html(`获取管理员列表失败：${codeTag(e?.message || e)}`),
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
