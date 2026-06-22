import { TelegramClient } from "@mtcute/node";
import type { InputPeerLike } from "@mtcute/node";
import type { Message } from "@mtcute/node";
import {
  getCurrentGeneration,
  tryGetCurrentGenerationContext,
  type GenerationContext,
} from "./globalClient";
import { logger } from "@utils/logger";

type EntityHelperCancellationContext = {
  signal?: AbortSignal;
  lifecycle?: GenerationContext;
};

type EntityHelperRetryOptions = EntityHelperCancellationContext & {
  maxRetries?: number;
};

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string") return new Error(reason);
  return new Error("Entity helper operation aborted");
}

function resolveCancellationContext(
  options?: EntityHelperCancellationContext
): EntityHelperCancellationContext {
  const lifecycle = options?.lifecycle ?? tryGetCurrentGenerationContext() ?? undefined;
  return {
    lifecycle,
    signal: options?.signal ?? lifecycle?.signal,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError(signal.reason);
  }
}

function isCurrentGeneration(lifecycle?: GenerationContext): boolean {
  return !lifecycle || lifecycle.generation === getCurrentGeneration();
}

function assertCurrentGeneration(lifecycle?: GenerationContext): void {
  if (lifecycle && !isCurrentGeneration(lifecycle)) {
    throw new Error(`Generation ${lifecycle.generation} is no longer current`);
  }
}

async function abortableDelay(
  ms: number,
  context: EntityHelperCancellationContext,
  label: string
): Promise<void> {
  throwIfAborted(context.signal);
  assertCurrentGeneration(context.lifecycle);

  if (context.lifecycle) {
    await context.lifecycle.delay(ms, { label });
  } else {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let cleanup = (): void => undefined;

      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };

      const onAbort = (): void => {
        finish(() => reject(abortError(context.signal?.reason)));
      };

      const handle = setTimeout(() => finish(resolve), ms);

      cleanup = (): void => {
        clearTimeout(handle);
        context.signal?.removeEventListener("abort", onAbort);
      };

      context.signal?.addEventListener("abort", onAbort, { once: true });
      if (context.signal?.aborted) {
        onAbort();
      }
    });
  }

  throwIfAborted(context.signal);
  assertCurrentGeneration(context.lifecycle);
}

function getFloodWaitSeconds(error: unknown): number | null {
  if (!(error instanceof Error) || !error.message.includes("FLOOD_WAIT")) {
    return null;
  }
  return parseInt(error.message.match(/\d+/)?.[0] || "60");
}

/**
 * 安全获取实体，确保包含正确的access hash
 * @param client - Telegram客户端实例
 * @param entityId - 实体ID (可以是数字ID、用户名或实体对象)
 * @returns 返回完整的实体对象
 */
export async function getEntityWithHash(
  client: TelegramClient,
  entityId: string | number | InputPeerLike
): Promise<InputPeerLike> {
  try {
    // 如果已经是对象，直接返回
    if (typeof entityId === "object") {
      return entityId;
    }

    // 使用 resolvePeer 获取完整 InputPeer
    const entity = await client.resolvePeer(entityId);
    return entity;
  } catch (error: unknown) {
    logger.error(`[EntityHelper] 获取实体失败: ${entityId}`, error);
    throw new Error(`无法获取实体: ${entityId}`);
  }
}

/**
 * 安全转发消息，自动处理access hash和错误重试
 * @param client - Telegram客户端实例
 * @param fromChatId - 源聊天ID
 * @param toChatId - 目标聊天ID
 * @param messageId - 消息ID
 * @param options - 转发选项
 */
export async function safeForwardMessage(
  client: TelegramClient,
  fromChatId: string | number,
  toChatId: string | number,
  messageId: number,
  options?: EntityHelperRetryOptions & {
    replyTo?: number;
    silent?: boolean;
    dropAuthor?: boolean;
  }
): Promise<Message[]> {
  const maxRetries = options?.maxRetries || 3;
  const cancellationContext = resolveCancellationContext(options);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    throwIfAborted(cancellationContext.signal);
    assertCurrentGeneration(cancellationContext.lifecycle);

    try {
      // mtcute 原生转发 API
      const result = await client.forwardMessagesById({
        fromChatId: fromChatId,
        toChatId: toChatId,
        messages: [messageId!],
        silent: options?.silent,
        noAuthor: options?.dropAuthor,
        ...(options?.replyTo ? { replyTo: options.replyTo } : {}),
      });
      return result;
    } catch (error: unknown) {
      lastError = error;
      logger.warn(
        `[EntityHelper] 转发尝试 ${attempt}/${maxRetries} 失败: ${fromChatId} -> ${toChatId}`,
        error
      );

      // 处理 FLOOD_WAIT 错误
      const floodWaitSeconds = getFloodWaitSeconds(error);
      if (floodWaitSeconds !== null) {
        logger.info(`[EntityHelper] FloodWait ${floodWaitSeconds}s, 等待重试`);
        await abortableDelay(
          (floodWaitSeconds + 1) * 1000,
          cancellationContext,
          "entity-helper-flood-wait"
        );
        continue;
      }

      // 如果不是最后一次尝试，等待后重试
      if (attempt < maxRetries) {
        await abortableDelay(
          1000 * attempt,
          cancellationContext,
          "entity-helper-retry-backoff"
        );
        continue;
      }
    }
  }

  logger.error(
    `[EntityHelper] 转发最终失败: ${fromChatId} -> ${toChatId}`,
    lastError
  );
  throw lastError;
}

/**
 * 批量获取实体，确保包含正确的access hash
 * @param client - Telegram客户端实例
 * @param entityIds - 实体ID数组
 * @returns 返回实体对象数组
 */
export async function getBatchEntitiesWithHash(
  client: TelegramClient,
  entityIds: (string | number)[],
  options?: EntityHelperCancellationContext
): Promise<InputPeerLike[]> {
  const cancellationContext = resolveCancellationContext(options);
  const entities: InputPeerLike[] = [];

  for (const entityId of entityIds) {
    throwIfAborted(cancellationContext.signal);
    assertCurrentGeneration(cancellationContext.lifecycle);

    try {
      const entity = await getEntityWithHash(client, entityId);
      entities.push(entity);
    } catch (error: unknown) {
      logger.warn(`[EntityHelper] 跳过无效实体: ${entityId}`, error);
    }
  }

  return entities;
}

/**
 * 解析实体ID，支持多种格式
 * @param input - 输入的实体标识 (@username, -100123456, 123456, "me", "here")
 * @param currentChatId - 当前聊天ID（用于处理"me"/"here"）
 * @returns 标准化的实体ID
 */
export function parseEntityId(
  input: string,
  currentChatId?: number
): string | number {
  if (!input) throw new Error("实体ID不能为空");

  const trimmed = input.trim();

  // 处理特殊关键词
  if (trimmed === "me" || trimmed === "here") {
    if (!currentChatId) throw new Error("当前聊天ID未提供");
    return currentChatId;
  }

  // 处理用户名格式 @username
  if (trimmed.startsWith("@")) {
    return trimmed;
  }

  // 处理数字ID
  const numId = parseInt(trimmed);
  if (!isNaN(numId)) {
    return numId;
  }

  // 直接返回字符串（可能是用户名）
  return trimmed;
}

/**
 * 通用的实体操作包装器，自动处理access hash
 * @param client - Telegram客户端实例
 * @param operation - 要执行的操作函数
 * @param entities - 需要解析的实体ID数组
 * @param maxRetries - 最大重试次数
 */
export async function withEntityAccess<T>(
  client: TelegramClient,
  operation: (resolvedEntities: InputPeerLike[]) => Promise<T>,
  entities: (string | number)[],
  options: number | EntityHelperRetryOptions = 3
): Promise<T> {
  const maxRetries = typeof options === "number" ? options : options.maxRetries ?? 3;
  const cancellationContext = resolveCancellationContext(
    typeof options === "number" ? undefined : options
  );
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    throwIfAborted(cancellationContext.signal);
    assertCurrentGeneration(cancellationContext.lifecycle);

    try {
      // 批量解析实体
      const resolvedEntities = await getBatchEntitiesWithHash(
        client,
        entities,
        cancellationContext
      );

      // 执行操作
      return await operation(resolvedEntities);
    } catch (error: unknown) {
      lastError = error;
      logger.warn(
        `[EntityHelper] 操作尝试 ${attempt}/${maxRetries} 失败:`,
        error
      );

      // 处理 FLOOD_WAIT 错误
      const floodWaitSeconds = getFloodWaitSeconds(error);
      if (floodWaitSeconds !== null) {
        logger.info(`[EntityHelper] FloodWait ${floodWaitSeconds}s, 等待重试`);
        await abortableDelay(
          (floodWaitSeconds + 1) * 1000,
          cancellationContext,
          "entity-helper-flood-wait"
        );
        continue;
      }

      // 如果不是最后一次尝试，等待后重试
      if (attempt < maxRetries) {
        await abortableDelay(
          1000 * attempt,
          cancellationContext,
          "entity-helper-retry-backoff"
        );
        continue;
      }
    }
  }

  logger.error(`[EntityHelper] 操作最终失败:`, lastError);
  throw lastError;
}
