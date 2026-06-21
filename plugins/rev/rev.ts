import { Plugin } from '@utils/pluginBase';
import { getPrefixes } from '@utils/pluginManager';
import { createDirectoryInTemp } from '@utils/pathHelpers';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { MessageContext } from "@mtcute/dispatcher";
import type { Message, MessageEntity, MessageMedia, Photo, Sticker, Video, Audio, Document, RawDocument } from "@mtcute/core";
import { html } from "@mtcute/html-parser";
import { getGlobalClient } from "@utils/globalClient";
import { promisify } from 'util';
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { logger } from "@utils/logger";
import { tl } from "@mtcute/core/tl";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];


const execFileAsync = promisify(execFile);
const FAN_TEMP_DIR = createDirectoryInTemp('rev');

type FlipMode = 'h' | 'v' | null;

interface MediaOptions {
	flipMode: FlipMode;
	invertColors: boolean;
	remaining: string[];
}

interface TransformOptions {
	inputPath: string;
	outputPath: string;
	flipMode: FlipMode;
	invertColors: boolean;
	isGif: boolean;
	isWebm: boolean;
}

class REVPlugin extends Plugin {

	name = 'rev';

	description = `🔄 <b>反转插件</b>

<b>✨ 功能介绍</b>
支持文字和媒体的多种反转操作，让你的内容倒过来！

<b>📝 文字反转</b>
• <code>${mainPrefix}rev [文字]</code> - 反转文字内容（支持 emoji）
• <code>${mainPrefix}rev</code>（回复文字消息）- 反转回复的文字

<b>🖼️ 媒体反转</b>
支持格式：图片 / GIF / WebM / WebP
• <code>${mainPrefix}rev</code>（回复媒体）- 水平翻转
• <code>${mainPrefix}rev h</code> - 水平翻转（左右镜像）
• <code>${mainPrefix}rev v</code> - 垂直翻转（上下镜像）
• <code>${mainPrefix}rev c</code> - 颜色反转（负片效果）
• <code>${mainPrefix}rev h c</code> - 组合使用（水平翻转 + 颜色反转）

<b>💡 使用示例</b>
• <code>${mainPrefix}rev 你好世界</code> → 界世好你
• 回复图片 + <code>${mainPrefix}rev v</code> → 上下翻转的图片
• 回复 GIF + <code>${mainPrefix}rev c</code> → 负片效果的 GIF
• 回复 WebM + <code>${mainPrefix}rev h c</code> → 水平翻转 + 负片效果`;

	cmdHandlers = {
		rev: async (msg: MessageContext) => {
			try {
				const args = this.parseArgs(msg);
				const { flipMode, invertColors, remaining } =
					this.extractMediaOptions(args);
				const inputText = remaining.join(' ').trim();

				// 处理文本反转
				if (inputText) {
					await this.handleTextReverse(msg, inputText);
					return;
				}

				// 处理媒体反转
				const replyMsg = await safeGetReplyMessage(msg);
				if (replyMsg) {
					const handled = await this.handleReplyMessage(
							msg,
							replyMsg,
							flipMode,
							invertColors
						);
					if (handled) return;
				}

				// 无有效内容时的提示
				await msg.edit({
					text: html`❌ 请提供文本内容或回复一条支持的消息<br><br><b>支持的格式：</b><br>• 文本消息（逐行反转）<br>• 图片（JPG/PNG/BMP/WebP）<br>• 动图（GIF/.gif.mp4）<br>• 贴纸（WebM）<br><br><b>使用方法：</b><br><code>${mainPrefix}rev [文本]</code> 或回复消息使用 <code>${mainPrefix}rev [参数]</code>`,
				});
			} catch (error: any) {
				await msg.edit({
					text: html`❌ 处理失败: ${this.htmlEscape(error.message)}`,
				});
			}
		},
	};

	// ==================== 文本处理 ====================

	private parseArgs(msg: MessageContext): string[] {
		const text = (msg.text || '').trim();
		return text ? text.split(/\s+/).slice(1) : [];
	}

	private async handleReplyMessage(
		msg: MessageContext,
		replyMsg: Message,
		flipMode: FlipMode,
		invertColors: boolean
	): Promise<boolean> {
		const replyText = (replyMsg.text || '').trim();
		const replyEntities = replyMsg.entities || [];

		// 优先尝试媒体处理
		const handledMedia = await this.tryHandleMediaTransform(
			msg,
			replyMsg,
			flipMode,
			invertColors,
			replyText,
			replyEntities
		);
		if (handledMedia) return true;

		// 回退到文本处理
		if (replyText) {
			await this.handleTextReverse(msg, replyText, replyEntities);
			return true;
		}

		return false;
	}

	private async handleTextReverse(
		msg: MessageContext,
		content: string,
		entities: readonly MessageEntity[] = []
	) {
		const { reversed, reversedEntities } = this.reverseStringWithEntities(
			content,
			entities
		);

		if (reversedEntities.length > 0) {
			try {
				const client = await getGlobalClient();
				await client.call({
					_: 'messages.editMessage',
					peer: await client.resolvePeer(msg.chat.id),
					id: msg.id,
					message: reversed,
					entities: reversedEntities as unknown as tl.TypeMessageEntity[],
				});
				return;
			} catch (err) {
				logger.debug("rev: rich text reverse send failed, falling back to plain", err);
			}
		}

		await msg.edit({ text: reversed });
	}

	private reverseStringWithEntities(text: string, entities: readonly MessageEntity[] = []) {
		// 逐行反转字符顺序，保持行的顺序不变
		const lines = text.split('\n');
		const reversedLines = lines.map((line) =>
			Array.from(line).reverse().join('')
		);
		const reversed = reversedLines.join('\n');
		const textLength = text.length;

		// 反转实体的位置偏移
		const reversedEntities = entities.map((entity) => ({
			...entity,
			offset: textLength - entity.offset - entity.length,
		}) as MessageEntity);

		return { reversed, reversedEntities };
	}

	// ==================== 媒体处理 ====================

	private async tryHandleMediaTransform(
		msg: MessageContext,
		replyMsg: Message,
		flipMode: FlipMode,
		invertColors: boolean,
		captionText?: string,
		captionEntities: readonly MessageEntity[] = []
	): Promise<boolean> {
		const media = replyMsg.media;
		if (!this.isSupportedMedia(media)) {
			return false;
		}

		const client = await getGlobalClient();

		await this.safeEditMessage(msg, '🔄 正在处理媒体，请稍候...');

		const { inputPath, outputPath, isGif, isWebm, isWebp } =
			this.prepareMediaPaths(media);

		try {
			await this.downloadMedia(client, replyMsg, inputPath);
			await this.transformMedia(
				inputPath,
				outputPath,
				flipMode,
				invertColors,
				isGif,
				isWebm
			);
			await this.sendTransformedMedia(
				client,
				msg,
				replyMsg,
				outputPath,
				isWebm,
				isWebp,
				captionText,
				captionEntities
			);
			await this.cleanupMessage(msg);
			return true;
		} finally {
			this.cleanupFiles([inputPath, outputPath]);
		}
	}

	private prepareMediaPaths(media: MessageMedia) {
		const extension = this.getExtensionFromMedia(media);
		const uniqueId = `${Date.now().toString(36)}_${Math.random()
			.toString(36)
			.slice(2, 8)}`;
		const inputPath = path.join(
			FAN_TEMP_DIR,
			`fan_src_${uniqueId}${extension}`
		);
		const outputPath = path.join(
			FAN_TEMP_DIR,
			`fan_flip_${uniqueId}${extension}`
		);
		const isGif = this.isGifMedia(media);
		const isWebm = this.isWebmMedia(media);
		const isWebp = extension === '.webp';

		return { inputPath, outputPath, isGif, isWebm, isWebp };
	}

	private async downloadMedia(
		client: any,
		replyMsg: Message,
		inputPath: string
	) {
		const buf = await client.downloadAsBuffer(replyMsg.media as unknown as import("@mtcute/core").FileLocation);
		fs.writeFileSync(inputPath, buf as Buffer);
		if (!fs.existsSync(inputPath)) {
			throw new Error('下载媒体失败，请稍后再试');
		}
	}

	private async transformMedia(
		inputPath: string,
		outputPath: string,
		flipMode: FlipMode,
		invertColors: boolean,
		isGif: boolean,
		isWebm: boolean
	) {
		await this.runFfmpegTransform({
			inputPath,
			outputPath,
			flipMode,
			invertColors,
			isGif,
			isWebm,
		});

		if (!fs.existsSync(outputPath)) {
			throw new Error('ffmpeg 未生成输出文件');
		}
	}

	private async sendTransformedMedia(
		client: any,
		msg: MessageContext,
		replyMsg: Message,
		outputPath: string,
		isWebm: boolean,
		isWebp: boolean,
		captionText?: string,
		captionEntities: readonly MessageEntity[] = []
	) {
		const sendOptions: any = {
			file: outputPath,
			replyTo: replyMsg.id,
		};

		// 处理文字说明
		if (captionText) {
			const { reversed, reversedEntities } = this.reverseStringWithEntities(
				captionText,
				captionEntities
			);
			sendOptions.caption = reversed;
			if (reversedEntities.length > 0) {
				sendOptions.entities = reversedEntities;
			}
		}

		// WebM 和 WebP 作为贴纸发送
		if (isWebm || isWebp) {
			sendOptions.attributes = [
				{ _: 'documentAttributeSticker', alt: 'fan', stickerset: { _: 'inputStickerSetEmpty' } } as tl.RawDocumentAttributeSticker,
			];
		}

		await client.sendMedia(msg.chat.id, sendOptions);
	}

	private async cleanupMessage(msg: MessageContext) {
		const deleted = await this.safeDeleteMessage(msg);
		if (!deleted) {
			await this.safeEditMessage(msg, '✅ 媒体已处理完成');
		}
	}

	private cleanupFiles(paths: string[]) {
		for (const filePath of paths) {
			try {
				if (fs.existsSync(filePath)) {
					fs.unlinkSync(filePath);
				}
			} catch (err) {
				logger.warn('清理临时文件失败', err);
			}
		}
	}

	// ==================== 媒体检测 ====================

	private isSupportedMedia(media: MessageMedia): media is Photo | Sticker | Video | Audio | Document {
		if (!media) return false;
		if (media.type === 'photo') return true;
		if (media.type === 'sticker' || media.type === 'video' || media.type === 'audio' || media.type === 'document') {
			const mime = media.mimeType || '';
			const fileName = media.fileName;
			if (fileName && fileName.toLowerCase().endsWith('.gif.mp4')) return true;
			return mime.startsWith('image/') || mime === 'video/webm' || mime.endsWith('/webm');
		}
		return false;
	}

	private isGifMedia(media: MessageMedia): boolean {
		if (!media || media.type === 'photo') return false;
		const doc = media as RawDocument;
		const fileName = doc.fileName;
		if (fileName && fileName.toLowerCase().endsWith('.gif.mp4')) return true;
		return doc.mimeType.toLowerCase().includes('gif');
	}

	private isWebmMedia(media: MessageMedia): boolean {
		if (!media || media.type === 'photo') return false;
		const doc = media as RawDocument;
		return doc.mimeType.toLowerCase().includes('webm');
	}

	private getExtensionFromMedia(media: MessageMedia): string {
		if (!media || media.type === 'photo') return '.jpg';
		if (media.type === 'sticker') return '.webp';
		const doc = media as RawDocument;
		const fileName = doc.fileName;
		if (fileName && fileName.toLowerCase().endsWith('.gif.mp4')) return '.gif.mp4';
		return this.getExtensionFromMime(doc.mimeType);
	}

	private getExtensionFromMime(mime?: string): string {
		if (!mime) return '.jpg';
		if (mime.includes('png')) return '.png';
		if (mime.includes('webp')) return '.webp';
		if (mime.includes('bmp')) return '.bmp';
		if (mime.includes('gif')) return '.gif';
		if (mime.includes('webm')) return '.webm';
		if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
		return '.jpg';
	}

	// ==================== FFmpeg 转换 ====================

	private async runFfmpegTransform(options: TransformOptions): Promise<void> {
		const { inputPath, outputPath, flipMode, invertColors, isGif, isWebm } =
			options;

		const filters = this.buildVideoFilters(flipMode, invertColors);
		const args = this.buildFfmpegArgs(
			inputPath,
			outputPath,
			filters,
			isGif,
			isWebm
		);

		try {
			await execFileAsync('ffmpeg', args);
		} catch (error: any) {
			if (error?.code === 'ENOENT') {
				throw new Error('未找到 ffmpeg，请先安装后再试');
			}
			const stderr =
				typeof error?.stderr === 'string' ? error.stderr.trim() : '';
			if (stderr) {
				throw new Error(`ffmpeg 处理失败: ${stderr.split('\n')[0]}`);
			}
			throw new Error(`ffmpeg 处理失败: ${error?.message || String(error)}`);
		}
	}

	private buildVideoFilters(
		flipMode: FlipMode,
		invertColors: boolean
	): string[] {
		const filters: string[] = [];

		if (flipMode === 'v') {
			filters.push('vflip');
		} else if (flipMode === 'h') {
			filters.push('hflip');
		}

		if (invertColors) {
			filters.push('negate');
		}

		return filters;
	}

	private buildFfmpegArgs(
		inputPath: string,
		outputPath: string,
		filters: string[],
		isGif: boolean,
		isWebm: boolean
	): string[] {
		const args = ['-y', '-i', inputPath];
		const filterChain = filters.join(',');

		// GIF 使用调色板优化保持质量
		if (isGif) {
			const baseFilter = filterChain || 'null';
			const paletteGraph = `[0:v]${baseFilter}[flip];[flip]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer`;
			args.push('-filter_complex', paletteGraph, '-loop', '0');
		} else if (filterChain) {
			args.push('-vf', filterChain);
		}

		// WebM 特殊编码参数（贴纸格式）
		if (isWebm) {
			args.push(
				'-c:v',
				'libvpx-vp9',
				'-pix_fmt',
				'yuva420p',
				'-b:v',
				'0',
				'-crf',
				'32',
				'-auto-alt-ref',
				'0'
			);
		}

		args.push(outputPath);
		return args;
	}

	// ==================== 参数解析 ====================

	// 解析媒体处理参数: h=水平翻转, v=垂直翻转, c=颜色反转
	private extractMediaOptions(args: string[]): MediaOptions {
		let flipMode: FlipMode = null;
		let flipSpecified = false;
		let invertColors = false;
		let index = 0;
		const totalArgs = args.length;

		while (index < args.length) {
			const token = args[index].toLowerCase();

			if (token === 'h') {
				flipMode = 'h';
				flipSpecified = true;
				index++;
			} else if (token === 'v') {
				flipMode = 'v';
				flipSpecified = true;
				index++;
			} else if (token === 'c') {
				invertColors = true;
				index++;
			} else {
				break;
			}
		}

		// 默认行为：如果只有 c 参数，不添加翻转；否则默认水平翻转
		if (
			!flipSpecified &&
			!(invertColors && index === totalArgs && totalArgs > 0)
		) {
			flipMode = 'h';
		}

		return {
			flipMode,
			invertColors,
			remaining: args.slice(index),
		};
	}

	// ==================== 工具方法 ====================

	private async safeEditMessage(
		msg: MessageContext,
		text: string
	): Promise<boolean> {
		try {
			await msg.edit({ text: html(text) });
			return true;
		} catch (error) {
			logger.warn('编辑消息失败', error);
			return false;
		}
	}

	private async safeDeleteMessage(msg: MessageContext): Promise<boolean> {
		try {
			await msg.delete();
			return true;
		} catch (error) {
			logger.warn('删除消息失败', error);
			return false;
		}
	}

	private htmlEscape(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}
}

const revPlugin = new REVPlugin();
export default revPlugin;
