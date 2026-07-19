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


/**
 * True when package.json differs between HEAD and remote branch after fetch.
 * Used to auto-escalate to force (reset --hard) so dependency range changes
 * land cleanly without local package.json merge noise.
 */
async function remotePackageJsonChanged(remote: string, branch: string): Promise<boolean> {
  try {
    const { stdout } = await gitExec([
      "diff",
      "--name-only",
      "HEAD",
      `${remote}/${branch}`,
      "--",
      "package.json",
    ]);
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .some((l) => l === "package.json" || l.endsWith("/package.json"));
  } catch {
    return false;
  }
}

/** Working tree has local modifications (tracked or untracked under git). */
async function hasLocalGitDirt(): Promise<boolean> {
  try {
    const { stdout } = await gitExec(["status", "--porcelain"]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Auto-update / 强制更新：对齐远程 tip。
 * 根因：VPS 上常见本地改动导致 `git pull` 拒绝合并，自动更新看起来“坏了”。
 * 自动路径一律 reset --hard；手动路径仅在 -f / package.json 变更 / 本地脏时强制。
 */
async function hardResetToRemote(remote: string, branch: string): Promise<void> {
  const full = `${remote}/${branch}`;
  await gitExec(["reset", "--hard", full]);
  // 清掉会挡住后续 pull/reset 的未跟踪冲突文件（不删 assets/config/session）
  try {
    await gitExec(["clean", "-fd", "--exclude=assets", "--exclude=config.json", "--exclude=session.db", "--exclude=plugins", "--exclude=.telebox", "--exclude=node_modules"]);
  } catch {
    /* clean 失败不阻断 */
  }
}

/** Serialize auto-update runs (GitHubBot 可能连发多条). */
let autoUpdateChain: Promise<void> = Promise.resolve();

function runAutoUpdateExclusive(label: string, fn: () => Promise<void>): Promise<void> {
  const prev = autoUpdateChain;
  const task = prev
    .catch(() => {
      /* previous failure must not block the queue */
    })
    .then(async () => {
      logger.info(`[auto-update] ${label}: start`);
      await fn();
    });
  // chain always settles so the next waiter is not stuck on rejection
  autoUpdateChain = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

/** GitHubBot 通知正文：text 优先，兼容 caption / raw. */
function getGithubNoticeText(msg: MessageContext): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyMsg = msg as any;
  const candidates = [
    msg.text,
    anyMsg.caption,
    anyMsg.raw?.text,
    anyMsg.raw?.message,
    anyMsg.message,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
  }
  return "";
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

    // package.json 变更 / 本地脏工作区 → 自动走 -f，避免 pull 因冲突静默失败
    if (!force && (await remotePackageJsonChanged(remote, branch))) {
      force = true;
      logger.info("📦 检测到 package.json 变更，自动切换为强制更新（等同 .update -f）");
      await msg.edit({ text: "📦 检测到 package.json 变更，自动强制更新..." });
    } else if (!force && (await hasLocalGitDirt())) {
      force = true;
      logger.info("📦 检测到本地未提交改动，自动切换为强制更新（等同 .update -f）");
      await msg.edit({ text: "📦 检测到本地改动，自动强制更新..." });
    }

    if (force) {
      logger.info(`⚠️ 强制回滚到 ${fullBranch}...`);
      await hardResetToRemote(remote, branch);
      await msg.edit({ text: "🔄 强制更新中..." });
    } else {
      try {
        await gitExec(["pull", remote, branch, "--no-rebase"]);
      } catch (pullErr: unknown) {
        // pull 冲突时降级 hard reset，避免“更新坏了”卡死
        logger.warn("[update] pull 失败，降级 reset --hard:", getErrorMessage(pullErr));
        await hardResetToRemote(remote, branch);
      }
      await msg.edit({ text: "🔄 正在合并最新代码..." });
    }

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

// ── Pending reaction: apply only AFTER the process fully restarts ───────
// The main-repo path restarts the process (npm install + exit). Reacting
// before exit lands while the OLD code is still (barely) running and the
// connection is being torn down. Instead we persist the intent and re-apply
// it once the NEW runtime is fully online — the moment equivalent to seeing
// the manual-update "已完成" summary.
//
// Root-cause notes (from production logs):
// 1) Persist chat ID as number (mtcute resolvePeer requires number, not string)
//    String(peer object) which becomes "[object Object]".
// 2) Prefer ❤ (API form of ❤️); fall back to 👍 if the pack disallows it.
const PENDING_REACTION_FILE = path.join(os.homedir(), ".telebox", "pending_reactions.json");
/** Prefer ❤️; keep common defaults as fallback for restricted packs. */
const SUCCESS_REACTION_EMOJIS = ["❤", "❤️", "👍"] as const;

interface PendingReaction {
  chatId: number;
  msgId: number;
  queuedAt: number;
}

function isUsableChatId(chatId: string | number): boolean {
  if (chatId == null || chatId === 0 || chatId === "") return false;
  const s = String(chatId);
  if (s === "[object Object]" || s === "undefined" || s === "null") return false;
  return true;
}

function loadPendingReactions(): PendingReaction[] {
  try {
    if (!fs.existsSync(PENDING_REACTION_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(PENDING_REACTION_FILE, "utf8"));
    if (!Array.isArray(raw)) return [];
    const out: PendingReaction[] = [];
    for (const x of raw) {
      if (!x || typeof x !== "object") continue;
      // Backward compat: old JSON used string chatIds (before number fix).
      const cid = typeof x.chatId === "string" && /^-?\d+$/.test(String(x.chatId))
        ? Number(x.chatId)
        : Number(x.chatId ?? 0);
      const mid = Number(x.msgId ?? 0);
      if (!isUsableChatId(cid) || !mid) continue;
      out.push({ chatId: cid, msgId: mid, queuedAt: Number(x.queuedAt ?? 0) });
    }
    return out;
  } catch {
    return [];
  }
}

function savePendingReactions(items: PendingReaction[]): void {
  try {
    fs.mkdirSync(path.dirname(PENDING_REACTION_FILE), { recursive: true });
    fs.writeFileSync(PENDING_REACTION_FILE, JSON.stringify(items.slice(-50), null, 2), "utf8");
  } catch (e) {
    logger.error("[auto-update] 保存待点 reaction 失败:", e);
  }
}

function queueReaction(chatId: number, msgId: number): void {
  if (!isUsableChatId(chatId) || !msgId) return;
  const items = loadPendingReactions().filter((x) => !(x.chatId === chatId && x.msgId === msgId));
  items.push({ chatId, msgId, queuedAt: Date.now() });
  savePendingReactions(items);
  logger.info(`[auto-update] queued reaction chat=${chatId} msg=${msgId} (apply after restart)`);
}

function isReactionInvalidError(err: unknown): boolean {
  const m = String(getErrorMessage(err) || err || "");
  return /REACTION_INVALID|reaction is invalid|specified reaction is invalid/i.test(m);
}

/** Send a success reaction with emoji fallback for restricted groups. */
/** Ensure chatId is a number for mtcute resolvePeer (string → username lookup, fails). */
function toPeerId(chatId: string | number): number | string {
  if (typeof chatId === "number") return chatId;
  // Non-numeric strings (e.g. usernames) pass through; numeric strings → number
  if (/^-?\d+$/.test(chatId)) return Number(chatId);
  return chatId;
}

/** Send a success reaction with emoji fallback for restricted groups. */
async function sendSuccessReaction(chatId: string | number, msgId: number): Promise<string> {
  const peerId = toPeerId(chatId);
  const client = await getGlobalClient();
  let lastErr: unknown;
  for (const emoji of SUCCESS_REACTION_EMOJIS) {
    try {
      await client.sendReaction({
        chatId: peerId,
        message: msgId,
        emoji,
      });
      return emoji;
    } catch (e: unknown) {
      lastErr = e;
      if (isReactionInvalidError(e)) continue;
      throw e;
    }
  }
  throw lastErr;
}

/** Apply queued reactions after the runtime is fully back online.
 * Called from runtimeManager once the new generation is running. */
export async function flushPendingReactions(): Promise<void> {
  const items = loadPendingReactions();
  if (items.length === 0) return;
  logger.info(`[auto-update] flushing ${items.length} pending reaction(s)`);
  const remaining: PendingReaction[] = [];
  for (const item of items) {
    if (Date.now() - item.queuedAt > 24 * 3600 * 1000) continue;
    if (!isUsableChatId(item.chatId)) continue;
    try {
      const used = await sendSuccessReaction(item.chatId, item.msgId);
      logger.info(`[auto-update] reaction ${used} applied chat=${item.chatId} msg=${item.msgId}`);
    } catch (err: unknown) {
      logger.warn("[auto-update] pending reaction still failing:", getErrorMessage(err) || err);
      const m = String(getErrorMessage(err) || err || "");
      if (/Cannot find any entity|No user has|PEER_ID_INVALID|CHAT_ID_INVALID|invalid reaction entity/i.test(m)) {
        continue;
      }
      if (isReactionInvalidError(err)) continue;
      remaining.push(item);
    }
  }
  savePendingReactions(remaining);
}

// ── Auto-update for main repo ──────────────────────────────────────────
/**
 * React on GitHubBot commit message after update finishes (success signal).
 * Plugin path captures chatId/msgId before silent loadPlugins()/reloadRuntime().
 */
async function reactSuccessOnGithubMsg(
  githubMsg: MessageContext,
  prefetched?: { chatId?: number; msgId?: number },
): Promise<void> {
  const chatId = prefetched?.chatId ?? normalizeChatId(githubMsg);
  const msgId = prefetched?.msgId ?? githubMsg.id;
  if (!isUsableChatId(chatId) || msgId == null) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const used = await sendSuccessReaction(chatId, msgId);
      logger.info(`[auto-update] reaction ${used} on msg ${msgId}`);
      return;
    } catch (e: unknown) {
      logger.warn(
        `[auto-update] reaction failed (attempt ${attempt}/3):`,
        getErrorMessage(e) || e,
      );
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function autoUpdateMainRepo(githubMsg: MessageContext): Promise<void> {
  // Silent success: no status replies. Errors only.
  // 自动路径一律 hard reset：VPS 本地脏文件是 pull 失败的首要根因。
  return runAutoUpdateExclusive("main", async () => {
    try {
      const branchInfo = await findMainBranch();
      if (!branchInfo) {
        throw new Error("未找到可用的远程分支");
      }
      const { remote, branch } = branchInfo;

      await gitExec(["fetch", "--all"]);
      logger.info(
        `[auto-update] 对齐 ${remote}/${branch}` +
          ((await remotePackageJsonChanged(remote, branch))
            ? "（含 package.json 变更）"
            : (await hasLocalGitDirt())
              ? "（含本地改动）"
              : ""),
      );
      await hardResetToRemote(remote, branch);

      // Reset succeeded → update is on disk. Process will restart after npm install.
      // React only after NEW runtime is online (flushPendingReactions).
      const chatId = normalizeChatId(githubMsg);
      if (chatId !== 0 && githubMsg.id != null) {
        queueReaction(chatId, githubMsg.id);
      }

      npm_install_project_dependencies();

      await executeAutoExit();
    } catch (error: unknown) {
      const errDetail = getErrorMessage(error) || String(error);
      logger.error("[auto-update] 主仓库更新失败:", errDetail);
      try {
        await githubMsg.replyText(`❌ 自动更新失败：${errDetail}`);
      } catch (_) {}
    }
  });
}

async function executeAutoExit(): Promise<void> {
  logger.info("[auto-update] 更新完成，退出进程…");
  process.exit(0);
}

// ── Auto-update for plugin repos ───────────────────────────────────────
async function autoUpdatePlugins(githubMsg: MessageContext): Promise<void> {
  // Capture ids BEFORE updateAllPlugins → silent loadPlugins() → reloadRuntime().
  const chatId = normalizeChatId(githubMsg);
  const msgId = githubMsg.id;

  return runAutoUpdateExclusive("plugins", async () => {
    try {
      const result = await updateAllPlugins(githubMsg, { silent: true });

      if (result.failedCount === 0) {
        await reactSuccessOnGithubMsg(githubMsg, { chatId, msgId });
        return;
      }
      try {
        await githubMsg.replyText(
          `❌ 插件自动更新失败：${result.failedCount} 个插件更新失败`,
        );
      } catch (_) {}
    } catch (error: unknown) {
      const errDetail = getErrorMessage(error) || String(error);
      logger.error("[auto-update] 插件更新异常:", errDetail);
      try {
        await githubMsg.replyText(`❌ 插件自动更新失败：${errDetail}`);
      } catch (_) {}
    }
  });
}

// ── GitHubBot message parsing ──────────────────────────────────────────
// Any chat with GitHubBot commit posts (product channel + telebox 群绑定)
/** Legacy product channel (no longer required; any chat with GitHubBot works). */
const _GITHUB_CHANNEL_ID_LEGACY = "-1003061608291";
void _GITHUB_CHANNEL_ID_LEGACY;
const GITHUB_BOT_USER_ID = "107550100";
const GITHUB_BOT_USERNAME = "githubbot";

// Next edition only reacts to Next repos (not TeleBox / TeleBox-Plugins alone).
// Accept TeleBoxOrg / TeleBoxLabs / bare names.
// GitHubBot: "1 new commit to …" / "2 new commits to …" (singular or plural)
// 兼容：`Repo:main` / `Repo: main` / markdown `[Org/Repo:main]` / 少量实体夹杂
const COMMIT_NOTICE_PATTERN = /\bnew\s+commits?\b/i;
// 标准格式："N new commits to Org/Repo:main" 或 "to [Org/Repo:main]"
const MAIN_REPO_PATTERN =
  /\bnew\s+commits?\b[\s\S]*?\bto\s+\[?(?:(?:TeleBoxOrg|TeleBoxLabs)\/)?(TeleBox-Next)\]?(?:\s*:\s*|\/)main\b/i;
const PLUGIN_REPO_PATTERN =
  /\bnew\s+commits?\b[\s\S]*?\bto\s+\[?(?:(?:TeleBoxOrg|TeleBoxLabs)\/)?(TeleBox-Next-Plugins|TeleBox-Next_Plugins|TeleBox_M_Plugins)\]?(?:\s*:\s*|\/)main\b/i;
// Markdown 反向格式："[Org/Repo:main] N new commits by Author"（repo 在前，无 "to"）
const MAIN_REPO_REVERSE_PATTERN =
  /\[?(?:(?:TeleBoxOrg|TeleBoxLabs)\/)?(TeleBox-Next)\s*:\s*main\]?[\s\S]*?\bnew\s+commits?\b/i;
const PLUGIN_REPO_REVERSE_PATTERN =
  /\[?(?:(?:TeleBoxOrg|TeleBoxLabs)\/)?(TeleBox-Next-Plugins|TeleBox-Next_Plugins|TeleBox_M_Plugins)\s*:\s*main\]?[\s\S]*?\bnew\s+commits?\b/i;

function normalizeChatId(msg: MessageContext): number {
  const id = msg.chat?.id;
  if (id != null) return Number(id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyMsg = msg as any;
  if (anyMsg.chatId != null) return Number(anyMsg.chatId);
  return 0;
}

function isGitHubBot(msg: MessageContext): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sender = msg.sender as any;
  // mtcute sender 可能是 User 对象 (含 id/username) 或 PeerUser (含 userId)
  const sid = sender?.id ?? sender?.userId;
  if (sid != null && String(sid) === GITHUB_BOT_USER_ID) return true;
  const uname = String(sender?.username || "").toLowerCase().replace(/^@/, "");
  if (uname === GITHUB_BOT_USERNAME) return true;
  // 回退：any 属性上的 senderId / fromId
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyMsg = msg as any;
  if (anyMsg.senderId != null && String(anyMsg.senderId) === GITHUB_BOT_USER_ID) return true;
  if (anyMsg.fromId?.userId != null && String(anyMsg.fromId.userId) === GITHUB_BOT_USER_ID) return true;
  return false;
}

class UpdatePlugin extends Plugin {
  description: string =
    `更新项目：拉取最新代码并安装依赖\n` +
    `<code>${mainPrefix}update -f/-force</code> 强制更新（package.json 变更时自动启用）\n` +
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
              "任意会话中 GitHubBot 推送 Next 仓库（TeleBox-Next / TeleBox-Next-Plugins）提交时自动更新。\n" +
              "成功：仅在 commit 消息上 ❤️；失败：回复错误。",
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

    const text = getGithubNoticeText(msg);
    if (!text) return;
    if (!COMMIT_NOTICE_PATTERN.test(text)) {
      // GitHubBot may send non-commit messages (e.g. CI results); skip silently
      return;
    }
    logger.info(`[auto-update] GitHubBot 提交通知: ${text.slice(0, 200)}`);

    const chatId = normalizeChatId(msg);
    // 标准格式优先，再试反向 markdown 格式
    if (PLUGIN_REPO_PATTERN.test(text) || PLUGIN_REPO_REVERSE_PATTERN.test(text)) {
      logger.info(`[auto-update] chat=${chatId || "?"} 插件仓库提交 → silent update`);
      await autoUpdatePlugins(msg);
    } else if (MAIN_REPO_PATTERN.test(text) || MAIN_REPO_REVERSE_PATTERN.test(text)) {
      logger.info(`[auto-update] chat=${chatId || "?"} 主仓库提交 → silent update`);
      await autoUpdateMainRepo(msg);
    } else {
      logger.info(
        `[auto-update] chat=${chatId || "?"} GitHubBot 通知未匹配 Next 仓库: ${text.slice(0, 120)}`,
      );
    }
  };
}

export default new UpdatePlugin();
