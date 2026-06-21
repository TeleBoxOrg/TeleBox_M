import axios from "axios";
import _ from "lodash";
import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import type { Message } from "@mtcute/node";
import { html } from "@mtcute/html-parser";
import { getGlobalClient } from "@utils/globalClient";
import { logger } from "@utils/logger";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
  }[m] || m));

const bots = {
  default: "@music_v1bot",
  vk: "@vkmusic_bot",
  ym: "@ttaudiobot",
};

const pluginName = "music_bot";

const commandName = `${mainPrefix}${pluginName}`;

const botReady = new Map<string, boolean>();

const help_text = `
依赖 ${Object.values(bots).join(", ")}

<code>${mainPrefix}mbvk 关键词</code>, <code>${commandName} vk 关键词</code> 使用 ${
  bots.vk
} 音乐源搜索

<code>${mainPrefix}mbym 关键词</code>, <code>${commandName} ym 关键词</code> 用 YouTube Music 源搜索

<code>${mainPrefix}mbs 关键词</code>, <code>${commandName} search 关键词</code> 使用 ${
  bots.default
} 搜索音乐，关键词中包含搜索源会自动识别 例如：<code>search 洛天依 网易云</code>
<code>${mainPrefix}mbkg 关键词</code>, <code>${commandName} kugou 关键词</code> 用酷狗源搜索
<code>${mainPrefix}mbkw 关键词</code>, <code>${commandName} kuwo 关键词</code> 用酷我源搜索
<code>${mainPrefix}mbqq 关键词</code>, <code>${commandName} qq 关键词</code> 用 QQ 音乐源搜索
<code>${mainPrefix}mbne 关键词</code>, <code>${commandName} netease 关键词</code> 用网易云音乐源搜索

`;

async function searchAndSendMusic(
  msg: MessageContext,
  action: string,
  keyword: string,
  bot: string,
  displayKeyword?: string
) {
  if (
    !["search", "kugou", "kuwo", "qq", "netease", "vk", "ym"].includes(
      action
    ) ||
    !keyword
  ) {
    await msg.edit({ text: html(help_text) });
    return;
  }

  const client = await getGlobalClient();
  if (!client) return;

  // Give quick feedback
  try {
    await msg.edit({
      text: `🔎 搜索中：<code>${htmlEscape(displayKeyword ?? keyword)}</code>`,
    });
  } catch (e) { logger.warn('[music_bot] edit msg failed:', e) }

  // Ensure bot is unblocked and muted
  try {
    await client.call({ _: "contacts.unblock", id: await client.resolvePeer(bot) });
  } catch (e) { logger.warn('[music_bot] unblock bot failed:', e) }

  try {
    const inputPeer = await client.resolvePeer(bot);
    await client.call({ _: "account.updateNotifySettings", peer: { _: "inputNotifyPeer", peer: inputPeer }, settings: { _: "inputPeerNotifySettings", silent: true, muteUntil: 2147483647 } });
  } catch (e) { logger.warn('[music_bot] mute bot failed:', e) }

  

  // Send search command
  const startTs = Math.floor(Date.now() / 1000);
  try {
    await client.sendText(bot, ["vk", "ym"].includes(action) ? keyword : `/${action} ${keyword}`);
  } catch (e) {
    // Only on first failure, try to initialize the bot once per process
    if (!botReady.get(bot)) {
      try {
        await client.sendText(bot, "/start");
        botReady.set(bot, true);
        await sleep(500);
        await client.sendText(bot, ["vk", "ym"].includes(action) ? keyword : `/${action} ${keyword}`);
      } catch (e) {
        try {
          await client.sendText(bot, keyword);
        } catch (e) { logger.warn('[music_bot] send keyword to bot failed:', e) }
      }
    } else {
      try {
        await client.sendText(bot, keyword);
      } catch (e) { logger.warn('[music_bot] send keyword to bot failed:', e) }
    }
  }

  // Wait for bot's reply that contains buttons, then click first
  let replyWithButtons: Message | undefined;
  for (let i = 0; i < 15; i++) {
    await sleep(700);
    const msgs = await client.getHistory(bot, { limit: 1 });
    for (const m of msgs.slice().reverse()) {
      const mDate = m.date instanceof Date ? Math.floor(m.date.getTime() / 1000) : (m.date as number || 0);
      if (!m.isOutgoing && mDate >= startTs && (m.raw as { replyMarkup?: { _?: string } })?.replyMarkup?._ === 'replyInlineMarkup') {
        replyWithButtons = m;
        break;
      }
    }
    if (replyWithButtons) break;
  }

  if (!replyWithButtons) {
    await msg.edit({ text: `⚠️ 机器人未启用或未响应，请先打开 ${htmlEscape(bot)} 并点击 Start，然后重试。` });
    return;
  }

  let clicked = false;
  try {
    await (replyWithButtons as any).click(0);
    clicked = true;
  } catch (e) { logger.warn('[music_bot] click button failed:', e) }
  if (!clicked) {
    try {
      await (replyWithButtons as any).click(0);
      clicked = true;
    } catch (e) { logger.warn('[music_bot] click button retry 1 failed:', e) }
  }
  if (!clicked) {
    try {
      await (replyWithButtons as any).click(0);
      clicked = true;
    } catch (e) { logger.warn('[music_bot] click button retry 2 failed:', e) }
  }
  if (!clicked) {
    try {
      await client.sendText(bot, "1");
      clicked = true;
    } catch (e) { logger.warn('[music_bot] send fallback text failed:', e) }
  }

  // After clicking, wait for the next incoming message with media
  let mediaMsg: Message | undefined;
  for (let i = 0; i < 20; i++) {
    await sleep(700);
    const msgs = await client.getHistory(bot, { limit: 6 });
    for (const m of msgs.slice().reverse()) {
      const mDate = m.date instanceof Date ? Math.floor(m.date.getTime() / 1000) : (m.date as number || 0);
      const replyDate = replyWithButtons?.date instanceof Date ? Math.floor(replyWithButtons.date.getTime() / 1000) : (replyWithButtons?.date as number | undefined) ?? startTs;
      if (
        !m.isOutgoing &&
        mDate >= replyDate &&
        m.media
      ) {
        mediaMsg = m;
        break;
      }
    }
    if (mediaMsg) break;
  }

  if (!mediaMsg || !mediaMsg.media) {
    await msg.edit({ text: `❌ 未获取到音乐文件。` });
    return;
  }

  // Send the media back to the user
  // Note: mediaMsg.media is MessageMedia (high-level), but sendMedia expects InputMediaLike.
  // The cast is needed because mtcute doesn't provide a direct conversion path.
  if (action === "ym") {
    await client.sendMedia(msg.chat.id, { type: "audio", file: mediaMsg.media as any }, { replyTo: msg.replyToMessage?.id ?? undefined });
  } else {
    await client.sendMedia(msg.chat.id, { type: "audio", file: mediaMsg.media as any, caption: `🎵 ${htmlEscape(displayKeyword ?? keyword)}` }, { replyTo: msg.replyToMessage?.id ?? undefined });
  }

  try {
    await msg.delete();
  } catch (e) { logger.warn('[music_bot] delete msg failed:', e) }
}

function getRemarkFromMsg(msg: MessageContext | string, n: number): string {
  return (typeof msg === "string" ? msg : msg?.text || "")
    .replace(new RegExp(`^\\S+${Array(n).fill("\\s+\\S+").join("")}`), "")
    .trim();
}

class MusicBotPlugin extends Plugin {
  cleanup(): void {
    botReady.clear();
  }

  description: string = `<br>多音源音乐搜索<br>${help_text}`;
  cmdHandlers: Record<
    string,
    (msg: MessageContext, trigger?: MessageContext) => Promise<void>
  > = {
    music_bot: async (msg: MessageContext, trigger?: MessageContext) => {
      const text = msg.text || "";
      const parts = text.trim().split(/\s+/);
      const action = parts[1] || "";
      const keyword = getRemarkFromMsg(msg, 1);
      await searchAndSendMusic(msg, action, keyword, bots.default);
    },
    mbs: async (msg: MessageContext, trigger?: MessageContext) => {
      const action = "search";
      const keyword = getRemarkFromMsg(msg, 0);
      await searchAndSendMusic(msg, action, keyword, bots.default);
    },
    mbkw: async (msg: MessageContext, trigger?: MessageContext) => {
      const action = "kuwo";
      const keyword = getRemarkFromMsg(msg, 0);
      await searchAndSendMusic(msg, action, keyword, bots.default);
    },
    mbkg: async (msg: MessageContext, trigger?: MessageContext) => {
      const action = "kugou";
      const keyword = getRemarkFromMsg(msg, 0);
      await searchAndSendMusic(msg, action, keyword, bots.default);
    },
    mbqq: async (msg: MessageContext, trigger?: MessageContext) => {
      const action = "qq";
      const keyword = getRemarkFromMsg(msg, 0);
      await searchAndSendMusic(msg, action, keyword, bots.default);
    },
    mbne: async (msg: MessageContext, trigger?: MessageContext) => {
      const action = "netease";
      const keyword = getRemarkFromMsg(msg, 0);
      await searchAndSendMusic(msg, action, keyword, bots.default);
    },
    mbvk: async (msg: MessageContext, trigger?: MessageContext) => {
      const action = "vk";
      const keyword = getRemarkFromMsg(msg, 0);
      await searchAndSendMusic(msg, action, keyword, bots.vk);
    },
    mbym: async (msg: MessageContext, trigger?: MessageContext) => {
      const action = "ym";
      const keywordBase = getRemarkFromMsg(msg, 0);
      const keyword = keywordBase ? `${keywordBase} lyric】` : "";
      await searchAndSendMusic(msg, action, keyword, bots.ym, keywordBase);
    },
  };
}

export default new MusicBotPlugin();
