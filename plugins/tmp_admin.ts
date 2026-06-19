import { getGlobalClient } from "@utils/globalClient";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { tryGetCurrentRuntime } from "@utils/runtimeManager";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import type { Low } from "lowdb";
import { JSONFilePreset } from "lowdb/node";
import path from "path";
import type { MessageContext } from "@mtcute/dispatcher";
import { html } from "@mtcute/html-parser";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const pluginName = "tmp_admin";
const commandName = `${mainPrefix}${pluginName}`;
const defaultDurationMinutes = 30;
const tempTitle = "临时管理";
const maxTimerDelayMs = 2_147_483_647;
const expiryRetryDelayMs = 60_000;
const maxExpiryRetries = 1;

const helpText = `
使用 <code>${commandName} add [分钟]</code> 回复一条消息, <code>${commandName} add 用户ID/用户名 [分钟]</code> 设置无权限临时管理员, 默认 ${defaultDurationMinutes} 分钟
使用 <code>${commandName} rm/remove</code> 回复一条消息, <code>${commandName} rm/remove 用户ID/用户名</code> 提前解除临时管理员
<code>${commandName} ls/list</code> 查看当前对话等待自动解除的临时管理员
`;

const adminRightKeys = [
  "changeInfo",
  "postMessages",
  "editMessages",
  "deleteMessages",
  "banUsers",
  "inviteUsers",
  "pinMessages",
  "addAdmins",
  "anonymous",
  "manageCall",
  "manageTopics",
  "postStories",
  "editStories",
  "deleteStories",
  "manageDirectMessages",
  "manageRanks",
] as const;

type ResolvedUser = {
  id?: number;
  entity?: any;
};

type TempAdminJob = {
  timer?: ReturnType<typeof setTimeout>;
  client: any;
  channel: any;
  chatKey: string;
  peerId: any;
  userEntity: any;
  userId: number;
  userDisplay: string;
  replyToMsgId?: number;
  expiresAt: number;
  retryCount: number;
};

type StoredChannel = {
  className: "any" | "InputChannel";
  channelId: string;
  accessHash: string;
};

type StoredUser = {
  className: "any" | "InputUser";
  userId: string;
  accessHash: string;
};

type StoredJob = {
  chatKey: string;
  channel: StoredChannel;
  user: StoredUser;
  userId: number;
  userDisplay: string;
  replyToMsgId?: number;
  expiresAt: number;
  retryCount?: number;
};

type TmpAdminDB = {
  jobs: Record<string, StoredJob>;
};

type CommandResponse = {
  text: string;
  parseMode?: "html";
};

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

function isMessageNotModified(error: any): boolean {
  return String(error?.message || error).includes("MESSAGE_NOT_MODIFIED");
}

async function editMessageIgnoringNotModified(
  msg: MessageContext,
  options: { text: any }
): Promise<void> {
  try {
    await msg.edit(options as any);
  } catch (error) {
    if (!isMessageNotModified(error)) throw error;
  }
}

async function deleteMessageQuiet(msg: MessageContext): Promise<void> {
  try {
    const target = msg as any;
    if (typeof target.safeDelete === "function") {
      await target.safeDelete({ revoke: true });
      return;
    }
    if (typeof target.delete === "function") {
      await target.delete({ revoke: true });
    }
  } catch (error) {
    console.error("[tmp_admin] 删除 sudo 命令副本失败:", error);
  }
}

async function respondToCommand(
  msg: MessageContext,
  trigger: MessageContext | undefined,
  options: CommandResponse,
  ignoreNotModified?: boolean
): Promise<void> {
  const editText = options.parseMode === "html" ? html(options.text) as any : options.text;
  const sendContent = options.parseMode === "html" ? html(options.text) as any : options.text;

  if (!trigger) {
    if (ignoreNotModified) {
      await editMessageIgnoringNotModified(msg, { text: editText });
      return;
    }
    await msg.edit({ text: editText } as any);
    return;
  }

  const client = (msg as any).client;
  const peer = msg.chat.id;
  if (!client || !peer) {
    await editMessageIgnoringNotModified(msg, { text: editText });
    return;
  }

  try {
    await client.sendText(peer, sendContent, {
      replyTo: trigger.id,
    } as any);
  } catch {
    await client.sendText(peer, sendContent);
  }

  await deleteMessageQuiet(msg);
}

function parseDurationMinutes(raw?: string): number {
  if (!raw) return defaultDurationMinutes;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error("时长必须是大于 0 的分钟数");
  }
  return minutes;
}

function formatDuration(minutes: number): string {
  return `${minutes} 分钟`;
}

function getReplyToMsgId(msg: MessageContext, trigger?: MessageContext): number | undefined {
  return trigger?.id || msg.id;
}

function getChatKey(chatEntity: any, msg: MessageContext): string {
  const raw = chatEntity?.id ?? msg.chat.id;
  return String(raw);
}

function getJobKey(chatKey: string, userId: number): string {
  return `${chatKey}:${userId}`;
}

function messageHasReply(msg: MessageContext): boolean {
  return !!(msg.replyToMessage?.id || (msg as any).replyToMsgId);
}

function getTargetSourceMessage(msg: MessageContext, trigger?: MessageContext): MessageContext {
  if (trigger && messageHasReply(trigger)) return trigger;
  return msg;
}

function longToString(value: any): string {
  if (value === undefined || value === null) {
    throw new Error("缺少可持久化的 long 值");
  }
  return String(value);
}

function serializeChannel(channel: any): StoredChannel {
  const cn = channel?._ === "inputPeerChannel" ? "any"
           : channel?._ === "inputChannel" ? "InputChannel"
           : undefined;
  if (!cn) {
    throw new Error(`不支持持久化当前对话实体: ${channel?._ || "unknown"}`);
  }

  return {
    className: cn,
    channelId: longToString(channel.channelId),
    accessHash: longToString(channel.accessHash),
  };
}

function serializeUser(user: any): StoredUser {
  const cn = user?._ === "inputPeerUser" ? "any"
           : user?._ === "inputUser" ? "InputUser"
           : undefined;
  if (!cn) {
    throw new Error(`不支持持久化目标用户实体: ${user?._ || "unknown"}`);
  }

  return {
    className: cn,
    userId: longToString(user.userId),
    accessHash: longToString(user.accessHash),
  };
}

function deserializeChannel(stored: StoredChannel): any {
  if (stored.className === "InputChannel") {
    return { _: "inputChannel", channelId: Number(stored.channelId), accessHash: Number(stored.accessHash) } as any;
  }
  return { _: "inputPeerChannel", channelId: Number(stored.channelId), accessHash: Number(stored.accessHash) } as any;
}

function deserializeUser(stored: StoredUser): any {
  if (stored.className === "InputUser") {
    return { _: "inputUser", userId: Number(stored.userId), accessHash: Number(stored.accessHash) } as any;
  }
  return { _: "inputPeerUser", userId: Number(stored.userId), accessHash: Number(stored.accessHash) } as any;
}

function toSendPeer(channel: any): any {
  if (channel?._ === "inputPeerChannel") return channel;
  if (channel?._ === "inputChannel") {
    return {
      _: "inputPeerChannel",
      channelId: channel.channelId,
      accessHash: channel.accessHash,
    } as any;
  }
  return channel;
}

function hasNonOtherAdminRights(rights?: any): boolean {
  if (!rights) return false;
  return adminRightKeys.some((key) => !!rights[key]);
}

function isTemporaryAdminParticipant(participant?: any): boolean {
  return (
    participant?._ === "channelParticipantAdmin" &&
    (participant as any).rank === tempTitle &&
    !hasNonOtherAdminRights((participant as any).adminRights)
  );
}

async function formatEntity(target: any, mention?: boolean, throwErrorIfFailed?: boolean) {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");
  if (!target) throw new Error("无效的目标");

  let id: any;
  let entity: any;
  try {
    entity = target?._ ? target : await client.getChat(target as any);
    if (!entity) throw new Error("无法获取 entity");
    id = entity.id;
    if (!id) throw new Error("无法获取 entity id");
  } catch (e: any) {
    if (throwErrorIfFailed) {
      throw new Error(`无法获取 ${target} 的 entity: ${e?.message || "未知错误"}`);
    }
  }

  const displayParts: string[] = [];
  if (entity?.title) displayParts.push(htmlEscape(entity.title));
  if (entity?.firstName) displayParts.push(htmlEscape(entity.firstName));
  if (entity?.lastName) displayParts.push(htmlEscape(entity.lastName));
  if (entity?.username) {
    displayParts.push(
      mention ? `@${htmlEscape(entity.username)}` : codeTag(`@${entity.username}`)
    );
  }

  if (id) {
    displayParts.push(`<a href="tg://user?id=${id}">${id}</a>`);
  } else if (!target?._) {
    displayParts.push(codeTag(target));
  }

  return {
    id,
    entity,
    display: displayParts.join(" ").trim(),
  };
}

class TmpAdminPlugin extends Plugin {
  private jobs = new Map<string, TempAdminJob>();
  private dbPromise?: Promise<Low<TmpAdminDB>>;
  private dbQueue: Promise<void> = Promise.resolve();
  private restorePromise: Promise<void>;

  constructor() {
    super();
    this.restorePromise = this.restoreJobs().catch((error) => {
      if (String(error?.message || error).includes("runtime is not initialized")) return;
      console.error("[tmp_admin] 恢复临时管理员任务失败:", error);
    });
  }

  cleanup(): void {
    for (const job of this.jobs.values()) {
      if (job.timer) clearTimeout(job.timer);
    }
    this.jobs.clear();
  }

  description: string = `<br>临时管理员<br><br>${helpText}`;

  cmdHandlers: Record<
    string,
    (msg: MessageContext, trigger?: MessageContext) => Promise<void>
  > = {
    tmp_admin: async (msg: MessageContext, trigger?: MessageContext) => {
      await this.restorePromise;
      const parts = (msg.text || "").trim().split(/\s+/).filter(Boolean);
      const sub = (parts[1] || "").toLowerCase();

      if (["help", "h"].includes(sub)) {
        await respondToCommand(msg, trigger, { text: helpText });
        return;
      }

      const isInChannel = (msg as any).isChannel;
      if (!isInChannel) {
        await respondToCommand(msg, trigger, {
          text: `请在超级群/频道中使用 <code>${commandName}</code> 命令`,
        });
        return;
      }

      const client = await getGlobalClient();
      if (!client) {
        await respondToCommand(msg, trigger, { text: "Telegram 客户端未初始化" });
        return;
      }
      const channel = client.resolvePeer(msg.chat.id) as any;
      const chatEntity = await msg.getCompleteChat();
      if (!channel || (chatEntity as any)?._ !== "channel") {
        await respondToCommand(msg, trigger, { text: "无法获取当前超级群/频道实体" });
        return;
      }
      const chatKey = getChatKey(chatEntity, msg);

      if (["ls", "list"].includes(sub)) {
        await this.listJobs(msg, trigger, chatKey);
        return;
      }

      if (["rm", "remove", "del"].includes(sub)) {
        const targetSourceMsg = getTargetSourceMessage(msg, trigger);
        const targetArg = messageHasReply(targetSourceMsg) ? undefined : parts[2];
        await this.removeTemporaryAdmin({
          msg,
          targetSourceMsg,
          trigger,
          channel,
          chatEntity,
          targetArg,
          manual: true,
        });
        return;
      }

      if (["add", "set"].includes(sub)) {
        const targetSourceMsg = getTargetSourceMessage(msg, trigger);
        const targetArg = messageHasReply(targetSourceMsg) ? undefined : parts[2];
        const durationArg = messageHasReply(targetSourceMsg) ? parts[2] : parts[3];
        await this.addTemporaryAdmin({
          msg,
          targetSourceMsg,
          trigger,
          channel,
          chatEntity,
          targetArg,
          durationArg,
        });
        return;
      }

      await respondToCommand(msg, trigger, { text: helpText });
    },
  };

  private async addTemporaryAdmin(params: {
    msg: MessageContext;
    targetSourceMsg: MessageContext;
    trigger?: MessageContext;
    channel: any;
    chatEntity: any;
    targetArg?: string;
    durationArg?: string;
  }): Promise<void> {
    const { msg, targetSourceMsg, trigger, channel, chatEntity, targetArg, durationArg } =
      params;
    let durationMinutes: number;
    try {
      durationMinutes = parseDurationMinutes(durationArg);
    } catch (e: any) {
      await respondToCommand(msg, trigger, {
        text: `设置临时管理员失败：${codeTag(e?.message || e)}`,
      });
      return;
    }

    const { entity: userEntity, id: userId } = await this.resolveUserFromReplyOrArg(
      targetSourceMsg,
      channel,
      targetArg
    );

    if (!userEntity || !userId) {
      await respondToCommand(msg, trigger, { text: "请回复一条消息或提供 用户ID/用户名" });
      return;
    }

    const chatKey = getChatKey(chatEntity, msg);
    const key = getJobKey(chatKey, userId);
    let participant: any;
    try {
      participant = await this.getCurrentParticipantOrThrow(channel, userEntity);
    } catch (e: any) {
      await respondToCommand(msg, trigger, {
        text:
          `查询当前管理员状态失败：${codeTag(e?.message || e)}<br>` +
          "为避免覆盖现有管理员权限, 已取消设置。",
      });
      return;
    }

    if (participant?._ === "channelParticipantCreator") {
      await respondToCommand(msg, trigger, { text: "不能把群主设置为临时管理员" });
      return;
    }

    if (
      participant?._ === "channelParticipantAdmin" &&
      !isTemporaryAdminParticipant(participant)
    ) {
      if (this.jobs.has(key)) {
        this.clearLocalJob(key);
        await this.deleteStoredJob(key);
      }
      await respondToCommand(msg, trigger, {
        text: "目标已经是管理员。为避免覆盖现有权限和头衔, 不会将其改为临时管理员。",
      });
      return;
    }

    const client = await getGlobalClient();
    if (!client) {
      await respondToCommand(msg, trigger, { text: "Telegram 客户端未初始化" });
      return;
    }

    try {
      await client.call({
        _: "channels.editAdmin",
        channel,
        userId: userEntity,
        adminRights: { _: "chatAdminRights", other: true } as any,
        rank: tempTitle,
      } as any);
      const user = await formatEntity(userId || userEntity, true);
      const expiresAt = Date.now() + durationMinutes * 60_000;
      const job: TempAdminJob = {
        client,
        channel,
        chatKey,
        peerId: msg.chat.id,
        userEntity,
        userId,
        userDisplay: user.display,
        replyToMsgId: getReplyToMsgId(msg, trigger),
        expiresAt,
        retryCount: 0,
      };
      this.scheduleExpiry(key, job);

      let persistenceWarning = "";
      try {
        await this.persistJob(key, job);
      } catch (e: any) {
        persistenceWarning = `<br>持久化失败: ${codeTag(e?.message || e)}`;
      }

      await sleep(1200);
      let verificationWarning = "";
      try {
        const refreshed = await this.getCurrentParticipantOrThrow(channel, userEntity);
        if (!isTemporaryAdminParticipant(refreshed)) {
          verificationWarning =
            "\n状态校验未确认, 已保留到期解除任务。若服务端稍后同步, 到期仍会尝试解除。";
        }
      } catch (e: any) {
        verificationWarning =
          `<br>状态校验失败, 已保留到期解除任务: ${codeTag(e?.message || e)}`;
      }

      await respondToCommand(msg, trigger, {
        text:
          `已设置临时管理员: ${user.display}<br>` +
          `头衔: ${codeTag(tempTitle)}<br>` +
          `时长: ${codeTag(formatDuration(durationMinutes))}` +
          `${persistenceWarning}${verificationWarning}`,
      }, true);
    } catch (e: any) {
      await respondToCommand(msg, trigger, {
        text: `设置临时管理员失败：${codeTag(e?.message || e)}`,
      }, true);
    }
  }

  private async removeTemporaryAdmin(params: {
    msg: MessageContext;
    targetSourceMsg: MessageContext;
    trigger?: MessageContext;
    channel: any;
    chatEntity: any;
    targetArg?: string;
    manual: boolean;
  }): Promise<void> {
    const { msg, targetSourceMsg, trigger, channel, chatEntity, targetArg, manual } =
      params;
    const { entity: userEntity, id: userId } = await this.resolveUserFromReplyOrArg(
      targetSourceMsg,
      channel,
      targetArg
    );

    if (!userEntity || !userId) {
      await respondToCommand(msg, trigger, { text: "请回复一条消息或提供 用户ID/用户名" });
      return;
    }

    const chatKey = getChatKey(chatEntity, msg);
    const key = getJobKey(chatKey, userId);
    const job = this.jobs.get(key);
    let participant: any;
    try {
      participant = await this.getCurrentParticipantOrThrow(channel, userEntity);
    } catch (e: any) {
      await respondToCommand(msg, trigger, {
        text:
          `查询当前管理员状态失败：${codeTag(e?.message || e)}<br>` +
          "已保留临时管理员记录, 未执行解除。",
      });
      return;
    }

    if (!isTemporaryAdminParticipant(participant)) {
      if (job) {
        this.clearLocalJob(key);
        await this.deleteStoredJob(key);
        await respondToCommand(msg, trigger, {
          text: "目标当前已不再是插件设置的临时管理状态, 已清理记录, 未解除管理员。",
        });
        return;
      }
      await respondToCommand(msg, trigger, {
        text: "目标不是当前插件记录的临时管理员, 也没有临时管理头衔。为避免误删真实管理员, 已取消。",
      });
      return;
    }

    try {
      const client = await getGlobalClient();
      if (!client) throw new Error("Telegram 客户端未初始化");

      await this.demoteAdmin(client, channel, userEntity);

      this.clearLocalJob(key);
      await this.deleteStoredJob(key);

      const user = await formatEntity(userId || userEntity, true);
      await respondToCommand(msg, trigger, {
        text: `${manual ? "已提前解除" : "已解除"}临时管理员: ${user.display}`,
      }, true);
    } catch (e: any) {
      await respondToCommand(msg, trigger, {
        text: `解除临时管理员失败：${codeTag(e?.message || e)}`,
      }, true);
    }
  }

  private scheduleExpiry(key: string, job: TempAdminJob): void {
    const existing = this.jobs.get(key);
    if (existing?.timer) clearTimeout(existing.timer);

    const scheduleWithDelay = (delay: number) => {
      job.timer = setTimeout(async () => {
        if (Date.now() < job.expiresAt) {
          scheduleNext();
          return;
        }

        let participant: any;
        try {
          participant = await this.getCurrentParticipantOrThrow(
            job.channel,
            job.userEntity
          );
        } catch (e) {
          scheduleRetry(e);
          return;
        }

        if (!isTemporaryAdminParticipant(participant)) {
          this.jobs.delete(key);
          await this.deleteStoredJobQuiet(key);
          await this.sendReplyQuiet(
            job,
            `临时管理员已到期, 但 ${job.userDisplay} 已不再是插件设置的临时管理状态, 未自动解除。`
          );
          return;
        }

        try {
          await this.demoteAdmin(job.client, job.channel, job.userEntity);
        } catch (e) {
          scheduleRetry(e);
          return;
        }

        this.jobs.delete(key);
        await this.deleteStoredJobQuiet(key);
        await this.sendReplyQuiet(
          job,
          `临时管理员已到期并自动解除: ${job.userDisplay}`
        );
      }, Math.min(Math.max(0, delay), maxTimerDelayMs));
    };

    const scheduleRetry = (error: any) => {
      if (job.retryCount >= maxExpiryRetries) {
        this.jobs.delete(key);
        void this.deleteStoredJobQuiet(key);
        void this.sendReplyQuiet(
          job,
          `临时管理员到期自动解除失败, 已重试 ${maxExpiryRetries} 次: ${codeTag(
            error?.message || error
          )}`
        );
        return;
      }

      job.retryCount += 1;
      void this.persistJobQuiet(key, job);
      console.error(
        `[tmp_admin] 临时管理员到期解除失败, ${expiryRetryDelayMs / 1000}s 后重试 ${key} (${job.retryCount}/${maxExpiryRetries}):`,
        error
      );
      this.jobs.set(key, job);
      scheduleWithDelay(expiryRetryDelayMs);
    };

    const scheduleNext = () => {
      const delay = Math.max(0, job.expiresAt - Date.now());
      scheduleWithDelay(delay);
    };

    this.jobs.set(key, job);
    scheduleNext();
  }

  private clearLocalJob(key: string): void {
    const job = this.jobs.get(key);
    if (job?.timer) clearTimeout(job.timer);
    this.jobs.delete(key);
  }

  private getDb(): Promise<Low<TmpAdminDB>> {
    if (!this.dbPromise) {
      const filePath = path.join(createDirectoryInAssets(pluginName), "jobs.json");
      this.dbPromise = JSONFilePreset<TmpAdminDB>(filePath, { jobs: {} });
    }
    return this.dbPromise;
  }

  private async mutateDb(mutator: (data: TmpAdminDB) => void): Promise<void> {
    const run = this.dbQueue.then(async () => {
      const db = await this.getDb();
      await db.read();
      if (!db.data) db.data = { jobs: {} };
      if (!db.data.jobs) db.data.jobs = {};
      mutator(db.data);
      await db.write();
    });
    this.dbQueue = run.catch(() => {});
    await run;
  }

  private async persistJob(key: string, job: TempAdminJob): Promise<void> {
    const stored: StoredJob = {
      chatKey: job.chatKey,
      channel: serializeChannel(job.channel),
      user: serializeUser(job.userEntity),
      userId: job.userId,
      userDisplay: job.userDisplay,
      replyToMsgId: job.replyToMsgId,
      expiresAt: job.expiresAt,
      retryCount: job.retryCount,
    };
    await this.mutateDb((data) => {
      data.jobs[key] = stored;
    });
  }

  private async deleteStoredJob(key: string): Promise<void> {
    await this.mutateDb((data) => {
      delete data.jobs[key];
    });
  }

  private async deleteStoredJobQuiet(key: string): Promise<void> {
    try {
      await this.deleteStoredJob(key);
    } catch (error) {
      console.error(`[tmp_admin] 删除持久化任务失败 ${key}:`, error);
    }
  }

  private async persistJobQuiet(key: string, job: TempAdminJob): Promise<void> {
    try {
      await this.persistJob(key, job);
    } catch (error) {
      console.error(`[tmp_admin] 更新持久化任务失败 ${key}:`, error);
    }
  }

  private async restoreJobs(): Promise<void> {
    const runtime = tryGetCurrentRuntime();
    if (!runtime) return;

    const db = await this.getDb();
    await db.read();
    if (!db.data) db.data = { jobs: {} };
    if (!db.data.jobs) db.data.jobs = {};

    const removedKeys: string[] = [];
    for (const [key, stored] of Object.entries(db.data.jobs)) {
      try {
        const channel = deserializeChannel(stored.channel);
        const userEntity = deserializeUser(stored.user);
        this.scheduleExpiry(key, {
          client: runtime.client,
          channel,
          chatKey: stored.chatKey,
          peerId: toSendPeer(channel),
          userEntity,
          userId: stored.userId,
          userDisplay: stored.userDisplay,
          replyToMsgId: stored.replyToMsgId,
          expiresAt: stored.expiresAt,
          retryCount: stored.retryCount || 0,
        });
      } catch (error) {
        console.error(`[tmp_admin] 跳过无法恢复的任务 ${key}:`, error);
        removedKeys.push(key);
      }
    }

    if (removedKeys.length > 0) {
      await this.mutateDb((data) => {
        for (const key of removedKeys) delete data.jobs[key];
      });
    }
  }

  private async demoteAdmin(client: any, channel: any, userEntity: any): Promise<void> {
    await client.call({
      _: "channels.editAdmin",
      channel,
      userId: userEntity,
      adminRights: { _: "chatAdminRights" } as any,
      rank: "",
    } as any);
  }

  private async sendReply(job: TempAdminJob, message: string): Promise<void> {
    const text = html(message) as any;

    try {
      await job.client.sendText(job.peerId, text, {
        ...(job.replyToMsgId ? { replyTo: job.replyToMsgId } : {}),
      } as any);
    } catch (e) {
      if (!job.replyToMsgId) throw e;
      await job.client.sendText(job.peerId, text);
    }
  }

  private async sendReplyQuiet(job: TempAdminJob, message: string): Promise<void> {
    try {
      await this.sendReply(job, message);
    } catch (error) {
      console.error("[tmp_admin] 发送到期通知失败:", error);
    }
  }

  private async listJobs(
    msg: MessageContext,
    trigger: MessageContext | undefined,
    chatKey: string
  ): Promise<void> {
    const jobs = [...this.jobs.values()].filter((job) => job.chatKey === chatKey);
    if (jobs.length === 0) {
      await respondToCommand(msg, trigger, { text: "当前没有等待自动解除的临时管理员" });
      return;
    }

    const now = Date.now();
    const lines = jobs.map((job) => {
      const remainingMinutes = Math.max(0, Math.ceil((job.expiresAt - now) / 60_000));
      return `- ${job.userDisplay} | 剩余 ${codeTag(`${remainingMinutes} 分钟`)}`;
    });

    await respondToCommand(msg, trigger, {
      text: `当前临时管理员：<br>${lines.join("<br>")}`,
    });
  }

  private async getCurrentParticipantOrThrow(
    channel: any,
    targetEntity: any
  ): Promise<any> {
    const client = await getGlobalClient();
    const info = await (client as any).call({
      _: "channels.getParticipant",
      channel,
      participant: targetEntity,
    } as any);
    return (info as any)?.participant;
  }

  private async resolveUserFromReplyOrArg(
    msg: MessageContext,
    channel: any,
    arg?: string
  ): Promise<ResolvedUser> {
    const client = await getGlobalClient();
    if (!client) throw new Error("Telegram 客户端未初始化");

    if (messageHasReply(msg)) {
      const reply = await safeGetReplyMessage(msg);
      if (!reply) return {};

      let sender: any;
      try {
        sender = await (reply as any).getCompleteSender?.();
      } catch {
        sender = undefined;
      }

      if ((sender as any)?._ === "user") {
        const input = client.resolvePeer(sender.id);
        return { id: Number(sender.id), entity: input };
      }

      const uid = Number((reply as any).sender?.id);
      if (!uid) return {};

      try {
        const input = client.resolvePeer(uid);
        const full = await client.getChat(input as any);
        if ((full as any)?._ === "user") {
          return { id: Number(full.id), entity: input };
        }
      } catch {
        return {};
      }
    }

    if (!arg) return {};

    try {
      const full = await client.getChat(arg as any);
      if ((full as any)?._ !== "user") return {};
      const input = client.resolvePeer((full as any).id);
      return { id: Number((full as any).id), entity: input };
    } catch {
      const numericId = Number(arg);
      if (!Number.isFinite(numericId)) return {};

      try {
        let offset = 0;
        const limit = 200;
        for (let i = 0; i < 5; i++) {
          const result: any = await (client as any).call({
            _: "channels.getParticipants",
            channel,
            filter: { _: "channelParticipantsRecent" } as any,
            offset,
            limit,
            hash: 0 as any,
          } as any);
          const participants: any[] = result?.participants || [];
          const users: any[] = result?.users || [];
          const found = participants.find((p: any) => Number(p.userId) === numericId);
          if (found) {
            const user = users.find((u: any) => Number(u.id) === numericId);
            if (user) {
              const input = client.resolvePeer(user.id);
              return { id: Number(user.id), entity: input };
            }
          }
          if (!participants.length) break;
          offset += participants.length;
        }
      } catch {
        return {};
      }
    }

    return {};
  }
}

export default new TmpAdminPlugin();
