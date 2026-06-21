import { safeGetMe } from "@utils/authGuards";
/**
 * DME (Delete My Messages) Plugin for TeleBox
 * 智能防撤回删除插件 - 优化版本
 * 支持媒体消息防撤回处理，文本消息快速删除
 */

import { TelegramClient } from "@mtcute/node";
import type { MessageContext } from "@mtcute/dispatcher";
import { html } from "@mtcute/html-parser";
import { getGlobalClient } from "@utils/globalClient";
import { getEntityWithHash } from "@utils/entityHelpers";
import { Plugin } from "@utils/pluginBase";
import * as fs from "fs";
import * as path from "path";
import { logger } from "@utils/logger";
import { Long } from "@mtcute/core";

// 常量配置
const CONFIG = {
  TROLL_IMAGE_URL:
    "https://raw.githubusercontent.com/TeleBoxDev/TeleBox/main/telebox.png",
  TROLL_IMAGE_PATH: "./assets/dme/dme_troll_image.png",
  BATCH_SIZE: 50,
  MIN_BATCH_SIZE: 5, // 最小批次大小
  MAX_BATCH_SIZE: 100, // 最大批次大小
  SEARCH_LIMIT: 100,
  MAX_SAFE_REQUEST_COUNT: 2000, // 单次请求安全上限（防止堆内存暴涨）
  CHANNEL_EMPTY_BATCH_LIMIT: 300, // 频道深度扫描空批次上限
  UNLIMITED_REQUEST_COUNT: 999999, // 特殊值：删除全部可见消息
  MAX_SEARCH_MULTIPLIER: 10,
  MIN_MAX_SEARCH: 2000,
  DEFAULT_BATCH_SIZE: 30,
  RETRY_ATTEMPTS: 3, // 重试次数
  DELAYS: {
    BATCH: 200,
    EDIT_WAIT: 1000,
    SEARCH: 100,
    RESULT_DISPLAY: 3000,
    RETRY: 2000, // 重试延迟
    NETWORK_ERROR: 5000, // 网络错误延迟
  },
} as const;

// 工具函数
const htmlEscape = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" }[
        m
      ] || m)
  );

// 获取命令前缀
const prefixes = ["."];
const mainPrefix = prefixes[0];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const TEXT_PLACEHOLDER = "占位符";

/**
 * 获取防撤回图片，支持缓存
 */
async function getTrollImage(): Promise<string | null> {
  if (fs.existsSync(CONFIG.TROLL_IMAGE_PATH)) {
    return CONFIG.TROLL_IMAGE_PATH;
  }

  const dir = path.dirname(CONFIG.TROLL_IMAGE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  try {
    const response = await fetch(CONFIG.TROLL_IMAGE_URL);
    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(CONFIG.TROLL_IMAGE_PATH, buffer);
      return CONFIG.TROLL_IMAGE_PATH;
    }
    return null;
  } catch (error) {
    logger.error("[DME] 下载防撤回图片失败:", error);
    return null;
  }
}

/**
 * 带重试机制的删除消息函数
 */
async function deleteMessagesWithRetry(
  client: TelegramClient,
  chatPeer: any,
  messageIds: number[],
  retryCount: number = 0
): Promise<number> {
  try {
    await client.deleteMessagesById(chatPeer, messageIds, { revoke: true });
    
    // 强制刷新更新状态，确保跨平台同步
    try {
      await client.call({ _: "updates.getState" });
      logger.info(`[DME] 已触发跨平台同步刷新`);
    } catch (syncError) {
      logger.info(`[DME] 同步刷新失败，但不影响删除操作:`, syncError);
    }
    
    return messageIds.length;
  } catch (error: any) {
    if (retryCount < CONFIG.RETRY_ATTEMPTS) {
      logger.info(`[DME] 删除失败，第 ${retryCount + 1} 次重试:`, error.message);
      await sleep(CONFIG.DELAYS.RETRY * (retryCount + 1));
      return deleteMessagesWithRetry(client, chatPeer, messageIds, retryCount + 1);
    }
    throw error;
  }
}

/**
 * 通用删除消息函数 - 增强版本
 */
async function deleteMessagesUniversal(
  client: TelegramClient,
  chatPeer: any,
  messageIds: number[]
): Promise<number> {
  return deleteMessagesWithRetry(client, chatPeer, messageIds);
}

/**
 * 媒体消息防撤回处理
 */
async function editMediaMessageToAntiRecall(
  client: TelegramClient,
  message: any,
  trollImagePath: string | null,
  chatPeer: any
): Promise<boolean> {
  // 排除网页预览
  if (!message.media || message.media?._ === "messageMediaWebPage") {
    return false;
  }

  // 检查是否为贴纸并跳过
  if (message.media?._ === "messageMediaDocument") {
    const doc = message.media.document;
    if (doc?._ === "document") {
      // 检查文档属性中是否包含贴纸标识
      const isSticker = doc.attributes?.some(
        (attr: any) => attr?._ === "documentAttributeSticker"
      );
      if (isSticker) {
        return false;
      }
    }
  }

  if (!trollImagePath || !fs.existsSync(trollImagePath)) {
    return false;
  }

  // 超过可编辑时间窗口(48h)则静默跳过，避免 MESSAGE_EDIT_TIME_EXPIRED
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof message.date === "number" && nowSec - message.date > 172800) {
    return false;
  }

  try {
    const buffer = fs.readFileSync(trollImagePath);
    await client.editMessage({
      chatId: chatPeer,
      message: message.id,
      media: buffer as unknown as import("@mtcute/core").InputMediaLike,
    });
    return true;
  } catch (e) {
    // 任意编辑失败(含 MESSAGE_EDIT_TIME_EXPIRED)静默跳过
    return false;
  }
}

async function editTextMessageToPlaceholder(
  client: TelegramClient,
  message: any,
  chatPeer: any
): Promise<boolean> {
  if (message.media) {
    return false;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof message.date === "number" && nowSec - message.date > 172800) {
    return false;
  }

  const currentText = typeof message.message === "string" ? message.message : "";
  if (currentText === TEXT_PLACEHOLDER) {
    return true;
  }

  try {
    await client.editMessage({
      chatId: chatPeer,
      message: message.id,
      text: TEXT_PLACEHOLDER,
    });
    return true;
  } catch (e) {
    return false;
  }
}

function isSavedMessagesPeer(chatPeer: any, myId: number): boolean {
  return (
    chatPeer?._ === "inputPeerSelf" ||
    (chatPeer?._ === "inputPeerUser" && chatPeer.userId === myId)
  );
}

function peerToTypedKey(peer: any): string | null {
  if (!peer) return null;
  if (peer.userId !== undefined && peer.userId !== null) {
    return `user:${peer.userId.toString()}`;
  }
  if (peer.channelId !== undefined && peer.channelId !== null) {
    return `channel:${peer.channelId.toString()}`;
  }
  if (peer.chatId !== undefined && peer.chatId !== null) {
    return `chat:${peer.chatId.toString()}`;
  }
  return null;
}

function normalizeIdToken(idText: string): string {
  if (idText.startsWith("-100")) return idText.slice(4);
  if (idText.startsWith("-")) return idText.slice(1);
  return idText;
}

function getPeerRawId(peer: any): string | null {
  if (!peer) return null;
  if (peer.userId !== undefined && peer.userId !== null) {
    return peer.userId.toString();
  }
  if (peer.channelId !== undefined && peer.channelId !== null) {
    return peer.channelId.toString();
  }
  if (peer.chatId !== undefined && peer.chatId !== null) {
    return peer.chatId.toString();
  }
  if (
    typeof peer === "bigint" ||
    typeof peer === "number" ||
    typeof peer === "string"
  ) {
    return peer.toString();
  }
  return null;
}

async function getSendAsIdentitySet(
  client: TelegramClient,
  chatPeer: any
): Promise<{ typedKeys: Set<string>; rawIds: Set<string> }> {
  const typedKeys = new Set<string>();
  const rawIds = new Set<string>();
  try {
    const sendAs = await client.call({
      _: "channels.getSendAs",
      peer: chatPeer,
    }) as { peers?: { peer?: unknown }[] };
    const peers = sendAs.peers || [];
    for (const item of peers) {
      const peer = item?.peer;
      const typedKey = peerToTypedKey(peer);
      if (typedKey) {
        typedKeys.add(typedKey);
      }
      const rawId = getPeerRawId(peer);
      if (rawId) {
        rawIds.add(rawId);
        rawIds.add(normalizeIdToken(rawId));
      }
    }
    logger.info(
      `[DME] 获取发送身份成功: typed=${typedKeys.size}, raw=${rawIds.size}`
    );
  } catch (error: any) {
    logger.info(`[DME] 获取发送身份失败，回退基础匹配: ${error?.message || error}`);
  }
  return { typedKeys, rawIds };
}

function isMyMessageByIdentity(
  message: any,
  myId: number,
  sendAsTypedKeySet: Set<string>,
  sendAsRawIdSet: Set<string>
): boolean {
  // Check senderId or fromId for the sender user/channel ID
  const senderId = message.fromId?.userId ?? message.fromId?.channelId ?? message.senderId;
  if (senderId?.toString?.() === myId.toString()) {
    return true;
  }
  if (message.out === true) {
    return true;
  }
  const identityCandidates = [message.fromId, message.senderId];
  for (const candidate of identityCandidates) {
    const typedKey = peerToTypedKey(candidate);
    if (typedKey && sendAsTypedKeySet.has(typedKey)) {
      return true;
    }

    const rawId = getPeerRawId(candidate);
    if (rawId) {
      if (
        sendAsRawIdSet.has(rawId) ||
        sendAsRawIdSet.has(normalizeIdToken(rawId))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 增强的消息搜索函数 - 带容错机制
 */
async function searchMyMessagesOptimized(
  client: TelegramClient,
  chatPeer: any,
  myId: number,
  userRequestedCount: number
): Promise<any[]> {
  // 使用多种策略搜索用户消息，提高成功率
  let allMessages: any[] = [];
  const maxSearchCount = Math.max(
    userRequestedCount * CONFIG.MAX_SEARCH_MULTIPLIER,
    CONFIG.MIN_MAX_SEARCH
  );

  try {
    // 策略1: 使用Search API搜索用户消息
    const searchResult: any = await client.call({
      _: "messages.search",
      peer: chatPeer,
      q: "",
      fromId: await client.resolvePeer(myId),
      filter: { _: "inputMessagesFilterEmpty" },
      minDate: 0,
      maxDate: 0,
      offsetId: 0,
      addOffset: 0,
      limit: maxSearchCount,
      maxId: 0,
      minId: 0,
      hash: Long.fromNumber(0)
    });
    
    if (searchResult.messages) {
      allMessages = searchResult.messages.filter(
        (m: any) => m._ === "message" && (m.fromId?.userId === myId || m.fromId?.channelId === myId || m.senderId?.toString() === myId.toString())
      );
      logger.info(`[DME] Search API找到 ${allMessages.length} 条消息`);
    }
  } catch (searchError) {
    logger.info(`[DME] Search API失败，尝试GetHistory:`, searchError);
  }

  // 如果Search API结果不足，尝试GetHistory API
  if (allMessages.length < userRequestedCount) {
    try {
      const history: any = await client.call({
        _: "messages.getHistory",
        peer: chatPeer,
        offsetId: 0,
        offsetDate: 0,
        addOffset: 0,
        limit: Math.min(maxSearchCount, 1000),
        maxId: 0,
        minId: 0,
        hash: Long.fromNumber(0)
      });
      
      const historyMessages = history.messages || [];
      const myMessages = historyMessages.filter(
        (m: any) =>
          m._ === "message" &&
          (m.fromId?.userId === myId ||
            m.fromId?.channelId === myId ||
            m.senderId?.toString() === myId.toString() ||
            m.out === true)
      );
      
      // 合并去重
      const existingIds = new Set(allMessages.map((m: any) => m.id));
      for (const msg of myMessages) {
        if (!existingIds.has(msg.id)) {
          allMessages.push(msg);
        }
      }
      
      logger.info(`[DME] GetHistory补充后总计 ${allMessages.length} 条消息`);
    } catch (historyError) {
      logger.info(`[DME] GetHistory也失败:`, historyError);
    }
  }

  // 按消息ID降序排序（最新的在前）
  allMessages.sort((a: any, b: any) => b.id - a.id);
  
  return allMessages.slice(0, userRequestedCount);
}

/**
 * 带重试机制的实体获取函数
 */
async function getEntityWithRetry(
  client: TelegramClient,
  entityId: string,
  retryCount: number = 0
): Promise<any> {
  try {
    return await client.resolvePeer(entityId);
  } catch (error: any) {
    if (retryCount < 2) {
      logger.info(`[DME] 获取实体失败，第 ${retryCount + 1} 次重试:`, error.message);
      await sleep(1000 * (retryCount + 1));
      return getEntityWithRetry(client, entityId, retryCount + 1);
    }
    throw error;
  }
}

/**
 * 通用实体解析器 - 增强版本
 */
async function resolveChatEntity(client: TelegramClient, chatId: string): Promise<any> {
  logger.info(`[DME] 开始解析聊天实体: ${chatId}`);

  // 策略1: 优先使用主仓库共享的 accessHash 感知解析器，覆盖折叠/归档等缓存未预热场景
  try {
    const entity = await getEntityWithHash(client, chatId);
    const entityType = typeof entity === 'object' && entity !== null ? (entity as Record<string, unknown>)._ as string : undefined;
    logger.info(`[DME] getEntityWithHash 解析成功:`, entityType || typeof entity);
    return entity;
  } catch (hashError: any) {
    logger.info(`[DME] getEntityWithHash 解析失败，继续多策略回退:`, hashError?.message || hashError);
  }

  // 策略2: 直接使用原始chatId尝试
  try {
    const entity = await getEntityWithRetry(client, chatId);
    const entityType2 = typeof entity === 'object' && entity !== null ? (entity as Record<string, unknown>)._ as string : undefined;
    logger.info(`[DME] 直接解析成功:`, entityType2 || typeof entity);
    return entity;
  } catch (directError: any) {
    logger.info(`[DME] 直接解析失败:`, directError.message);
  }

  // 策略2: 尝试标准化群组ID格式
  const normalizedIds = [chatId];
  
  // 如果是负数ID，尝试不同格式
  if (chatId.startsWith("-100")) {
    normalizedIds.push(chatId.substring(4));
    normalizedIds.push(chatId.substring(1));
  } else if (chatId.startsWith("-")) {
    normalizedIds.push(chatId.substring(1));
    normalizedIds.push(`-100${chatId.substring(1)}`);
  } else {
    normalizedIds.push(`-100${chatId}`);
    normalizedIds.push(`-${chatId}`);
  }

  // 尝试所有可能的ID格式
  for (const normalizedId of normalizedIds) {
    if (normalizedId === chatId) continue;
    
    try {
      logger.info(`[DME] 尝试标准化ID: ${normalizedId}`);
      const entity = await getEntityWithRetry(client, normalizedId);
      const entityType3 = typeof entity === 'object' && entity !== null ? (entity as Record<string, unknown>)._ as string : undefined;
      logger.info(`[DME] 标准化ID解析成功:`, entityType3 || typeof entity);
      return entity;
    } catch (normalizedError: any) {
      logger.info(`[DME] 标准化ID ${normalizedId} 解析失败:`, normalizedError.message);
    }
  }

  // 策略3: 通过对话列表查找匹配的实体
  try {
    logger.info(`[DME] 尝试通过对话列表查找实体`);
    const dialogsResult: any = await client.call({
      _: "messages.getDialogs",
      offsetDate: 0,
      offsetId: 0,
      offsetPeer: { _: "inputPeerEmpty" },
      limit: 100,
      hash: Long.fromNumber(0)
    });
    const dialogs = dialogsResult.dialogs || [];
    const chats = dialogsResult.chats || [];
    const users = dialogsResult.users || [];
    
    for (const dialog of dialogs) {
      const dialogPeer = dialog.peer;
      let dialogId = "";
      if (dialogPeer?.userId) dialogId = dialogPeer.userId.toString();
      else if (dialogPeer?.channelId) dialogId = dialogPeer.channelId.toString();
      else if (dialogPeer?.chatId) dialogId = dialogPeer.chatId.toString();
      
      if (dialogId === chatId || 
          dialogId === chatId.replace("-100", "") ||
          dialogId === chatId.replace("-", "")) {
        logger.info(`[DME] 通过对话列表找到实体`);
        return dialogPeer;
      }
    }
  } catch (dialogsError: any) {
    logger.info(`[DME] 对话列表查找失败:`, dialogsError.message);
  }

  throw new Error(`无法解析聊天实体: ${chatId}`);
}

/**
 * 从回复头中提取 topic root id
 */
function getTopicRootIdFromReplyHeader(replyTo: any): number | undefined {
  if (!replyTo) return undefined;
  const candidates = [
    replyTo.threadId,
    replyTo.replyTopId,
    replyTo.replyToTopId,
    replyTo.topMsgId,
    replyTo.replyToMsgId,
    replyTo.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return undefined;
}

function getTopicRootIdFromMessage(message: any): number | undefined {
  // For MessageContext, use replyToMessage; for raw objects, use replyTo
  const replyTo = message?.replyToMessage ?? message?.replyTo;
  return getTopicRootIdFromReplyHeader(replyTo);
}

function isMessageInTopic(message: any, topicRootId?: number): boolean {
  if (typeof topicRootId !== "number") return true;
  return getTopicRootIdFromMessage(message) === topicRootId;
}

/**
 * 自适应批次删除函数
 */
async function adaptiveBatchDelete(
  client: TelegramClient,
  chatPeer: any,
  messageIds: number[]
): Promise<{ deletedCount: number; failedCount: number }> {
  let deletedCount = 0;
  let failedCount = 0;
  let currentBatchSize: number = CONFIG.BATCH_SIZE;

  for (let i = 0; i < messageIds.length; i += currentBatchSize) {
    const batch = messageIds.slice(i, i + currentBatchSize);
    
    try {
      await deleteMessagesWithRetry(client, chatPeer, batch);
      deletedCount += batch.length;
      
      // 成功则可以适当增加批次大小
      if (currentBatchSize < CONFIG.MAX_BATCH_SIZE) {
        currentBatchSize = Math.min(currentBatchSize + 5, CONFIG.MAX_BATCH_SIZE);
      }
      
      logger.info(`[DME] 成功删除批次 ${batch.length} 条，当前批次大小: ${currentBatchSize}`);
      await sleep(CONFIG.DELAYS.BATCH);
      
    } catch (error: any) {
      logger.info(`[DME] 批次删除失败，减少批次大小:`, error.message);
      
      // 失败则减少批次大小
      currentBatchSize = Math.max(Math.floor(currentBatchSize / 2), CONFIG.MIN_BATCH_SIZE);
      
      if (currentBatchSize <= CONFIG.MIN_BATCH_SIZE && batch.length === 1) {
        // 单条消息删除失败，跳过
        failedCount += 1;
        logger.info(`[DME] 跳过无法删除的消息: ${batch[0]}`);
      } else {
        // 重新尝试当前批次（使用更小的批次大小）
        i -= batch.length;
      }
      
      await sleep(CONFIG.DELAYS.RETRY);
    }
  }

  return { deletedCount, failedCount };
}

/**
 * 收藏夹直接按数量删除（不做媒体编辑）
 */
async function deleteInSavedMessages(
  client: TelegramClient,
  chatPeer: any,
  userRequestedCount: number
): Promise<{ processedCount: number; actualCount: number; editedCount: number }> {
  const targetCount =
    userRequestedCount === CONFIG.UNLIMITED_REQUEST_COUNT ? Infinity : userRequestedCount;
  let offsetId = 0;
  let collected = 0;
  let deleted = 0;
  const batchLimit = 100;

  while (collected < targetCount) {
    const limit =
      targetCount === Infinity ? batchLimit : Math.min(batchLimit, targetCount - collected);
    const history: any = await client.call({
      _: "messages.getHistory",
      peer: chatPeer,
      offsetId,
      offsetDate: 0,
      addOffset: 0,
      limit,
      maxId: 0,
      minId: 0,
      hash: Long.fromNumber(0)
    });
    const msgs: any[] = history.messages || [];
    const justMsgs = msgs.filter((m: any) => m._ === "message");
    if (justMsgs.length === 0) break;

    offsetId = justMsgs[justMsgs.length - 1].id;
    const ids = justMsgs.map((m: any) => m.id);
    const result = await deleteMessagesUniversal(client, chatPeer, ids);
    deleted += result;
    collected += ids.length;
    await sleep(CONFIG.DELAYS.BATCH);
  }

  return { processedCount: deleted, actualCount: collected, editedCount: 0 };
}

/**
 * 检测群组是否禁止转发和复制（受限群组）
 */
async function isRestrictedGroup(client: TelegramClient, chatPeer: any): Promise<boolean> {
  try {
    // 对于频道/超级群，检查noforwards属性
    if (chatPeer._ === "inputPeerChannel") {
      const fullChannel: any = await client.call({
        _: "channels.getFullChannel",
        channel: chatPeer,
      });
      return fullChannel?.fullChat?.noforwards === true;
    }
    
    if (chatPeer._ === "inputPeerChat") {
      // 对于普通群组，检查migratedTo属性等
      return false; // 普通群组通常不受此限制
    }
    
    return false;
  } catch (error) {
    logger.info(`[DME] 检测群组限制失败:`, error);
    return false;
  }
}

/**
 * 传统遍历消息流式处理 - 适用于禁止转发和复制的群组
 */
async function traditionalStreamProcessing(
  client: TelegramClient,
  chatPeer: any,
  myId: number,
  userRequestedCount: number,
  isAntiRecallMode: boolean = false,
  topicRootId?: number
): Promise<{
  processedCount: number;
  actualCount: number;
  editedCount: number;
}> {
  logger.info(`[DME] 使用传统遍历消息流式处理模式`);
  
  const targetCount = userRequestedCount === 999999 ? Infinity : userRequestedCount;
  const trollImagePath = isAntiRecallMode ? await getTrollImage() : null;
  const sendAsIdentity =
    chatPeer._ === "inputPeerChannel"
      ? await getSendAsIdentitySet(client, chatPeer)
      : { typedKeys: new Set<string>(), rawIds: new Set<string>() };
  
  let totalProcessed = 0;
  let totalEdited = 0;
  let totalDeleted = 0;
  let offsetId = 0;
  let consecutiveEmptyBatches = 0;
  const maxEmptyBatches =
    chatPeer._ === "inputPeerChannel" ? CONFIG.CHANNEL_EMPTY_BATCH_LIMIT : 3;
  const HISTORY_BATCH = 100; // 每批获取历史消息数量

  // 传统模式：逐批获取历史消息，筛选自己的消息进行处理
  while (totalProcessed < targetCount && consecutiveEmptyBatches < maxEmptyBatches) {
    try {
      // 获取历史消息
      const history: any = await client.call({
        _: "messages.getHistory",
        peer: chatPeer,
        offsetId,
        offsetDate: 0,
        addOffset: 0,
        limit: HISTORY_BATCH,
        maxId: 0,
        minId: 0,
        hash: Long.fromNumber(0)
      });

      const allMessages: any[] = history.messages || [];
      const validMessages = allMessages.filter((m: any) => m._ === "message");
      
      if (validMessages.length === 0) {
        consecutiveEmptyBatches++;
        logger.info(`[DME] 空批次 ${consecutiveEmptyBatches}/${maxEmptyBatches}`);
        await sleep(CONFIG.DELAYS.SEARCH);
        continue;
      }

      // 筛选出自己的消息
      const myMessages = validMessages.filter(
        (m: any) =>
          isMessageInTopic(m, topicRootId) &&
          isMyMessageByIdentity(
            m,
            myId,
            sendAsIdentity.typedKeys,
            sendAsIdentity.rawIds
          )
      );

      if (myMessages.length === 0) {
        // 更新offsetId继续搜索
        offsetId = validMessages[validMessages.length - 1].id;
        consecutiveEmptyBatches++;
        logger.info(
          `[DME] 当前批次无可删消息，空批次 ${consecutiveEmptyBatches}/${maxEmptyBatches}`
        );
        await sleep(CONFIG.DELAYS.SEARCH);
        continue;
      }

      consecutiveEmptyBatches = 0; // 重置空批次计数
      
      // 限制处理数量
      const messagesToProcess = targetCount === Infinity 
        ? myMessages 
        : myMessages.slice(0, targetCount - totalProcessed);

      logger.info(`[DME] 传统模式找到 ${messagesToProcess.length} 条自己的消息`);

      if (isAntiRecallMode) {
        const mediaMessages = messagesToProcess.filter((m: any) => {
          if (!m.media || m.media?._ === "messageMediaWebPage") return false;
          if (m.media?._ === "messageMediaDocument") {
            const doc = m.media.document;
            if (doc?._ === "document") {
              const isSticker = doc.attributes?.some(
                (attr: any) => attr?._ === "documentAttributeSticker"
              );
              if (isSticker) return false;
            }
          }
          return true;
        });
        const textMessages = messagesToProcess.filter(
          (m: any) => !m.media && typeof m.message === "string"
        );

        if (mediaMessages.length > 0 && trollImagePath) {
          logger.info(`[DME] 传统模式编辑 ${mediaMessages.length} 条媒体消息`);
          const editPromises = mediaMessages.map((msg: any) => 
            editMediaMessageToAntiRecall(client, msg, trollImagePath, chatPeer)
              .catch(() => false)
          );
          const editResults = await Promise.allSettled(editPromises);
          const edited = editResults.filter(r => r.status === "fulfilled" && r.value === true).length;
          totalEdited += edited;
          logger.info(`[DME] 传统模式成功编辑 ${edited} 条媒体`);
        }

        if (textMessages.length > 0) {
          logger.info(`[DME] 传统模式编辑 ${textMessages.length} 条文本消息`);
          const textEditPromises = textMessages.map((msg: any) =>
            editTextMessageToPlaceholder(client, msg, chatPeer).catch(() => false)
          );
          const textEditResults = await Promise.allSettled(textEditPromises);
          const textEdited = textEditResults.filter(
            (r) => r.status === "fulfilled" && r.value === true
          ).length;
          totalEdited += textEdited;
          logger.info(`[DME] 传统模式成功编辑 ${textEdited} 条文本`);
        }
        
        if (mediaMessages.length > 0 || textMessages.length > 0) {
          await sleep(CONFIG.DELAYS.EDIT_WAIT);
        }
      }

      // 删除这批消息
      const deleteIds = messagesToProcess.map((m: any) => m.id);
      if (deleteIds.length > 0) {
        try {
          // 分小批次删除，避免API限制
          const DELETE_BATCH_SIZE = 20;
          for (let i = 0; i < deleteIds.length; i += DELETE_BATCH_SIZE) {
            const batch = deleteIds.slice(i, i + DELETE_BATCH_SIZE);
            await deleteMessagesWithRetry(client, chatPeer, batch);
            totalDeleted += batch.length;
            await sleep(CONFIG.DELAYS.BATCH);
          }
          logger.info(`[DME] 传统模式删除 ${deleteIds.length} 条，总计 ${totalDeleted} 条`);
        } catch (error: any) {
          logger.error(`[DME] 传统模式删除失败:`, error.message);
        }
      }

      totalProcessed += messagesToProcess.length;
      
      // 如果已达到目标数量，停止处理
      if (totalProcessed >= targetCount) {
        break;
      }
      
      // 更新偏移ID继续搜索
      offsetId = validMessages[validMessages.length - 1].id;
      await sleep(CONFIG.DELAYS.SEARCH);
      
    } catch (error: any) {
      logger.error(`[DME] 传统模式批次处理失败:`, error.message);
      consecutiveEmptyBatches++;
      await sleep(CONFIG.DELAYS.RETRY);
      
      if (consecutiveEmptyBatches >= maxEmptyBatches) {
        logger.info(`[DME] 传统模式达到最大重试次数，停止处理`);
        break;
      }
    }
  }

  if (consecutiveEmptyBatches >= maxEmptyBatches) {
    logger.info(
      `[DME] 达到空批次上限 ${maxEmptyBatches}，停止继续深扫`
    );
  }

  logger.info(`[DME] 传统模式处理完成，删除 ${totalDeleted} 条，编辑 ${totalEdited} 条`);

  return {
    processedCount: totalDeleted,
    actualCount: totalProcessed,
    editedCount: totalEdited,
  };
}

/**
 * 快速删除模式 - 直接调用官方API删除消息
 */
async function quickDeleteMyMessages(
  client: TelegramClient,
  chatPeer: any,
  myId: number,
  userRequestedCount: number,
  topicRootId?: number
): Promise<{
  processedCount: number;
  actualCount: number;
  editedCount: number;
}> {
  // 频道/超级群里"以频道身份发言"的消息通常不带个人 senderId，
  // 直接改用 out 消息遍历模式，避免快速搜索漏删。
  if (chatPeer._ === "inputPeerChannel") {
    logger.info(`[DME] 频道会话启用出站消息遍历模式（支持频道身份发言）`);
    return await traditionalStreamProcessing(client, chatPeer, myId, userRequestedCount, false, topicRootId);
  }

  // 检测是否为受限群组（禁止转发和复制）
  const isRestricted = await isRestrictedGroup(client, chatPeer);
  if (isRestricted) {
    logger.info(`[DME] 检测到受限群组，切换到传统遍历模式`);
    return await traditionalStreamProcessing(client, chatPeer, myId, userRequestedCount, false, topicRootId);
  }
  
  logger.info(`[DME] 使用快速删除模式`);
  
  const targetCount =
    userRequestedCount === CONFIG.UNLIMITED_REQUEST_COUNT
      ? Infinity
      : userRequestedCount;
  let offsetId = 0;
  let searchFailCount = 0;
  const maxSearchFails = 2;
  let totalMatched = 0;
  let totalDeleted = 0;
  let hasSearchResult = false;

  // 流式搜索并删除：避免 allMyMessages 大数组导致堆内存膨胀
  while (targetCount === Infinity || totalMatched < targetCount) {
    const searchLimit =
      targetCount === Infinity
        ? CONFIG.SEARCH_LIMIT
        : Math.min(CONFIG.SEARCH_LIMIT, targetCount - totalMatched);

    try {
      const searchResult: any = await client.call({
        _: "messages.search",
        peer: chatPeer,
        q: "",
        fromId: await client.resolvePeer(myId),
        ...(typeof topicRootId === "number" ? { topMsgId: topicRootId } : {}),
        filter: { _: "inputMessagesFilterEmpty" },
        minDate: 0,
        maxDate: 0,
        offsetId: offsetId,
        addOffset: 0,
        limit: searchLimit,
        maxId: 0,
        minId: 0,
        hash: Long.fromNumber(0)
      });

      const resultMessages = searchResult.messages;
      if (!resultMessages || resultMessages.length === 0) {
        break;
      }

      const allBatchMessages = resultMessages.filter(
        (m: any) => m._ === "message"
      );
      if (allBatchMessages.length === 0) {
        break;
      }

      offsetId = allBatchMessages[allBatchMessages.length - 1].id;

      const messagesToDelete = allBatchMessages.filter(
        (m: any) =>
          m._ === "message" &&
          isMessageInTopic(m, topicRootId) &&
          ((m.fromId?.userId === myId || m.fromId?.channelId === myId) || m.out === true)
      );

      if (messagesToDelete.length === 0) {
        await sleep(CONFIG.DELAYS.SEARCH);
        continue;
      }

      hasSearchResult = true;
      const deleteIds = messagesToDelete.map((m: any) => m.id);

      const result = await adaptiveBatchDelete(client, chatPeer, deleteIds);
      totalDeleted += result.deletedCount;
      totalMatched += messagesToDelete.length;

      await sleep(CONFIG.DELAYS.SEARCH);
    } catch (error: any) {
      logger.error(`[DME] 搜索失败:`, error.message);
      searchFailCount++;
      
      // 如果连续搜索失败，切换到传统模式
      if (searchFailCount >= maxSearchFails) {
        if (totalMatched > 0) {
          break;
        }
        logger.info(`[DME] API搜索多次失败，切换到传统遍历模式`);
        return await traditionalStreamProcessing(client, chatPeer, myId, userRequestedCount, false, topicRootId);
      }
      await sleep(CONFIG.DELAYS.RETRY);
    }
  }

  if (!hasSearchResult) {
    logger.info(`[DME] API搜索无结果，尝试传统遍历模式`);
    return await traditionalStreamProcessing(client, chatPeer, myId, userRequestedCount, false, topicRootId);
  }
  
  return {
    processedCount: totalDeleted,
    actualCount: totalMatched,
    editedCount: 0
  };
}

/**
 * 搜索并处理用户消息的主函数 - 防撤回模式（-f参数）流式处理版本
 */
async function searchEditAndDeleteMyMessages(
  client: TelegramClient,
  chatPeer: any,
  myId: number,
  userRequestedCount: number,
  topicRootId?: number
): Promise<{
  processedCount: number;
  actualCount: number;
  editedCount: number;
}> {
  // 收藏夹（保存的消息）专用快速删除
  if (isSavedMessagesPeer(chatPeer, myId)) {
    logger.info("[DME] 检测到收藏夹会话，直接按数量删除");
    return await deleteInSavedMessages(client, chatPeer, userRequestedCount);
  }

  // 检查是否为频道且有管理权限
  const isChannel = chatPeer._ === "inputPeerChannel";
  if (isChannel) {
    logger.info(`[DME] 检测到频道，检查管理员权限...`);
    try {
      const me = await safeGetMe(client);
      if (!me) return { processedCount: 0, actualCount: 0, editedCount: 0 };
      const participant: any = await client.call({
        _: "channels.getParticipant",
        channel: chatPeer,
        participant: await client.resolvePeer(me.id),
      });

      const pClassName = participant.participant?._ || "";
      const isCreator = pClassName === "channelParticipantCreator";
      
      // Check if this is a broadcast channel
      const fullChannel: any = await client.call({
        _: "channels.getFullChannel",
        channel: chatPeer,
      });
      const isBroadcast = fullChannel?.fullChat?.broadcast === true;
      
      if (isCreator && isBroadcast) {
        logger.info(`[DME] 检测到私人频道且为频道主，直接按数量删除`);
        return await deleteInSavedMessages(client, chatPeer, userRequestedCount);
      }

      const isAdmin =
        pClassName === "channelParticipantAdmin" ||
        pClassName === "channelParticipantCreator";

      if (isAdmin) {
        logger.info(`[DME] 拥有频道管理权限，但仍使用普通模式避免误删别人消息`);
      } else {
        logger.info(`[DME] 无频道管理权限，使用普通模式`);
      }
    } catch (error) {
      logger.info(`[DME] 权限检查失败，使用普通模式:`, error);
    }
  }

  // 频道/超级群里"以频道身份发言"的消息通常不带个人 senderId，
  // 直接改用 out 消息遍历模式，避免流式搜索漏删。
  if (isChannel) {
    logger.info(`[DME] 频道会话启用出站消息遍历模式（支持频道身份发言）`);
    return await traditionalStreamProcessing(client, chatPeer, myId, userRequestedCount, true, topicRootId);
  }
  
  // 检测是否为受限群组（禁止转发和复制）
  const isRestricted = await isRestrictedGroup(client, chatPeer);
  if (isRestricted) {
    logger.info(`[DME] 检测到受限群组，切换到传统遍历模式`);
    return await traditionalStreamProcessing(client, chatPeer, myId, userRequestedCount, true, topicRootId);
  }
  
  logger.info(`[DME] 流式处理模式，目标数量: ${userRequestedCount === 999999 ? "全部" : userRequestedCount}`);

  const targetCount = userRequestedCount === 999999 ? Infinity : userRequestedCount;
  const trollImagePath = await getTrollImage();
  
  let totalProcessed = 0;
  let totalEdited = 0;
  let totalDeleted = 0;
  let offsetId = 0;
  let searchFailCount = 0;
  const maxSearchFails = 2;
  const STREAM_BATCH = 50; // 每批处理50条

  // 流式处理：搜索一批，处理一批，删除一批
  while (totalProcessed < targetCount) {
    try {
      // 搜索一批消息
      const searchResult: any = await client.call({
        _: "messages.search",
        peer: chatPeer,
        q: "",
        fromId: await client.resolvePeer(myId),
        ...(typeof topicRootId === "number" ? { topMsgId: topicRootId } : {}),
        filter: { _: "inputMessagesFilterEmpty" },
        minDate: 0,
        maxDate: 0,
        offsetId: offsetId,
        addOffset: 0,
        limit: Math.min(STREAM_BATCH, targetCount === Infinity ? STREAM_BATCH : targetCount - totalProcessed),
        maxId: 0,
        minId: 0,
        hash: Long.fromNumber(0)
      });

      const resultMessages = searchResult.messages;
      if (!resultMessages || resultMessages.length === 0) {
        logger.info(`[DME] 流式处理完成，无更多消息`);
        break;
      }

      const allBatchMessages = resultMessages.filter(
        (m: any) => m._ === "message"
      );
      if (allBatchMessages.length === 0) {
        break;
      }

      const batchMessages = allBatchMessages.filter(
        (m: any) =>
          isMessageInTopic(m, topicRootId) &&
          ((m.fromId?.userId === myId || m.fromId?.channelId === myId) || m.out === true)
      );

      offsetId = allBatchMessages[allBatchMessages.length - 1].id;

      if (batchMessages.length === 0) {
        await sleep(CONFIG.DELAYS.SEARCH);
        continue;
      }

      const mediaMessages = batchMessages.filter((m: any) => {
        if (!m.media || m.media?._ === "messageMediaWebPage") return false;
        if (m.media?._ === "messageMediaDocument") {
          const doc = m.media.document;
          if (doc?._ === "document") {
            const isSticker = doc.attributes?.some(
              (attr: any) => attr?._ === "documentAttributeSticker"
            );
            if (isSticker) return false;
          }
        }
        return true;
      });
      const textMessages = batchMessages.filter(
        (m: any) => !m.media && typeof m.message === "string"
      );

      if (mediaMessages.length > 0 && trollImagePath) {
        const editPromises = mediaMessages.map((msg: any) => 
          editMediaMessageToAntiRecall(client, msg, trollImagePath, chatPeer)
            .catch(() => false)
        );
        const editResults = await Promise.allSettled(editPromises);
        const edited = editResults.filter(r => r.status === "fulfilled" && r.value === true).length;
        totalEdited += edited;
        logger.info(`[DME] 批次编辑 ${edited}/${mediaMessages.length} 条媒体`);
      }

      if (textMessages.length > 0) {
        const textEditPromises = textMessages.map((msg: any) =>
          editTextMessageToPlaceholder(client, msg, chatPeer).catch(() => false)
        );
        const textEditResults = await Promise.allSettled(textEditPromises);
        const textEdited = textEditResults.filter(
          (r) => r.status === "fulfilled" && r.value === true
        ).length;
        totalEdited += textEdited;
        logger.info(`[DME] 批次编辑 ${textEdited}/${textMessages.length} 条文本`);
      }

      if ((mediaMessages.length > 0 && trollImagePath) || textMessages.length > 0) {
        await sleep(CONFIG.DELAYS.EDIT_WAIT);
      }

      // 立即删除这批消息
      const deleteIds = batchMessages.map((m: any) => m.id);
      try {
        await deleteMessagesWithRetry(client, chatPeer, deleteIds);
        totalDeleted += deleteIds.length;
        logger.info(`[DME] 流式删除 ${deleteIds.length} 条，总计 ${totalDeleted} 条`);
      } catch (error: any) {
        logger.error(`[DME] 批次删除失败:`, error.message);
      }

      totalProcessed += batchMessages.length;
      
      await sleep(CONFIG.DELAYS.BATCH);
    } catch (error: any) {
      logger.error(`[DME] 流式处理批次失败:`, error.message);
      searchFailCount++;
      
      // 如果连续搜索失败，切换到传统模式
      if (searchFailCount >= maxSearchFails) {
        logger.info(`[DME] API搜索多次失败，切换到传统遍历模式`);
        const traditionalResult = await traditionalStreamProcessing(client, chatPeer, myId, userRequestedCount, true, topicRootId);
        return {
          processedCount: totalDeleted + traditionalResult.processedCount,
          actualCount: totalProcessed + traditionalResult.actualCount,
          editedCount: totalEdited + traditionalResult.editedCount,
        };
      }
      
      await sleep(CONFIG.DELAYS.RETRY);
      break;
    }
  }

  // 如果API搜索没有找到任何消息，尝试传统模式
  if (totalProcessed === 0) {
    logger.info(`[DME] API搜索无结果，尝试传统模式`);
    return await traditionalStreamProcessing(client, chatPeer, myId, userRequestedCount, true, topicRootId);
  }

  logger.info(`[DME] 流式处理完成，删除 ${totalDeleted} 条，编辑 ${totalEdited} 条`);

  return {
    processedCount: totalDeleted,
    actualCount: totalProcessed,
    editedCount: totalEdited,
  };
}

// 已移除频道直接删除功能，避免误删别人消息
// 所有情况下都使用普通模式，只删除自己的消息


// 定义帮助文本常量
const help_text = `🗑️ <b>智能防撤回删除插件</b>

<b>命令格式：</b>
<code>${mainPrefix}dme [数量]</code>
<code>${mainPrefix}dme -f [数量]</code>

<b>可用命令：</b>
• <code>${mainPrefix}dme [数量]</code> - 快速删除指定数量的消息
• <code>${mainPrefix}dme -f [数量]</code> - 防撤回模式（替换媒体后删除）

<b>智能适配：</b>
• 自动检测禁止转发和复制的群组
• 受限群组自动切换传统遍历模式
• API搜索失败时自动回退处理

<b>示例：</b>
• <code>${mainPrefix}dme 10</code> - 快速删除最近10条消息
• <code>${mainPrefix}dme -f 100</code> - 防撤回删除最近100条消息
• <code>${mainPrefix}dme 999</code> - 快速删除所有自己的消息`;

const dme = async (msg: MessageContext) => {
  const client = await getGlobalClient();
  if (!client) {
    await msg.edit({ text: html("❌ 客户端未初始化") });
    return;
  }

  // 标准参数解析
  const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
  const parts = lines?.[0]?.split(/\s+/) || [];
  const [, ...args] = parts;
  const sub = (args[0] || "").toLowerCase();

  try {
    // 无参数时显示帮助
    if (!sub) {
      await msg.edit({
        text: html(help_text),
      });
      return;
    }

    // 处理 help 命令
    if (sub === "help" || sub === "h") {
      await msg.edit({
        text: html(help_text),
      });
      return;
    }

    // 检查是否为防撤回模式 (-f 参数)
    const isAntiRecallMode = sub === "-f";
    let userRequestedCount: number;
    
    if (isAntiRecallMode) {
      // -f 模式，数量在第二个参数
      const countArg = args[1];
      if (!countArg) {
        await msg.edit({
          text: html(`❌ <b>参数错误:</b> 请指定删除数量<br><br>💡 使用 <code>${mainPrefix}dme -f [数量]</code>`),
        });
        return;
      }
      userRequestedCount = parseInt(countArg);
    } else {
      // 普通模式，数量在第一个参数
      userRequestedCount = parseInt(sub);
    }
    
    if (isNaN(userRequestedCount) || userRequestedCount <= 0) {
      await msg.edit({
        text: html(`❌ <b>参数错误:</b> 请输入有效的数字`),
      });
      return;
    }

    const requestedTotalCount = userRequestedCount;
    const shouldRunInRounds =
      requestedTotalCount !== CONFIG.UNLIMITED_REQUEST_COUNT &&
      requestedTotalCount > CONFIG.MAX_SAFE_REQUEST_COUNT;

    if (shouldRunInRounds) {
      logger.info(
        `[DME] 请求数量 ${requestedTotalCount} 超过单次安全上限 ${CONFIG.MAX_SAFE_REQUEST_COUNT}，将分轮执行直到达到目标或无可删消息`
      );
    }

    const me = await safeGetMe(client);
      if (!me) return;
    const myId = Number(me.id);
    const chatId = msg.chat.id.toString();
    const chatPeer = await getEntityWithHash(client, chatId);
    const topicRootId = getTopicRootIdFromMessage(msg);

    if (typeof topicRootId === "number") {
      logger.info(`[DME] 检测到话题上下文: topMsgId=${topicRootId}`);
    }

    // 删除命令消息
    try {
      await client.deleteMessagesById(chatPeer, [msg.id], {
        revoke: true,
      });
    } catch (e) { /* noop */ }

    // 执行主要操作
    logger.info(`[DME] ========== 开始执行DME任务 ==========`);
    logger.info(`[DME] 聊天ID: ${chatId}`);
    logger.info(`[DME] 请求数量: ${requestedTotalCount}`);
    logger.info(`[DME] 模式: ${isAntiRecallMode ? '防撤回模式 (-f)' : '快速删除模式'}`);
    const startTime = Date.now();

    const runOneRound = async (count: number) =>
      isAntiRecallMode
        ? await searchEditAndDeleteMyMessages(
            client,
            chatPeer,
            myId,
            count,
            topicRootId
          )
        : await quickDeleteMyMessages(
            client,
            chatPeer,
            myId,
            count,
            topicRootId
          );

    let result = { processedCount: 0, actualCount: 0, editedCount: 0 };

    if (!shouldRunInRounds) {
      result = await runOneRound(requestedTotalCount);
    } else {
      let remaining = requestedTotalCount;
      let round = 1;
      while (remaining > 0) {
        const roundTarget = Math.min(remaining, CONFIG.MAX_SAFE_REQUEST_COUNT);
        logger.info(
          `[DME] 第 ${round} 轮开始，请求 ${roundTarget} 条，剩余目标 ${remaining} 条`
        );

        const roundResult = await runOneRound(roundTarget);
        result.processedCount += roundResult.processedCount;
        result.actualCount += roundResult.actualCount;
        result.editedCount += roundResult.editedCount;
        remaining = Math.max(0, remaining - roundResult.processedCount);

        logger.info(
          `[DME] 第 ${round} 轮完成，删除 ${roundResult.processedCount} 条，累计 ${result.processedCount}/${requestedTotalCount}`
        );

        if (roundResult.actualCount === 0) {
          logger.info(`[DME] 第 ${round} 轮未找到可删除消息，提前结束`);
          break;
        }

        if (roundResult.processedCount === 0) {
          logger.info(`[DME] 第 ${round} 轮没有删除进度，提前结束避免空转`);
          break;
        }

        await sleep(CONFIG.DELAYS.BATCH);
      }
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    logger.info(`[DME] ========== 任务完成 ==========`);
    logger.info(`[DME] 总耗时: ${duration} 秒`);
    logger.info(`[DME] 处理消息: ${result.processedCount} 条`);
    logger.info(`[DME] 编辑媒体: ${result.editedCount} 条`);
    if (
      shouldRunInRounds &&
      requestedTotalCount !== CONFIG.UNLIMITED_REQUEST_COUNT &&
      result.processedCount < requestedTotalCount
    ) {
      logger.info(
        `[DME] 未达到目标数量，目标: ${requestedTotalCount}，实际: ${result.processedCount}（可能已无可删消息）`
      );
    }
    logger.info(`[DME] =============================`);

    // 完全静默模式 - 不发送任何前台消息
  } catch (error: any) {
    logger.error("[DME] 操作失败:", error);
    await msg.edit({
      text: html(`❌ <b>操作失败:</b> ${htmlEscape(error.message || "未知错误")}`),
    });
  }
};

class DmePlugin extends Plugin {

  description: string = `智能防撤回删除插件<br><br>${help_text}`;
  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    dme,
  };
}

export default new DmePlugin();
