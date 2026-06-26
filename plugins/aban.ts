import { Plugin } from "@utils/pluginBase";
import { getCurrentGenerationContext } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/globalClient";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import type { TelegramClient } from "@mtcute/node";
import type { ClientInternals } from "@utils/clientInternals";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import path from "path";
import bigInt from "big-integer";
import { safeGetReplyMessage } from "@utils/safeGetMessages";

import { safeGetMe } from "@utils/authGuards";
import { npm_install } from "@utils/npm_install";
import { logger } from "@utils/logger";
import { sleep } from "@utils/asyncHelpers";
import { getErrorMessage } from "@utils/errorHelpers";
import type { tl } from "@mtcute/core";
import type { MtcuteMessageContext } from "@utils/mtcuteTypes";
import type { MtcuteInputPeer } from "@utils/mtcuteTypes";

/**
 * Chat identifier type used across PermissionManager and BanManager.
 * Can be an InputPeer (from resolvePeer), a PeerChat/Chat-like object,
 * or a ManagedGroup-like object with kind/className.
 */
type ChatIdArg = MtcuteInputPeer | { chatId?: number | bigInt.BigInteger; id?: number; kind?: string; className?: string; [key: string]: unknown };

/**
 * Entity type returned by safeGetEntity - partial Telegram entity.
 */
type PartialEntity = {
  id?: number | string;
  _?: string;
  chatId?: number | string;
  username?: string;
  title?: string;
  firstName?: string;
  first_name?: string;
  lastName?: string;
  last_name?: string;
  accessHash?: string | number;
};

/**
 * Raw chat full response type for getFullChat.
 */
type _RawChatFull = {
  fullChat?: {
    participants?: {
      _?: string;
      participants?: Array<{ _?: string; userId?: number }>;
    };
  };
  users?: Array<{ id?: number | string; _?: string; [key: string]: unknown }>;
};
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// p-limit 是 ESM-only，必须动态加载
let pLimit: typeof import("p-limit").default;
let pLimitReady: Promise<void> | null = null;
async function ensurePLimit(): Promise<typeof pLimit> {
  if (pLimit) return pLimit;
  if (!pLimitReady) {
    pLimitReady = (async () => {
      try {
        npm_install("p-limit");
      } catch (e: unknown) { logger.warn('操作失败', e) }
      pLimit = (await import("p-limit")).default;
    })();
  }
  await pLimitReady;
  return pLimit;
}

// 解析 FLOOD_WAIT 错误中的等待秒数；非 flood 错返回 null
function getFloodWaitSeconds(error: unknown): number | null {
  const msg = error instanceof Error ? getErrorMessage(error) : String(error || "");
  // teleproto 抛出的 RPCError 里通常带 "FLOOD_WAIT_X" 或 "wait of N seconds"
  let m = msg.match(/FLOOD_WAIT_(\d+)/);
  if (m) return parseInt(m[1], 10);
  m = msg.match(/wait of (\d+) seconds?/i);
  if (m) return parseInt(m[1], 10);
  // teleproto FloodWaitError 的 seconds 字段
  const seconds = (error as { seconds?: number })?.seconds;
  if (typeof seconds === "number" && Number.isFinite(seconds)) return seconds;
  return null;
}


// ==================== 配置常量 ====================
const CONFIG = {
  BATCH_SIZE: 50, // 增加批次大小
  PARALLEL_LIMIT: 20, // 增加并发数
  DEFAULT_MUTE_DURATION: 0, // 0表示永久禁言
  MESSAGE_AUTO_DELETE: 10,
  PER_GROUP_SCAN_LIMIT: 2000,
  CACHE_DB_NAME: "aban_cache.json"
};

// ==================== 帮助文本 ====================
const HELP_TEXT = `<b>封禁管理</b>

<code>${mainPrefix}kick</code> 踢出
<code>${mainPrefix}ban</code> 封禁  
<code>${mainPrefix}unban</code> 解封
<code>${mainPrefix}mute [time]</code> 禁言 (如 60s/5m/1h/1d，不填则永久)
<code>${mainPrefix}unmute</code> 解禁言
<code>${mainPrefix}sb</code> 批量封禁
<code>${mainPrefix}unsb</code> 批量解封
<code>${mainPrefix}refresh</code> 刷新

回复消息或@用户名`;

// ==================== 工具函数 ====================
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#x27;'
  }[m] || m));

// 解析时间字符串
function parseTimeString(timeStr?: string): number {
  if (!timeStr) return 0; // 无参数返回0（永久）
  
  const time = timeStr.toLowerCase();
  const num = parseInt(time) || 0;
  
  if (time.includes('d')) return num * 86400;
  if (time.includes('h')) return num * 3600;
  if (time.includes('m')) return num * 60;
  if (time.includes('s')) return num;
  
  return 0; // 默认永久
}

// ==================== 缓存管理器 ====================
type CacheEntry = {
  id: number;
  title?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  type: "user" | "chat" | "channel";
};

type CacheData = {
  cache: Record<string, CacheEntry>;
};

class CacheManager {
  private db: Low<CacheData> | null = null;
  private static instance: CacheManager;
  private initPromise: Promise<void>;

  private constructor() {
    this.initPromise = this.initDb();
  }

  static getInstance(): CacheManager {
    if (!this.instance) {
      this.instance = new CacheManager();
    }
    return this.instance;
  }

  private async initDb(): Promise<void> {
    const dbPath = path.join(
      createDirectoryInAssets("aban"),
      CONFIG.CACHE_DB_NAME
    );
    const adapter = new JSONFile<CacheData>(dbPath);
    this.db = new Low(adapter, { cache: {} });
    await this.db.read();
    if (!this.db.data) {
      this.db.data = { cache: {} };
      await this.db.write();
    }
  }

  async get(key: string): Promise<unknown> {
    await this.initPromise;
    if (!this.db) return null;
    return this.db.data.cache[key] || null;
  }

  async set(key: string, value: CacheEntry): Promise<void> {
    await this.initPromise;
    if (!this.db) return;
    this.db.data.cache[key] = value;
    await this.db.write();
  }

  async clear(): Promise<void> {
    await this.initPromise;
    if (!this.db) return;
    this.db.data.cache = {};
    await this.db.write();
  }
}

// ==================== 用户解析器 ====================
type ResolvedUser = {
  id: number;
  firstName?: string;
  lastName?: string;
  username?: string;
  title?: string;
  type: "user" | "chat" | "channel";
  raw?: unknown;
};

type ResolvedTarget = {
  user: ResolvedUser | null;
  uid: number | null;
  participant?: tl.TypeInputPeer;
  source: "reply" | "username" | "numeric" | "unknown";
  resolutionError?: string;
  chatType?: "channel" | "chat" | "unknown";
};

class UserResolver {
  static async resolveTarget(
    client: TelegramClient,
    message: MtcuteMessageContext,
    args: string[]
  ): Promise<ResolvedTarget> {
    // 从参数解析
    if (args.length > 0) {
      const target = args[0];
      return await this.resolveFromString(client, message, target);
    }
    
    // 从回复消息解析
    const reply = await safeGetReplyMessage(message);
    if (reply && (reply as { senderId?: number | string })?.senderId) {
      const uid = Number((reply as { senderId?: number | string }).senderId);
      const sender = await this.getReplySender(reply as { getSender?: () => Promise<unknown>; sender?: unknown });
      const participant = sender?.type === 'user'
        ? await this.safeGetInputEntity(client, sender!.raw as unknown as number | string)
        : await this.safeGetInputEntity(client, uid);
      const fallbackParticipant = participant || await this.resolveParticipantFromContext(client, message, uid, sender?.raw as PartialEntity | undefined);

      return {
        user: sender,
        uid,
        participant: fallbackParticipant,
        source: "reply",
        resolutionError: fallbackParticipant ? undefined : "TARGET_ENTITY_UNRESOLVABLE",
        chatType: this.getChatType(message),
      };
    }
    
    return { user: null, uid: null, source: "unknown", resolutionError: "NO_TARGET", chatType: this.getChatType(message) };
  }

  private static async resolveFromString(
    client: TelegramClient,
    message: MtcuteMessageContext,
    target: string
  ): Promise<ResolvedTarget> {
    try {
      // @username 格式
      if (target.startsWith("@")) {
        const entity = await this.safeGetEntity(client, target);
        const participant = entity ? await this.safeGetInputEntity(client, entity as unknown as number | string) : undefined;
        const uid = entity?.id ? Number(entity.id) : null;
        const fallbackParticipant = uid
          ? participant || await this.resolveParticipantFromContext(client, message, uid, entity as PartialEntity | undefined)
          : undefined;
        return {
          user: entity ? { id: Number(entity.id), firstName: entity.firstName ?? entity.first_name, lastName: entity.lastName ?? entity.last_name, username: entity.username, title: entity.title, type: (entity._ === "user" ? "user" : entity._ === "chat" ? "chat" : "channel") as "user" | "chat" | "channel" } : null,
          uid,
          participant: fallbackParticipant,
          source: "username",
          resolutionError: fallbackParticipant || uid === null ? undefined : "TARGET_ENTITY_UNRESOLVABLE",
          chatType: this.getChatType(message),
        };
      }
      
      // 纯数字 ID
      if (/^-?\d+$/.test(target)) {
        const userId = parseInt(target, 10);
        const entity = await this.safeGetEntity(client, userId);
        const participant = entity
          ? await this.safeGetInputEntity(client, entity)
          : await this.resolveParticipantFromContext(client, message, userId);

        return {
          user: entity ? { id: Number(entity.id), firstName: entity.firstName ?? entity.first_name, lastName: entity.lastName ?? entity.last_name, username: entity.username, title: entity.title, type: (entity._ === "user" ? "user" : entity._ === "chat" ? "chat" : "channel") as "user" | "chat" | "channel" } : null,
          uid: userId,
          participant,
          source: "numeric",
          resolutionError: participant ? undefined : "TARGET_ENTITY_UNRESOLVABLE",
          chatType: this.getChatType(message),
        };
      }
    } catch (error: unknown) {
      logger.error(`[UserResolver] 解析失败: ${error}`);
    }
    
    return { user: null, uid: null, source: "unknown", resolutionError: "INVALID_TARGET", chatType: this.getChatType(message) };
  }

  private static async getReplySender(reply: { getSender?: () => Promise<unknown>; sender?: unknown }): Promise<ResolvedUser | null> {
    try {
      const sender = await reply.getSender?.();
      if (sender && typeof sender === "object") {
        const raw = sender as { _?: string; firstName?: string; first_name?: string; lastName?: string; last_name?: string; username?: string; title?: string; id?: number | string };
        return {
          id: Number(raw.id ?? 0),
          firstName: raw.firstName ?? raw.first_name,
          lastName: raw.lastName ?? raw.last_name,
          username: raw.username,
          title: raw.title,
          type: (raw._ === "user" ? "user" : raw._ === "chat" ? "chat" : "channel") as "user" | "chat" | "channel",
          raw: sender,
        };
      }
      return null;
    } catch (e: unknown) {
      logger.warn('aban: failed to extract sender entity', e);
      return null;
    }
  }

  private static getChatType(message: MtcuteMessageContext): "channel" | "chat" | "unknown" {
    if ((message as { isChannel?: boolean }).isChannel) return "channel";
    if ((message as { isGroup?: boolean }).isGroup) return "chat";
    return "unknown";
  }

  private static async safeGetEntity(
    client: TelegramClient,
    target: string | number
  ): Promise<PartialEntity | null> {
    try {
      return await (client as unknown as ClientInternals).resolvePeer(target) as PartialEntity | null;
    } catch (e: unknown) {
      logger.warn(`aban: safeGetEntity failed for target ${target}`, e);
      return null;
    }
  }

  private static async safeGetInputEntity(
    client: TelegramClient,
    target: unknown
  ): Promise<tl.TypeInputPeer | undefined> {
    try {
      return await (client as unknown as ClientInternals).getInputEntity(target) as tl.TypeInputPeer | undefined;
    } catch (e: unknown) {
      logger.warn('aban: safeGetInputEntity failed', e);
      return undefined;
    }
  }

  private static async resolveParticipantFromContext(
    client: TelegramClient,
    message: MtcuteMessageContext,
    userId: number,
    knownEntity?: PartialEntity
  ): Promise<tl.TypeInputPeer | undefined> {
    const chat = (message as { peerId?: unknown }).peerId;
    if (!chat) {
      return undefined;
    }

    if ((message as { isChannel?: boolean }).isChannel) {
      try {
        let offset = 0;
        const limit = 200;
        for (let i = 0; i < 5; i++) {
          const res = await client.call({
              _: 'channels.getParticipants',
              channel: chat,
              filter: { _: 'channelParticipantsRecent' } as tl.TypeChannelParticipantsFilter,
              offset,
              limit,
              hash: 0,
            } as unknown as Parameters<typeof client.call>[0]);

          const rawRes = res as tl.channels.RawChannelParticipants;
          const participants = rawRes.participants ?? [];
          const users = (rawRes.users ?? []).filter(
            (u): u is tl.RawUser => u != null && (u as tl.RawUser)._ === 'user',
          );
          const matchedUser = users.find((u) => Number(u?.id) === userId);
          if (matchedUser) {
            const input = await this.safeGetInputEntity(client, matchedUser);
            if (input) {
              return input;
            }
          }

          if (!participants.length) break;
          offset += participants.length;
        }
      } catch (e: unknown) {
        logger.warn('aban: findParticipantPage failed', e);
        return undefined;
      }
    }

    if ((message as { isGroup?: boolean }).isGroup) {
      try {
        const peer = knownEntity || await this.safeGetEntity(client, chat as unknown as string | number);
        const chatId = Number(peer?.chatId ?? peer?.id ?? (chat as { chatId?: number })?.chatId);
        if (!Number.isFinite(chatId)) {
          return undefined;
        }

        const full = await client.call({
            _: 'messages.getFullChat',
            chatId: Number(bigInt(chatId)),
        }) as unknown as { fullChat?: { participants?: { _?: string }; users?: unknown[] } };

        const participants = full?.fullChat?.participants;
        if (!participants || participants?._ === 'chatParticipantsForbidden') {
          return undefined;
        }
        const users: unknown[] = full?.fullChat?.users || [];
        const matchedUser = users.find((u) => Number((u as { id?: number })?.id) === userId);
        if (matchedUser) {
          return await this.safeGetInputEntity(client, matchedUser);
        }
      } catch (e: unknown) {
        logger.warn('aban: getFullChat participant lookup failed', e);
        return undefined;
      }
    }

    return undefined;
  }

  static formatUser(user: any, userId: number): string {
    if (user?.firstName || user?.first_name) {
      let name = user.firstName || user.first_name || String(userId);
      if (user.lastName || user.last_name) {
        name += ` ${user.lastName || user.last_name}`;
      }
      if (user.username) {
        name += ` (@${user.username})`;
      }
      return name;
    } else if (user?.title) {
      return `频道: ${user.title}${user.username ? ` (@${user.username})` : ''}`;
    }
    return String(userId);
  }
}

// ==================== 消息管理器 ====================
class MessageManager {
  static async smartEdit(
    message: MtcuteMessageContext,
    text: string,
    deleteAfter: number = CONFIG.MESSAGE_AUTO_DELETE
  ): Promise<MtcuteMessageContext> {
    try {
      const client = await getGlobalClient();
      if (!client) return message;

      await message.edit({text});

      if (deleteAfter > 0) {
        const lifecycle = getCurrentGenerationContext();
        if (lifecycle) {
          lifecycle.setTimeout(async () => {
            try {
              const peerId = (message as unknown as { peerId?: number }).peerId;
              await client.deleteMessagesById(peerId as unknown as number, [message.id], {
                revoke: true,
              });
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              if (!msg.includes('MESSAGE_ID_INVALID')) {
                logger.error(`删除消息失败: ${e}`);
              }
            }
          }, deleteAfter * 1000, { label: 'aban:smartEdit-delayed-delete' });
        }
      }

      return message;
    } catch (error: unknown) {
      const errMsg = getErrorMessage(error) || String(error);
      if (errMsg.includes('MESSAGE_ID_INVALID')) {
        // Expected when the target message was already deleted - not actionable
      } else {
        logger.error(`编辑消息失败: ${errMsg}`);
      }
      return message;
    }
  }
}

// ==================== 权限管理器 ====================
type ManagedGroup = {
  id: number;
  title: string;
  kind: ChatKind;
  // bigint 序列化为字符串。channel 必填；basic group 不需要
  accessHash?: string;
};

/**
 * 把 ManagedGroup 转成可以直接喂给 any.* 的 channel 参数。
 * - channel 有 accessHash → 构造完整 InputChannel，直接走，不触发 GetChannels 兜底
 * - channel 无 accessHash（旧缓存或未填）→ 通过 getInputEntity 让 teleproto 自行解析
 * - basic group → 返回裸 id（调用方应通过 kind 分流到 messages.* 路径）
 */
async function resolveChannelInput(
  client: TelegramClient,
  group: ManagedGroup
): Promise<tl.TypeInputChannel | number> {
  if (group.kind !== 'channel') {
    return group.id;
  }
  if (group.accessHash) {
    return {
    _: 'inputChannel' as const,
    channelId: bigInt(group.id) as unknown as number,
    accessHash: bigInt(group.accessHash) as unknown as tl.Long,
    };
  }
  // 兜底：让 teleproto 走自己的 entity cache / dialogs 解析
  return await (client as unknown as ClientInternals).getInputEntity(group.id) as unknown as number | tl.TypeInputChannel;
}

/**
 * 把 ManagedGroup 转成 PermissionManager 那一组方法能识别的 chatId。
 * - channel：返回 InputChannel（带 accessHash），走 any.GetParticipant
 * - basic group：返回 PeerChat-like 对象，让 getChatKind/getBasicGroupChatId 走 chat 路径
 */
async function resolvePermissionTarget(
  client: TelegramClient,
  group: ManagedGroup
): Promise<MtcuteInputPeer | { className: string; chatId: bigInt.BigInteger }> {
  if (group.kind === 'chat') {
    return { className: 'PeerChat', chatId: bigInt(group.id) };
  }
  const channel = await resolveChannelInput(client, group);
  if (typeof channel === 'number') {
    // basic group without channel info — shouldn't happen if kind is correct
    return { className: 'PeerChat', chatId: bigInt(channel) };
  }
  return channel as unknown as MtcuteInputPeer | { className: string; chatId: bigInt.BigInteger };
}

class PermissionManager {
  private static getChatKind(chatId: ChatIdArg | { kind?: string }): ChatKind {
    const obj = chatId as { kind?: string; className?: string };
    if (obj?.kind === 'chat' || obj?.kind === 'channel') {
      return obj.kind;
    }
    const className = obj?.className;
    if (className === 'PeerChat' || className === 'Chat') {
      return 'chat';
    }
    return 'channel';
  }

  private static getBasicGroupChatId(chatId: { chatId?: number; id?: number }): number {
    return Number(chatId?.chatId ?? chatId?.id);
  }

  private static async getBasicGroupParticipants(client: TelegramClient, chatId: unknown): Promise<Array<{ _?: string; userId?: number }> | null> {
    const full = await client.call({
        _: 'messages.getFullChat',
        chatId: Number(this.getBasicGroupChatId(chatId as { chatId?: number; id?: number })),
      } as Parameters<typeof client.call>[0]) as { fullChat?: { participants?: { _?: string; participants?: Array<{ _?: string; userId?: number }> } } };

    const participants = full?.fullChat?.participants;
    if (!participants || participants?._ === 'chatParticipantsForbidden') {
      return null;
    }

    return participants.participants || null;
  }

  static async checkAdminPermission(
    client: TelegramClient,
    chatId: ChatIdArg
  ): Promise<boolean> {
    try {
      const me = await safeGetMe(client);
      if (!me) return false;
      if (this.getChatKind(chatId) === 'chat') {
        const participants = await this.getBasicGroupParticipants(client, chatId);
        if (!participants) {
          return false;
        }

        const meParticipant = participants.find((p: { userId?: number }) => Number(p?.userId) === Number((me as { id?: number | string }).id));
        return meParticipant?._ === 'chatParticipantCreator' || meParticipant?._ === 'chatParticipantAdmin';
      }

      const participant = await client.call({
          _: 'channels.getParticipant',
          channel: chatId as unknown as tl.TypeInputChannel,
          participant: await client.resolvePeer(me.id)
        });

      const p = participant.participant;
      if (p?._ === 'channelParticipantCreator') return true;
      if (p?._ === 'channelParticipantAdmin') {
        const rights = p.adminRights;
        return !!(rights?.banUsers || rights?.deleteMessages);
      }
      return false;
    } catch (e: unknown) {
      logger.warn('aban: isMeAdmin check failed', e);
      return false;
    }
  }

  static async isTargetAdmin(
    client: TelegramClient,
    chatId: ChatIdArg,
    userId: number
  ): Promise<boolean> {
    try {
      if (this.getChatKind(chatId) === 'chat') {
        const participants = await this.getBasicGroupParticipants(client, chatId);
        if (!participants) {
          return false;
        }

        const targetParticipant = participants.find((p: any) => Number(p?.userId) === userId);
        return targetParticipant?._ === 'chatParticipantCreator' || targetParticipant?._ === 'chatParticipantAdmin';
      }

      const participant = await client.call({
          _: 'channels.getParticipant',
          channel: chatId as unknown as tl.TypeInputChannel,
          participant: await client.resolvePeer(userId)
        });
      
      const p = participant.participant;
      return (
        p?._ === 'channelParticipantCreator' ||
        p?._ === 'channelParticipantAdmin'
      );
    } catch (e: unknown) {
      logger.warn('aban: isOwnerOrAdmin check failed', e);
      return false;
    }
  }

  static async canDeleteMessages(
    client: TelegramClient,
    chatId: ChatIdArg
  ): Promise<boolean> {
    try {
      const me = await safeGetMe(client);
      if (!me) return false;
      if (this.getChatKind(chatId) === 'chat') {
        const participants = await this.getBasicGroupParticipants(client, chatId);
        if (!participants) {
          return false;
        }

        const meParticipant = participants.find((p: { userId?: number }) => Number(p?.userId) === Number((me as { id?: number | string }).id));
        return meParticipant?._ === 'chatParticipantCreator' || meParticipant?._ === 'chatParticipantAdmin';
      }

      const participant = await client.call({
          _: 'channels.getParticipant',
          channel: chatId as unknown as tl.TypeInputChannel,
          participant: await client.resolvePeer(me.id)
        });
      
      const p = participant.participant;
      if (p?._ === 'channelParticipantCreator') return true;
      if (p?._ === 'channelParticipantAdmin') {
        return !!p.adminRights?.deleteMessages;
      }
      return false;
    } catch (e: unknown) {
      logger.warn('aban: canDeleteMessages check failed', e);
      return false;
    }
  }
}

// ==================== 群组管理器 ====================
class GroupManager {
  private static cache = CacheManager.getInstance();

  static async getAllManageableDialogs(client: TelegramClient): Promise<Array<{ id: number; isChannel: boolean; isGroup: boolean; title: string; entity?: { id?: number; accessHash?: string | number } }>> {
    const dialogMap = new Map<number, { id: number; isChannel: boolean; isGroup: boolean; title: string; entity?: { id?: number; accessHash?: string | number } }>();

    const collectDialogs = async (params: Record<string, unknown>) => {
      const dialogs = await (client as unknown as ClientInternals).getDialogs(params);
      for (const dialog of dialogs || []) {
        if (dialog.isChannel || dialog.isGroup) {
          dialogMap.set(Number(dialog.id), dialog as { id: number; isChannel: boolean; isGroup: boolean; title: string; entity?: { id?: number; accessHash?: string | number } });
        }
      }
    };

    await collectDialogs({});
    await collectDialogs({ folderId: 1 });

    return Array.from(dialogMap.values());
  }

  static async getManagedGroups(
    client: TelegramClient
  ): Promise<ManagedGroup[]> {
    const cached = await this.cache.get("managed_groups_v3");
    if (cached) return cached as ManagedGroup[];

    const groups: ManagedGroup[] = [];
    
    try {
      const dialogs = await this.getAllManageableDialogs(client);
      
      const checkPromises = dialogs.map(async (dialog: any) => {
        if (dialog.isChannel || dialog.isGroup) {
          const hasPermission = await PermissionManager.checkAdminPermission(
            client,
            dialog.entity
          );
          
          if (hasPermission) {
            const isChannel = !(dialog.isGroup && !dialog.isChannel);
            // 仅 channel 需要 accessHash，basic group 用裸 chatId
            const rawHash = isChannel ? dialog.entity?.accessHash : undefined;
            const accessHash = rawHash != null ? String(rawHash) : undefined;
            // ⚠️ dialog.id 是 marked id（channel: -100xxxx，basic group: -xxx），
            // 而 any.channelId / any.DeleteChatUser.chatId 需要 raw 正数 id。
            // 这里必须用 dialog.entity.id（Channel/Chat 实体上的原始正数 id），否则服务端会
            // 直接 CHANNEL_INVALID / PEER_ID_INVALID，导致批量 sb 全部失败。
            const rawId = Number(dialog.entity?.id ?? dialog.id);
            return {
              id: rawId,
              title: dialog.title || "Unknown",
              kind: isChannel ? 'channel' as const : 'chat' as const,
              accessHash,
            };
          }
        }
        return null;
      });
      
      const results = await Promise.all(checkPromises);
      for (const g of results) {
        if (g !== null) groups.push(g as ManagedGroup);
      }
      
      try {
        await this.cache.set("managed_groups_v3", groups as unknown as CacheEntry);
      } catch (cacheError: unknown) {
        logger.error(`[GroupManager] 缓存群组失败: ${cacheError}`);
      }
    } catch (error: unknown) {
      logger.error(`[GroupManager] 获取群组失败: ${error}`);
    }
    
    return groups;
  }

  static async clearCache(): Promise<void> {
    await this.cache.clear();
  }
}

// ==================== 封禁操作管理器 ====================
type BatchGroupFailure = {
  group: ManagedGroup;
  reason: string;
};

type ChatKind = "channel" | "chat";

type BatchBanResult = {
  success: number;
  failed: number;
  failedGroups: string[];
  failureDetails: BatchGroupFailure[];
  unresolved: boolean;
  unresolvedReason?: string;
};

class BanManager {
  static async resolveParticipant(
    client: TelegramClient,
    userId: number,
    participant?: tl.TypeInputPeer
  ): Promise<tl.TypeInputPeer> {
    if (participant) {
      return participant;
    }
    return (client as unknown as ClientInternals).getInputEntity(userId) as Promise<tl.TypeInputPeer>;
  }

  private static getErrorReason(error: unknown): string {
    const message = error instanceof Error ? getErrorMessage(error) : String(error || "UNKNOWN_ERROR");
    const match = message.match(/[A-Z_]{3,}/);
    return match?.[0] || message;
  }

  private static getChatKind(chatId: any): ChatKind {
    if (chatId?.kind === 'chat' || chatId?.kind === 'channel') {
      return chatId.kind;
    }

    const className = chatId?.className;
    if (className === 'PeerChat' || className === 'Chat') {
      return 'chat';
    }
    return 'channel';
  }

  private static getBasicGroupChatId(chatId: { chatId?: number; id?: number }): number {
    return Number(chatId?.chatId ?? chatId?.id);
  }

  private static async applyBanLikeAction(
    client: TelegramClient,
    chatId: ChatIdArg,
    resolvedParticipant: tl.TypeInputPeer,
    bannedRights: { _: 'chatBannedRights'; untilDate: number; [key: string]: unknown },
    action: 'ban' | 'unban' | 'mute'
  ): Promise<void> {
    const chatKind = this.getChatKind(chatId);
    if (chatKind === 'chat') {
      if (action === 'unban' || action === 'mute') {
        throw new Error('BASIC_GROUP_ACTION_UNSUPPORTED');
      }

      await client.call({
          _: 'messages.deleteChatUser',
          chatId: Number(bigInt(this.getBasicGroupChatId(chatId as { chatId?: number; id?: number }))),
          userId: resolvedParticipant as unknown as tl.TypeInputUser,
        });
      return;
    }

    await client.call({
        _: 'channels.editBanned',
        channel: chatId as unknown as tl.TypeInputChannel,
        participant: resolvedParticipant,
        bannedRights,
      });
  }

  static async banUser(
    client: TelegramClient,
    chatId: ChatIdArg,
    userId: number,
    _until: number = 0,
    participant?: tl.TypeInputPeer
  ): Promise<boolean> {
    try {
      const resolvedParticipant = await this.resolveParticipant(client, userId, participant);
      const rights = { _: 'chatBannedRights' as const,
        untilDate: 0,
        viewMessages: true,
        sendMessages: true,
        sendMedia: true,
        sendStickers: true,
        sendGifs: true,
        sendGames: true,
        sendInline: true,
        embedLinks: true,
      };

      await this.applyBanLikeAction(client, chatId, resolvedParticipant, rights, 'ban');
      return true;
    } catch (error: unknown) {
      logger.error(`[BanManager] 封禁失败: ${error}`);
      return false;
    }
  }

  static async unbanUser(
    client: TelegramClient,
    chatId: ChatIdArg,
    userId: number,
    participant?: tl.TypeInputPeer
  ): Promise<boolean> {
    try {
      const resolvedParticipant = await this.resolveParticipant(client, userId, participant);
      const rights = { _: 'chatBannedRights' as const, 
        untilDate: 0,
      };

      await this.applyBanLikeAction(client, chatId, resolvedParticipant, rights, 'unban');
      return true;
    } catch (error: unknown) {
      logger.error(`[BanManager] 解封失败: ${error}`);
      return false;
    }
  }

  static async muteUser(
    client: TelegramClient,
    chatId: ChatIdArg,
    userId: number,
    duration: number,
    participant?: tl.TypeInputPeer
  ): Promise<boolean> {
    try {
      const resolvedParticipant = await this.resolveParticipant(client, userId, participant);
      const until = duration === 0 ? 0 : Math.floor(Date.now() / 1000) + duration;
      const rights = { _: 'chatBannedRights' as const, 
        untilDate: until,
        sendMessages: true,
        sendMedia: true,
        sendStickers: true,
        sendGifs: true,
        sendGames: true,
        sendInline: true,
        embedLinks: true,
      };

      await this.applyBanLikeAction(client, chatId, resolvedParticipant, rights, 'mute');
      return true;
    } catch (error: unknown) {
      logger.error(`[BanManager] 禁言失败: ${error}`);
      return false;
    }
  }

  static async kickUser(
    client: TelegramClient,
    chatId: ChatIdArg,
    userId: number,
    participant?: tl.TypeInputPeer
  ): Promise<boolean> {
    try {
      if (this.getChatKind(chatId) === 'chat') {
        return await this.banUser(client, chatId, userId, 0, participant);
      }

      const banned = await this.banUser(client, chatId, userId, 0, participant);
      if (!banned) {
        return false;
      }

      return await this.unbanUser(client, chatId, userId, participant);
    } catch (error: unknown) {
      logger.error(`[BanManager] 踢出失败: ${error}`);
      return false;
    }
  }

  // 删除用户在当前会话的消息（sb命令优化）
  static async deleteHistoryInCurrentChat(
    client: TelegramClient,
    chatId: ChatIdArg,
    userId: number,
    participant?: tl.TypeInputPeer
  ): Promise<boolean> {
    try {
      const canDelete = await PermissionManager.canDeleteMessages(client, chatId);
      if (!canDelete) {
        logger.info(`[BanManager] 无删除消息权限`);
        return false;
      }

      const resolvedParticipant: tl.TypeInputPeer = participant || await (client as { resolvePeer: (target: unknown) => Promise<tl.TypeInputPeer> }).resolvePeer(userId);

      await client.call({
          _: 'channels.deleteParticipantHistory',
          channel: chatId as unknown as tl.TypeInputChannel,
          participant: resolvedParticipant,
        });
      
      logger.info(`[BanManager] 成功删除用户 ${userId} 在当前会话的所有消息`);
      return true;
    } catch (error: unknown) {
      // 静默处理常见错误
      if (!/CHANNEL_INVALID|CHAT_ADMIN_REQUIRED|USER_NOT_PARTICIPANT/.test(getErrorMessage(error))) {
        logger.error(`[BanManager] 删除消息失败: ${getErrorMessage(error)}`);
      }
      return false;
    }
  }

  static async batchBanUser(
    client: TelegramClient,
    groups: ManagedGroup[],
    userId: number,
    participant?: tl.TypeInputPeer,
    reason: string = "跨群违规"
  ): Promise<BatchBanResult> {
    let resolvedParticipant: tl.TypeInputPeer;
    try {
      resolvedParticipant = await this.resolveParticipant(client, userId, participant);
    } catch (error: unknown) {
      return {
        success: 0,
        failed: groups.length,
        failedGroups: groups.map((group) => group.title),
        failureDetails: [],
        unresolved: true,
        unresolvedReason: this.getErrorReason(error),
      };
    }

    const rights = { _: 'chatBannedRights' as const,
      untilDate: 0,
      viewMessages: true,
      sendMessages: true,
      sendMedia: true,
      sendStickers: true,
      sendGifs: true,
      sendGames: true,
      sendInline: true,
      embedLinks: true,
    };

    const limit = (await ensurePLimit())(4);

    const runOne = async (
      group: ManagedGroup
    ): Promise<
      | { success: true; group: ManagedGroup }
      | { success: false; group: ManagedGroup; reason: string }
    > => {
      const buildRequest = async (): Promise<unknown> => {
        if (group.kind === 'chat') {
          return client.call({
              _: 'messages.deleteChatUser',
              chatId: Number(this.getBasicGroupChatId({ id: group.id })),
              userId: resolvedParticipant as unknown as tl.TypeInputUser,
            });
        }
        const channelInput = await resolveChannelInput(client, group);
        return client.call({
              _: 'channels.editBanned',
              channel: channelInput as unknown as tl.TypeInputChannel,
              participant: resolvedParticipant,
              bannedRights: rights,
            });
      };

      // 单组重试：FLOOD_WAIT 等待 ≤ 8s 时重试一次，其余错误直接返回
      const attempt = async (retriesLeft: number): Promise<
        | { success: true; group: ManagedGroup }
        | { success: false; group: ManagedGroup; reason: string }
      > => {
        try {
          await buildRequest();
          return { success: true as const, group };
        } catch (error: unknown) {
          const floodSecs = getFloodWaitSeconds(error);
          if (floodSecs !== null && floodSecs <= 8 && retriesLeft > 0) {
            await sleep((floodSecs + 1) * 1000);
            return attempt(retriesLeft - 1);
          }
          return {
            success: false as const,
            group,
            reason: this.getErrorReason(error),
          };
        }
      };

      return attempt(1);
    };

    const settled = await Promise.allSettled(
      groups.map((group) => limit(() => runOne(group)))
    );

    const results: Array<
      | { success: true; group: ManagedGroup }
      | { success: false; group: ManagedGroup; reason: string }
    > = settled.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      return {
        success: false as const,
        group: groups[index],
        reason: this.getErrorReason(result.reason),
      };
    });
    
    let success = 0;
    let failed = 0;
    const failedGroups: string[] = [];
    const failureDetails: BatchGroupFailure[] = [];
    
    results.forEach((result) => {
      if (result.success) {
        success++;
      } else {
        failed++;
        failedGroups.push(result.group.title);
        failureDetails.push({
          group: result.group,
          reason: (result as { reason: string }).reason,
        });
      }
    });

    void reason;
    return {
      success,
      failed,
      failedGroups,
      failureDetails,
      unresolved: false,
    };
  }

  // 批量解封操作（全并发版本）
  static async batchUnbanUser(
    client: TelegramClient,
    groups: ManagedGroup[],
    userId: number,
    participant?: tl.TypeInputPeer
  ): Promise<{ success: number; failed: number; failedGroups: string[]; unresolved: boolean; unresolvedReason?: string }> {
    let resolvedParticipant: tl.TypeInputPeer;
    try {
      resolvedParticipant = await this.resolveParticipant(client, userId, participant);
    } catch (error: unknown) {
      return {
        success: 0,
        failed: groups.length,
        failedGroups: groups.map((group) => group.title),
        unresolved: true,
        unresolvedReason: this.getErrorReason(error),
      };
    }

    const rights = { _: 'chatBannedRights' as const,
      untilDate: 0,
    };

    const limit = (await ensurePLimit())(4);

    const runOne = async (
      group: ManagedGroup
    ): Promise<{ success: boolean; group: ManagedGroup }> => {
      if (group.kind === 'chat') {
        // 基础群不支持解封操作
        return { success: false, group };
      }

      const buildRequest = async (): Promise<unknown> => {
        const channelInput = await resolveChannelInput(client, group);
        return client.call({
              _: 'channels.editBanned',
              channel: channelInput as unknown as tl.TypeInputChannel,
              participant: resolvedParticipant,
              bannedRights: rights,
            });
      };

      const attempt = async (
        retriesLeft: number
      ): Promise<{ success: boolean; group: ManagedGroup }> => {
        try {
          await buildRequest();
          return { success: true, group };
        } catch (error: unknown) {
          const floodSecs = getFloodWaitSeconds(error);
          if (floodSecs !== null && floodSecs <= 8 && retriesLeft > 0) {
            await sleep((floodSecs + 1) * 1000);
            return attempt(retriesLeft - 1);
          }
          return { success: false, group };
        }
      };

      return attempt(1);
    };

    const settled = await Promise.allSettled(
      groups.map((group) => limit(() => runOne(group)))
    );

    const results: Array<{ success: boolean; group: ManagedGroup }> = settled.map(
      (result, index) => {
        if (result.status === 'fulfilled') {
          return result.value;
        }
        return { success: false, group: groups[index] };
      }
    );
    
    let success = 0;
    let failed = 0;
    const failedGroups: string[] = [];
    
    results.forEach((result) => {
      if (result.success) {
        success++;
      } else {
        failed++;
        failedGroups.push(result.group.title);
      }
    });

    return { success, failed, failedGroups, unresolved: false };
  }
}

// ==================== 命令处理器 ====================
class CommandHandlers {
  // 单群基础命令处理
  static async handleBasicCommand(
    client: TelegramClient,
    message: any,
    action: 'kick' | 'ban' | 'unban' | 'mute' | 'unmute'
  ): Promise<void> {
    try {
      // 权限检查
      const hasPermission = await PermissionManager.checkAdminPermission(
        client,
        message.peerId
      );
      
      if (!hasPermission) {
        await MessageManager.smartEdit(message, "❌ 无管理员权限");
        return;
      }

      // 解析参数
      const args = message.message?.split(" ").slice(1) || [];
      const { user, uid, participant, resolutionError, chatType } = await UserResolver.resolveTarget(client, message, args);

      if (!uid) {
        await MessageManager.smartEdit(message, "❌ 获取用户失败");
        return;
      }

      const basicGroupActionAllowedWithoutParticipant = chatType === 'chat' && ['ban', 'kick'].includes(action);
      if (!participant && ['ban', 'unban', 'mute', 'unmute', 'kick'].includes(action) && !basicGroupActionAllowedWithoutParticipant) {
        const errorText = resolutionError === 'TARGET_ENTITY_UNRESOLVABLE'
          ? '❌ 无法解析该目标的 Telegram 实体，请使用回复消息或 @用户名 后再试'
          : '❌ 获取用户失败';
        await MessageManager.smartEdit(message, errorText);
        return;
      }

      // 检查目标是否为管理员
      const isAdmin = await PermissionManager.isTargetAdmin(client, message.peerId, uid);
      if (isAdmin) {
        const hasConfirm = args.includes('true');
        if (!hasConfirm) {
          await MessageManager.smartEdit(message, "⚠️ 目标是管理员，请在命令后加上 <code>true</code> 确认执行");
          return;
        }
      }

      const display = UserResolver.formatUser(user, uid);
      const status = await MessageManager.smartEdit(
        message,
        `⏳ ${this.getActionName(action)}${htmlEscape(display)}...`,
        0
      );

      let success = false;
      let resultText = "";

      switch (action) {
        case 'kick':
          success = await BanManager.kickUser(client, message.peerId, uid, participant);
          resultText = `✅ 已踢出 ${htmlEscape(display)}`;
          break;
        case 'ban':
          // 先删除消息，再封禁
          const deleteSuccess = await BanManager.deleteHistoryInCurrentChat(client, message.peerId, uid, participant);
          success = await BanManager.banUser(client, message.peerId, uid, 0, participant);
          const deleteText = deleteSuccess ? '(已清理消息)' : '';
          resultText = chatType === 'chat'
            ? `✅ 已移出 ${htmlEscape(display)} ${deleteText}`
            : `✅ 已封禁 ${htmlEscape(display)} ${deleteText}`;
          break;
        case 'unban':
          success = await BanManager.unbanUser(client, message.peerId, uid, participant);
          resultText = chatType === 'chat'
            ? `✅ 已处理 ${htmlEscape(display)}`
            : `✅ 已解封 ${htmlEscape(display)}`;
          break;
        case 'mute':
          const duration = parseTimeString(args[1]);
          success = await BanManager.muteUser(client, message.peerId, uid, duration, participant);
          const durationText = duration === 0 ? '永久' : this.formatDuration(duration);
          resultText = chatType === 'chat'
            ? `✅ 已处理 ${htmlEscape(display)} ${durationText}`
            : `✅ 已禁言 ${htmlEscape(display)} ${durationText}`;
          break;
        case 'unmute':
          success = await BanManager.unbanUser(client, message.peerId, uid, participant);
          resultText = chatType === 'chat'
            ? `✅ 已处理 ${htmlEscape(display)}`
            : `✅ 已解禁言 ${htmlEscape(display)}`;
          break;
      }

      if (success) {
        await MessageManager.smartEdit(status, resultText);
      } else {
        await MessageManager.smartEdit(status, `❌ ${this.getActionName(action)}失败`);
      }
    } catch (error: unknown) {
      await MessageManager.smartEdit(message, `❌ 操作失败：${htmlEscape(getErrorMessage(error))}`);
    }
  }

  private static getActionName(action: string): string {
    const names: Record<string, string> = {
      kick: '踢出', ban: '封禁', unban: '解封',
      mute: '禁言', unmute: '解除禁言'
    };
    return names[action] || action;
  }

  private static formatDuration(seconds: number): string {
    if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`;
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
    if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
    return `${seconds}s`;
  }

  // sb命令：即时返回+后台处理
  static async handleSuperBan(
    client: TelegramClient,
    message: any
  ): Promise<void> {
    try {
      const args = message.message?.split(" ").slice(1) || [];
      const { user, uid, participant, resolutionError } = await UserResolver.resolveTarget(client, message, args);

      if (!uid) {
        await MessageManager.smartEdit(message, "❌ 获取用户失败");
        return;
      }

      if (!participant) {
        const errorText = resolutionError === 'TARGET_ENTITY_UNRESOLVABLE'
          ? '❌ 无法解析该目标的 Telegram 实体，请先通过回复消息、@用户名或让该目标在当前会话中可见后再试'
          : '❌ 获取用户失败';
        await MessageManager.smartEdit(message, errorText);
        return;
      }

      const groups = await GroupManager.getManagedGroups(client);
      const hasBasicGroups = groups.some((group) => group.kind === 'chat');
      
      if (groups.length === 0) {
        await MessageManager.smartEdit(message, "❌ 无管理群组");
        return;
      }

      // 权限检查：并发检查目标是否为管理员（使用 p-limit 控制并发避免 flood）
      const checkLimit = (await ensurePLimit())(4);
      const adminResults = await Promise.allSettled(
        groups.map((group) =>
          checkLimit(async () => {
            try {
              const target = await resolvePermissionTarget(client, group);
              return await PermissionManager.isTargetAdmin(client, target, uid);
            } catch (_e: unknown) {
              return false;
            }
          })
        )
      );
      const adminGroups = adminResults.filter(
        (r) => r.status === 'fulfilled' && r.value
      ).length;

      if (adminGroups > 0) {
        const hasConfirm = args.includes('true');
        if (!hasConfirm) {
          await MessageManager.smartEdit(message, `⚠️ 目标在 ${adminGroups} 个管理群中具有管理员身份，请在命令后加上 <code>true</code> 确认执行`);
          return;
        }
      }

      const display = UserResolver.formatUser(user, uid);

      // 立即返回处理中状态
      const statusActionText = (message as { isGroup?: boolean; isChannel?: boolean }).isGroup && !(message as { isChannel?: boolean }).isChannel ? '移出' : '封禁';
      const status = await MessageManager.smartEdit(
        message,
        `⚡ 在${groups.length}个频道/群组中${statusActionText}该用户...`,
        0
      );

      // 后台处理：不等待结果，立即启动
      const backgroundProcess = async () => {
        const startTime = Date.now();
        
        // 并发执行删除和封禁
        const [deletedInCurrent, banResult] = await Promise.allSettled([
          BanManager.deleteHistoryInCurrentChat(client, message.peerId, uid, participant),
          BanManager.batchBanUser(client, groups, uid, participant, args.slice(1).join(" ") || "违规")
        ]);

        const elapsed = (Date.now() - startTime) / 1000;
        
        // 处理结果
        const deleteSuccess = deletedInCurrent.status === 'fulfilled' && deletedInCurrent.value;
        const {
          success = 0,
          failed = groups.length,
          failureDetails = [],
          unresolved = false,
          unresolvedReason,
        } = banResult.status === 'fulfilled'
          ? banResult.value
          : { failureDetails: [], unresolved: true, unresolvedReason: 'UNKNOWN_ERROR' };

        // 内部日志辅助：不含 HTML 转义的纯文本原因汇总
        const summarizeReasonsPlain = (details: BatchGroupFailure[]): string => {
          const counts = new Map<string, number>();
          for (const item of details) {
            counts.set(item.reason, (counts.get(item.reason) || 0) + 1);
          }
          return Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([reason, count]) => `${reason}×${count}`)
            .join(', ');
        };

        if (failureDetails.length > 0) {
          logger.warn(`[sb] 封禁失败汇总: failed=${failureDetails.length}, unresolved=${unresolved ? 'yes' : 'no'}, reasons=[${summarizeReasonsPlain(failureDetails)}]`);
        }

        const summarizeReasons = (details: BatchGroupFailure[]): string => {
          const counts = new Map<string, number>();
          for (const item of details) {
            counts.set(item.reason, (counts.get(item.reason) || 0) + 1);
          }
          return Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([reason, count]) => `${htmlEscape(reason)}×${count}`)
            .join('、');
        };

        const failureSummary = unresolved
          ? `<br>⚠️ 目标实体无法解析：${htmlEscape(unresolvedReason || 'UNKNOWN_ERROR')}`
          : failed > 0
            ? `<br>⚠️ 失败 ${failed} 个频道/群组（${summarizeReasons(failureDetails)}）`
            : '';
        const capabilityNote = hasBasicGroups
          ? `<br>ℹ️ 基础群仅支持移出现有成员，不支持对未入群目标提前封禁`
          : '';

        // 更新最终结果
        const finalActionText = (message as { isGroup?: boolean; isChannel?: boolean }).isGroup && !(message as { isChannel?: boolean }).isChannel ? '移出' : '封禁';
        const result = `✅ 在${success}个频道/群组中${finalActionText}该用户 ${htmlEscape(display)}${failureSummary}${capabilityNote}<br>🗑️当前群组消息: ${deleteSuccess ? '✓已清理' : '✗'} | ⏱️${elapsed.toFixed(1)}s`;
        
        // 更新为最终结果
        const lc1 = getCurrentGenerationContext();
        if (lc1) {
          lc1.setTimeout(() => {
            MessageManager.smartEdit(status, result, 30).catch(() => { /* smartEdit may fail if msg was deleted */ });
          }, 100, { label: 'aban:sb-result-update' });
        }
      };

      // 后台执行，不等待
      backgroundProcess().catch(() => { /* background process error logged internally */ });

    } catch (error: unknown) {
      await MessageManager.smartEdit(message, `❌ ${getErrorMessage(error)}`);
    }
  }

  // unsb命令：即时返回+后台处理
  static async handleSuperUnban(
    client: TelegramClient,
    message: any
  ): Promise<void> {
    try {
      const args = message.message?.split(" ").slice(1) || [];
      const { user, uid, participant, resolutionError } = await UserResolver.resolveTarget(client, message, args);

      if (!uid) {
        await MessageManager.smartEdit(message, "❌ 获取用户失败");
        return;
      }

      if (!participant) {
        const errorText = resolutionError === 'TARGET_ENTITY_UNRESOLVABLE'
          ? '❌ 无法解析该目标的 Telegram 实体，请先通过回复消息、@用户名或让该目标在当前会话中可见后再试'
          : '❌ 获取用户失败';
        await MessageManager.smartEdit(message, errorText);
        return;
      }

      const groups = await GroupManager.getManagedGroups(client);
      const hasBasicGroups = groups.some((group) => group.kind === 'chat');
      
      if (groups.length === 0) {
        await MessageManager.smartEdit(message, "❌ 无管理群组");
        return;
      }

      // 权限检查：并发检查目标是否为管理员（使用 p-limit 控制并发避免 flood）
      const checkLimitUnban = (await ensurePLimit())(4);
      const adminResultsUnban = await Promise.allSettled(
        groups.map((group) =>
          checkLimitUnban(async () => {
            try {
              const target = await resolvePermissionTarget(client, group);
              return await PermissionManager.isTargetAdmin(client, target, uid);
            } catch (_e: unknown) {
              return false;
            }
          })
        )
      );
      const adminGroups = adminResultsUnban.filter(
        (r) => r.status === 'fulfilled' && r.value
      ).length;

      if (adminGroups > 0) {
        const hasConfirm = args.includes('true');
        if (!hasConfirm) {
          await MessageManager.smartEdit(message, `⚠️ 目标在 ${adminGroups} 个管理群中具有管理员身份，请在命令后加上 <code>true</code> 确认执行`);
          return;
        }
      }

      const display = UserResolver.formatUser(user, uid);
      
      // 立即返回处理中状态
      const status = await MessageManager.smartEdit(
        message,
        `🔓 在${groups.length}个频道/群组中解封该用户...`,
        0
      );

      // 后台处理
      const backgroundProcess = async () => {
        const startTime = Date.now();
        const {
          success = 0,
          failed = groups.length,
          unresolved = false,
          unresolvedReason,
        } = await BanManager.batchUnbanUser(client, groups, uid, participant).catch(() => ({
          success: 0,
          failed: groups.length,
          unresolved: true,
          unresolvedReason: 'UNKNOWN_ERROR',
        }));
        
        const elapsed = (Date.now() - startTime) / 1000;

        // 内部日志：记录失败原因
        if (!unresolved && failed > 0) {
          logger.warn(`[unsb] 解封失败: failed=${failed}/${groups.length}`);
        }

        const failureSummary = unresolved
          ? ` | ⚠️ 目标实体无法解析：${htmlEscape(unresolvedReason || 'UNKNOWN_ERROR')}`
          : failed > 0
            ? ` | ⚠️ ${failed} 个频道/群组解封失败`
            : '';
        const capabilityNote = hasBasicGroups
          ? ` | ℹ️ 基础群不支持跨群解封语义，仅会跳过`
          : '';
        const result = `✅ 在${success}个频道/群组中解封该用户 ${htmlEscape(display)}${failureSummary}${capabilityNote} | ⏱️${elapsed.toFixed(1)}s`;
        
        const lc2 = getCurrentGenerationContext();
        if (lc2) {
          lc2.setTimeout(() => {
            MessageManager.smartEdit(status, result, 30).catch(() => { /* smartEdit may fail if msg was deleted */ });
          }, 100, { label: 'aban:unsb-result-update' });
        }
      };

      backgroundProcess().catch(() => { /* background process error logged internally */ });
    } catch (error: unknown) {
      await MessageManager.smartEdit(message, `❌ ${getErrorMessage(error)}`);
    }
  }
}

// ==================== 插件主类 ====================
class AbanPlugin extends Plugin {
  description: string = HELP_TEXT;

  cleanup(): void {
    // Lifecycle-aware timers are now managed by GenerationContext
    // and cleaned up automatically on reload. No manual cleanup needed.
  }

  cmdHandlers: Record<string, (msg: MtcuteMessageContext) => Promise<void>> = {
    // 帮助命令
    aban: async (msg) => {
      await MessageManager.smartEdit(msg, HELP_TEXT);
    },

    // 基础管理命令
    kick: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }
      await CommandHandlers.handleBasicCommand(client, msg, 'kick');
    },

    ban: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }
      await CommandHandlers.handleBasicCommand(client, msg, 'ban');
    },

    unban: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }
      await CommandHandlers.handleBasicCommand(client, msg, 'unban');
    },

    mute: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }
      await CommandHandlers.handleBasicCommand(client, msg, 'mute');
    },

    unmute: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }
      await CommandHandlers.handleBasicCommand(client, msg, 'unmute');
    },

    // 批量管理命令
    sb: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }
      await CommandHandlers.handleSuperBan(client, msg);
    },

    unsb: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }
      await CommandHandlers.handleSuperUnban(client, msg);
    },

    // 系统命令
    refresh: async (msg) => {
      const client = await getGlobalClient();
      if (!client) {
        await MessageManager.smartEdit(msg, "❌ 客户端未初始化");
        return;
      }

      const status = await MessageManager.smartEdit(msg, "🔄 刷新中...", 0);
      
      try {
        GroupManager.clearCache();
        const groups = await GroupManager.getManagedGroups(client);
        await MessageManager.smartEdit(status, `✅ 已刷新 ${groups.length}个群组`);
      } catch (_e: unknown) {
        await MessageManager.smartEdit(status, `❌ 刷新失败`);
      }
    }
  };
}

// 导出插件实例
export default new AbanPlugin();
