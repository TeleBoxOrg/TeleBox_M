import { Plugin } from "@utils/pluginBase";
import { htmlEscape } from "@utils/htmlEscape";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { safeGetMessages } from "@utils/safeGetMessages";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";
import type { ClientInternals } from "@utils/clientInternals";
import type { TelegramClient } from "@mtcute/node";
import type { InputPeerLike } from "@mtcute/core";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

function toInt(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function toStrInt(value: unknown): string | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? String(Math.trunc(n)) : undefined;
}

const CN_TIME_ZONE = "Asia/Shanghai";

function formatDate(date: Date): string {
  return date.toLocaleString("zh-CN", { timeZone: CN_TIME_ZONE });
}

async function formatEntity(
  target: string | number | { className?: string; id?: number },
  mention?: boolean,
  throwErrorIfFailed?: boolean,
) {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");
  if (!target) throw new Error("无效的目标");
  let id: number | undefined;
  let entity: { id?: number; title?: string; firstName?: string; lastName?: string; username?: string; className?: string; bot?: boolean; deleted?: boolean; fake?: boolean; scam?: boolean; botBusiness?: boolean } | undefined;
  try {
    entity = typeof target === 'object' && target.className
      ? target as { id?: number; title?: string; firstName?: string; lastName?: string; username?: string; className?: string; bot?: boolean; deleted?: boolean; fake?: boolean; scam?: boolean; botBusiness?: boolean }
      : (await (client as unknown as ClientInternals)?.resolvePeer(target as string | number)) as { id?: number; className?: string } | undefined;
    if (!entity) throw new Error("无法获取 entity");
    id = entity.id;
    if (!id) throw new Error("无法获取 entity id");
  } catch (e: unknown) {
    logger.error("[dbdj] 获取 entity 失败:", e);
    if (throwErrorIfFailed)
      throw new Error(
        `无法获取 ${target} 的 entity: ${e instanceof Error ? e.message : "未知错误"}`,
      );
  }
  const displayParts: string[] = [];

  if (entity?.title) displayParts.push(htmlEscape(entity.title));
  if (entity?.firstName) displayParts.push(htmlEscape(entity.firstName));
  if (entity?.lastName) displayParts.push(htmlEscape(entity.lastName));
  if (entity?.username)
    displayParts.push(
      mention
        ? htmlEscape(`@${entity.username}`)
        : `<code>@${htmlEscape(entity.username)}</code>`,
    );

  if (id) {
    displayParts.push(
      entity && 'firstName' in entity
        ? `<a href="tg://user?id=${id}">${id}</a>`
        : `<a href="https://t.me/c/${id}">${id}</a>`,
    );
  } else if (typeof target !== 'object' || !target.className) {
    displayParts.push(`<code>${htmlEscape(String(target))}</code>`);
  }

  return {
    id,
    entity,
    display: displayParts.join(" ").trim(),
  };
}
class DbdjPlugin extends Plugin {
  description: string = `点兵点将\n<code>${mainPrefix}dbdj 消息数 人数 文案</code> - 从最近的消息中随机抽取指定人数的用户`;
  cmdHandlers: Record<
    string,
    (msg: any, trigger?: any) => Promise<void>
  > = {
    dbdj: async (msg: any, trigger?: any) => {
      const startAt = Date.now();
      const replyAndDeleteMsg = async (message: string) => {
        const replyTarget = trigger || msg;
        await replyTarget.reply(message, {
          parseMode: "html",
          linkPreview: false,
        });
        try {
          await msg.delete();
        } catch (e: unknown) {
          logger.warn('[dbdj] 消息已被删除，跳过');
        }
      };

      try {
        const parts = (msg.message || "").trim().split(/\s+/);
        // 期望格式: .dbdj 消息数 人数 文案...
        const countStr = parts[1];
        const pickStr = parts[2];
        const note = parts.slice(3).join(" ");

        const scanCount = toInt(countStr);
        const pickCount = toInt(pickStr);

        if (!scanCount || !pickCount || scanCount <= 0 || pickCount <= 0) {
          await replyAndDeleteMsg(
            `用法: <code>${mainPrefix}dbdj 消息数 人数 文案</code>\n例如: <code>${mainPrefix}dbdj 50 2 恭喜发财</code>`,
          );
          return;
        }

        await msg.edit({
          text: `点兵点将...`,
          parseMode: "html",
        });

        const client = msg.client as TelegramClient;
        const offsetId = (msg.id || 1) - 1; // 从命令消息之前开始
        const messages = await safeGetMessages(client, msg.peerId as InputPeerLike, {
          ids: [] as number[],
          ...{ offsetId, limit: scanCount },
        } as Parameters<typeof safeGetMessages>[2]);

        // 收集有效用户: 仅统计来自用户的消息, 排除自身(out)、无 fromId 的消息
        const uniqueUserIds: number[] = [];
        const seen = new Set<number>();
        const filtered = new Set<number>();

        // 先收集所有需要查询的用户ID
        const uidsToFetch: number[] = [];
        for (const m of messages) {
          // 跳过自己发送的消息（已迁移到 mtcute: m.raw.out）
          const from = (m as { fromId?: { userId?: number } }).fromId;
          const uid = from?.userId ? Number(from.userId) : undefined;
          if (!uid || !Number.isFinite(uid)) continue;

          if (!seen.has(uid) && !filtered.has(uid)) {
            uidsToFetch.push(uid);
            seen.add(uid); // 标记为已处理，避免重复查询
          }
        }

        // 并行查询所有用户实体
        const entityResults = await Promise.all(
          uidsToFetch.map(async (uid) => ({ uid, entity: (await formatEntity(uid))?.entity })),
        );

        // 分类有效用户和被过滤用户
        for (const { uid, entity } of entityResults) {
          if (
            !entity ||
            entity?.bot ||
            entity?.deleted ||
            entity?.fake ||
            entity?.scam ||
            entity?.botBusiness
          ) {
            filtered.add(uid);
          } else {
            uniqueUserIds.push(uid);
          }
        }

        const population = uniqueUserIds.length;
        if (population === 0) {
          await replyAndDeleteMsg(
            `未在最近的 <code>${scanCount}</code> 条消息中找到可抽取的有效用户。`,
          );
          return;
        }

        // 随机选取
        const k = Math.min(pickCount, population);
        // 洗牌抽样
        for (let i = uniqueUserIds.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [uniqueUserIds[i], uniqueUserIds[j]] = [
            uniqueUserIds[j],
            uniqueUserIds[i],
          ];
        }
        const winners = uniqueUserIds.slice(0, k);

        // 格式化展示
        const winnerDisplays = await Promise.all(
          winners.map(async (id) => (await formatEntity(id, true)).display),
        );

        const usedNote = note ? ` ${htmlEscape(note)}` : "";
        const seconds = (
          Math.round(((Date.now() - startAt) / 1000) * 100) / 100
        ).toString();

        const head = `点兵点将, 点到谁... ${winnerDisplays.join(
          ", ",
        )}${usedNote}`;
        const stats = [
          `📊 统计信息:`,
          `• 扫描消息数: ${toStrInt(scanCount)}`,
          `• 有效用户数: ${population}`,
          `• 选中人数: ${k}`,
          `• 选中概率: ${
            population > 0
              ? (Math.round((k / population) * 100 * 100) / 100).toString()
              : "0.00"
          }%`,
          `• 耗时: ${seconds} 秒`,
        ].join("\n");

        await replyAndDeleteMsg(`${head}\n\n${stats}`);
      } catch (error: unknown) {
        await replyAndDeleteMsg(
          `执行失败: <code>${htmlEscape(
            getErrorMessage(error),
          )}</code>`,
        );
      }
    },
  };
}

export default new DbdjPlugin();
