import { Plugin } from "@utils/pluginBase";
import type { MessageContext } from "@mtcute/dispatcher";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import fs from "fs/promises";
import path from "path";
import { safeGetMessages, safeGetReplyMessage } from "@utils/safeGetMessages";
import { getRawType, getUsername, getTitle, getMessageMedia, isMegagroup } from "@utils/entityTypeGuards";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const CONFIG_FILE_PATH = path.join(
  process.cwd(),
  "temp",
  "channel_search_config.json"
);

interface SearchConfig {
  defaultChannel: string | null;
  channelList: { title: string; handle: string; linkedGroup?: string }[];
  adFilters: string[];
}

enum SubCommand {
  Add = "add",
  Delete = "del",
  Default = "default",
  List = "list",
  Export = "export",
  Import = "import",
  Kkp = "kkp",
  Ad = "ad",
}

class SearchService {
  private client: any;
  private config: SearchConfig = {
    defaultChannel: null,
    channelList: [],
    adFilters: [
      "广告", "推广", "赞助", "合作", "代理", "招商", "加盟", "投资", "理财",
      "贷款", "借钱", "网贷", "信用卡", "pos机", "刷单", "兼职", "副业",
      "微商", "代购", "淘宝", "拼多多", "京东", "直播带货", "优惠券",
      "返利", "红包", "现金", "提现", "充值", "游戏币", "点卡",
      "彩票", "博彩", "赌博", "六合彩", "时时彩", "北京赛车",
      "股票", "期货", "外汇", "数字货币", "比特币", "挖矿",
      "保险", "医疗", "整容", "减肥", "丰胸", "壮阳", "药品",
      "假货", "高仿", "A货", "精仿", "原单", "尾单",
      "办证", "刻章", "发票", "学历", "文凭", "证书",
      "黑客", "破解", "外挂", "木马", "病毒", "盗号",
      "vpn", "翻墙", "代理ip", "科学上网", "梯子"
    ]
  };

  constructor(client: any) {
    this.client = client;
  }

  public async initialize() {
    await this.loadConfig();
  }

  private async loadConfig() {
    try {
      await fs.access(CONFIG_FILE_PATH);
      const data = await fs.readFile(CONFIG_FILE_PATH, "utf-8");
      this.config = { ...this.config, ...JSON.parse(data) };
    } catch (error) {
      console.log("未找到搜索配置，使用默认配置。");
    }
  }

  private async saveConfig() {
    try {
      await fs.mkdir(path.dirname(CONFIG_FILE_PATH), { recursive: true });
      await fs.writeFile(CONFIG_FILE_PATH, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error("保存配置失败:", error);
    }
  }

  private async discoverLinkedGroup(channel: any): Promise<string | undefined> {
    try {
      const fullChannel = await this.client.call({
        _: 'channels.getFullChannel',
        channel: channel as any,
      } as any);

      if ((fullChannel as any).fullChat?.linkedChatId) {
        const linkedChatId = (fullChannel as any).fullChat.linkedChatId;
        const linkedGroup = await this.client.resolvePeer(linkedChatId) as any;
        if (getRawType(linkedGroup) === 'channel' && isMegagroup(linkedGroup)) {
          const uname = getUsername(linkedGroup);
          if (uname) {
            return `@${uname}`;
          } else {
            try {
              const inviteLink = await this.client.call({
                _: 'messages.exportChatInvite',
                peer: linkedGroup as any,
              } as any);
              if ((inviteLink as any)._ === 'chatInviteExported') {
                return (inviteLink as any).link;
              }
            } catch (linkError: any) {
              console.log(`获取邀请链接失败: ${linkError.message}`);
            }
            return undefined;
          }
        }
      }
      return undefined;
    } catch (error: any) {
      console.log(`获取频道关联讨论组失败: ${error.message}`);
      return undefined;
    }
  }

  private async searchInChannelWithLinkedGroup(
    channelInfo: { title: string; handle: string; linkedGroup?: string },
    query: string
  ): Promise<any[]> {
    const videos: any[] = [];
    if (!channelInfo.linkedGroup) return [];

    try {
      const linkedGroupEntity = await this.client.resolvePeer(channelInfo.linkedGroup) as any;
      const groupMessages = await safeGetMessages(this.client, linkedGroupEntity, {
        limit: 100,
        search: query,
       } as any);

      for (const textMsg of groupMessages) {
        if (this.isMessageMatching(textMsg, query) && (textMsg as any).replies) {
          console.log(`找到匹配消息 #${textMsg.id}，正在精确获取其 ${(textMsg as any).replies.replies} 条评论...`);
             const commentsParams: any = { limit: 100, replyTo: textMsg.id };
             const comments = await safeGetMessages(this.client, linkedGroupEntity, commentsParams);

          const videoReplies = comments.filter((msg: any) => {
            const media = getMessageMedia(msg);
            return msg.video &&
            !(media && getRawType(media) === 'messageMediaWebPage') &&
            !this.isAdContent(msg);
          });

          if (videoReplies.length > 0) {
            console.log(`在评论区找到 ${videoReplies.length} 个视频。`);
            videos.push(...videoReplies);
            return videos;
          }
        }
      }

      if (videos.length === 0) {
        const groupVideoMessages = await safeGetMessages(this.client, linkedGroupEntity, {
          limit: 100,
          search: query,
          filter: { _: 'inputMessagesFilterVideo' } as any,
         } as any);

        const pureVideos = groupVideoMessages.filter((v: any) => {
          const vMedia = getMessageMedia(v);
          return v.video &&
          !(vMedia && getRawType(vMedia) === 'messageMediaWebPage') &&
          !this.isAdContent(v);
        });

        if (pureVideos.length > 0) {
          videos.push(...pureVideos);
        }
      }
    } catch (linkedGroupError: any) {
      console.error(`访问关联讨论组失败: ${linkedGroupError.message}`);
    }
    return videos;
  }

  public async handle(msg: MessageContext) {
    let fullArgs = msg.text.substring(4).trim();
    const useSpoiler = fullArgs.toLowerCase().includes(" -s");
    const useRandom = fullArgs.toLowerCase().includes(" -r");

    if (useSpoiler) fullArgs = fullArgs.replace(/\s+-s/i, "").trim();
    if (useRandom) fullArgs = fullArgs.replace(/\s+-r/i, "").trim();

    const args = fullArgs.split(/\s+/);
    const subCommand = args[0]?.toLowerCase() as SubCommand;
    const subCommandArgs = args.slice(1).join(" ");

    const adminMsg = await msg.edit({ text: `⚙️ 正在执行命令...` });
    if (!adminMsg) return;

    try {
      switch (subCommand) {
        case SubCommand.Add:
          await this.handleAdd(adminMsg, subCommandArgs);
          break;
        case SubCommand.Delete:
          await this.handleDelete(adminMsg, subCommandArgs);
          break;
        case SubCommand.Default:
          await this.handleDefault(adminMsg, subCommandArgs);
          break;
        case SubCommand.List:
          await this.handleList(adminMsg);
          break;
        case SubCommand.Export:
          await this.handleExport(msg);
          break;
        case SubCommand.Import:
          await this.handleImport(msg);
          break;
        case SubCommand.Kkp:
          await this.handleKkp(msg, useSpoiler);
          break;
        case SubCommand.Ad:
          await this.handleAd(msg, subCommandArgs);
          break;
        default:
          await this.handleSearch(msg, fullArgs, useSpoiler, useRandom);
      }
    } catch (error: any) {
      await (adminMsg as any).edit({ text: `❌ 错误：\\n${error.message}` });
    }
  }

  private async handleAdd(msg: any, args: string) {
    if (!args) throw new Error("请提供频道链接或 @username，使用 \\ 分隔。");
    const channels = args.split("\\");
    let addedCount = 0;

    for (const channelHandle of channels) {
        try {
            const normalizedHandle = channelHandle.trim();
            const entity = await this.client.resolvePeer(normalizedHandle) as any;

            const eType = getRawType(entity);
            if (eType !== 'channel' && eType !== 'chat') {
                await msg.edit({ text: `错误：${normalizedHandle} 不是公开频道、群组或讨论组。` });
                continue;
            }
            if (this.config.channelList.some((c) => c.handle === normalizedHandle)) {
                await msg.edit({ text: `目标 "${getTitle(entity) || ''}" 已存在。` });
                continue;
            }

            let linkedGroup: string | undefined;
            if (eType === 'channel' && !isMegagroup(entity) && (entity as any).broadcast) {
                linkedGroup = await this.discoverLinkedGroup(entity);
            }

            this.config.channelList.push({
                title: getTitle(entity) || '',
                handle: normalizedHandle,
                linkedGroup: linkedGroup,
            });
            if (!this.config.defaultChannel) this.config.defaultChannel = normalizedHandle;
            addedCount++;
        } catch (error: any) {
            await msg.edit({ text: `添加频道 ${channelHandle.trim()} 时出错：${error.message}` });
        }
    }
    await this.saveConfig();
    await msg.edit({ text: `✅ 成功添加 ${addedCount} 个频道。` });
  }

  private async handleDelete(msg: any, args: string) {
    if (!args) throw new Error(`用法: ${mainPrefix}so del &lt;频道链接|序号&gt; [...] 或 ${mainPrefix}so del all。`);
    if (args.toLowerCase().trim() === "all") {
        const count = this.config.channelList.length;
        this.config.channelList = [];
        this.config.defaultChannel = null;
        await this.saveConfig();
        await msg.edit({ text: `✅ 已清空所有 ${count} 个频道。` });
        return;
    }

    const inputs = args.split(/[\s\\]+/).filter(Boolean);
    const handlesToRemove = new Set<string>();
    const removedTitles: string[] = [];
    
    const currentList = [...this.config.channelList];

    for (const input of inputs) {
        const index = parseInt(input, 10);
        if (!isNaN(index) && index > 0 && index <= currentList.length) {
            const handle = currentList[index - 1].handle;
            handlesToRemove.add(handle);
        } else {
            handlesToRemove.add(input);
        }
    }
    
    if (handlesToRemove.size === 0) {
        await msg.edit({ text: `❓ 未提供有效的频道链接或序号。` });
        return;
    }
    
    const originalLength = this.config.channelList.length;
    
    this.config.channelList = this.config.channelList.filter(channel => {
        if (handlesToRemove.has(channel.handle)) {
            removedTitles.push(channel.title);
            return false;
        }
        return true;
    });
    
    const removedCount = originalLength - this.config.channelList.length;

    if (removedCount > 0) {
        if (this.config.defaultChannel && handlesToRemove.has(this.config.defaultChannel)) {
            this.config.defaultChannel = this.config.channelList.length > 0 ? this.config.channelList[0].handle : null;
        }
        await this.saveConfig();
        await msg.edit({ text: `✅ 成功移除 ${removedCount} 个频道:\n- ${removedTitles.join('\n- ')}` });
    } else {
        await msg.edit({ text: `❓ 在列表中未找到指定的频道或序号。` });
    }
  }

  private async handleDefault(msg: any, args: string) {
    if (!args) throw new Error(`用法: ${mainPrefix}so default &lt;频道链接&gt; 或 ${mainPrefix}so default d。`);
    if (args === "d") {
        this.config.defaultChannel = null;
        await this.saveConfig();
        await msg.edit({ text: `✅ 默认频道已移除。` });
        return;
    }
    const normalizedHandle = args.trim();
    if (!this.config.channelList.some((c) => c.handle === normalizedHandle)) {
        throw new Error(`请先使用 \`${mainPrefix}so add\` 添加此频道。`);
    }
    this.config.defaultChannel = normalizedHandle;
    await this.saveConfig();
    await msg.edit({ text: `✅ 已将 "${normalizedHandle}" 设为默认频道。` });
  }

  private async handleList(msg: any) {
    if (this.config.channelList.length === 0) {
      await msg.edit({ text: "没有添加任何搜索频道。" });
      return;
    }
    let listText = "**当前搜索频道列表:**\n\n";
    this.config.channelList.forEach((channel, index) => {
      const isDefault = channel.handle === this.config.defaultChannel ? " (默认)" : "";
      listText += `${index + 1}. ${channel.title}${isDefault}\n`;
    });
    await msg.edit({ text: listText });
  }

  private async handleExport(msg: MessageContext) {
    if (this.config.channelList.length === 0) {
        await msg.edit({ text: "没有可导出的频道。" });
        return;
    }
    const backupContent = this.config.channelList.map((c) => c.handle).join("\n");
    const backupFilePath = path.join(process.cwd(), "temp", "so_channels_backup.txt");
    await fs.mkdir(path.dirname(backupFilePath), { recursive: true });
    await fs.writeFile(backupFilePath, backupContent);
    await (this.client as any).sendFile(msg.chat.id, { file: backupFilePath, caption: `✅ 您的频道源已导出。`, replyTo: (msg as any).id });
    await fs.unlink(backupFilePath);
  }

  private async handleImport(msg: MessageContext) {
    const replied = await safeGetReplyMessage(msg);
    if (!replied || !(replied as any).document) throw new Error("❌ 请回复备份文件。");
    
    const buffer = await this.client.downloadAsBuffer((replied as any).media);
    if (!buffer) throw new Error("下载文件失败。");

    const handles = buffer.toString().split("\n").map((h: string) => h.trim()).filter(Boolean);
    if (handles.length === 0) throw new Error("备份文件无效。");

    await msg.edit({ text: `⚙️ 正在导入 ${handles.length} 个源...` });
    this.config.channelList = [];
    this.config.defaultChannel = null;
    await this.handleAdd(msg as any, handles.join("\\"));
  }

  private async handleAd(msg: MessageContext, args: string) {
    const parts = args.split(/\s+/);
    const subCmd = parts[0]?.toLowerCase();
    const keywords = parts.slice(1);

    switch (subCmd) {
      case "add":
        if (keywords.length === 0) throw new Error("请提供关键词。");
        this.config.adFilters.push(...keywords);
        await this.saveConfig();
        await msg.edit({ text: `✅ 成功添加 ${keywords.length} 个广告过滤词。` });
        break;
      case "del":
        if (keywords.length === 0) throw new Error("请提供关键词。");
        const initialLength = this.config.adFilters.length;
        this.config.adFilters = this.config.adFilters.filter(k => !keywords.includes(k));
        await this.saveConfig();
        await msg.edit({ text: `✅ 成功删除 ${initialLength - this.config.adFilters.length} 个广告过滤词。` });
        break;
      case "list":
        if (this.config.adFilters.length === 0) {
          await msg.edit({ text: "当前没有广告过滤词。" });
        } else {
          await msg.edit({ text: `**当前广告过滤词:**\n\n${this.config.adFilters.join(", ")}` });
        }
        break;
      default:
        throw new Error(`用法: ${mainPrefix}so ad &lt;add|del|list&gt; [关键词]`);
    }
  }

  private async handleKkp(msg: MessageContext, useSpoiler: boolean) {
    await this.findAndSendVideo(msg, null, useSpoiler, true, "kkp");
  }

  private async handleSearch(msg: MessageContext, query: string, useSpoiler: boolean, useRandom: boolean) {
    if (!query) throw new Error("请输入搜索关键词。");
    await this.findAndSendVideo(msg, query, useSpoiler, useRandom, "search");
  }

  private async findAndSendVideo(
    msg: MessageContext,
    query: string | null,
    useSpoiler: boolean,
    useRandom: boolean,
    type: "kkp" | "search"
  ) {
    if (this.config.channelList.length === 0)
      throw new Error(`请至少使用 \`${mainPrefix}so add\` 添加一个搜索频道。`);

    const initialMessage = type === "kkp" ? "🎲 正在随机寻找视频..." : "🔍 正在搜索视频...";
    await msg.edit({ text: initialMessage });

    const searchOrder = [...new Set([this.config.defaultChannel, ...this.config.channelList.map((c) => c.handle)].filter(Boolean) as string[])];
    
    let validVideos: any[] = [];
    const processedGroupIds = new Set<string>();

    for (const [index, channelHandle] of searchOrder.entries()) {
      if (index > 0) {
        await new Promise(resolve => setTimeout(resolve, 750));
      }

      const channelInfo = this.config.channelList.find((c) => c.handle === channelHandle);
      if (!channelInfo) continue;
      
      let videosInCurrentChannel: any[] = [];

      try {
        await msg.edit({ text: `- 正在搜索... (源: ${index + 1}/${searchOrder.length})` });
        const entity = await this.client.resolvePeer(channelInfo.handle) as any;

        if (type === "search" && query) {
          if (channelInfo.linkedGroup) {
            const linkedVideos = await this.searchInChannelWithLinkedGroup(channelInfo, query);
            if (linkedVideos.length > 0) videosInCurrentChannel.push(...linkedVideos);
          }

          const queryParams: any = { limit: 200, search: query };
          const allQueryMessages = await safeGetMessages(this.client, entity, queryParams);

          for (const foundMsg of allQueryMessages) {
            if (this.isMessageMatching(foundMsg, query)) {
              if ((foundMsg as any).groupedId) {
                const groupIdStr = (foundMsg as any).groupedId.toString();
                if (processedGroupIds.has(groupIdStr)) continue;

                const surroundingMessages = await safeGetMessages(this.client, entity, {
                    limit: 20,
                    offsetId: foundMsg.id + 10,
                 } as any);
                
                const groupedId = (foundMsg as any).groupedId;
                if (!groupedId) continue;
                const albumMessages = surroundingMessages.filter((m: any) => (m as any).groupedId?.toString() === groupedId.toString());
                const videosInAlbum = albumMessages.filter((m: any) => m.video && !this.isAdContent(m));

                if (videosInAlbum.length > 0) {
                  videosInCurrentChannel.push(...videosInAlbum);
                  processedGroupIds.add(groupIdStr);
                }
              } else if ((foundMsg as any).video && !this.isAdContent(foundMsg)) {
                videosInCurrentChannel.push(foundMsg);
              }
            }
          }
        } else if (type === "kkp") { 
          const isMegagroup = (entity as any)._ === 'channel' && (entity as any).megagroup === true;
          const messages = await safeGetMessages(this.client, entity, {
            limit: isMegagroup ? 200 : 100,
            filter: { _: 'inputMessagesFilterVideo' } as any,
           } as any);

          const filteredVideos = messages.filter((v: any) => {
            const isPureVideo = v.video && !(v.media && (v.media as any)._ === 'messageMediaWebPage');
            if (!isPureVideo || this.isAdContent(v)) return false;

            const durationAttr = v.video?.attributes?.find((attr: any) => attr._ === 'documentAttributeVideo') as any;
            return durationAttr && durationAttr.duration >= 20 && durationAttr.duration <= 180;
          });
          videosInCurrentChannel.push(...filteredVideos);
        }
        
        if (videosInCurrentChannel.length > 0) {
          validVideos.push(...videosInCurrentChannel);
          if (type === "search" && !useRandom) {
              console.log(`在频道 "${channelInfo.title}" 中找到结果，精确模式下停止搜索。`);
              break;
          }
        }

      } catch (error: any) {
        if (error.message.includes("Could not find the input entity")) {
            console.error(`无法找到频道 ${channelInfo.title}，已自动移除。`);
            this.config.channelList = this.config.channelList.filter(c => c.handle !== channelHandle);
            if(this.config.defaultChannel === channelHandle) this.config.defaultChannel = null;
            await this.saveConfig();
        } else {
            console.error(`在频道 "${channelInfo.title}" 搜索失败: ${error.message}`);
        }
        continue;
      }
    }

    if (validVideos.length > 0) {
        validVideos = Array.from(new Map(validVideos.map(v => [v.id, v])).values());
    }

    if (validVideos.length === 0) {
      await msg.edit({ text: type === "kkp" ? "🤷‍♂️ 未找到合适的视频。" : "❌ 在任何频道中均未找到匹配结果。" });
      return;
    }

    let selectedVideo: any;

    if (useRandom || type === "kkp") {
      console.log(`随机模式开启，从 ${validVideos.length} 个视频中选择...`);
      selectedVideo = this.selectRandomVideo(validVideos);
    } else {
      console.log(`精确模式，从 ${validVideos.length} 个视频中按相关性选择...`);
      if (validVideos.length > 1) {
          const queryNormalized = this.normalizeSearchTerm(query || "");
          const getScore = (video: any): number => {
              let score = 0;
              const fileNameAttr = video.video?.attributes?.find((attr: any) => attr._ === 'documentAttributeFilename') as any;
              if (fileNameAttr?.fileName) {
                  const normalizedFileName = this.normalizeSearchTerm(fileNameAttr.fileName);
                  if (normalizedFileName.includes(queryNormalized)) score += 100;
              }
              if (video.text) {
                  const normalizedMessage = this.normalizeSearchTerm(video.text);
                  if (normalizedMessage.includes(queryNormalized)) score += 50;
              }
              return score;
          };

          validVideos.sort((a, b) => {
              const scoreA = getScore(a);
              const scoreB = getScore(b);
              if (scoreB !== scoreA) return scoreB - scoreA;
              
              const durationA = a.video?.attributes?.find((attr: any) => attr._ === 'documentAttributeVideo')?.duration || 0;
              const durationB = b.video?.attributes?.find((attr: any) => attr._ === 'documentAttributeVideo')?.duration || 0;
              return durationB - durationA;
          });
      }
      selectedVideo = validVideos[0];
    }

    await msg.edit({ text: `✅ 已找到结果，准备发送...` });
    
    const originalMsg = msg;
    await this.sendVideo(originalMsg, selectedVideo, useSpoiler, query);
    
    if (!useSpoiler && (originalMsg as any).isOutgoing) {
      try {
        await (originalMsg as any).delete();
      } catch (e) {
        console.warn("删除原始消息失败，可能已被删除");
      }
    }
  }

  private async sendVideo(originalMsg: MessageContext, video: any, useSpoiler: boolean, caption?: string | null) {
    if (useSpoiler) {
      await this.downloadAndUploadVideo(originalMsg, video, true, caption);
    } else {
      try {
        await this.client.forwardMessages((originalMsg as any).chat.id, { messages: [video.id], fromPeer: (video as any).chat?.id || (video as any).peerId });
      } catch (forwardError: any) {
        console.log(`转发失败，自动转为下载上传: ${forwardError.message}`);
        await this.downloadAndUploadVideo(originalMsg, video, false, caption);
      }
    }
  }

  private async downloadAndUploadVideo(originalMsg: MessageContext, video: any, spoiler: boolean = false, caption?: string | null): Promise<void> {
    const tempDir = path.join(process.cwd(), "temp");
    await fs.mkdir(tempDir, { recursive: true });
    const tempFilePath = path.join(tempDir, `video_${Date.now()}.mp4`);

    const statusMsg = await this.client.sendText((originalMsg as any).chat.id, `🔥 正在下载视频...`, { replyTo: (originalMsg as any).id } as any);

    try {
      const buffer = await this.client.downloadAsBuffer((video as any).media);
      await fs.writeFile(tempFilePath, Buffer.from(buffer as any));
      await statusMsg.edit({ text: `✅ 下载完成，正在上传...` });

      if (!video.video) throw new Error("消息不包含有效的视频媒体。");
      
      const videoAttr = video.video?.attributes?.find((attr: any) => attr._ === 'documentAttributeVideo') as any;

      await this.client.sendFile((originalMsg as any).chat.id, {
          file: tempFilePath,
          caption: caption || video.text || "",
          forceDocument: false,
          spoiler: spoiler,
          attributes: [
              {
                  _: 'documentAttributeVideo',
                  duration: videoAttr?.duration || 0,
                  w: videoAttr?.w || 0,
                  h: videoAttr?.h || 0,
                  supportsStreaming: true,
              } as any,
              {
                  _: 'documentAttributeFilename',
                  fileName: path.basename(tempFilePath),
              } as any,
          ],
          replyTo: (originalMsg as any).id
      } as any);
      await statusMsg.delete();
      if ((originalMsg as any).isOutgoing) await (originalMsg as any).delete();
    } catch (error: any) {
      console.error("下载上传视频时出错:", error);
      await statusMsg.edit({ text: `❌ 发送视频失败: ${error.message}` });
    } finally {
      try {
        await fs.unlink(tempFilePath);
      } catch (cleanupError) {
        console.warn("清理临时文件失败:", cleanupError);
      }
    }
  }

  private isMessageMatching(message: any, query: string): boolean {
    const normalizedQuery = this.normalizeSearchTerm(query);
    const textSources = [message.text, (message as any).message];
    const fileNameAttr = message.video?.attributes?.find((attr: any) => attr._ === 'documentAttributeFilename') as any;
    if (fileNameAttr?.fileName) textSources.push(fileNameAttr.fileName);

    for (const source of textSources) {
      if (source) {
        const normalizedText = this.normalizeSearchTerm(source);
        if (this.fuzzyMatch(normalizedText, normalizedQuery)) return true;
      }
    }
    return false;
  }

  private normalizeSearchTerm(text: string): string {
    return text.toLowerCase().replace(/[-_\s\.\|\\\/#]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private fuzzyMatch(text: string, query: string): boolean {
    if (text.includes(query)) return true;
    const queryParts = query.split(' ').filter(part => part.length > 0);
    const textParts = text.split(' ');

    if (queryParts.length === 1 && /[a-z]+\s*\d+/i.test(query)) {
      if (text.replace(/\s+/g, '').includes(query.replace(/\s+/g, ''))) return true;
    }

    return queryParts.every(queryPart => textParts.some(textPart => textPart.includes(queryPart)));
  }

  private isAdContent(message: any): boolean {
    const text = (message.text || (message as any).message || "").toLowerCase();
    const fileNameAttr = message.video?.attributes?.find((attr: any) => attr._ === 'documentAttributeFilename') as any;
    const fileName = (fileNameAttr?.fileName || "").toLowerCase();
    return this.config.adFilters.some(filter => text.includes(filter) || fileName.includes(filter));
  }

  private selectRandomVideo(videos: any[]): any {
    return videos[Math.floor(Math.random() * videos.length)];
  }
}

const so = async (msg: MessageContext) => {
  const client = await getGlobalClient();
  if (!client) return;

  const service = new SearchService(client);
  await service.initialize();
  await service.handle(msg);
};

class ChannelSearchPlugin extends Plugin {
    cleanup(): void {
    // 当前插件不持有需要在 reload 时额外释放的长期资源。
  }


  description: string = `强大的多频道资源搜索插件，具备高级功能：

搜索功能:
- 关键词搜索: ${mainPrefix}so &lt;关键词&gt; （不限制大小和时长）
- 随机速览: ${mainPrefix}so kkp （随机选择20秒-3分钟的视频）

选项:
- 防剧透模式: -s (下载视频并将其作为防剧透消息发送)
- 随机模式: -r (从匹配结果中随机选择)

频道管理:
- 添加频道: .so add &lt;频道链接&gt; (使用 \\ 分隔)
- 删除频道: ${mainPrefix}so del &lt;频道链接|序号&gt; [...] 或 ${mainPrefix}so del all (删除所有)
- 设置默认: ${mainPrefix}so default &lt;频道链接&gt; 或 ${mainPrefix}so default d (移除默认)
- 列出频道: ${mainPrefix}so list
- 导出配置: ${mainPrefix}so export
- 导入配置: ${mainPrefix}so import (回复备份文件)

广告过滤:
- 添加关键词: ${mainPrefix}so ad add &lt;关键词1&gt; &lt;关键词2&gt; ...
- 删除关键词: ${mainPrefix}so ad del &lt;关键词1&gt; &lt;关键词2&gt; ...
- 查看关键词: ${mainPrefix}so ad list`;
  
  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    so,
    search: so,
  };
}

export default new ChannelSearchPlugin();
