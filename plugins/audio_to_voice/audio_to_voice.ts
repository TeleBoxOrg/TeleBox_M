import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import type { MessageContext } from "@mtcute/dispatcher";
import type { Audio, Document, InputMediaVoice } from "@mtcute/core";
import fs from "fs";
import path from "path";
import { createDirectoryInTemp } from "@utils/pathHelpers";
import { exec } from "child_process";
import { promisify } from "util";
import { safeGetMessages } from "@utils/safeGetMessages";
import { logger } from "@utils/logger";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const execAsync = promisify(exec);


class AudioToVoicePlugin extends Plugin {

  description: string = `🎙️ <b>音频转语音</b><br/><br/>
<b>命令</b><br/>
• <code>${mainPrefix}audio_to_voice</code>（回复一条包含音乐的消息）<br/><br/>
<b>功能</b><br/>
• 将音乐文件转换为 Telegram 语音消息（OGG/Opus）<br/><br/>
<b>用法</b><br/>
1) 回复音乐文件发送 <code>${mainPrefix}audio_to_voice</code><br/><br/>
<b>依赖</b><br/>
• 需要系统安装 FFmpeg`;
  
  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    "audio_to_voice": this.handleAudioToVoice.bind(this),
  };

  private hasAudio(msg: MessageContext): boolean {
    if (!msg.media) return false;

    // Check if media is an Audio document (not a voice note)
    const media = msg.media;
    if (media.type === 'audio') {
      return true;
    }
    // Also accept documents with audio mime type
    if (media.type === 'document') {
      const doc = media as Document;
      return doc.mimeType?.startsWith('audio/') ?? false;
    }
    return false;
  }

  private getAudioDuration(msg: MessageContext): number {
    const media = msg.media;
    if (!media) return 0;

    if (media.type === 'audio') {
      return (media as Audio).duration;
    }
    if (media.type === 'document') {
      // Document doesn't expose duration directly; return 0 as fallback
      return 0;
    }
    return 0;
  }

  private async handleAudioToVoice(msg: MessageContext): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ 客户端未初始化" });
      return;
    }

    try {
      // Check if the message itself has audio or if replying to one
      let audioMsg: MessageContext | null = null;
      let isReplyAudio = false;
      
      if (msg.replyToMessage) {
        const replyMessages = await safeGetMessages(client, msg.chat.id, {
          ids: [msg.replyToMessage.id!],
        });
        if (replyMessages && replyMessages.length > 0) {
          const replyMsg = replyMessages[0];
          // Check if the reply message has audio (using high-level type)
          if (replyMsg.media && (replyMsg.media.type === 'audio' || replyMsg.media.type === 'document')) {
            const replyMedia = replyMsg.media;
            if (replyMedia.type === 'audio' || 
                (replyMedia.type === 'document' && (replyMedia as Document).mimeType?.startsWith('audio/'))) {
              isReplyAudio = true;
            }
          }
        }
      }

      if (!isReplyAudio && !this.hasAudio(msg)) {
        await msg.edit({ text: "请回复一个音乐文件" });
        return;
      }

      audioMsg = msg;

      await msg.edit({ text: "转换中。。。" });

      // 先检测 ffmpeg 是否可用
      try {
        await execAsync(`ffmpeg -version`);
      } catch (e) {
        await msg.edit({ text: "❌ 未检测到 ffmpeg，请先在系统安装 ffmpeg 后重试。macOS 可使用：brew install ffmpeg" });
        return;
      }

      const tempDir = createDirectoryInTemp("audio_to_voice");
      // 原始下载路径（无扩展名）
      const audioPath = path.join(tempDir, `audio_${Date.now()}`);
      const oggPath = path.join(tempDir, `voice_${Date.now()}.ogg`);

      try {
        // 下载音频文件
        const media = audioMsg.media!;
        // Audio/Document extend RawDocument which extends FileLocation, compatible with downloadAsBuffer
        const buffer = await client.downloadAsBuffer(media as unknown as import("@mtcute/core").FileLocation);
        fs.writeFileSync(audioPath, buffer as Buffer);

        // 使用 FFmpeg 转码为 OGG/Opus（Telegram 语音格式）
        // 48k-64k 比特率，48k 采样率，单声道
        const cmd = `ffmpeg -y -i "${audioPath}" -vn -acodec libopus -b:a 64k -ar 48000 -ac 1 "${oggPath}"`;
        try {
          await execAsync(cmd, { timeout: 180000 });
        } catch (e) {
          throw new Error(`FFmpeg 转码失败，请确认系统已安装 FFmpeg（macOS: brew install ffmpeg）。`);
        }

        if (!fs.existsSync(oggPath)) {
          throw new Error("转码后的语音文件未找到");
        }

        const duration = this.getAudioDuration(audioMsg);
        
        // 确定回复目标
        const replyToId: number | undefined = isReplyAudio ? (msg.replyToMessage?.id ?? undefined) : undefined;
        
        // 发送语音笔记
        const voiceMedia: InputMediaVoice = {
          type: "voice",
          file: oggPath,
          duration: duration || undefined,
        };
        await client.sendMedia(msg.chat.id, voiceMedia, {
          replyTo: replyToId,
        });

        // 清理临时文件
        this.safeRemove(audioPath);
        this.safeRemove(oggPath);
        
        // 清理状态消息
        if (isReplyAudio) {
          // 如果是回复的音频，删除状态消息
          try {
            await msg.delete();
          } catch (deleteError) {
            logger.warn("删除状态消息失败:", deleteError);
          }
        } else {
          // 如果是消息本身的音频，清空消息内容
          try {
            await msg.edit({ text: "" });
          } catch (editError) {
            logger.warn("清空消息失败:", editError);
          }
        }
        
      } catch (error) {
        this.safeRemove(audioPath);
        this.safeRemove(oggPath);
        await msg.edit({ text: `转换为语音消息失败：${error}` });
      }
      
    } catch (error) {
      logger.error("AudioToVoice plugin error:", error);
      await msg.edit({ text: `转换为语音消息失败：${error}` });
    }
  }

  private safeRemove(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      logger.warn(`删除文件失败 ${filePath}:`, error);
    }
  }
}

export default new AudioToVoicePlugin();