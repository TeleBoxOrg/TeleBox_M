import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { execFile } from "child_process";
import { promisify } from "util";
import type { MessageContext } from "@mtcute/dispatcher";
import { npm_install_project_dependencies } from "@utils/npm_install";
import { getGlobalClient } from "@utils/runtimeManager";
import { executeExit } from "./reload";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";
import { updateAllPlugins } from "./tpm";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const execFileAsync = promisify(execFile);

// ── Auto-update state ──────────────────────────────────────────────────
const AUTO_UPDATE_STATE_DIR = path.join(os.homedir(), ".telebox");
const AUTO_UPDATE_STATE_FILE = path.join(AUTO_UPDATE_STATE_DIR, "auto_update.json");

interface AutoUpdateState {
  enabled: boolean;
}

function loadAutoUpdateState(): AutoUpdateState {
  try {
    if (fs.existsSync(AUTO_UPDATE_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(AUTO_UPDATE_STATE_FILE, "utf8"));
    }
  } catch (e: unknown) {
    logger.warn("[auto-update] 读取状态文件失败:", e);
  }
  return { enabled: false };
}

function saveAutoUpdateState(state: AutoUpdateState): void {
  try {
    fs.mkdirSync(AUTO_UPDATE_STATE_DIR, { recursive: true });
    fs.writeFileSync(AUTO_UPDATE_STATE_FILE, JSON.stringify(state), "utf8");
  } catch (e: unknown) {
    logger.error("[auto-update] 保存状态文件失败:", e);
  }
}

// ── Git helpers ────────────────────────────────────────────────────────
// Inject identity so git pull (which may create merge commits) doesn't fail
// on machines without global git config. Synced from teleproto 5ba6a97.
const GIT_USER_NAME = "TeleBox-Next Auto-Update";
const GIT_USER_EMAIL = "telebox@users.noreply.github.com";

async function gitExec(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", [
    "-c", `user.name=${GIT_USER_NAME}`,
    "-c", `user.email=${GIT_USER_EMAIL}`,
    ...args,
  ]);
}

async function getRemotes(): Promise<string[]> {
  try {
    const { stdout } = await gitExec(["remote"]);
    return stdout.trim().split("\n").filter((r) => r.trim());
  } catch {
    return [];
  }
}

async function getBranches(): Promise<string[]> {
  try {
    const { stdout } = await gitExec(["branch", "-r"]);
    const branches = stdout
      .trim()
      .split("\n")
      .map((b) => b.trim().replace(/^\*/, "").trim())
      .filter((b) => b && !b.includes("->"));
    return branches;
  } catch {
    return [];
  }
}

async function findMainBranch(): Promise<{ remote: string; branch: string } | null> {
  const [branches, allRemotes] = await Promise.all([getBranches(), getRemotes()]);
  const mainBranchNames = ["main", "master"];

  const remotes = allRemotes.includes("origin")
    ? ["origin", ...allRemotes.filter((r) => r !== "origin")]
    : allRemotes;

  for (const branchName of mainBranchNames) {
    for (const remote of remotes) {
      const fullBranch = `${remote}/${branchName}`;
      if (branches.includes(fullBranch)) {
        return { remote, branch: branchName };
      }
      if (branches.includes(branchName)) {
        return { remote, branch: branchName };
      }
    }
  }

  return null;
}

// ── Manual update (existing) ───────────────────────────────────────────
async function update(force = false, msg: MessageContext) {
  await msg.edit({ text: "🚀 正在更新项目..." });
  logger.info("🚀 开始更新项目...\n");

  try {
    const branchInfo = await findMainBranch();
    if (!branchInfo) {
      throw new Error("未找到可用的远程分支 (main/master)。请确保已配置 git remote。");
    }

    const { remote, branch } = branchInfo;
    const fullBranch = `${remote}/${branch}`;

    await gitExec(["fetch", "--all"]);
    await msg.edit({ text: "🔄 正在拉取最新代码..." });

    if (force) {
      logger.info(`⚠️ 强制回滚到 ${fullBranch}...`);
      await gitExec(["reset", "--hard", fullBranch]);
      await msg.edit({ text: "🔄 强制更新中..." });
    }

    await gitExec(["pull", remote, branch, "--no-rebase"]);
    await msg.edit({ text: "🔄 正在合并最新代码..." });

    logger.info("\n📦 安装依赖...");
    await msg.edit({ text: "📦 正在安装依赖..." });
    npm_install_project_dependencies();

    logger.info("\n✅ 更新完成。");

    await executeExit(msg, {
      pendingText: "🔄 正在重启进程...",
      successText: "✅ 更新完成，耗时 {elapsedMs}ms",
    });
  } catch (error: unknown) {
    logger.error("❌ 更新失败:", error);

    const errObj = error as Record<string, unknown>;
    const errCmd = errObj.cmd as string || "";
    const errDetail = (errObj.stderr as string) || getErrorMessage(error) || String(error);

    const errorText =
      `❌ 更新失败\n` +
      (errCmd ? `失败命令行：${errCmd}\n` : "") +
      `失败原因：${errDetail}\n\n` +
      "如果是 Git 冲突，请手动解决后再更新，或使用 .update -f 强制更新（会丢弃本地改动）";

    try {
      await msg.edit({ text: errorText });
    } catch (editError: unknown) {
      logger.error("Failed to send error message after update failure:", editError);
      try {
        const client = await getGlobalClient();
        const targetChat = msg.chat.id;
        if (client && targetChat) {
          await client.sendText(targetChat, errorText);
        }
      } catch (sendError: unknown) {
        logger.error("Failed to send error via fallback client:", sendError);
      }
    }
  }
}

// ── Auto-update helpers: mtcute replyText() returns raw Message, cast to MessageContext ──
async function replyAsCtx(msg: MessageContext, text: string): Promise<MessageContext> {
  return (await msg.replyText(text)) as unknown as MessageContext;
}

async function deleteMsgSafe(m: MessageContext | undefined): Promise<void> {
  if (!m) return;
  // Snapshot chat.id before any blocking operation — m may become stale after reload.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chatId = (m as any).chat?.id;
  const msgId = m.id;
  if (!chatId) return;
  try {
    const client = await getGlobalClient();
    await client.deleteMessagesById(chatId, [msgId], { revoke: true });
  } catch (_) { /* ignore */ }
}

/**
 * Delete a status message by chatId+msgId using a fresh client.
 * After npm install / reloadRuntime the connection may be dead — retry with
 * backoff, then queue to ~/.telebox/pending_status_deletes.json for next boot.
 */
async function deleteStatusMessage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chatId: any,
  msgId: number
): Promise<boolean> {
  const peer = chatId == null ? null : String(chatId);
  if (!peer || !msgId) return false;
  const delays = [0, 2000, 4000, 8000, 15000];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) {
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
    try {
      const client = await getGlobalClient();
      await client.deleteMessagesById(peer, [msgId], { revoke: true });
      logger.info(`[auto-update] 状态消息已删除 (attempt ${attempt + 1})`);
      return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      logger.error(`[auto-update] 删除状态消息失败 (attempt ${attempt + 1}): ${err?.message || err}`);
    }
  }
  logger.error("[auto-update] 状态消息删除最终失败 — 写入待删队列");
  try {
    const file = path.join(os.homedir(), ".telebox", "pending_status_deletes.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let items: Array<{ chatId: string; msgId: number; queuedAt: number }> = [];
    if (fs.existsSync(file)) {
      try { items = JSON.parse(fs.readFileSync(file, "utf8")); } catch { items = []; }
    }
    if (!Array.isArray(items)) items = [];
    items = items.filter((x) => !(x.chatId === peer && x.msgId === msgId));
    items.push({ chatId: peer, msgId, queuedAt: Date.now() });
    fs.writeFileSync(file, JSON.stringify(items.slice(-50), null, 2), "utf8");
  } catch (e) {
    logger.error("[auto-update] 写入待删队列失败:", e);
  }
  return false;
}

/** Flush deletes that failed while the client was dead. */
export async function flushPendingStatusDeletes(): Promise<void> {
  const file = path.join(os.homedir(), ".telebox", "pending_status_deletes.json");
  if (!fs.existsSync(file)) return;
  let items: Array<{ chatId: string; msgId: number; queuedAt: number }> = [];
  try { items = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
  if (!Array.isArray(items) || items.length === 0) return;
  logger.info(`[auto-update] flushing ${items.length} pending status delete(s)`);
  const remaining: typeof items = [];
  for (const item of items) {
    if (Date.now() - item.queuedAt > 7 * 24 * 3600 * 1000) continue;
    try {
      const client = await getGlobalClient();
      await client.deleteMessagesById(item.chatId, [item.msgId], { revoke: true });
      logger.info(`[auto-update] pending delete ok chat=${item.chatId} msg=${item.msgId}`);
    } catch (err: unknown) {
      logger.warn(`[auto-update] pending delete still failing:`, err);
      remaining.push(item);
    }
  }
  fs.writeFileSync(file, JSON.stringify(remaining, null, 2), "utf8");
}

async function editMsgSafe(m: MessageContext | undefined, text: string): Promise<void> {
  if (!m) return;
  try {
    // replyText() returns raw Message — .edit() doesn't exist.
    // Use client.editMessage with chat.id and message id.
    const client = await getGlobalClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chatId = (m as any).chat?.id;
    if (chatId) {
      await client.editMessage({ chatId, message: m.id, text });
    }
  } catch (_) { /* ignore */ }
}

// ── Auto-update for main repo ──────────────────────────────────────────
/** React ✅ on GitHubBot commit message (success signal; no chat spam). */
async function reactSuccessOnGithubMsg(githubMsg: MessageContext): Promise<void> {
  try {
    const client = await getGlobalClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chatId = (githubMsg as any).chat?.id ?? (githubMsg as any).chatId;
    if (chatId == null || githubMsg.id == null) return;
    await client.sendReaction({
      chatId,
      message: githubMsg.id,
      emoji: "✅",
    });
    logger.info(`[auto-update] ✅ reaction on msg ${githubMsg.id}`);
  } catch (e: unknown) {
    logger.warn("[auto-update] ✅ reaction failed:", getErrorMessage(e) || e);
  }
}

async function autoUpdateMainRepo(githubMsg: MessageContext): Promise<void> {
  // Silent success: no status replies. Errors only.
  try {
    const branchInfo = await findMainBranch();
    if (!branchInfo) {
      throw new Error("未找到可用的远程分支");
    }
    const { remote, branch } = branchInfo;

    await gitExec(["fetch", "--all"]);
    await gitExec(["pull", remote, branch, "--no-rebase"]);
    npm_install_project_dependencies();

    await reactSuccessOnGithubMsg(githubMsg);
    await executeAutoExit();
  } catch (error: unknown) {
    const errDetail = getErrorMessage(error) || String(error);
    logger.error("[auto-update] 主仓库更新失败:", errDetail);
    try {
      await githubMsg.replyText(`❌ 自动更新失败：${errDetail}`);
    } catch (_) {}
  }
}

async function executeAutoExit(): Promise<void> {
  logger.info("[auto-update] 更新完成，退出进程…");
  process.exit(0);
}

// ── Auto-update for plugin repos ───────────────────────────────────────
async function autoUpdatePlugins(githubMsg: MessageContext): Promise<void> {
  try {
    const result = await updateAllPlugins(githubMsg, { silent: true });

    if (result.failedCount === 0) {
      await reactSuccessOnGithubMsg(githubMsg);
      return;
    }
    try {
      await githubMsg.replyText(`❌ 插件自动更新失败：${result.failedCount} 个插件更新失败`);
    } catch (_) {}
  } catch (error: unknown) {
    const errDetail = getErrorMessage(error) || String(error);
    logger.error("[auto-update] 插件更新异常:", errDetail);
    try {
      await githubMsg.replyText(`❌ 插件自动更新失败：${errDetail}`);
    } catch (_) {}
  }
}

// ── GitHubBot message parsing ──────────────────────────────────────────
// Any chat with GitHubBot commit posts (product channel + telebox 群绑定)
/** Legacy product channel (no longer required; any chat with GitHubBot works). */
const _GITHUB_CHANNEL_ID_LEGACY = "-1003061608291";
void _GITHUB_CHANNEL_ID_LEGACY;
const GITHUB_BOT_USER_ID = "107550100";
const GITHUB_BOT_USERNAME = "githubbot";

// Next edition only reacts to Next repos (not classic TeleBox / TeleBox-Plugins alone).
// Accept TeleBoxOrg / TeleBoxLabs / bare names.
const MAIN_REPO_PATTERN =
  /new commit[\s\S]*?to\s+(?:(?:TeleBoxOrg|TeleBoxLabs)\/)?(TeleBox-Next)\s*:\s*main/i;
const PLUGIN_REPO_PATTERN =
  /new commit[\s\S]*?to\s+(?:(?:TeleBoxOrg|TeleBoxLabs)\/)?(TeleBox-Next-Plugins|TeleBox-Next_Plugins|TeleBox_M_Plugins)\s*:\s*main/i;

function normalizeChatId(msg: MessageContext): string {
  const id = msg.chat?.id;
  if (id != null) return String(id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyMsg = msg as any;
  if (anyMsg.chatId != null) return String(anyMsg.chatId);
  return "";
}

function isGitHubBot(msg: MessageContext): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sender = msg.sender as any;
  const sid = sender?.id != null ? String(sender.id) : "";
  if (sid && sid === GITHUB_BOT_USER_ID) return true;
  const uname = String(sender?.username || "").toLowerCase().replace(/^@/, "");
  if (uname === GITHUB_BOT_USERNAME) return true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyMsg = msg as any;
  if (anyMsg.senderId != null && String(anyMsg.senderId) === GITHUB_BOT_USER_ID) return true;
  return false;
}

class UpdatePlugin extends Plugin {
  description: string =
    `更新项目：拉取最新代码并安装依赖\n` +
    `<code>${mainPrefix}update -f/-force</code> 强制更新\n` +
    `<code>${mainPrefix}update auto on</code> / <code>off</code> 自动更新开关（默认关闭）`;

  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    update: async (msg) => {
      const parts = msg.text.slice(1).split(" ").slice(1);

      if (parts[0] === "auto") {
        const sub = parts[1]?.toLowerCase();
        if (sub === "on") {
          saveAutoUpdateState({ enabled: true });
          await msg.edit({
            text:
              "✅ 自动更新已开启\n\n" +
              "任意会话中 GitHubBot 推送 Next 仓库（TeleBox-Next / TeleBox-Next-Plugins，含 TeleBoxLabs 镜像）提交时自动更新。\n" +
              "成功：仅在 commit 消息上 ✅；失败：回复错误。",
          });
          return;
        }
        if (sub === "off") {
          saveAutoUpdateState({ enabled: false });
          await msg.edit({ text: "🔒 自动更新已关闭" });
          return;
        }
        const state = loadAutoUpdateState();
        await msg.edit({
          text: `自动更新状态：${state.enabled ? "✅ 开启" : "🔒 关闭"}\n\n使用 <code>${mainPrefix}update auto on/off</code> 切换`,
        });
        return;
      }

      const force = parts.includes("--force") || parts.includes("-f");
      await update(force, msg);
    },
  };

  listenMessageHandler = async (msg: MessageContext): Promise<void> => {
    const state = loadAutoUpdateState();
    if (!state.enabled) return;

    if (!isGitHubBot(msg)) return;

    const text = msg.text || "";
    if (!text || !/new commit/i.test(text)) return;

    const chatId = normalizeChatId(msg);
    if (PLUGIN_REPO_PATTERN.test(text)) {
      logger.info(`[auto-update] chat=${chatId || "?"} 插件仓库提交 → silent update`);
      await autoUpdatePlugins(msg);
    } else if (MAIN_REPO_PATTERN.test(text)) {
      logger.info(`[auto-update] chat=${chatId || "?"} 主仓库提交 → silent update`);
      await autoUpdateMainRepo(msg);
    }
  };
}

export default new UpdatePlugin();
