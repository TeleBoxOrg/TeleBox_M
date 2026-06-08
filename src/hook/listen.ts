import { MessageContext } from "@mtcute/dispatcher";
import { getGlobalClient } from "@utils/globalClient";
import { SudoDB } from "@utils/sudoDB";

function checkIfSenderIdFromSudoUser(uid: number): boolean {
  const sudoDB = new SudoDB();
  const list = sudoDB.ls();
  sudoDB.close();
  return !!list.find((a) => a.uid == uid);
}

/**
 * sudo 编辑重定向 hook(当前在 index.ts 中处于关闭状态)。
 *
 * 旧 gramjs 实现 monkey-patch `Api.Message.prototype.edit`,当消息发送者是 sudo
 * 用户时改用 sendMessage 重发而非 edit。mtcute 的 MessageContext.edit 是 class
 * 方法,这里保留 native 等价实现:patch MessageContext.prototype.edit,在 sudo
 * 场景下回退到 client.sendText。
 *
 * 与旧版一致,此 hook 默认不启用(index.ts 中 `patchMsgEdit()` 调用被注释)。
 */
async function patchMsgEdit(): Promise<void> {
  const originEdit = MessageContext.prototype.edit;

  MessageContext.prototype.edit = async function (
    this: MessageContext,
    params: Parameters<MessageContext["edit"]>[0]
  ): ReturnType<MessageContext["edit"]> {
    const senderId = this.sender ? Number(this.sender.id) : 0;
    const isSudoUser = checkIfSenderIdFromSudoUser(senderId);

    if (isSudoUser) {
      const client = await getGlobalClient();
      if (client && params && "text" in params && params.text != null) {
        return client.sendText(this.chat, params.text);
      }
    }

    return originEdit.apply(this, [params]);
  };
}

export { patchMsgEdit };
