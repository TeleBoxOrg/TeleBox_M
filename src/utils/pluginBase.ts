import { TelegramClient } from "@mtcute/node";
import type { MessageContext } from "@mtcute/dispatcher";
import type { GenerationContext } from "./generationContext";
import { logger } from "@utils/logger";

export interface PluginRuntimeContext {
  generation: number;
  signal: AbortSignal;
  lifecycle: GenerationContext;
}

type CronTask = {
  cron: string;
  description: string;
  handler: (client: TelegramClient) => Promise<void>;
};

type PluginDescription =
  | string
  | ((...args: unknown[]) => string | void)
  | ((...args: unknown[]) => Promise<string | void>);

/**
 * Native mtcute event handler descriptor.
 *
 * The legacy gramjs `eventHandlers` carried a teleproto `EventBuilder` plus a
 * raw callback. mtcute drives all updates through @mtcute/dispatcher, so a
 * plugin instead declares the dispatcher update kind it wants and a callback.
 * pluginManager wires these onto the per-generation Dispatcher.
 *
 * `kind` mirrors the dispatcher registration method:
 *   - "newMessage"  → dp.onNewMessage
 *   - "editMessage" → dp.onEditMessage
 *   - "rawUpdate"   → dp.onRawUpdate
 * The handler receives the dispatcher context for that update kind. We keep the
 * context typed as `unknown` here to avoid leaking dispatcher-internal generics
 * into the plugin contract; pluginManager narrows per kind at registration.
 */
type PluginEventHandler = {
  kind?: "newMessage" | "editMessage" | "rawUpdate";
  handler: (ctx: unknown) => Promise<void>;
};

let cmdIgnoreEdited = true;
try {
  const raw = process.env.TB_CMD_IGNORE_EDITED;
  cmdIgnoreEdited = raw !== undefined ? !!JSON.parse(raw) : true;
} catch (e: unknown) {
  logger.warn(`[pluginBase] TB_CMD_IGNORE_EDITED 环境变量 JSON 解析失败，使用默认值 true:`, e);
}
logger.info(
  `[CMD_IGNORE_EDITED] 命令监听忽略编辑的消息: ${cmdIgnoreEdited} (可使用环境变量 TB_CMD_IGNORE_EDITED 覆盖)`
);

abstract class Plugin {
  name?: string;
  ignoreEdited?: boolean = cmdIgnoreEdited;
  abstract description: PluginDescription;
  abstract cmdHandlers: Record<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (msg: any, trigger?: any) => Promise<void>
  >;
  listenMessageHandlerIgnoreEdited?: boolean = true;
  listenMessageHandler?: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    msg: any,
    options?: { isEdited?: boolean }
  ) => Promise<void>;
  eventHandlers?: PluginEventHandler[];
  cronTasks?: Record<string, CronTask>;
  setup?(context: PluginRuntimeContext): Promise<void> | void;
  cleanup?(): Promise<void> | void;
}

/**
 * Legacy plugin compatibility type.
 *
 * During the teleproto → mtcute migration, plugins written in the old
 * teleproto style use `Api.Message` as their handler parameter type.
 * Since `Api.Message` (from the teleproto type stub) is structurally
 * compatible at runtime but not at the type level with mtcute's
 * `MessageContext`, this type alias provides a bridge for plugin
 * `cmdHandlers` declarations.
 *
 * Plugin handlers declared with this type are callable from
 * pluginManager (which passes `MessageContext`) and from the
 * legacy teleproto dispatcher (which passes `Api.Message`).
 */
export type LegacyPluginHandler = (
  msg: import("teleproto").Api.Message,
  trigger?: import("teleproto").Api.Message
) => Promise<void>;

function isValidPlugin(obj: unknown): obj is Plugin {
  if (!obj || typeof obj !== "object") return false;
  const candidate = obj as Partial<Plugin>;

  const desc = candidate.description;
  const isValidDescription =
    typeof desc === "string" || typeof desc === "function";

  if (!isValidDescription) return false;

  if (typeof candidate.cmdHandlers !== "object" || candidate.cmdHandlers === null) {
    return false;
  }
  for (const key of Object.keys(candidate.cmdHandlers)) {
    if (typeof candidate.cmdHandlers[key] !== "function") {
      return false;
    }
  }

  if (
    candidate.listenMessageHandler &&
    typeof candidate.listenMessageHandler !== "function"
  ) {
    return false;
  }

  if (candidate.cronTasks) {
    if (typeof candidate.cronTasks !== "object") return false;
    for (const key of Object.keys(candidate.cronTasks)) {
      const task = candidate.cronTasks[key];
      if (typeof task.cron !== "string") return false;
      if (typeof task.handler !== "function") return false;
    }
  }

  if (candidate.setup && typeof candidate.setup !== "function") {
    return false;
  }

  if (candidate.cleanup && typeof candidate.cleanup !== "function") {
    return false;
  }

  return true;
}

export { Plugin, isValidPlugin };
export type { PluginEventHandler, CronTask, PluginDescription };
