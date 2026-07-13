import { MessageContext } from "@mtcute/dispatcher";
import { logger } from "@utils/logger";

/**
 * TeleBox-Next 自定义 MessageContext 便捷方法。
 *
 * 旧 gramjs 版本把这些挂在 `Api.Message.prototype`,并额外做 HTML 实体保护 hack
 * (因为 gramjs 的 HTMLParser 会错误处理 `&lt;` 等)。mtcute 0.29 的 `html` 解析器
 * 原生正确处理实体,所以实体保护 hack 已删除。
 *
 * 命令 handler 收到的是 MessageContext(继承 Message),因此这些方法挂在
 * MessageContext.prototype 上即可被插件直接调用。类型增广见
 * src/hook/types/telegram.d.ts。
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
