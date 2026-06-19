import axios from "axios";
// 不再需要 form-data 依赖，Axios 会自动序列化对象为 FormData
import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { html } from "@mtcute/html-parser";
import { getGlobalClient, tryGetCurrentGenerationContext } from "@utils/globalClient";
import { Buffer } from "buffer";
import { safeGetReplyMessage } from "@utils/safeGetMessages";

// HTML转义
const htmlEscape = (text: string): string =>
  text.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#x27;'
  }[m] || m));

// 消息分割与发送（接受原始HTML字符串，内部用html模板标签解析）
const MAX_MESSAGE_LENGTH = 4096;
function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];
  const parts: string[] = [];
  let currentPart = "";
  const lines = text.split("\n");
  for (const line of lines) {
    if (currentPart.length + line.length + 1 > MAX_MESSAGE_LENGTH) {
      parts.push(currentPart);
      currentPart = line;
    } else {
      currentPart += (currentPart ? "\n" : "") + line;
    }
  }
  if (currentPart) parts.push(currentPart);
  return parts;
}
async function sendLongHtml(msg: MessageContext, rawHtml: string) {
  const parts = splitMessage(rawHtml);
  if (parts.length === 1) {
    await msg.edit({ text: html(parts[0]) });
  } else {
    await msg.edit({ text: html(parts[0] + "\n\n📄 (1/" + parts.length + ")") });
    for (let i = 1; i < parts.length; i++) {
      await msg.replyText(html(parts[i] + "\n\n📄 (" + (i + 1) + "/" + parts.length + ")"));
    }
  }
}

const timeout = 60000;
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const pluginName = "0x0";
const commandName = `${mainPrefix}${pluginName}`;

const help_text = `🗂️ <b>0x0.st 文件上传插件</b>\n\n<b>命令格式：</b>\n<code>${commandName} [expires=小时] [secret]</code>\n\n<b>用法：</b>\n• 回复一条带文件/视频/语音的消息，自动上传到 <a href='https://0x0.st/'>0x0.st</a> 并返回下载链接\n• <code>${commandName} expires=72 secret</code> 设置72小时有效期并启用难猜链接\n• <code>${commandName} help</code> 显示帮助\n\n<b>参数说明：</b>\n• <code>expires=xx</code> 设置有效期（小时）\n• <code>secret</code> 生成更难猜的链接\n`;

class Ox0Plugin extends Plugin {

  description: string = `文件上传到 0x0.st\n\n${help_text}`;
  cmdHandlers: Record<string, (msg: MessageContext, trigger?: MessageContext) => Promise<void>> = {
    "0x0": async (msg: MessageContext) => {
      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts;
      const sub = (args[0] || "").toLowerCase();

      // 仅当明确输入 help/h 时显示帮助
      if (sub === "help" || sub === "h") {
        await sendLongHtml(msg, help_text);
        return;
      }
      if (args[1] && (args[1].toLowerCase() === "help" || args[1].toLowerCase() === "h")) {
        await sendLongHtml(msg, help_text);
        return;
      }

      let expires: string | undefined;
      let secret = false;
      for (const arg of args) {
        if (/^expires=\d+$/.test(arg)) {
          expires = arg.split("=")[1];
        } else if (arg === "secret") {
          secret = true;
        }
      }

      let replied: Awaited<ReturnType<typeof safeGetReplyMessage>>;
      try {
        replied = await safeGetReplyMessage(msg);
      } catch (e: any) {
        await sendLongHtml(msg, `❌ <b>错误:</b> ${htmlEscape(e.message)}`);
        return;
      }
      if (!replied || !replied.media) {
        await sendLongHtml(msg, `❌ <b>错误:</b> 请回复一条带文件、视频、语音、图片等消息`);
        return;
      }

      await msg.edit({ text: "⏳ 正在下载并上传..." });
      try {
        const client = await getGlobalClient();
        const downloaded = await client.downloadAsBuffer(replied.media as unknown as Parameters<typeof client.downloadAsBuffer>[0]);
        const buffer = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded);
        if (buffer.length === 0) {
          await sendLongHtml(msg, `❌ <b>错误:</b> 媒体下载失败或为空`);
          return;
        }

        // 文件名只保留英文、数字、下划线和扩展名，最长32位
        let filename = "file";
        const media = replied.media as unknown as { type?: string; fileName?: string };
        if (media?.type === 'document' && media.fileName) {
          filename = media.fileName;
        } else if (replied.text) {
          filename = replied.text.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 32) || filename;
        } else if (media?.type === 'video') {
          filename = "video.mp4";
        } else if (media?.type === 'audio') {
          filename = "audio.ogg";
        } else if (media?.type === 'voice') {
          filename = "voice.ogg";
        } else if (media?.type === 'photo') {
          // 自动识别图片类型
          const head = buffer.slice(0, 8).toString('hex').toLowerCase();
          if (head.startsWith('ffd8ff')) {
            filename = "photo.jpg";
          } else if (head.startsWith('89504e47')) {
            filename = "photo.png";
          } else if (head.startsWith('47494638')) {
            filename = "photo.gif";
          } else if (head.startsWith('52494646')) {
            filename = "photo.webp";
          } else {
            filename = "photo.bin";
          }
        }
        if (!filename || filename.length < 3) filename = "file";

        // 使用 Node.js 原生 FormData（无需 form-data 依赖）
        const form = new globalThis.FormData();
        form.append("file", new Blob([new Uint8Array(buffer)], { type: "application/octet-stream" }), filename);
        if (expires) form.append("expires", expires);
        if (secret) form.append("secret", "1");
        const headers = { 'User-Agent': 'curl/8.0.1' };

        try {
          const response = await axios.post("https://0x0.st", form, {
            headers,
            timeout,
          });
          const url = response.data?.toString().trim();
          if (!url || !url.startsWith("https://0x0.st/")) {
            await sendLongHtml(msg, `❌ <b>错误:</b> 上传失败或未获取到链接`);
            return;
          }
          await sendLongHtml(msg, `<code>${htmlEscape(url)}</code>`);
        } catch (err: any) {
          await sendLongHtml(msg, `❌ <b>错误:</b> 上传失败 — ${htmlEscape(err?.message || String(err))}`);
        }
      } catch (error: any) {
        if (error.message?.includes("FLOOD_WAIT")) {
          const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
          const lifecycle = tryGetCurrentGenerationContext();
          if (lifecycle) {
            await lifecycle.delay((waitTime + 1) * 1000, { label: "oxost:flood-wait" });
          } else {
            await new Promise(res => setTimeout(res, (waitTime + 1) * 1000));
          }
        }
        await sendLongHtml(msg, `❌ <b>错误:</b> ${htmlEscape(error.message)}`);
      }
    },
  };
}

export default new Ox0Plugin();