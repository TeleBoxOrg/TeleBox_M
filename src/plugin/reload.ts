import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { thtml as html, TelegramClient, type InputPeerLike } from "@mtcute/node";
import type { MessageContext } from "@mtcute/dispatcher";
import { createDirectoryInTemp } from "@utils/pathHelpers";
import fs from "fs";
import path from "path";
import { getGlobalClient } from "@utils/runtimeManager";
import { execFile } from "child_process";
import { promisify } from "util";
import { getCurrentGenerationContext } from "@utils/runtimeManager";
import { reloadRuntime } from "@utils/runtimeManager";
import { logger } from "@utils/logger";
import { htmlEscape } from "@utils/htmlEscape";
import { getErrorMessage } from "@utils/errorHelpers";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const execFileAsync = promisify(execFile);

const exitDir = createDirectoryInTemp("exit");
const exitFile = path.join(exitDir, "msg.json");
const pendingExitTimers = new Set<ReturnType<typeof setTimeout>>();

async function updateReloadStatus(params: {
  client: TelegramClient;
  targetChat: InputPeerLike;
  targetMessageId: number;
  text: string;
  isHtml?: boolean;
}) {
  const { client, targetChat, targetMessageId, text, isHtml } = params;
  try {
    await client?.editMessage({
      chatId: targetChat,
      message: targetMessageId,
      text: isHtml ? html(text) : text,
    });
  } catch (error: unknown) {
    logger.error("Failed to edit reload status message, falling back to sendText:", error);
    try {
      await client?.sendText(targetChat, isHtml ? html(text) : text);
    } catch (sendError: unknown) {
      logger.error("Fallback sendText also failed (client may be destroyed):", sendError);
    }
  }
}

function scheduleTrackedTimeout(
  callback: () => void | Promise<void>,
  delay: number
): ReturnType<typeof setTimeout> {
  let timer: ReturnType<typeof setTimeout>;
  const context = getCurrentGenerationContext();
  timer = context.setTimeout(() => {
    pendingExitTimers.delete(timer);
    const task = Promise.resolve(callback());
    context.trackTask(task, { label: "reload:scheduled-timeout" });
    task.catch((error: unknown) => {
      logger.error("[RELOAD] Scheduled timeout failed:", error);
    });
  }, delay, { label: "reload:scheduled-timeout" });
  pendingExitTimers.add(timer);
  return timer;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const editExitMsg = async () => {
  if (!fs.existsSync(exitFile)) return;
  let payload: {
    messageId?: number;
    chatId?: unknown;
    time?: number;
    successText?: string;
    isHtml?: boolean;
  };
  try {
    payload = JSON.parse(fs.readFileSync(exitFile, "utf-8"));
  } catch (e: unknown) {
    logger.error("Failed to parse exit message file:", e);
    try {
      fs.unlinkSync(exitFile);
    } catch {
      /* ignore */
    }
    return;
  }

  const messageId = Number(payload.messageId);
  // Coerce chatId to a plain string/number (never nested peer objects)
  let chatId: string | number | undefined;
  if (typeof payload.chatId === "string" || typeof payload.chatId === "number") {
    chatId = payload.chatId;
  } else if (payload.chatId && typeof payload.chatId === "object") {
    const o = payload.chatId as { id?: unknown; chatId?: unknown; userId?: unknown };
    if (o.id != null) chatId = String(o.id);
    else if (o.chatId != null) chatId = String(o.chatId);
    else if (o.userId != null) chatId = String(o.userId);
  }
  if (chatId == null || !Number.isFinite(messageId)) {
    try {
      fs.unlinkSync(exitFile);
    } catch {
      /* ignore */
    }
    return;
  }

  const elapsedMs = Date.now() - (Number(payload.time) || Date.now());
  const tmpl: string = payload.successText || "✅ 重启完成，耗时 {elapsedMs}ms";
  const text = tmpl.replace(/\{elapsedMs\}/g, String(elapsedMs));
  const isHtml = !!payload.isHtml;

  const delays = [0, 1500, 3000, 6000, 12000];
  let lastErr: unknown;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await sleep(delays[i]);
    try {
      const client = await getGlobalClient();
      if (!client) {
        lastErr = new Error("client not ready");
        continue;
      }
      await client.editMessage({
        chatId,
        message: messageId,
        text: isHtml ? html(text) : text,
      });
      fs.unlinkSync(exitFile);
      return;
    } catch (e: unknown) {
      lastErr = e;
    }
  }

  try {
    const client = await getGlobalClient();
    if (client) {
      await client.sendText(chatId, isHtml ? html(text) : text);
    }
  } catch (sendErr: unknown) {
    logger.error("Failed to edit/send exit message after retries:", lastErr || sendErr);
  }
  try {
    fs.unlinkSync(exitFile);
  } catch {
    /* ignore */
  }
};

if (fs.existsSync(exitFile)) {
  setTimeout(() => {
    editExitMsg().catch((e: unknown) => logger.error("Failed to handle exit message on startup:", e));
  }, 2000);
}

export async function executeExit(
  msg: MessageContext,
  options?: {
    pendingText?: string;
    successText?: string;
    isHtml?: boolean;
  }
) {
  const pendingText = options?.pendingText ?? "🔄 正在结束进程...";
  const isHtml = options?.isHtml ?? false;
  const result = await msg.edit({
    text: isHtml ? html(pendingText) : pendingText,
  });
  const messageId =
    result && typeof result === "object" && "id" in result
      ? Number((result as { id: number }).id)
      : Number(msg.id);
  const chatId =
    (result && typeof result === "object" && "chat" in result
      ? (result as { chat?: { id?: string | number } }).chat?.id
      : undefined) ??
    msg.chat?.id;
  if (Number.isFinite(messageId) && chatId != null) {
    fs.writeFileSync(
      exitFile,
      JSON.stringify({
        messageId,
        chatId: typeof chatId === "object" ? String((chatId as { id?: unknown }).id ?? chatId) : chatId,
        time: Date.now(),
        successText: options?.successText,
        isHtml,
      }),
      "utf-8",
    );
  } else {
    logger.warn("[RELOAD] executeExit: could not persist exit status peer/messageId");
  }
  process.exit(0);
}

const HELP_TEXT = `🔄 Reload · 重载与重启

• <code>${mainPrefix}reload</code> — 重新加载插件（一般不重启整个程序）
• <code>${mainPrefix}exit</code> / <code>${mainPrefix}restart</code> — 退出进程，PM2 会自动再启动
• <code>${mainPrefix}pmr</code> — 让 PM2 直接重启本进程

🩺 想管内存 / 自动保护？用：
• <code>${mainPrefix}health</code> — 看内存
• <code>${mainPrefix}memory on</code> — 打开自动保护
• <code>${mainPrefix}memory</code> — 完整说明（小白友好）
`;

class ReloadPlugin extends Plugin {
  cleanup(): void {
    for (const timer of pendingExitTimers) {
      clearTimeout(timer);
    }
    pendingExitTimers.clear();
  }

  description = HELP_TEXT;

  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    reload: async (msg) => {
      const statusMessage = await msg.edit({ text: "🔄 正在重新加载插件..." });
      const targetChat = statusMessage?.chat?.id ?? msg.chat.id;
      const targetMessageId = statusMessage?.id ?? msg.id;
      try {
        const startTime = Date.now();
        const runtime = await reloadRuntime();
        const loadTime = Date.now() - startTime;
        try {
          const { noteReloadCompleted } = await import("./health");
          await noteReloadCompleted();
        } catch (e: unknown) {
          logger.warn("[RELOAD] noteReloadCompleted:", e);
        }
        await updateReloadStatus({
          client: runtime.client,
          targetChat,
          targetMessageId,
          text: `✅ 重载完成，耗时 ${loadTime}ms`,
          isHtml: true,
        });
      } catch (error: unknown) {
        logger.error("Plugin reload failed:", error);
        const errorMessage = getErrorMessage(error) || String(error);
        try {
          const client = await getGlobalClient();
          await updateReloadStatus({
            client,
            targetChat,
            targetMessageId,
            text: `❌ 插件重新加载失败\n错误信息：${htmlEscape(errorMessage)}\n请检查控制台日志获取详细信息`,
          });
        } catch (editError: unknown) {
          logger.error("Failed to update reload status message:", editError);
        }
      }
    },

    exit: async (msg) => {
      await executeExit(msg);
    },

    restart: async (msg) => {
      await executeExit(msg);
    },

    pmr: async (msg) => {
      await msg.delete();
      scheduleTrackedTimeout(async () => {
        try {
          const pm2Name = process.env.name || "telebox-next";
          await execFileAsync("pm2", ["restart", pm2Name]);
        } catch (error: unknown) {
          logger.error("PM2 restart failed:", error);
        }
      }, 500);
    },
  };
}

export default new ReloadPlugin();
