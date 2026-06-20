import { Plugin, type PluginRuntimeContext } from "@utils/pluginBase";
import { html } from "@mtcute/html-parser";
import type { MessageContext } from "@mtcute/dispatcher";

import { safeGetMessages } from "@utils/safeGetMessages";
import { getGlobalClient } from "@utils/globalClient";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";
import { spawn, type ChildProcess } from "child_process";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { getPrefixes } from "@utils/pluginManager";
import type { GenerationContext } from "@utils/generationContext";
import { tryGetCurrentGenerationContext } from "@utils/runtimeManager";
import { logger } from "@utils/logger";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
// 时区设置
const CN_TIME_ZONE = "Asia/Shanghai";

function formatCN(date: Date): string {
  return date.toLocaleString("zh-CN", { timeZone: CN_TIME_ZONE });
}

async function formatEntity(
  target: any,
  mention?: boolean,
  throwErrorIfFailed?: boolean
) {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");
  if (!target) throw new Error("无效的目标");
  let id: any;
  let entity: any;
  try {
    // If target is already an mtcute entity (has _type marker), use it directly;
    // otherwise resolve it via getChat
    entity = target?._type
      ? target
      : await client.getChat(target);
    if (!entity) throw new Error("无法获取 entity");
    id = entity.id;
    if (!id) throw new Error("无法获取 entity id");
  } catch (e: any) {
    logger.error(e);
    if (throwErrorIfFailed)
      throw new Error(
        `无法获取 ${target} 的 entity: ${e?.message || "未知错误"}`
      );
  }
  const displayParts: string[] = [];

  if (entity?.title) displayParts.push(entity.title);
  if (entity?.firstName) displayParts.push(entity.firstName);
  if (entity?.lastName) displayParts.push(entity.lastName);
  if (entity?.username)
    displayParts.push(
      mention ? `@${entity.username}` : `<code>@${entity.username}</code>`
    );

  if (id) {
    displayParts.push(
      "firstName" in entity
        ? `<a href="tg://user?id=${id}">${id}</a>`
        : `<a href="https://t.me/c/${id}">${id}</a>`
    );
  } else if (!target?._type) {
    displayParts.push(`<code>${target}</code>`);
  }

  return {
    id,
    entity,
    display: displayParts.join(" ").trim(),
  };
}

// 类型定义
interface BackupConfig {
  target_chat_ids: string[];
}

interface FileInfo {
  file_name: string;
  file_size: number;
  message_id: number;
  chat_id: number;
  date: string;
}

// 配置管理类
class ConfigManager {
  private static db: Low<BackupConfig> | null = null;

  static async getDB(): Promise<Low<BackupConfig>> {
    if (!this.db) {
      const configDir = createDirectoryInAssets("bf");
      const configPath = path.join(configDir, "bf_config.json");
      const adapter = new JSONFile<BackupConfig>(configPath);
      this.db = new Low<BackupConfig>(adapter, { target_chat_ids: [] });
      await this.db.read();
    }
    return this.db;
  }

  static async getTargets(): Promise<string[]> {
    const db = await this.getDB();
    return db.data.target_chat_ids || [];
  }

  static async setTargets(targets: string[]): Promise<void> {
    const db = await this.getDB();
    db.data.target_chat_ids = targets;
    await db.write();
  }

  static async addTargets(newTargets: string[]): Promise<string[]> {
    const current = await this.getTargets();
    const combined = [...new Set([...current, ...newTargets])];
    await this.setTargets(combined);
    return combined;
  }

  static async removeTarget(target: string): Promise<string[]> {
    if (target === "all") {
      await this.setTargets([]);
      return [];
    }
    const current = await this.getTargets();
    const filtered = current.filter((t) => t !== target);
    await this.setTargets(filtered);
    return filtered;
  }

  static cleanup(): void {
    this.db = null;
  }
}

// 工具函数
function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9_.-]/g, "_").substring(0, 100);
}

function generateBackupName(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "_");
  const randomId = crypto.randomBytes(4).toString("hex");
  return sanitizeFilename(`telebox_backup_${timestamp}_${randomId}.tar.gz`);
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string") return new Error(reason);
  return new Error("Backup operation aborted");
}

function throwIfAborted(lifecycle: GenerationContext): void {
  if (lifecycle.signal.aborted) {
    throw abortError(lifecycle.signal.reason);
  }
}

function trackChildProcess<T extends ChildProcess>(
  child: T,
  lifecycle: GenerationContext,
  label: string
): T {
  return lifecycle.trackChildProcess(child, { label }) as T;
}

// 创建备份压缩包
async function createBackup(
  dirs: string[],
  outputPath: string,
  lifecycle: GenerationContext
): Promise<void> {
  const tempDir = path.join(
    os.tmpdir(),
    `backup_${crypto.randomBytes(8).toString("hex")}`
  );
  const backupDir = path.join(tempDir, "telebox_backup");

  try {
    // 创建临时目录
    fs.mkdirSync(backupDir, { recursive: true });

    // 复制目录
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;

      const baseName = path.basename(dir);
      const targetDir = path.join(backupDir, baseName);

      copyDirRecursive(dir, targetDir);
    }

    // 创建tar.gz
    await lifecycle.runTask(
      async () =>
        await new Promise<void>((resolve, reject) => {
          const tar = trackChildProcess(spawn("tar", [
            "-czf",
            outputPath,
            "-C",
            tempDir,
            "telebox_backup",
          ]), lifecycle, "bf:create-tar");

          tar.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`tar exited with code ${code}`));
          });

          tar.on("error", reject);
          throwIfAborted(lifecycle);
        }),
      { label: "bf:create-tar" }
    );
  } finally {
    // 清理临时目录
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      /* ignored */
    } catch { /* ignored */ }
  }
}

// 递归复制目录
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 解压备份文件
async function extractBackup(archivePath: string, lifecycle: GenerationContext): Promise<string> {
  const extractDir = path.join(os.tmpdir(), `extract_${Date.now()}`);
  fs.mkdirSync(extractDir, { recursive: true });

  await lifecycle.runTask(
    async () =>
      await new Promise<void>((resolve, reject) => {
        const tar = trackChildProcess(
          spawn("tar", ["-xzf", archivePath, "-C", extractDir]),
          lifecycle,
          "bf:extract-tar"
        );

        tar.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`tar exited with code ${code}`));
        });

        tar.on("error", reject);
        throwIfAborted(lifecycle);
      }),
    { label: "bf:extract-tar" }
  );

  return extractDir;
}

// 恢复备份
async function restoreBackup(extractPath: string): Promise<void> {
  const programDir = process.cwd();
  const backupRoot = path.join(extractPath, "telebox_backup");

  if (!fs.existsSync(backupRoot)) {
    throw new Error("无效的备份文件格式");
  }

  // 创建当前状态备份
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  const currentBackupDir = path.join(
    programDir,
    `_restore_backup_${timestamp}`
  );
  fs.mkdirSync(currentBackupDir, { recursive: true });

  // 恢复 plugins 和 assets
  const dirs = ["plugins", "assets"];

  for (const dir of dirs) {
    const currentPath = path.join(programDir, dir);
    const backupPath = path.join(backupRoot, dir);
    const savePath = path.join(currentBackupDir, dir);

    // 备份当前目录
    if (fs.existsSync(currentPath)) {
      copyDirRecursive(currentPath, savePath);
      fs.rmSync(currentPath, { recursive: true, force: true });
    }

    // 恢复备份
    if (fs.existsSync(backupPath)) {
      copyDirRecursive(backupPath, currentPath);
    }
  }

  logger.info(`恢复完成，原文件备份在: ${currentBackupDir}`);
}

const help_text = `<code>${mainPrefix}bf</code> 备份 plugins + assets 目录
<code>${mainPrefix}bf all</code> - 备份整个程序（包含所有文件）
<code>${mainPrefix}bf set 对话ID</code> - 设置备份发送到的目标对话
<code>${mainPrefix}bf to 对话ID</code> - 仅本次备份发送到目标对话
<code>${mainPrefix}bf del 对话ID/all</code> - 删除备份发送到的目标对话
<code>${mainPrefix}hf</code> 恢复备份`;

// 插件类
class BfPlugin extends Plugin {
  private lifecycle: GenerationContext | null = null;

  setup(context: PluginRuntimeContext): void {
    this.lifecycle = context.lifecycle;
  }

  cleanup(): void {
    this.lifecycle = null;
    ConfigManager.cleanup();
  }

  private getLifecycle(): GenerationContext {
    // Prefer setup()-injected lifecycle; fall back to the live runtime context
    // if setup() was skipped due to a sibling plugin's setup failure (avoids
    // the spurious "Backup plugin lifecycle is not initialized" error).
    let lifecycle = this.lifecycle;
    if (!lifecycle || lifecycle.signal.aborted) {
      const fallback = tryGetCurrentGenerationContext();
      if (fallback && !fallback.signal.aborted) {
        this.lifecycle = fallback;
        lifecycle = fallback;
      }
    }
    if (!lifecycle) {
      throw new Error("Backup plugin lifecycle is not initialized");
    }
    throwIfAborted(lifecycle);
    return lifecycle;
  }

  description = `\n📦 备份插件\n\n${help_text}

若想实现定时备份, 可安装并使用 <code>${mainPrefix}tpm i acron</code>
每天2点自动备份(调用 <code>${mainPrefix}bf</code> 命令)

<pre>${mainPrefix}acron cmd 0 0 2 * * * me 定时备份
.bf</pre>
`;

  cmdHandlers = {
    bf: async (msg: MessageContext) => {
      const lifecycle = this.getLifecycle();
      const args = (msg.text || "").slice(1).split(" ").slice(1);
      const cmd = args[0] || "";

      // 设置目标
      if (cmd === "set") {
        if (args.length < 2) {
          await msg.edit({
            text: html(help_text),
          });
          return;
        }

        const ids = args
          .slice(1)
          .join(" ")
          .replace(/,/g, " ")
          .split(/\s+/)
          .filter(Boolean);
        const valid = ids
          .filter((id) => /^-?\d+$/.test(id))
          .map((id) => {
            // 自动转换100开头的频道ID为负数
            if (/^100\d+$/.test(id)) {
              return `-${id}`;
            }
            return id;
          });

        if (valid.length === 0) {
          await msg.edit({ text: "❌ 无效的聊天ID" });
          return;
        }

        const targets = await ConfigManager.addTargets(valid);
        await msg.edit({
          text: html(`✅ 目标已更新: ${targets.join(", ") || "无"}`),
        });
        return;
      }

      // 删除目标
      if (cmd === "del") {
        if (args.length < 2) {
          await msg.edit({
            text: html(help_text),
          });
          return;
        }

        const target = args[1];
        const remaining = await ConfigManager.removeTarget(target);

        await msg.edit({
          text: html(
            target === "all"
              ? "✅ 已清空所有目标"
              : `✅ 已删除 ${target}<br>当前目标: ${
                  remaining.join(", ") || "无"
                }`
          ),
        });
        return;
      }

      // 支持一次性目标: .bf to 对话ID
      let oneTimeTargets: string[] | null = null;
      if (cmd === "to") {
        if (args.length < 2) {
          await msg.edit({
            text: html(help_text),
          });
          return;
        }
        const ids = args
          .slice(1)
          .join(" ")
          .replace(/,/g, " ")
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => {
            // 自动转换100开头的频道ID为负数
            if (/^100\d+$/.test(id)) {
              return `-${id}`;
            }
            return id;
          });
        if (ids.length === 0) {
          await msg.edit({ text: "❌ 无效的聊天ID" });
          return;
        }
        oneTimeTargets = ids;
      }

      // 执行备份
      const client = await getGlobalClient();

      try {
        await msg.edit({ text: "🔄 正在创建备份..." });

        const programDir = process.cwd();
        const backupName = generateBackupName();
        const backupPath = path.join(os.tmpdir(), backupName);

        if (cmd === "all") {
          const parentDir = path.dirname(programDir);
          const dirName = path.basename(programDir);
          
          await lifecycle.runTask(
            async () =>
              await new Promise<void>((resolve, reject) => {
                  const tar = trackChildProcess(spawn("tar", [
                    "-cf",
                    "-",
                    "-C",
                    parentDir,
                    "--exclude=node_modules",
                    "--exclude=.git",
                    "--exclude=my_session",
                    "--exclude=temp",
                    "--exclude=logs",
                    dirName,
                  ], { stdio: ["pipe", "pipe", "pipe"] }), lifecycle, "bf:full-tar");

                  const gzip = trackChildProcess(
                    spawn("gzip", ["-1"], { stdio: ["pipe", "pipe", "pipe"] }),
                    lifecycle,
                    "bf:full-gzip"
                  );

                  const output = fs.createWriteStream(backupPath);

                  tar.stdout.pipe(gzip.stdin);
                  gzip.stdout.pipe(output);

                  let tarError = "";
                  let gzipError = "";
                  tar.stderr.on("data", (d) => (tarError += d.toString()));
                  gzip.stderr.on("data", (d) => (gzipError += d.toString()));

                  output.on("finish", () => resolve());
                  output.on("error", reject);
                  tar.on("error", reject);
                  gzip.on("error", reject);
                  tar.on("close", (code) => {
                    if (code !== 0) reject(new Error(`tar: ${tarError || code}`));
                  });
                  gzip.on("close", (code) => {
                    if (code !== 0) reject(new Error(`gzip: ${gzipError || code}`));
                  });
                  throwIfAborted(lifecycle);
              }),
            { label: "bf:full-backup-pipeline" }
          );
        } else {
          const dirsToBackup = [
            path.join(programDir, "plugins"),
            path.join(programDir, "assets"),
          ].filter(fs.existsSync);

          if (dirsToBackup.length === 0) {
            await msg.edit({
              text: "❌ 没有找到可备份的目录",
            });
            return;
          }

          await createBackup(dirsToBackup, backupPath, lifecycle);
        }

        await msg.edit({ text: "📤 正在上传备份..." });

        const stats = fs.statSync(backupPath);
        const backupType = cmd === "all" ? "全量备份" : "标准备份";
        const contentDesc = cmd === "all" 
          ? "程序目录（排除node_modules等）"
          : "plugins, assets";
        
        const caption =
          `📦 <b>TeleBox ${backupType}</b>\n\n` +
          `🕐 <b>时间</b>: ${formatCN(new Date())}\n` +
          `📊 <b>大小</b>: ${(stats.size / 1024 / 1024).toFixed(2)} MB\n` +
          `📋 <b>内容</b>: ${contentDesc}`;

        // 上传文件
        const savedTargets = await ConfigManager.getTargets();
        const destinations =
          oneTimeTargets && oneTimeTargets.length > 0
            ? oneTimeTargets
            : savedTargets.length > 0
            ? savedTargets
            : ["me"];
        const destDisplays = [];

        for (const dest of destinations) {
          const { display } = await formatEntity(dest);
          destDisplays.push(display);
          try {
            await client.sendMedia(dest, {
              type: "document",
              file: backupPath,
              caption: html(caption),
              fileName: backupName,
            });
          } catch (err) {
            logger.error(`发送到 ${dest} 失败:`, err);
            if (dest !== "me") {
              await client.sendMedia("me", {
                type: "document",
                file: backupPath,
                caption: html(`⚠️ 发送到 ${dest} 失败<br><br>${caption}`),
                fileName: backupName,
              });
            }
          }
        }

        const backupTypeDisplay = cmd === "all" ? "全量备份" : "备份";
        const contentDisplay = cmd === "all" 
          ? "程序目录（排除node_modules等）"
          : "plugins, assets";
        
        await msg.edit({
          text: html(
            `✅ <b>${backupTypeDisplay}完成</b><br><br>` +
            `🎯 <b>发送到</b>: ${destDisplays.join(", ")}\n` +
            `📦 <b>内容</b>: ${contentDisplay}\n` +
            `💾 <b>大小</b>: ${(stats.size / 1024 / 1024).toFixed(2)} MB`
          ),
        });
      } catch (error) {
        await msg.edit({
          text: `❌ 备份失败: ${String(error)}`,
        });
      } finally {
        try {
          const backupName = generateBackupName().replace(/[^a-zA-Z0-9]/g, "");
          const tempFiles = fs.readdirSync(os.tmpdir()).filter(
            (f) => f.includes("telebox_backup") && f.endsWith(".tar.gz")
          );
          for (const f of tempFiles) {
            fs.unlinkSync(path.join(os.tmpdir(), f));
          }
          /* ignored */
        } catch { /* ignored */ }
      }
    },

    hf: async (msg: MessageContext) => {
      const lifecycle = this.getLifecycle();
      const args = (msg.text || "").slice(1).split(" ").slice(1);
      const cmd = args[0] || "";

      if (cmd === "help" || cmd === "帮助") {
        await msg.edit({
          text: html(
            "🔄 <b>TeleBox 恢复系统</b><br><br>" +
            "📁 回复备份文件消息，发送 <code>hf</code> 恢复<br>" +
            "📦 支持格式: .tar.gz 备份文件<br>" +
            "🔄 恢复后会自动重载插件"
          ),
        });
        return;
      }

      if (!msg.replyToMessage) {
        await msg.edit({
          text: html("❌ 请回复一个备份文件消息后使用 <code>hf</code>"),
        });
        return;
      }

      const client = await getGlobalClient();

      try {
        // 获取回复的消息
        const messages = await safeGetMessages(client, msg.chat, {
          ids: [msg.replyToMessage!.id!],
        });

        const backupMsg = messages[0];
        const fileName = (backupMsg?.media as unknown as { fileName?: string })?.fileName ?? "";
        if (!fileName?.endsWith(".tar.gz")) {
          await msg.edit({
            text: "❌ 回复的消息不是有效的备份文件",
          });
          return;
        }

        await msg.edit({ text: "📥 正在下载备份..." });

        // Download file — backupMsg.media may be a Document (which extends FileLocation),
        // but TypeScript can't verify that through the MessageMedia union, so we cast.
        const tempPath = path.join(os.tmpdir(), `restore_${Date.now()}.tar.gz`);
        const media = backupMsg!.media as unknown as import("@mtcute/node").FileLocation;
        const buffer = await client.downloadAsBuffer(media);

        if (!buffer) {
          throw new Error("下载失败");
        }

        fs.writeFileSync(tempPath, buffer);

        await msg.edit({ text: "📦 正在解压备份..." });

        // 解压文件
        const extractPath = await extractBackup(tempPath, lifecycle);

        await msg.edit({ text: "🔄 正在恢复备份..." });

        // 恢复备份
        await restoreBackup(extractPath);

        // 清理临时文件
        try {
          fs.unlinkSync(tempPath);
          fs.rmSync(extractPath, { recursive: true, force: true });
          /* ignored */
        } catch { /* ignored */ }

        // 尝试重载插件
        try {
          const pluginManager = require("@utils/pluginManager");
          if (pluginManager.loadPlugins) {
            await pluginManager.loadPlugins();
            await msg.edit({
              text: "✅ 恢复完成并已重载插件",
            });
          } else {
            await msg.edit({
              text: "✅ 恢复完成，请重启程序",
            });
          }
        } catch {
          await msg.edit({
            text: "✅ 恢复完成，请重启程序",
          });
        }
      } catch (error) {
        await msg.edit({
          text: `❌ 恢复失败: ${String(error)}`,
        });
      }
    },
  };
}

export default new BfPlugin();