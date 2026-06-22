import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import type { Sticker, InputMediaDocument, InputMediaPhoto } from "@mtcute/core";
import type { MessageContext } from "@mtcute/dispatcher";
import type { TelegramClient } from "@mtcute/core/highlevel/client.js";
import { html } from "@mtcute/html-parser";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as os from "os";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// HTML转义工具
const htmlEscape = (text: string): string => 
  text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', 
    '"': '&quot;', "'": '&#x27;' 
  }[m] || m));

// 自动安装ImageMagick（静默安装，无需用户干预）
const ensureImageMagick = async (showProgress: boolean = false, msg?: MessageContext): Promise<boolean> => {
  try {
    // 检查是否已安装
    execSync('which convert', { stdio: 'ignore' });
    return true;
  } catch (error: unknown) {
    logger.info('[sticker_to_pic] ImageMagick未安装，正在自动安装...');
    
    if (showProgress && msg) {
      await msg.edit({ text: html("⚙️ 正在自动安装ImageMagick依赖...") });
    }
    
    try {
      const platform = os.platform();
      
      if (platform === 'linux') {
        // Ubuntu/Debian系统
        try {
          // 尝试使用sudo（如果可用）
          try {
            execSync('sudo -n true', { stdio: 'ignore' });
            execSync('sudo apt-get update && sudo apt-get install -y imagemagick', { stdio: 'pipe' });
          } catch (e: unknown) {
            // 无sudo权限，尝试直接安装
            execSync('apt-get update && apt-get install -y imagemagick', { stdio: 'pipe' });
          }
          logger.info('[sticker_to_pic] ImageMagick自动安装成功 (apt)');
          return true;
        } catch (aptError: unknown) {
          // 尝试yum (CentOS/RHEL)
          try {
            try {
              execSync('sudo -n true', { stdio: 'ignore' });
              execSync('sudo yum install -y ImageMagick', { stdio: 'pipe' });
            } catch (e: unknown) {
              execSync('yum install -y ImageMagick', { stdio: 'pipe' });
            }
            logger.info('[sticker_to_pic] ImageMagick自动安装成功 (yum)');
            return true;
          } catch (yumError: unknown) {
            // 尝试dnf (Fedora)
            try {
              try {
                execSync('sudo -n true', { stdio: 'ignore' });
                execSync('sudo dnf install -y ImageMagick', { stdio: 'pipe' });
              } catch (e: unknown) {
                execSync('dnf install -y ImageMagick', { stdio: 'pipe' });
              }
              logger.info('[sticker_to_pic] ImageMagick自动安装成功 (dnf)');
              return true;
            } catch (dnfError: unknown) {
              logger.error('[sticker_to_pic] Linux系统自动安装失败，可能需要手动安装');
              return false;
            }
          }
        }
      } else if (platform === 'darwin') {
        // macOS系统
        try {
          // 检查是否有Homebrew
          execSync('which brew', { stdio: 'ignore' });
          execSync('brew install imagemagick', { stdio: 'pipe' });
          logger.info('[sticker_to_pic] ImageMagick自动安装成功 (brew)');
          return true;
        } catch (brewError: unknown) {
          // 尝试安装Homebrew后再安装ImageMagick
          try {
            logger.info('[sticker_to_pic] 正在安装Homebrew...');
            execSync('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"', { stdio: 'pipe' });
            execSync('brew install imagemagick', { stdio: 'pipe' });
            logger.info('[sticker_to_pic] ImageMagick自动安装成功 (brew)');
            return true;
          } catch (e: unknown) {
            logger.error('[sticker_to_pic] macOS自动安装失败');
            return false;
          }
        }
      } else if (platform === 'win32') {
        // Windows系统 - 尝试使用chocolatey或scoop
        try {
          execSync('where choco', { stdio: 'ignore' });
          execSync('choco install imagemagick -y', { stdio: 'pipe' });
          logger.info('[sticker_to_pic] ImageMagick自动安装成功 (chocolatey)');
          return true;
        } catch (e: unknown) {
          try {
            execSync('where scoop', { stdio: 'ignore' });
            execSync('scoop install imagemagick', { stdio: 'pipe' });
            logger.info('[sticker_to_pic] ImageMagick自动安装成功 (scoop)');
            return true;
          } catch (e: unknown) {
            logger.error('[sticker_to_pic] Windows系统需要手动安装ImageMagick');
            return false;
          }
        }
      } else {
        logger.error('[sticker_to_pic] 不支持的操作系统');
        return false;
      }
    } catch (installError: unknown) {
      logger.error('[sticker_to_pic] ImageMagick自动安装出错:', installError);
      return false;
    }
  }
};

// 帮助文档
const help_text = `🖼️ <b>贴纸转图片插件</b>

<b>📝 功能描述:</b>
• 🔄 <b>格式转换</b>：将Telegram贴纸转换为JPG/PNG图片
• 🎨 <b>透明处理</b>：支持保持或移除透明背景
• 📄 <b>文档模式</b>：支持以文档形式发送原图
• ⚡ <b>自动安装</b>：自动检测并安装ImageMagick依赖

<b>🔧 使用方法:</b>
• <code>${mainPrefix}sticker_to_pic</code> - 转换为JPG（回复贴纸）
• <code>${mainPrefix}stp</code> - 快捷命令
• <code>${mainPrefix}stp png</code> - 转换为PNG格式
• <code>${mainPrefix}stp transparent</code> - PNG格式保持透明
• <code>${mainPrefix}stp doc</code> - 以文档形式发送源文件

<b>💡 示例:</b>
• <code>${mainPrefix}stp</code> - 转换为JPG图片
• <code>${mainPrefix}stp png</code> - 转换为PNG图片
• <code>${mainPrefix}stp transparent</code> - PNG透明背景
• <code>${mainPrefix}stp doc</code> - 文档模式发送

<b>🔄 管理命令:</b>

<b>📋 支持格式:</b>
• 输入：WebP贴纸文件
• 输出：JPG（默认）、PNG
• 透明：仅PNG格式支持

<b>⚙️ 系统要求:</b>
• ImageMagick（自动安装）
• 支持Linux/macOS自动安装`;

class StickerToPicPlugin extends Plugin {

  description: string = help_text;
  
  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    "sticker_to_pic": this.handleStickerToPic.bind(this),
    "stp": this.handleStickerToPic.bind(this),
  };

  private async handleStickerToPic(msg: MessageContext): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: html("❌ 客户端未初始化") });
      return;
    }

    // 参数解析（严格按acron.ts模式）
    const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
    const parts = lines?.[0]?.split(/\s+/) || [];
    const [, ...args] = parts; // 跳过命令本身
    const sub = (args[0] || "").toLowerCase();

    try {
      // 无参数时处理贴纸转换
      if (!sub) {
        await this.processStickerConversion(msg, client, 'jpg', false, false);
        return;
      }

      // 明确请求帮助时才显示
      if (sub === "help" || sub === "h") {
        await msg.edit({
          text: html(help_text)
        });
        return;
      }

      // 隐藏的检查命令（不在帮助文档中显示）
      if (sub === "check") {
        await msg.edit({ text: html("🔍 正在检查ImageMagick状态...") });
        
        // 首先检查是否已安装
        try {
          execSync('which convert', { stdio: 'ignore' });
          // 已安装，获取版本信息
          try {
            const version = execSync('convert -version', { encoding: 'utf8' });
            const versionLine = version.split('\n')[0];
            await msg.edit({
              text: html(`✅ <b>ImageMagick状态正常</b><br><br><b>版本信息:</b><br><code>${htmlEscape(versionLine)}</code><br><br>🎯 <b>功能状态:</b> 可正常使用贴纸转换功能`)
            });
          } catch (error: unknown) {
            await msg.edit({
              text: html("✅ <b>ImageMagick已安装</b><br><br>⚠️ 无法获取版本信息，但可正常使用")
            });
          }
        } catch (error: unknown) {
          // 未安装，尝试自动安装
          await msg.edit({ text: html("❌ <b>ImageMagick未安装</b><br><br>🔄 正在自动安装，请稍候...") });
          
          const isInstalled = await ensureImageMagick(true, msg);
          if (isInstalled) {
            try {
              const version = execSync('convert -version', { encoding: 'utf8' });
              const versionLine = version.split('\n')[0];
              await msg.edit({
                text: html(`🎉 <b>ImageMagick自动安装成功！</b><br><br><b>版本信息:</b><br><code>${htmlEscape(versionLine)}</code><br><br>✅ <b>状态:</b> 现在可以正常使用贴纸转换功能`)
              });
            } catch (versionError: unknown) {
              await msg.edit({
                text: html("🎉 <b>ImageMagick自动安装成功！</b><br><br>✅ <b>状态:</b> 现在可以正常使用贴纸转换功能")
              });
            }
          } else {
            const platform = os.platform();
            let installCmd = '';
            let platformName = '';
            
            if (platform === 'linux') {
              installCmd = 'sudo apt install imagemagick';
              platformName = 'Linux';
            } else if (platform === 'darwin') {
              installCmd = 'brew install imagemagick';
              platformName = 'macOS';
            } else if (platform === 'win32') {
              installCmd = '请访问 https://imagemagick.org/script/download.php#windows';
              platformName = 'Windows';
            } else {
              installCmd = '请查阅官方文档安装ImageMagick';
              platformName = '未知系统';
            }
            
            await msg.edit({
              text: html(`❌ <b>ImageMagick自动安装失败</b><br><br><b>检测到系统:</b> ${platformName}<br><b>手动安装命令:</b><br><code>${htmlEscape(installCmd)}</code>`)
            });
          }
        }
        return;
      }

      // 解析转换参数
      let outputFormat = 'jpg';
      let keepTransparency = false;
      let sendAsDocument = false;

      if (sub === 'png') {
        outputFormat = 'png';
        keepTransparency = args.includes('transparent');
      } else if (sub === 'transparent') {
        outputFormat = 'png';
        keepTransparency = true;
      } else if (sub === 'doc') {
        sendAsDocument = true;
        if (args.includes('png')) {
          outputFormat = 'png';
          keepTransparency = args.includes('transparent');
        }
      } else {
        // 未知子命令，提示错误
        await msg.edit({
          text: html(`❌ <b>未知子命令:</b> <code>${htmlEscape(sub)}</code><br><br>请使用 <code>${mainPrefix}stp help</code> 查看可用选项`)
        });
        return;
      }

      await this.processStickerConversion(msg, client, outputFormat, keepTransparency, sendAsDocument);

    } catch (error: unknown) {
      logger.error("[sticker_to_pic] 插件执行失败:", error);
      await msg.edit({
        text: html(`❌ <b>插件执行失败:</b> ${htmlEscape(getErrorMessage(error))}`)
      });
    }
  }

  private async processStickerConversion(
    msg: MessageContext,
    client: TelegramClient, 
    outputFormat: string, 
    keepTransparency: boolean, 
    sendAsDocument: boolean
  ): Promise<void> {
    try {
      const reply = await safeGetReplyMessage(msg);
      const targetMsg = reply || msg;

      const media = targetMsg.media;
      if (!media || media.type !== 'sticker') {
        await msg.edit({
          text: html("❌ <b>请回复一个贴纸消息</b>")
        });
        return;
      }

      const sticker = media as Sticker;

      await msg.edit({
        text: html("📥 正在下载贴纸...")
      });

      const tempDir = path.join(process.cwd(), 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const timestamp = Date.now();
      const stickerPath = path.join(tempDir, `sticker_${timestamp}.webp`);
      const outputPath = path.join(tempDir, `pic_${timestamp}.${outputFormat}`);

      try {
        await client.downloadToFile(stickerPath, sticker);

        if (!fs.existsSync(stickerPath)) {
          await msg.edit({
            text: html("❌ <b>贴纸下载失败</b>")
          });
          return;
        }

        await msg.edit({
          text: html(`🔄 正在转换为${outputFormat.toUpperCase()}格式...`)
        });

        // 静默检查并自动安装ImageMagick
        const isImageMagickReady = await ensureImageMagick(false);
        if (!isImageMagickReady) {
          // 如果静默安装失败，显示进度并重试
          await msg.edit({
            text: html("⚙️ 正在自动安装ImageMagick依赖，请稍候...")
          });
          
          const retryInstall = await ensureImageMagick(true, msg);
          if (!retryInstall) {
            const platform = os.platform();
            let installCmd = '';
            
            if (platform === 'linux') {
              installCmd = 'sudo apt install imagemagick';
            } else if (platform === 'darwin') {
              installCmd = 'brew install imagemagick';
            } else if (platform === 'win32') {
              installCmd = '请访问 https://imagemagick.org/script/download.php#windows';
            }
            
            await msg.edit({
              text: html(`❌ <b>ImageMagick自动安装失败</b><br><br><b>请手动安装:</b><br><code>${htmlEscape(installCmd)}</code>`)
            });
            return;
          }
          
          // 安装成功，继续转换
          await msg.edit({
            text: html(`🔄 正在转换为${outputFormat.toUpperCase()}格式...`)
          });
        }


        try {
          let convertCmd: string;
          
          if (outputFormat === 'png') {
            if (keepTransparency) {
              convertCmd = `convert "${stickerPath}" "${outputPath}"`;
            } else {
              convertCmd = `convert "${stickerPath}" -background white -alpha remove "${outputPath}"`;
            }
          } else {
            convertCmd = `convert "${stickerPath}" -background white -alpha remove -alpha off "${outputPath}"`;
          }
          
          execSync(convertCmd, { stdio: 'ignore' });
          
          if (!fs.existsSync(outputPath)) {
            throw new Error('转换失败：输出文件未生成');
          }
          
        } catch (convertError: unknown) {
          logger.error('[sticker_to_pic] ImageMagick转换失败:', convertError);
          await msg.edit({
            text: html(`❌ <b>贴纸转换失败</b><br><br><b>错误详情:</b> ${htmlEscape(getErrorMessage(convertError))}<br><br>💡 请确保贴纸格式正确`)
          });
          return;
        }

        await msg.edit({
          text: html("📤 正在发送图片...")
        });

        if (sendAsDocument) {
          // 发送为文档（原图）
          const docMedia: InputMediaDocument = {
            type: "document",
            file: outputPath,
            caption: html(`📄 <b>贴纸已转换为${outputFormat.toUpperCase()}格式（原图）</b>`)
          };
          await client.sendMedia(msg.chat.id, docMedia, {
            replyTo: msg.id
          });
        } else {
          // 发送为图片
          const photoMedia: InputMediaPhoto = {
            type: "photo",
            file: outputPath,
            caption: html(`🖼️ <b>贴纸已转换为${outputFormat.toUpperCase()}格式</b>${keepTransparency ? '（透明背景）' : ''}`)
          };
          await client.sendMedia(msg.chat.id, photoMedia, {
            replyTo: msg.id
          });
        }

        await msg.delete();
        
      } finally {
        try {
          if (fs.existsSync(stickerPath)) {
            fs.unlinkSync(stickerPath);
          }
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
          }
        } catch (cleanupError: unknown) {
          logger.error('[sticker_to_pic] 清理临时文件失败:', cleanupError);
        }
      }
    } catch (error: unknown) {
      logger.error("[sticker_to_pic] 处理贴纸转换失败:", error);
      
      let errorMsg = "❌ <b>转换贴纸为图片时出现错误</b>";
      
      if (getErrorMessage(error).includes('MEDIA_INVALID')) {
        errorMsg = "❌ <b>无效的媒体文件</b>";
      } else if (getErrorMessage(error).includes('FILE_PARTS_INVALID')) {
        errorMsg = "❌ <b>文件损坏或格式不支持</b>";
      } else if (getErrorMessage(error).includes('DOCUMENT_INVALID')) {
        errorMsg = "❌ <b>无效的文档文件</b>";
      } else {
        errorMsg += `<br><br><b>错误详情:</b> ${htmlEscape(getErrorMessage(error))}`;
      }
      
      await msg.edit({
        text: html(errorMsg)
      });
    }
  };
}

export default new StickerToPicPlugin();
