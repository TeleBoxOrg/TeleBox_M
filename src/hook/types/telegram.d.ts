import "@mtcute/dispatcher";

/**
 * 扩展 mtcute 的 MessageContext，添加 TeleBox-Next 自定义的便捷删除方法。
 *
 * 这些方法由 src/hook/patches/telegram.patch.ts 在运行时挂到
 * MessageContext.prototype 上。命令 handler 收到的就是 MessageContext，
 * 因此可直接 `await msg.deleteWithDelay(2000)`。
 */
declare module "@mtcute/dispatcher" {
  interface MessageContext {
    /**
     * 删除消息，但会先等待指定的毫秒数。
     *
     * @param delay 等待的时间（毫秒）
     * @param shouldThrowError 是否在删除失败时抛出错误，默认为 false
     * @example
     * ```ts
     * await msg.deleteWithDelay(2000);
     * ```
     */
    deleteWithDelay(
      delay: number,
      shouldThrowError?: boolean
    ): Promise<void>;

    /**
     * MessageContext.delete 的替代品，删除消息时捕捉错误，而不是导致进程结束。
     * @example
     * ```ts
     * await msg.safeDelete();
     * ```
     */
    safeDelete(params?: { revoke?: boolean }): Promise<void>;
  }
}
