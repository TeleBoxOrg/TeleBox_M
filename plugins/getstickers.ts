import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import type { MessageContext } from "@mtcute/dispatcher";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import archiver from "archiver";
import { exec } from "child_process";
import { getPrefixes } from "@utils/pluginManager";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";

interface StickerAttribute {
  _?: string;
  video?: boolean;
  animated?: boolean;
  stickerset?: StickerSetRef;
}

interface StickerSetRef {
  _?: string;
  shortName?: string;
  short_name?: string;
  id?: string | number | bigint;
  accessHash?: string | number | bigint;
  access_hash?: string | number | bigint;
}

interface StickerDocument {
  _?: string;
  id?: string | number | bigint;
  accessHash?: string | number | bigint;
  access_hash?: string | number | bigint;
  attributes?: StickerAttribute[];
  mimeType?: string;
  mime_type?: string;
}

interface RawMediaMessage {
  _?: string;
  media?: {
    _?: string;
    document?: StickerDocument;
  };
}

interface MessageLike {
  sticker?: StickerDocument;
  document?: StickerDocument;
  media?: { caption?: string } | null;
  raw?: RawMediaMessage;
  replyToMessage?: { id: number };
}

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];


const execAsync = promisify(exec);


class GetStickersPlugin extends Plugin {

  description: string = `🧩 <b>贴纸包打包下载</b><br/><br/>
<b>命令</b><br/>
• <code>${mainPrefix}getstickers</code>（回复任意贴纸）<br/><br/>
<b>功能</b><br/>
• 从回复的贴纸中识别贴纸包并下载全部贴纸<br/>
• 使用 FFmpeg 自动转换所有格式为 gif（方便微信使用）<br/>
• 支持 webp、tgs、mp4 格式转换<br/>
• 自动生成 pack.txt 与全部资源，并以 ZIP 发送<br/><br/>
<b>用法</b><br/>
1) 回复一张贴纸并发送 <code>${mainPrefix}getstickers</code><br/><br/>
<b>依赖安装</b><br/>
• <b>FFmpeg</b>（必需）:<br/>
  - Windows: <code>choco install ffmpeg</code><br/>
  - macOS: <code>brew install ffmpeg</code><br/>
  - Linux: <code>sudo apt install ffmpeg</code><br/>
• <b>lottie</b>（tgs转换需要）:<br/>
  - <code>pip install lottie[all]</code><br/><br/>
<b>注意</b><br/>
• 若贴纸包很大，处理时间较长，请耐心等待`;
  
  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    "getstickers": this.handleGetStickers.bind(this),
  };

  private async handleGetStickers(msg: MessageContext): Promise<void> {
    const client = await getGlobalClient();
    
    if (!client) {
      await msg.edit({
        text: "❌ 客户端未初始化"
      });
      return;
    }
    
    try {
      await msg.edit({
        text: "⚙️ 检查工具依赖..."
      });
      
      const tools = await this.checkAndInstallTools();
      
      if (!tools.ffmpeg) {
        await msg.edit({
          text: "❌ 未检测到 FFmpeg，请先安装:\n• Windows: choco install ffmpeg\n• macOS: brew install ffmpeg\n• Linux: sudo apt install ffmpeg"
        });
        return;
      }
      
      if (!tools.lottie) {
        logger.info('lottie 未安装，tgs格式将无法转换');
      }

      const dataDir = path.join(process.cwd(), 'data', 'sticker');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      
      let sticker: any = null;
      

      const replyMsg = await safeGetReplyMessage(msg);
      if (replyMsg) {
        try {
          const replyLike = replyMsg as MessageLike;
          if (replyLike.sticker) {
            sticker = replyLike.sticker;
          } else if (replyLike.document && replyLike.document.mimeType?.includes('sticker')) {
            sticker = replyLike.document;
          } else if (replyLike.raw) {
            // Try raw media for sticker/document
            const raw = replyLike.raw;
            if (raw?.media?._ === 'messageMediaDocument' && raw.media.document?._ === 'document') {
              const doc = raw.media.document;
              const isSticker = doc.attributes?.some(
                (a: StickerAttribute) => a._ === 'documentAttributeSticker'
              );
              if (isSticker || doc.mime_type?.includes('sticker')) {
                sticker = doc;
              }
            }
          }
        } catch (error: unknown) {
          logger.error('Failed to get reply message:', error);
        }
      }
      
      if (!sticker) {
        // Check if current message has a sticker
        const msgLike = msg as MessageLike;
        if (msgLike.sticker) {
          sticker = msgLike.sticker;
        } else if (msgLike.document && msgLike.document.mimeType?.includes('sticker')) {
          sticker = msgLike.document;
        } else if (msgLike.raw) {
          const raw = msgLike.raw;
          if (raw?.media?._ === 'messageMediaDocument' && raw.media.document?._ === 'document') {
            const doc = raw.media.document;
            const isSticker = doc.attributes?.some(
              (a: StickerAttribute) => a._ === 'documentAttributeSticker'
            );
            if (isSticker || doc.mime_type?.includes('sticker')) {
              sticker = doc;
            }
          }
        }
      }
      
      if (!sticker) {
        await msg.edit({
          text: "请回复一张贴纸。"
        });
        return;
      }
      

      const stickerSetName = this.getStickerSetName(sticker);
      if (!stickerSetName) {
        await msg.edit({
          text: "回复的贴纸不属于任何贴纸包。"
        });
        return;
      }
      
      await this.downloadStickers(client, msg, stickerSetName);
      
    } catch (error: unknown) {
      logger.error("GetStickers plugin error:", error);
      
      await msg.edit({
        text: "❌ 处理贴纸时出现错误"
      });
    }
  }
  
  private getStickerSetName(sticker: StickerDocument | null): string | null {
    if (sticker?.attributes) {
      for (const attr of sticker.attributes) {
        if (attr._ === 'documentAttributeSticker' && attr.stickerset) {
          const ss = attr.stickerset;
          logger.info('贴纸包类型:', ss._ || typeof ss);
          
          // 优先使用shortName，这与Python版本一致
          if (ss._ === 'inputStickerSetShortName') {
            logger.info('找到贴纸包名称:', ss.shortName);
            return ss.shortName ?? null;
          } else if (ss._ === 'inputStickerSetEmpty') {
            logger.info('空贴纸包，跳过');
            continue;
          } else if (ss && typeof ss === 'object') {
            // 处理VirtualClass和其他类型的贴纸包
            
            // 尝试多种属性名称来获取贴纸包名称
            if (ss.shortName && typeof ss.shortName === 'string') {
              logger.info('从对象提取贴纸包名称 (shortName):', ss.shortName);
              return ss.shortName;
            }
            
            // 对于VirtualClass类型，尝试其他可能的属性
            if (ss.short_name && typeof ss.short_name === 'string') {
              logger.info('从对象提取贴纸包名称 (short_name):', ss.short_name);
              return ss.short_name;
            }
            
            // 如果有id/access_hash属性，尝试通过id+access_hash获取贴纸包信息
            const toPlainString = (v: unknown): string | null => {
              if (v === undefined || v === null) return null;
              if (typeof v === 'string') return v;
              if (typeof v === 'number') return String(v);
              if (typeof v === 'bigint') return v.toString();
              try {
                // 常见: { value: 123n }
                const valObj = v as { value?: unknown };
                if (typeof valObj.value !== 'undefined') {
                  const val = valObj.value;
                  if (typeof val === 'bigint') return val.toString();
                  if (typeof val === 'number' || typeof val === 'string') return String(val);
                }
                const s = (v as { toString?: () => string }).toString?.();
                if (s && !s.includes('[object')) return s;
              } catch (e: unknown) { logger.warn('操作失败', e) }
              return String(v);
            };
            const idVal = toPlainString(ss.id) || toPlainString((ss as { _id?: unknown })._id);
            const hashVal = toPlainString(ss.accessHash) || toPlainString(ss.access_hash);
            if (idVal && hashVal) {
              logger.info('找到贴纸包ID与access_hash，将尝试通过ID查询:', idVal, hashVal);
              return `__ID__${idVal}__HASH__${hashVal}`;
            }
            if (idVal) {
              logger.info('找到贴纸包ID（缺少access_hash）:', idVal);
              return `__ID__${idVal}`;
            }
            
            logger.info('VirtualClass贴纸包对象属性:', Object.keys(ss));
          }
        }
      }
    }
    logger.info('未找到贴纸包信息');
    return null;
  }
  
  private async downloadStickers(client: any, msg: MessageContext, stickerSetName: string): Promise<void> {
    let packDir: string | undefined;
    try {
      if (!stickerSetName || stickerSetName.trim() === '') {
        await msg.edit({
          text: "❌ 贴纸包名称无效"
        });
        return;
      }
      
      let stickerSetInput: any;
      
      // 检查是否是ID查询
      if (stickerSetName.startsWith('__ID__')) {
        // 支持两种格式: __ID__<id> 或 __ID__<id>__HASH__<access_hash>
        const match = stickerSetName.match(/^__ID__(.+?)(?:__HASH__(.+))?$/);
        const idStr = match?.[1]?.trim();
        const hashStr = match?.[2]?.trim();
        if (!idStr || !hashStr) {
          logger.warn('ID查询缺少access_hash，无法通过ID获取贴纸包，建议通过shortName查询');
          await msg.edit({ text: '❌ 贴纸包信息不足（缺少 access_hash），无法通过ID查询。请回复来源贴纸或尝试使用短名称。' });
          return;
        }
        logger.info('使用ID查询贴纸包:', idStr, 'access_hash:', hashStr);
        stickerSetInput = {
          _: 'inputStickerSetID',
          id: BigInt(idStr),
          accessHash: BigInt(hashStr)
        };
      } else {
        // 使用shortName查询，与Python版本保持一致
        logger.info('使用短名称查询贴纸包:', stickerSetName.trim());
        stickerSetInput = {
          _: 'inputStickerSetShortName',
          shortName: stickerSetName.trim()
        };
      }
      
      const stickerSet = await client.call({
        _: 'messages.getStickerSet',
        stickerset: stickerSetInput,
        hash: 0
      });
      
      if (!stickerSet || !stickerSet.documents) {
        await msg.edit({
          text: "回复的贴纸不存在于任何贴纸包中。"
        });
        return;
      }
      
      const setInfo = stickerSet.set;
      const documents = stickerSet.documents;
      packDir = path.join(process.cwd(), 'data', 'sticker', setInfo.short_name || setInfo.shortName);
      
      // 创建贴纸包目录
      if (fs.existsSync(packDir)) {
        fs.rmSync(packDir, { recursive: true, force: true });
      }
      fs.mkdirSync(packDir, { recursive: true });
      
      const setShortName = setInfo.short_name || setInfo.shortName;
      const setCount = setInfo.count || documents.length;
      await msg.edit({
        text: `正在下载 ${setShortName} 中的 ${setCount} 张贴纸...\n进度：0/${setCount}`
      });
      
      // 构建表情映射
      const emojis: Record<string, string> = {};
      if (stickerSet.packs) {
        for (const pack of stickerSet.packs) {
          for (const docId of pack.documents) {
            emojis[docId.toString()] = pack.emoticon || '';
          }
        }
      }
      
      // 下载所有贴纸（顺序执行以便稳定更新进度）
      const packFile = path.join(packDir, 'pack.txt');
      if (fs.existsSync(packFile)) {
        fs.unlinkSync(packFile);
      }

      const total = documents.length;
      let downloaded = 0;

      for (let index = 0; index < documents.length; index++) {
        const document: any = documents[index];
        try {
          // 确定文件扩展名
          let fileExt = 'webp';
          if (document.attributes) {
            for (const attr of document.attributes) {
              if (attr._ === 'documentAttributeSticker') {
                if (attr.video) {
                  fileExt = 'mp4';
                } else if (attr.animated) {
                  fileExt = 'tgs';
                }
                break;
              }
            }
          }
          
          const fileName = `${index.toString().padStart(3, '0')}.${fileExt}`;
          const filePath = path.join(packDir, fileName);
          
          // 下载贴纸文件
          const buffer = await client.downloadAsBuffer(document);
          fs.writeFileSync(filePath, Buffer.from(buffer));
          
          let finalFileName = fileName;
          if (fileExt === 'webp') {
            try {
              const gifFileName = `${index.toString().padStart(3, '0')}.gif`;
              const gifPath = path.join(packDir, gifFileName);
              await this.convertWebpToGif(filePath, gifPath);
              fs.unlinkSync(filePath);
              finalFileName = gifFileName;
            } catch (convertError: unknown) {
              logger.error(`转换webp失败，保留原格式:`, convertError);
            }
          } else if (fileExt === 'tgs') {
            try {
              const gifFileName = `${index.toString().padStart(3, '0')}.gif`;
              const gifPath = path.join(packDir, gifFileName);
              await this.convertTgsToGif(filePath, gifPath);
              fs.unlinkSync(filePath);
              finalFileName = gifFileName;
            } catch (convertError: unknown) {
              logger.error(`转换tgs失败，保留原格式:`, convertError);
            }
          } else if (fileExt === 'mp4') {
            try {
              const gifFileName = `${index.toString().padStart(3, '0')}.gif`;
              const gifPath = path.join(packDir, gifFileName);
              await this.convertMp4ToGif(filePath, gifPath);
              fs.unlinkSync(filePath);
              finalFileName = gifFileName;
            } catch (convertError: unknown) {
              logger.error(`转换mp4失败，保留原格式:`, convertError);
            }
          }
          
          const emoji = emojis[document.id.toString()] || '';
          const packEntry = `{'image_file': '${finalFileName}','emojis':${emoji}},\n`;
          fs.appendFileSync(packFile, packEntry);

          downloaded++;
          if (downloaded === 1 || downloaded % 10 === 0 || downloaded === total) {
            await msg.edit({ text: `正在下载 ${setShortName} 中的 ${setCount} 张贴纸...\n进度：${downloaded}/${total}` });
          }
          
        } catch (error: unknown) {
          logger.error(`下载贴纸 ${index} 失败:`, error);
        }
      }
      
      // 打包上传
      await this.uploadStickerPack(client, msg, setInfo, packDir);
      
    } catch (error: unknown) {
      logger.error('下载贴纸包失败:', error);

      // Clean up temporary sticker directory on failure to avoid disk leaks
      if (packDir) {
        try {
          if (fs.existsSync(packDir)) {
            fs.rmSync(packDir, { recursive: true, force: true });
          }
        } catch (cleanupErr: unknown) {
          logger.error('清理贴纸临时目录失败:', cleanupErr);
        }
      }

      let errorMessage = "❌ 下载贴纸包时出现错误";
      const errObj = error as Record<string, unknown>;
      const innerMsg = errObj.errorMessage as string | undefined;

      if (innerMsg) {
        switch (innerMsg) {
          case 'STICKERSET_INVALID':
            errorMessage = `❌ 贴纸包 "${stickerSetName}" 不存在或无效`;
            break;
          case 'STICKERSET_NOT_MODIFIED':
            errorMessage = "❌ 贴纸包未修改";
            break;
          case 'PEER_ID_INVALID':
            errorMessage = "❌ 无效的用户或群组ID";
            break;
          default:
            errorMessage = `❌ 下载失败: ${innerMsg}`;
        }
      }
      
      await msg.edit({
        text: errorMessage
      });
    }
  }
  
  private async uploadStickerPack(client: any, msg: MessageContext, setInfo: any, packDir: string): Promise<void> {
    let zipPath: string | undefined;
    try {
      await msg.edit({
        text: "下载完毕，打包上传中。"
      });
      
      const setShortName = setInfo.short_name || setInfo.shortName;
      zipPath = path.join(path.dirname(packDir), `${setShortName}.zip`);
      
      // 创建ZIP文件
      await this.createZipFile(packDir, zipPath);
      
      // 检查ZIP文件是否创建成功
      if (!fs.existsSync(zipPath)) {
        throw new Error('ZIP文件创建失败');
      }
      
      const stats = fs.statSync(zipPath);
      if (stats.size === 0) {
        throw new Error('ZIP文件为空');
      }
      
      logger.info(`ZIP文件创建成功，大小: ${stats.size} 字节`);
      
      // 检查文件权限和可读性
      try {
        fs.accessSync(zipPath, fs.constants.R_OK);
        logger.info('ZIP文件权限检查通过');
      } catch (accessError: unknown) {
        throw new Error(`ZIP文件无法读取: ${accessError}`);
      }
      
      // 尝试读取文件的前几个字节来验证文件完整性
       try {
         const buffer = fs.readFileSync(zipPath);
         if (buffer.length === 0) {
           throw new Error('ZIP文件无法读取或为空');
         }
         // 检查ZIP文件头（应该以PK开头）
         if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4B) {
           logger.info('ZIP文件完整性检查通过');
         } else {
           throw new Error('ZIP文件格式无效');
         }
       } catch (readError: unknown) {
          throw new Error(`ZIP文件读取测试失败: ${readError}`);
        }
        
        // 等待一小段时间确保文件完全写入磁盘
        await new Promise(resolve => setTimeout(resolve, 1000));
        logger.info('文件写入等待完成');
        
        // 上传ZIP文件
        logger.info('开始上传ZIP文件...');
      const fileName = path.basename(zipPath);
      const fileBuffer = fs.readFileSync(zipPath);
      const replyToMsgId = (msg as MessageLike).replyToMessage?.id;
      await client.sendMedia(msg.chat.id, {
        type: 'document',
        file: fileBuffer,
        fileName: fileName
      } as { type: string; file: Buffer; fileName: string }, {
        caption: setShortName,
        replyTo: replyToMsgId
      });
      logger.info('ZIP文件发送成功');
      
      // 清理临时文件
      if (fs.existsSync(zipPath)) {
        fs.unlinkSync(zipPath);
      }
      if (fs.existsSync(packDir)) {
        fs.rmSync(packDir, { recursive: true, force: true });
      }
      
      // 删除原消息
      await msg.delete();
      
    } catch (error: unknown) {
      logger.error('上传贴纸包失败:', error);
      
      // 清理临时文件
      try {
        if (zipPath && fs.existsSync(zipPath)) {
          fs.unlinkSync(zipPath);
          logger.info('已清理ZIP文件:', zipPath);
        }
        if (fs.existsSync(packDir)) {
          fs.rmSync(packDir, { recursive: true, force: true });
          logger.info('已清理贴纸目录:', packDir);
        }
      } catch (cleanupError: unknown) {
        logger.error('清理临时文件失败:', cleanupError);
      }
      
      let errorMessage = "❌ 上传贴纸包时出现错误";
      const errMsg = getErrorMessage(error);
      if (errMsg) {
        if (errMsg.includes('Could not create buffer')) {
          errorMessage = "❌ 文件读取失败，可能是ZIP文件损坏";
        } else {
          errorMessage = `❌ 上传失败: ${errMsg}`;
        }
      }
      
      await msg.edit({
        text: errorMessage
      });
    }
  }
  
  private async checkAndInstallTools(): Promise<{ ffmpeg: boolean; lottie: boolean }> {
    const result = { ffmpeg: false, lottie: false };
    
    try {
      await execAsync('ffmpeg -version');
      result.ffmpeg = true;
      logger.info('FFmpeg 已安装');
    } catch (e: unknown) {
      logger.info('FFmpeg 未安装:', e);
    }
    
    try {
      await execAsync('pip show lottie');
      result.lottie = true;
      logger.info('lottie 已安装');
    } catch (e: unknown) {
      logger.info('lottie 未安装:', e);
    }
    
    return result;
  }
  
  private async convertWebpToGif(webpPath: string, gifPath: string): Promise<void> {
    const ffmpegCmd = `ffmpeg -i "${webpPath}" -vf "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0" -loop 0 "${gifPath}"`;
    await execAsync(ffmpegCmd);
  }
  
  private async convertTgsToGif(tgsPath: string, gifPath: string): Promise<void> {
    const pythonScript = `
import sys
import gzip
import json
from lottie.exporters.gif import export_gif
from lottie.parsers.tgs import parse_tgs

tgs_path = sys.argv[1]
gif_path = sys.argv[2]

with gzip.open(tgs_path, 'rb') as f:
    lottie_data = json.loads(f.read())

animation = parse_tgs(lottie_data)
export_gif(animation, gif_path, 512, 512, 30)
`;
    
    const scriptPath = path.join(path.dirname(tgsPath), 'convert_tgs.py');
    fs.writeFileSync(scriptPath, pythonScript);
    
    try {
      const pythonCmd = `python "${scriptPath}" "${tgsPath}" "${gifPath}"`;
      await execAsync(pythonCmd, { timeout: 60000 });
    } finally {
      if (fs.existsSync(scriptPath)) {
        fs.unlinkSync(scriptPath);
      }
    }
  }
  
  private async convertMp4ToGif(mp4Path: string, gifPath: string): Promise<void> {
    const ffmpegCmd = `ffmpeg -i "${mp4Path}" -vf "fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0" "${gifPath}"`;
    await execAsync(ffmpegCmd);
  }
  
  private async createZipFile(sourceDir: string, zipPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // 检查源目录是否存在
      if (!fs.existsSync(sourceDir)) {
        reject(new Error(`源目录不存在: ${sourceDir}`));
        return;
      }
      
      // 确保目标目录存在
      const zipDir = path.dirname(zipPath);
      if (!fs.existsSync(zipDir)) {
        fs.mkdirSync(zipDir, { recursive: true });
      }
      
      // 创建输出流
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', {
      zlib: { level: 9 } // 最高压缩级别
    });
      
      // 监听错误事件
       output.on('error', (err: Error) => {
         logger.error('输出流错误:', err);
         reject(err);
       });
       
       archive.on('error', (err: Error) => {
         logger.error('Archive错误:', err);
         reject(err);
       });
      
      // 监听完成事件
      output.on('close', () => {
        logger.info(`ZIP文件创建完成，总大小: ${archive.pointer()} 字节`);
        
        // 验证文件是否正确创建
        if (fs.existsSync(zipPath)) {
          const stats = fs.statSync(zipPath);
          if (stats.size > 0) {
            logger.info('ZIP文件验证成功');
            resolve();
          } else {
            reject(new Error('ZIP文件为空'));
          }
        } else {
          reject(new Error('ZIP文件创建失败'));
        }
      });
      
      // 连接输出流
      archive.pipe(output);
      
      // 添加目录中的所有文件，类似Python版本的zipdir函数
      const addDirectory = (dirPath: string, zipPath: string = '') => {
        const files = fs.readdirSync(dirPath);
        
        for (const file of files) {
          const filePath = path.join(dirPath, file);
          const stat = fs.statSync(filePath);
          const zipFilePath = zipPath ? path.join(zipPath, file) : file;
          
          if (stat.isDirectory()) {
            addDirectory(filePath, zipFilePath);
          } else {
            archive.file(filePath, { name: zipFilePath });
          }
        }
      };
      
      // 添加源目录中的所有文件
      addDirectory(sourceDir);
      
      // 完成归档
      archive.finalize();
    });
  }
}

export default new GetStickersPlugin();
