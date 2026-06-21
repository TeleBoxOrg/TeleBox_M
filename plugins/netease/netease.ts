import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { html } from "@mtcute/html-parser";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/globalClient";
import { Message } from "@mtcute/node";
import { logger } from "@utils/logger";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// 参考 plugins/music_bot.ts 的结构与实现方式

const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
  }[m] || m));

const prefixes = getPrefixes();

const mainPrefix = prefixes[0];

const bot = "Music163bot"; // 与原实现保持一致（可用 @ 或不带 @）

const pluginName = "netease";
const commandName = `${mainPrefix}${pluginName}`;

const help_text = `
依赖 @Music163bot

<code>${commandName} 关键词</code> 按关键词搜索并返回音频
<code>${commandName} 链接</code> 解析网易云链接并返回音频
<code>${commandName} ID</code> 通过歌曲ID返回音频

示例：
<code>${commandName} 晴天</code>
<code>${commandName} https://music.163.com/#/song?id=123456</code>
<code>${commandName} 123456</code>
`;

function getRemarkFromMsg(msg: MessageContext | string, n: number): string {
  return (typeof msg === "string" ? msg : msg?.text || "")
    .replace(new RegExp(`^\\S+${Array(n).fill("\\s+\\S+").join("")}`), "")
    .trim();
}

// 解析网易云链接获取ID
function extractSongId(text: string): string | null {
  const idMatch = text.match(/(?:song\?id=|\/song\/)(\d+)/);
  return idMatch ? idMatch[1] : null;
}

async function ensureBotReady(msg: MessageContext) {
  const client = await getGlobalClient();
  // 解除拉黑
  try {
    await client.call({
      _: "contacts.unblock",
      id: await client.resolvePeer(bot),
    });
  } catch (e) { logger.warn('[netease] unblock bot failed:', e) }

  // 静音通知
  try {
    const inputPeer = await client.resolvePeer(bot);
    await client.call({
      _: "account.updateNotifySettings",
      peer: { _: "inputNotifyPeer", peer: inputPeer },
      settings: {
        _: "inputPeerNotifySettings",
        silent: true,
        muteUntil: 2147483647,
      },
    });
  } catch (e) { logger.warn('[netease] mute bot failed:', e) }

  // 启动 bot（首次使用）
  try {
    await client.sendText(bot, "/start");
  } catch (e) { logger.warn('[netease] start bot failed:', e) }
}

async function fetchAndSendAudio(
  msg: MessageContext,
  commandToBot: string,
  caption: string
) {
  const client = await getGlobalClient();
  const startTs = Math.floor(Date.now() / 1000);

  // 发送命令
  try {
    await client.sendText(bot, commandToBot);
  } catch (e) {
    try {
      // 回退：有些 bot 可能只接收文本
      await client.sendText(bot, commandToBot.replace(/^\/(?:search|music)\s+/, ""));
    } catch (e) { logger.warn('[netease] send fallback text failed:', e) }
  }

  // 轮询新消息：优先寻找按钮消息，其次直接媒体消息
  let replyWithButtons: Message | undefined;
  let mediaMsg: Message | undefined;
  for (let i = 0; i < 20; i++) {
    await sleep(700);
    const msgs = await client.getHistory(bot, { limit: 6 });
    for (const m of msgs.slice().reverse()) {
      if (!m.isOutgoing && (m.date?.getTime?.() || 0) >= startTs) {
        if (!mediaMsg && m.media) mediaMsg = m;
        const btnCount = (m as { buttonCount?: number }).buttonCount || 0;
        if (!replyWithButtons && btnCount > 0) replyWithButtons = m;
      }
    }
    if (mediaMsg || replyWithButtons) break;
  }

  // 若有按钮则点击第一个按钮
  if (!mediaMsg && replyWithButtons) {
    try {
      await (replyWithButtons as any).click({});
    } catch (e) {
      await msg.edit({ text: html(`❌ 点击按钮失败：${htmlEscape((e as { message?: string })?.message || String(e))}`) });
      return;
    }

    // 点击后继续等待媒体
    for (let i = 0; i < 20; i++) {
      await sleep(700);
      const msgs = await client.getHistory(bot, { limit: 6 });
      for (const m of msgs.slice().reverse()) {
        if (
          !m.isOutgoing &&
          m.media &&
          (m.date?.getTime?.() || 0) >= (replyWithButtons?.date?.getTime?.() || startTs)
        ) {
          mediaMsg = m;
          break;
        }
      }
      if (mediaMsg) break;
    }
  }

  if (!mediaMsg || !mediaMsg.media) {
    await msg.edit({ text: "❌ 未获取到音乐文件。" });
    return;
  }

  // 以纯上传形式回传 - 下载后重新发送
  try {
    // Note: downloadAsBuffer expects FileDownloadLocation, but MessageMedia doesn't match.
    // The cast is needed because mtcute doesn't provide a direct conversion path.
    const buffer = await client.downloadAsBuffer(mediaMsg.media as any);
    const replyToId = msg.replyToMessage?.id;
    await client.sendMedia(msg.chat.id, {
      type: "audio",
      file: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
      fileName: "music.mp3",
    } as any, {
      caption,
      ...(replyToId ? { replyTo: replyToId } : {}),
    });
  } catch (e) {
    // Fallback: forward the message
    try {
      await client.forwardMessagesById({
        fromChatId: bot,
        messages: [mediaMsg.id],
        toChatId: msg.chat.id,
      });
    } catch (e) { logger.warn('[netease] forward message failed:', e) }
  }
}

class NeteasePlugin extends Plugin {

  description: string = `<br>netease<br><br>${help_text}`;
  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    netease: async (msg: MessageContext) => {
      const keyword = getRemarkFromMsg(msg, 0);

      if (!keyword) {
        await msg.edit({ text: html(help_text) });
        return;
      }

      const client = await getGlobalClient();
      if (!client) return;

      try {
        await msg.edit({
          text: html(`🔎 处理中：<code>${htmlEscape(keyword)}</code>`),
        });
      } catch (e) { logger.warn('[netease] edit msg failed:', e) }

      await ensureBotReady(msg);

      // 判定命令：ID -> /music，链接 -> 解析ID -> /music，否则 /search
      let commandToBot = `/search ${keyword}`;
      if (/^\d+$/.test(keyword.trim())) {
        commandToBot = `/music ${keyword.trim()}`;
      } else if (keyword.includes("music.163.com")) {
        const id = extractSongId(keyword);
        if (id) commandToBot = `/music ${id}`;
      }

      const caption = `🎵 ${htmlEscape(keyword)}`;
      await fetchAndSendAudio(msg, commandToBot, caption);

      try {
        await msg.delete();
      } catch (e) { logger.warn('[netease] delete msg failed:', e) }
    },
  };
}

export default new NeteasePlugin();