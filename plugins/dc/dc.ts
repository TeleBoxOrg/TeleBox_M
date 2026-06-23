import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { html } from "@mtcute/html-parser";
import { getGlobalClient } from "@utils/globalClient";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { logger } from "@utils/logger";
import type { tl } from "@mtcute/core";

const htmlEscape = (text: string): string =>
  text.replace(/[&<>\"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
  }[m] || m));

/** Shape of the users.userFull TL response wrapper */
interface UsersUserFullResponse {
  users: tl.TypeUser[];
  chats: tl.TypeChat[];
  fullUser: tl.TypeUserFull;
}

const dc = async (msg: MessageContext) => {
  const args = msg.text.slice(1).split(" ").slice(1);
  const param = args[0] || "";

  // 参数检查
  if (args.length > 1) {
    await msg.edit({
      text: html`❌ 参数错误，最多只能指定一个用户`,
    });
    return;
  }

  const client = await getGlobalClient();
  if (!client) {
    await msg.edit({
      text: html`❌ Telegram客户端未初始化`,
    });
    return;
  }

  await msg.edit({
    text: html`🔍 <b>正在获取 DC 信息...</b>`,
  });

  try {
    // 如果是回复消息
    if (msg.replyToMessage) {
      const replyMessage = await safeGetReplyMessage(msg);
      if (!replyMessage) {
        await msg.edit({
          text: html`❌ 无法获取回复的消息`,
        });
        return;
      }

      const senderId = replyMessage.sender?.id;
      if (!senderId) {
        await msg.edit({
          text: html`❌ 无法获取回复消息的发送者`,
        });
        return;
      }

      try {
        // 尝试获取用户信息
        const fullUser = await client.call({
          _: 'users.getFullUser',
          id: await client.resolveUser(senderId),
        }) as UsersUserFullResponse;

        const user = fullUser.users[0];
        if (!user || user._ === "userEmpty" || !user.photo || user.photo._ === "userProfilePhotoEmpty") {
          await msg.edit({
            text: html`❌ 目标用户没有头像，无法获取 DC 信息`,
          });
          return;
        }

        const photo = user.photo;
        const firstName = user.firstName || "未知用户";
        await msg.edit({
          text: html`📍 <b>${htmlEscape(firstName)}</b> 所在数据中心为: <b>DC${photo.dcId}</b>`,
        });
        return;
      } catch {
        // 如果获取用户失败，尝试获取聊天信息
        try {
          const chat = await (replyMessage as MessageContext).getCompleteChat();
          if (
            !chat ||
            !chat.photo ||
            (chat.photo.raw._ !== "userProfilePhoto" && chat.photo.raw._ !== "chatPhoto")
          ) {
            await msg.edit({
              text: html`❌ 回复的消息所在对话需要先设置头像`,
            });
            return;
          }

          const photo = chat.photo.raw;
          const title = chat.displayName || "未知聊天";
          await msg.edit({
            text: html`📍 <b>${htmlEscape(title)}</b> 所在数据中心为: <b>DC${photo.dcId}</b>`,
          });
          return;
        } catch {
          await msg.edit({
            text: html`❌ 无法获取该对象的 DC 信息`,
          });
          return;
        }
      }
    }

    // 如果没有参数，获取当前聊天的 DC
    if (!param) {
      const chat = await msg.getCompleteChat();
      if (
        !chat ||
        !chat.photo ||
        (chat.photo.raw._ !== "userProfilePhoto" && chat.photo.raw._ !== "chatPhoto")
      ) {
        await msg.edit({
          text: html`❌ 当前群组/频道没有头像，无法获取 DC 信息`,
        });
        return;
      }

      const photo = chat.photo.raw;
      const title = chat.displayName || "当前聊天";
      await msg.edit({
        text: html`📍 <b>${htmlEscape(title)}</b> 所在数据中心为: <b>DC${photo.dcId}</b>`,
      });
      return;
    }

    // 处理用户参数
    let targetUser: string | number | null = null;

    try {
      // 检查消息实体（@用户名或电话号码）
      if (msg.entities) {
        for (const entity of msg.entities) {
          if (entity.is('text_mention')) {
            targetUser = entity.params.userId.toString();
            break;
          }
          if (entity.kind === "phone_number") {
            if (/^\d+$/.test(param)) {
              targetUser = parseInt(param);
            }
            break;
          }
        }
      }

      // 如果没有找到实体，直接使用参数
      if (!targetUser) {
        if (/^\d+$/.test(param)) {
          targetUser = parseInt(param);
        } else {
          targetUser = param;
        }
      }
    } catch (entityError: unknown) {
      logger.error("解析消息实体失败:", entityError);
      // 降级为直接使用参数
      if (/^\d+$/.test(param)) {
        targetUser = parseInt(param);
      } else {
        targetUser = param;
      }
    }

    if (!targetUser) {
      await msg.edit({
        text: html`❌ 请指定有效的用户名或用户ID`,
      });
      return;
    }

    try {
      // 获取用户实体
      const userEntity = await client.getChat(targetUser);

      // 获取完整用户信息
      const fullUser = await client.call({
        _: 'users.getFullUser',
        id: await client.resolveUser(userEntity.id),
      }) as UsersUserFullResponse;

      const user = fullUser.users[0];
      if (!user || user._ === "userEmpty" || !user.photo || user.photo._ === "userProfilePhotoEmpty") {
        await msg.edit({
          text: html`❌ 目标用户需要先设置头像才能获取 DC 信息`,
        });
        return;
      }

      const photo = user.photo;
      const firstName = user.firstName || "未知用户";
      await msg.edit({
        text: html`📍 <b>${htmlEscape(firstName)}</b> 所在数据中心为: <b>DC${photo.dcId}</b>`,
      });
    } catch (error: unknown) {
      const errorStr = String(error);

      if (errorStr.includes("Cannot find any entity corresponding to")) {
        await msg.edit({
          text: html`❌ 找不到对应的用户或实体`,
        });
      } else if (errorStr.includes("No user has")) {
        await msg.edit({
          text: html`❌ 没有找到指定的用户`,
        });
      } else if (errorStr.includes("Could not find the input entity for")) {
        await msg.edit({
          text: html`❌ 无法找到输入的实体`,
        });
      } else if (errorStr.includes("int too big to convert")) {
        await msg.edit({
          text: html`❌ 用户ID过长，请检查输入`,
        });
      } else {
        logger.error("DC插件获取用户信息失败:", error);
        await msg.edit({
          text: html`❌ <b>获取用户信息失败:</b> ${htmlEscape(
            errorStr.length > 100
              ? errorStr.substring(0, 100) + "..."
              : errorStr
          )}`,
        });
      }
    }
  } catch (error: unknown) {
    logger.error("DC插件执行失败:", error);
    await msg.edit({
      text: html`❌ <b>DC 查询失败:</b> ${htmlEscape(String(error))}`,
    });
  }
};

class DcPlugin extends Plugin {

  description: string = `获取指定用户或当前群组/频道的 DC`;
  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    dc,
  };
}

export default new DcPlugin();
