/**
 * Conversation 工具 — 原生 mtcute 版本
 * 直接使用 mtcute 内置的 Conversation 类，支持等待消息、发送、标记已读等
 */

import { TelegramClient, Conversation as MtcuteConversation } from "@mtcute/node";
import type { InputPeerLike } from "@mtcute/node";
import type { Message } from "@mtcute/node";
import {
  getCurrentGeneration,
  tryGetCurrentGenerationContext,
} from "./runtimeManager";
import type { GenerationContext } from "./generationContext";

type ConversationCancellationOptions = {
  signal?: AbortSignal;
  lifecycle?: GenerationContext;
};

type ConversationOptions = ConversationCancellationOptions & {
  timeout?: number;
};

/**
 * 一次性等待消息（从指定 peer 等待下一条消息）
 * 使用 mtcute 内置 Conversation.waitForNewMessage
 */
async function waitForMessage(
  client: TelegramClient,
  peer: InputPeerLike,
  timeoutOrOptions?: number | ConversationOptions
): Promise<Message> {
  const timeout = typeof timeoutOrOptions === "number"
    ? timeoutOrOptions
    : timeoutOrOptions?.timeout ?? 10000;
  const lifecycle = typeof timeoutOrOptions === "object"
    ? timeoutOrOptions?.lifecycle ?? tryGetCurrentGenerationContext() ?? undefined
    : tryGetCurrentGenerationContext() ?? undefined;

  const conv = new MtcuteConversation(client, peer);
  await conv.start();

  try {
    const message = await conv.waitForNewMessage(undefined, timeout);
    return message;
  } finally {
    conv.stop();
  }
}

/**
 * Conversation 包装类
 * 封装 mtcute 内置 Conversation，提供生命周期管理
 */
class ConversationWrapper {
  private conv: MtcuteConversation;
  private client: TelegramClient;
  private peer: InputPeerLike;
  private options: ConversationCancellationOptions;

  constructor(client: TelegramClient, peer: InputPeerLike, options?: ConversationCancellationOptions) {
    this.client = client;
    this.peer = peer;
    this.options = options ?? {};
    this.conv = new MtcuteConversation(client, peer);
  }

  /** 发送文本消息 */
  async send(message: string): Promise<void> {
    await this.conv.sendText(message);
  }

  /** 等待 Bot 回复 */
  async getResponse(timeout?: number | ConversationOptions): Promise<Message> {
    const timeoutMs = typeof timeout === "number"
      ? timeout
      : timeout?.timeout ?? 10000;
    return await this.conv.waitForNewMessage(undefined, timeoutMs);
  }

  /** 标记信息为已读 */
  async markAsRead(): Promise<void> {
    await this.conv.markRead();
  }

  /** 点击 InlineKeyboard 按钮 */
  async clickButton(
    message: Message,
    rowIndex: number,
    colIndex: number
  ): Promise<void> {
    // mtcute Message.raw 包含完整 TL 数据，包括 replyMarkup
    const raw = message.raw as unknown as { replyMarkup?: { _?: string; rows?: Array<{ buttons: Array<{ data?: Uint8Array }> }> } };
    const keyboard = raw.replyMarkup;
    if (!keyboard || keyboard._ !== 'replyInlineMarkup') {
      throw new Error("消息没有 InlineKeyboard 按钮");
    }

    // 通过行/列索引点击按钮
    const rows = keyboard.rows;
    if (!rows || rowIndex >= rows.length || colIndex >= rows[rowIndex]?.buttons?.length) {
      throw new Error("按钮索引超出范围");
    }

    const button = rows[rowIndex].buttons[colIndex];
    if (button?.data) {
      // callback button — 使用 raw TL 调用
      await this.client.call({
        _: 'messages.getBotCallbackAnswer',
        peer: await this.client.resolvePeer(this.peer),
        msgId: message.id,
        data: button.data,
      });
    }
  }

  async start(): Promise<void> {
    await this.conv.start();
  }

  async close(): Promise<void> {
    this.conv.stop();
  }
}

type ConversationCallback = (conv: ConversationWrapper) => Promise<void>;

function getConversationCancellationOptions(
  options?: ConversationCancellationOptions | ConversationCallback
): ConversationCancellationOptions | undefined {
  return typeof options === "function" ? undefined : options;
}

async function conversation(
  client?: TelegramClient,
  peer?: InputPeerLike,
  callbackOrOptions?: ConversationCallback | ConversationCancellationOptions,
  optionsOrCallback?: ConversationCancellationOptions | ConversationCallback
): Promise<void> {
  if (!client || !peer) {
    throw new Error("client 和 peer 参数不能为空");
  }

  const callback = typeof callbackOrOptions === "function"
    ? callbackOrOptions
    : typeof optionsOrCallback === "function"
      ? optionsOrCallback
      : undefined;
  const options = typeof callbackOrOptions === "function"
    ? optionsOrCallback
    : callbackOrOptions;

  const conv = new ConversationWrapper(client, peer, getConversationCancellationOptions(options));
  try {
    await conv.start();
    if (callback) {
      await callback(conv);
    }
  } finally {
    await conv.close();
  }
}

export { conversation };