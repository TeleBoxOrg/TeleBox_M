import { MessageContext } from "@mtcute/dispatcher";
import { thtml } from "@mtcute/html-parser";
import type { InputText, TextWithEntities } from "@mtcute/core";
import { logger } from "@utils/logger";

/**
 * TeleBox-Next 自定义 MessageContext 便捷方法 + 中央 HTML 兼容层。
 *
 * 背景：大量插件（从 teleproto/gramjs 迁移）仍写
 *   `msg.edit({ text: `<b>…</b>\n<code>…</code>` })`
 * mtcute 没有 parseMode，纯字符串会原样显示标签。逐插件改 120+ 文件不可维护。
 *
 * 方案：在 MessageContext.edit / replyText / answerText 以及
 * TelegramClient.sendText / editMessage / sendMedia 入口，
 * 对「看起来像 HTML」的纯字符串自动 thtml() 解析（保留 \n）。
 * 已是 TextWithEntities（thtml/html 产物）的原样放行。
 *
 * 另：gramjs 的 client.sendFile → mtcute client.sendMedia 兼容别名。
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bot API / TeleBox 插件常用 HTML 标签 */
const HTML_TAG_RE =
  /<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|a|blockquote|br|tg-spoiler|tg-emoji)\b/i;

function isTextWithEntities(value: unknown): value is TextWithEntities {
  return (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof (value as TextWithEntities).text === "string"
  );
}

/**
 * 若 text 是含 HTML 标签的纯字符串 → thtml 解析；
 * 已是 entities 对象 / 无标签纯文本 → 原样返回。
 */
export function coerceHtmlInputText(text: unknown): unknown {
  if (typeof text !== "string") return text;
  if (!HTML_TAG_RE.test(text)) return text;
  try {
    return thtml(text);
  } catch (e: unknown) {
    // 非法 HTML 时不阻断发送，回退纯文本
    logger.debug?.("[html-compat] thtml parse failed, sending plain:", e);
    return text;
  }
}

function patchEditParams<T extends { text?: InputText; media?: unknown }>(
  params: T
): T {
  if (!params || typeof params !== "object") return params;
  const next = { ...params } as T & {
    text?: unknown;
    media?: { caption?: unknown } & Record<string, unknown>;
  };
  if (typeof next.text === "string") {
    next.text = coerceHtmlInputText(next.text) as InputText;
  }
  // edit with media.caption
  if (
    next.media &&
    typeof next.media === "object" &&
    next.media !== null &&
    "caption" in next.media &&
    typeof (next.media as { caption?: unknown }).caption === "string"
  ) {
    next.media = {
      ...(next.media as object),
      caption: coerceHtmlInputText(
        (next.media as { caption: string }).caption
      ) as InputText,
    };
  }
  return next as T;
}

// ── MessageContext: delete helpers (existing) ──

MessageContext.prototype.deleteWithDelay = async function (
  this: MessageContext,
  delay: number,
  shouldThrowError: boolean = false
): Promise<void> {
  await sleep(delay);
  try {
    await this.delete();
  } catch (e: unknown) {
    logger.error("[patch] deleteWithDelay failed:", e);
    if (shouldThrowError) {
      throw e;
    }
  }
};

MessageContext.prototype.safeDelete = async function (
  this: MessageContext,
  { revoke }: { revoke?: boolean } = { revoke: false }
): Promise<void> {
  try {
    await this.delete({ revoke });
  } catch (error: unknown) {
    logger.info("safeDelete catch error:", error);
  }
};

// ── MessageContext.edit — central HTML auto-parse ──

const originalEdit = MessageContext.prototype.edit;
MessageContext.prototype.edit = function (
  this: MessageContext,
  params: Parameters<typeof originalEdit>[0]
) {
  return originalEdit.call(this, patchEditParams(params));
};

// ── MessageContext.replyText / answerText ──
// signature: replyText(text, params?) or answerText(text, params?)

type TextFirstFn = (
  this: MessageContext,
  text: InputText,
  ...rest: unknown[]
) => unknown;

function wrapTextFirstMethod(
  proto: MessageContext,
  name: "replyText" | "answerText"
): void {
  const original = (proto as unknown as Record<string, TextFirstFn>)[name];
  if (typeof original !== "function") return;
  (proto as unknown as Record<string, TextFirstFn>)[name] = function (
    this: MessageContext,
    text: InputText,
    ...rest: unknown[]
  ) {
    return original.call(this, coerceHtmlInputText(text) as InputText, ...rest);
  };
}

wrapTextFirstMethod(MessageContext.prototype, "replyText");
wrapTextFirstMethod(MessageContext.prototype, "answerText");

/**
 * Patch a live TelegramClient instance (call once after create).
 * Covers sendText / editMessage / sendMedia caption + sendFile alias.
 */
export function patchTelegramClientHtmlCompat(client: {
  sendText?: (...args: unknown[]) => unknown;
  editMessage?: (...args: unknown[]) => unknown;
  sendMedia?: (...args: unknown[]) => unknown;
  sendFile?: (...args: unknown[]) => unknown;
}): void {
  const c = client as {
    sendText: (chatId: unknown, text: InputText, params?: unknown) => unknown;
    editMessage: (params: Record<string, unknown>) => unknown;
    sendMedia: (
      chatId: unknown,
      media: unknown,
      params?: Record<string, unknown>
    ) => unknown;
    sendFile?: (...args: unknown[]) => unknown;
    __teleboxHtmlCompatPatched?: boolean;
  };

  if (c.__teleboxHtmlCompatPatched) return;
  c.__teleboxHtmlCompatPatched = true;

  if (typeof c.sendText === "function") {
    const orig = c.sendText.bind(c);
    c.sendText = (chatId, text, params) =>
      orig(chatId, coerceHtmlInputText(text) as InputText, params);
  }

  if (typeof c.editMessage === "function") {
    const orig = c.editMessage.bind(c);
    c.editMessage = (params) =>
      orig(patchEditParams(params as { text?: InputText }));
  }

  if (typeof c.sendMedia === "function") {
    const orig = c.sendMedia.bind(c);
    c.sendMedia = (chatId, media, params) => {
      let m = media;
      if (
        m &&
        typeof m === "object" &&
        m !== null &&
        "caption" in (m as object) &&
        typeof (m as { caption?: unknown }).caption === "string"
      ) {
        m = {
          ...(m as object),
          caption: coerceHtmlInputText((m as { caption: string }).caption),
        };
      }
      let p = params;
      if (p && typeof p.caption === "string") {
        p = { ...p, caption: coerceHtmlInputText(p.caption) as InputText };
      }
      return orig(chatId, m, p);
    };

    // gramjs 兼容：sendFile → sendMedia
    // 旧插件: client.sendFile(peer, { file, caption, forceDocument })
    // 或 client.sendFile(peer, path)
    if (typeof c.sendFile !== "function") {
      (c as any).sendFile = async (
        chatId: unknown,
        fileOrOpts: unknown,
        maybeParams?: Record<string, unknown>
      ) => {
        if (typeof fileOrOpts === "string" || Buffer.isBuffer(fileOrOpts)) {
          const caption =
            maybeParams && typeof maybeParams.caption === "string"
              ? coerceHtmlInputText(maybeParams.caption)
              : maybeParams?.caption;
          const forceDoc = maybeParams?.forceDocument === true;
          return orig(
            chatId,
            {
              type: forceDoc ? "document" : "auto",
              file: fileOrOpts,
              ...(caption !== undefined ? { caption } : {}),
              ...(typeof maybeParams?.fileName === "string"
                ? { fileName: maybeParams.fileName }
                : {}),
            },
            maybeParams
          );
        }
        if (fileOrOpts && typeof fileOrOpts === "object") {
          const o = fileOrOpts as Record<string, unknown>;
          const caption =
            typeof o.caption === "string"
              ? coerceHtmlInputText(o.caption)
              : o.caption;
          const forceDoc = o.forceDocument === true;
          const file = o.file ?? o;
          return orig(chatId, {
            type:
              (o.type as string) ||
              (forceDoc ? "document" : "photo"),
            file,
            ...(caption !== undefined ? { caption } : {}),
            ...(typeof o.fileName === "string" ? { fileName: o.fileName } : {}),
            ...(o.attributes ? { attributes: o.attributes } : {}),
          });
        }
        return orig(chatId, fileOrOpts as never, maybeParams);
      };
    }
  }

  logger.info("[html-compat] TelegramClient HTML auto-parse + sendFile alias ready");
}
