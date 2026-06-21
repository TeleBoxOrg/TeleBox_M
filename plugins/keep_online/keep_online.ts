import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { TelegramClient } from "@mtcute/node";
import { createDirectoryInTemp } from "@utils/pathHelpers";
import fs from "fs";
import path from "path";

import { safeGetMe } from "@utils/authGuards";
import { logger } from "@utils/logger";
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const pluginName = "keep_online";

const commandName = `${mainPrefix}${pluginName}`;

const file = path.join(createDirectoryInTemp("keep_online"), "keep_online.txt");
const help_text = `
每隔 55 秒, 脚本将尝试保活并把时间戳写入 TeleBox 工作目录下的 <code>temp/keep_online/keep_online.txt</code>. 请自行使用外部定时任务(如宿主机的 crontab) 来定时读取 TeleBox 工作目录下的 <code>temp/keep_online/keep_online.txt</code>(如果是宿主机, 需要使用你映射的宿主机的路径) 中的时间戳, 以此来判断离线是否超过一定的时间(如两分钟), 以此判断是否需要重启服务.
可参考脚本 <code>https://github.com/TeleBoxDev/TeleBox_Plugins/blob/main/keep_online/keep_online.sh?raw=true</code>
`;

class KeepOnlinePlugin extends Plugin {
  cmdHandlers: Record<
    string,
    (msg: MessageContext, trigger?: MessageContext) => Promise<void>
  > = {
    keep_online: async (msg: MessageContext, trigger?: MessageContext) => {},
  };
  description: string = `${help_text}`;
  cronTasks = {
    keep_online: {
      cron: "*/55 * * * * *",
      description: `${help_text}`,
      handler: async (client: TelegramClient) => {
        try {
          await safeGetMe(client);
          const timestamp = Date.now() / 1000;
          fs.writeFileSync(file, `${timestamp.toFixed(0)}`, "utf-8");
        } catch (e) { logger.warn('[keep_online] heartbeat write failed:', e) }
      },
    },
  };
}

export default new KeepOnlinePlugin();