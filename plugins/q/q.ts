import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { conversation } from "@utils/conversation";
import type { MessageContext } from "@mtcute/dispatcher";
import type { Message } from "@mtcute/node";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { getGlobalClient } from "@utils/globalClient";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];


const bots = ["QuotLyBot", "PagerMaid_QuotLyBot"];

async function firstSuccessfulBotResponse(
  promises: Promise<Message>[],
  controllers: AbortController[]
): Promise<Message> {
  return await new Promise<Message>((resolve, reject) => {
    let pending = promises.length;
    const errors: unknown[] = [];

    promises.forEach((promise, index) => {
      promise.then(
        (response) => {
          controllers.forEach((controller) => {
            if (!controller.signal.aborted) {
              controller.abort("Quote bot race resolved");
            }
          });
          resolve(response);
        },
        (error) => {
          errors[index] = error;
          pending -= 1;
          if (pending === 0) {
            reject(errors);
          }
        }
      );
    });
  });
}

async function quoteMsgs(msg: MessageContext): Promise<void> {
  const client = await getGlobalClient();
  if (!client) throw new Error("客户端未初始化");

  const [, ...args] = msg.text.slice(1).split(" ");
  const repliedMessage = await safeGetReplyMessage(msg);
  const count = parseInt(args[0]) || 1;
  const msgs = await client.getHistory(msg.chat.id, {
    offset: { id: repliedMessage!.id, date: 0 },
    limit: count,
    reverse: true,
  });

  const controllers = bots.map(() => new AbortController());
  const botPromises = bots.map((botName, index) => 
    (async (): Promise<Message> => {
      try {
        let response: Message | undefined;
        await conversation(
          client,
          botName,
          { signal: controllers[index].signal },
          async (conv) => {
            await client.forwardMessagesById({
              fromChatId: msg.chat.id,
              messages: msgs.map((m) => m.id),
              toChatId: botName,
            });
            response = await conv.getResponse();
            await conv.markAsRead();
          }
        );
        if (!response) {
          throw new Error(`${botName}: 未收到响应`);
        }
        return response;
      } catch (error: unknown) {
        throw new Error(`${botName}: ${error}`);
      }
    })()
  );

  try {
    const response = await firstSuccessfulBotResponse(botPromises, controllers);
    await Promise.allSettled(botPromises);
    
    await client.sendText(msg.chat.id, response.text || "");
    await msg.delete();
  } catch {
    const settled = await Promise.allSettled(botPromises);
    const errors = settled
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => String(r.reason));
    throw new Error(`所有机器人都失败了:\n${errors.join("\n")}`);
  }
}

async function handleQutoe(msg: MessageContext): Promise<void> {
  try {
    await msg.edit({ text: "🔄 正在生成语录表情包..." });
    await quoteMsgs(msg);
  } catch (error: unknown) {
    await msg.edit({
      text: `❌ 生成语录表情包错误：${error}`,
    });
  }
}

const q = async (msg: MessageContext) => {
  if (!msg.replyToMessage) {
    await msg.edit({ text: "请回复一条消息来制作语录表情包" });
    return;
  }
  await handleQutoe(msg);
};

class QPlugin extends Plugin {

  description: string = `${mainPrefix}q [count] - 制作语录表情包（同时发送给 @QuotLyBot 和 @PagerMaid_QuotLyBot）, count: 可选，默认为 1, 表示消息的数量`;
  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    q,
  };
}

export default new QPlugin();