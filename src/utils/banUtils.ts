/**
 * 封禁/解封相关的通用工具函数
 * 原生 mtcute 版本 — 使用 banChatMember / unbanChatMember / getChatMembers
 */

import { TelegramClient } from "@mtcute/node";
import type { InputPeerLike } from "@mtcute/node";
import { logger } from "@utils/logger";

/**
 * 解封用户 - 移除所有限制
 * @param client TelegramClient 实例
 * @param channel 群组/频道 ID 或实体
 * @param user 用户 ID 或实体
 * @returns 是否成功
 */
export async function unbanUser(
  client: TelegramClient,
  channel: InputPeerLike,
  user: InputPeerLike
): Promise<boolean> {
  try {
    await client.unbanChatMember({
      chatId: channel,
      participantId: user,
    });
    return true;
  } catch (error: unknown) {
    logger.error(`解封用户失败:`, error);
    return false;
  }
}

/**
 * 封禁用户
 * @param client TelegramClient 实例
 * @param channel 群组/频道 ID 或实体
 * @param user 用户 ID 或实体
 * @param untilDate 封禁到期时间（秒），0 = 永久
 * @returns 是否成功
 */
export async function banUser(
  client: TelegramClient,
  channel: InputPeerLike,
  user: InputPeerLike,
  untilDate: number = 0
): Promise<boolean> {
  try {
    await client.banChatMember({
      chatId: channel,
      participantId: user,
      untilDate: untilDate ? untilDate : undefined,
    });
    return true;
  } catch (error: unknown) {
    logger.error(`封禁用户失败:`, error);
    return false;
  }
}

/**
 * 踢出用户（封禁后立即解封）
 * @param client TelegramClient 实例
 * @param channel 群组/频道 ID 或实体
 * @param user 用户 ID 或实体
 * @returns 是否成功
 */
export async function kickUser(
  client: TelegramClient,
  channel: InputPeerLike,
  user: InputPeerLike
): Promise<boolean> {
  try {
    // 先封禁
    const banned = await banUser(client, channel, user, Math.floor(Date.now() / 1000) + 60);
    if (!banned) return false;

    // 等待一下确保生效
    await new Promise(resolve => setTimeout(resolve, 500));

    // 立即解封
    return await unbanUser(client, channel, user);
  } catch (error: unknown) {
    logger.error(`踢出用户失败:`, error);
    return false;
  }
}

/**
 * 获取被封禁的用户列表
 * @param client TelegramClient 实例
 * @param channel 群组/频道 ID 或实体
 * @param limit 获取数量限制
 * @returns 被封禁实体列表
 */
export async function getBannedUsers(
  client: TelegramClient,
  channel: InputPeerLike,
  limit: number = 200
): Promise<Array<{
  id: number;
  firstName: string;
  username?: string;
  kickedBy?: number;
  kickedDate?: number;
  type: 'user' | 'channel' | 'chat';
  title?: string;
}>> {
  const bannedUsers: Array<{
    id: number;
    firstName: string;
    username?: string;
    kickedBy?: number;
    kickedDate?: number;
    type: 'user' | 'channel' | 'chat';
    title?: string;
  }> = [];

  try {
    // mtcute 高级 API: getChatMembers with type 'banned'
    const members = await client.getChatMembers(channel, {
      type: 'banned',
      limit,
    });

    for (const member of members) {
      // member 可以是 ChatMember 类型，使用接口描述运行时属性
      const memberAny = member as unknown as {
        kickedBy?: { id?: number };
        date?: number;
        peer?: { userId?: number; channelId?: number; chatId?: number };
        user?: { id?: number; firstName?: string; username?: string; title?: string };
      };

      if (memberAny.kickedBy !== undefined || memberAny.date !== undefined) {
        // Banned member
        let entityId: number = 0;
        let entityType: 'user' | 'channel' | 'chat' = 'user';

        if (memberAny.peer?.userId) {
          entityId = Number(memberAny.peer.userId);
          entityType = 'user';
        } else if (memberAny.peer?.channelId) {
          entityId = Number(memberAny.peer.channelId);
          entityType = 'channel';
        } else if (memberAny.peer?.chatId) {
          entityId = Number(memberAny.peer.chatId);
          entityType = 'chat';
        } else if (memberAny.user?.id) {
          entityId = Number(memberAny.user.id);
          entityType = 'user';
        }

        if (entityId) {
          const user = memberAny.user;
          const displayName = entityType === 'user'
            ? (user?.firstName || user?.username || "Unknown User")
            : (user?.title || user?.username || "Unknown");

          bannedUsers.push({
            id: entityId,
            firstName: displayName,
            username: user?.username,
            kickedBy: memberAny.kickedBy ? Number(memberAny.kickedBy) : undefined,
            kickedDate: memberAny.date,
            type: entityType,
            title: user?.title,
          });
        }
      }
    }
  } catch (error: unknown) {
    logger.error("获取被封禁用户失败:", error);
  }

  return bannedUsers;
}

/**
 * 批量解封用户
 * @param client TelegramClient 实例
 * @param channel 群组/频道 ID 或实体
 * @param userIds 用户ID数组
 * @param delayMs 每个操作之间的延迟（毫秒）
 * @returns 成功和失败的统计
 */
export async function batchUnbanUsers(
  client: TelegramClient,
  channel: InputPeerLike,
  userIds: number[],
  delayMs: number = 500
): Promise<{
  success: number[];
  failed: number[];
}> {
  const success: number[] = [];
  const failed: number[] = [];

  for (const userId of userIds) {
    const result = await unbanUser(client, channel, userId);
    if (result) {
      success.push(userId);
    } else {
      failed.push(userId);
    }

    // 添加延迟避免频率限制
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return { success, failed };
}