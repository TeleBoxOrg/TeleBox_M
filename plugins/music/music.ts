/**
 * Music Plugin for TeleBox
 * Professional YouTube audio downloader with AI-enhanced search
 * @version 3.0.0
 * @author TeleBox Team
 */

import { Plugin } from "@utils/pluginBase";
import { getGlobalClient, tryGetCurrentGenerationContext } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import {
  createDirectoryInAssets,
  createDirectoryInTemp,
} from "@utils/pathHelpers";
import type { MessageContext } from "@mtcute/dispatcher";
import { html } from "@mtcute/html-parser";
import * as fs from "fs";
import * as path from "path";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import * as https from "https";
import * as http from "http";
import { JSONFilePreset } from "lowdb/node";

const execAsync = promisify(exec);

async function lifecycleDelay(ms: number, label: string): Promise<void> {
  const lifecycle = tryGetCurrentGenerationContext();
  if (lifecycle) {
    await lifecycle.delay(ms, { label });
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type SpawnResult = string;

function runTrackedProcess(command: string, args: string[], label: string): Promise<SpawnResult> {
  const lifecycle = tryGetCurrentGenerationContext();

  return new Promise((resolve, reject) => {
    if (lifecycle?.signal.aborted) {
      reject(new Error("Generation aborted"));
      return;
    }

    const child = spawn(command, args);
    lifecycle?.trackChildProcess(child, { label });

    let data = '';
    let errorData = '';

    child.stdout.on('data', (chunk) => {
      data += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      errorData += chunk.toString();
    });

    child.on('close', (code) => {
      if (code === 0 && data) {
        resolve(data.trim());
      } else {
        const idMatch = errorData.match(/\[youtube\]\s+([a-zA-Z0-9_-]{11}):/);
        if (idMatch && idMatch[1]) {
          console.log(`[Music] Extracted video ID from error log: ${idMatch[1]}`);
          resolve(idMatch[1]);
        } else {
          reject(new Error(errorData || `Process exited with code ${code}`));
        }
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

// HTML转义函数
const htmlEscape = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#x27;",
      }[m] || m)
  );

// 消息长度限制
const MAX_MESSAGE_LENGTH = 4096;

// 获取命令前缀，参考 kitt.ts
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const pluginName = "music";
const commandName = `${mainPrefix}${pluginName}`;
const pendingCleanupTimers = new Set<ReturnType<typeof setTimeout>>();

// ==================== Configuration ====================
const CONFIG = {
  PATHS: {
    CONFIG: path.join(
      createDirectoryInAssets(`${pluginName}`),
      `${pluginName}_config.json`
    ),
    TEMP: createDirectoryInTemp("music"),
    // 移除缓存目录，禁用缓存功能
  },
  DEFAULTS: {
    API_URL: "https://generativelanguage.googleapis.com",
    MODEL: "gemini-2.0-flash",
    TIMEOUT: 60000,  // Increased timeout to 60 seconds
    MAX_RETRIES: 3,   // Add retry mechanism
  },
  KEYS: {
    API: "music_gemini_api_key",
    COOKIE: "music_ytdlp_cookie",
    PROXY: "music_ytdlp_proxy",
    BASE_URL: "music_gemini_base_url",
    MODEL: "music_gemini_model",
    AUDIO_QUALITY: "music_audio_quality",
    TEMPERATURE: "music_gemini_temperature",
    TOP_P: "music_gemini_top_p",
    TOP_K: "music_gemini_top_k",
    COOKIE_BROWSER: "music_ytdlp_cookie_browser",
  },
};

// 默认配置（包含所有配置键）
const DEFAULT_CONFIG: Record<string, string> = {
  [CONFIG.KEYS.BASE_URL]: "https://generativelanguage.googleapis.com",
  [CONFIG.KEYS.MODEL]: "gemini-2.0-flash",
  [CONFIG.KEYS.COOKIE]: "",
  [CONFIG.KEYS.API]: "",
  [CONFIG.KEYS.PROXY]: "",
  [CONFIG.KEYS.AUDIO_QUALITY]: "", // 空则不指定，保持最佳可用
  [CONFIG.KEYS.TEMPERATURE]: "0.0", // 低温度提高准确性
  [CONFIG.KEYS.TOP_P]: "0.6", // 适中的核采样
  [CONFIG.KEYS.TOP_K]: "20", // 限制候选词提高准确性
  [CONFIG.KEYS.COOKIE_BROWSER]: "",
};

// ==================== Types ====================
// 历史版本存储为分组字段，这里保留兼容；新版本统一为顶级键存储
type LegacyConfigData = {
  apiKeys?: Record<string, string>;
  cookies?: Record<string, string>;
  settings?: Record<string, any>;
} & Record<string, any>;

interface SongInfo {
  title: string;
  artist: string;
  album?: string;
  thumbnail?: string;
  duration?: number; // 单位：秒
}

// ==================== Dependency Manager ====================
class DependencyManager {
  // 依赖通过项目 package.json 管理，避免运行时安装
  private static requiredPackages: string[] = [];

  static async checkAndInstallDependencies(): Promise<boolean> {
    for (const pkg of this.requiredPackages) {
      if (!this.isPackageInstalled(pkg)) {
        console.log(`[music] Installing ${pkg}...`);
        try {
          await execAsync(`npm install ${pkg}`);
          console.log(`[music] ${pkg} installed successfully`);
        } catch (error) {
          console.error(`[music] Failed to install ${pkg}:`, error);
          return false;
        }
      }
    }
    return true;
  }

  private static async isPackageInstalled(
    packageName: string
  ): Promise<boolean> {
    try {
      const packagePath = path.join(process.cwd(), "node_modules", packageName);
      await fs.promises.access(packagePath, fs.constants.F_OK);
      return true;
    } catch (e) {
      return false;
    }
  }

  static async checkYtDlp(): Promise<boolean> {
    const commands = [
      "yt-dlp --version",
      "python3 -m yt_dlp --version",
    ];

    for (const cmd of commands) {
      try {
        await execAsync(cmd);
        console.log(`[music] yt-dlp found: ${cmd}`);
        return true;
      } catch (e) {
        continue;
      }
    }
    return false;
  }

  static async checkFfmpeg(): Promise<boolean> {
    try {
      await execAsync("ffmpeg -version");
      console.log("[Music] FFmpeg 已就绪");
      return true;
    } catch (e) {
      console.log("[Music] FFmpeg 未找到");
      return false;
    }
  }
}

// ==================== Utilities ====================
class Utils {
  static escape(text: string): string {
    return text.replace(
      /[&<>"']/g,
      (m) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#x27;",
        }[m] || m)
    );
  }

  static sanitizeFilename(name: string): string {
    return name
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "_")
      .substring(0, 50);
  }

  static async fileExists(path: string): Promise<boolean> {
    try {
      await fs.promises.access(path);
      return true;
    } catch (e) {
      return false;
    }
  }

  static formatSize(bytes: number): string {
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  static formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }

  // 解析多种时长表示："mm:ss"、"hh:mm:ss"、"225"、"225s"、"3分45秒"
  static parseDuration(input: string): number | undefined {
    if (!input) return undefined;
    const txt = String(input).trim();

    // 纯数字（秒）或带 s 后缀
    const secNum = /^\d+(?:\.\d+)?s?$/i;
    if (secNum.test(txt)) {
      const v = parseFloat(txt.replace(/s$/i, ""));
      return Number.isFinite(v) ? Math.round(v) : undefined;
    }

    // 中文格式：3分45秒 / 1小时2分3秒
    const zh = /(?:(\d+)\s*小时)?\s*(?:(\d+)\s*分)?\s*(?:(\d+)\s*秒)?/;
    const zhMatch = txt.match(zh);
    if (zhMatch && (zhMatch[1] || zhMatch[2] || zhMatch[3])) {
      const h = parseInt(zhMatch[1] || "0", 10);
      const m = parseInt(zhMatch[2] || "0", 10);
      const s = parseInt(zhMatch[3] || "0", 10);
      return h * 3600 + m * 60 + s;
    }

    // 冒号分隔：hh:mm:ss 或 mm:ss
    const parts = txt
      .split(":")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 2 || parts.length === 3) {
      const nums = parts.map((p) => parseInt(p, 10));
      if (nums.every((n) => Number.isFinite(n))) {
        let h = 0,
          m = 0,
          s = 0;
        if (nums.length === 3) {
          [h, m, s] = nums as [number, number, number];
        } else {
          [m, s] = nums as [number, number];
        }
        return h * 3600 + m * 60 + s;
      }
    }

    return undefined;
  }
}

// ==================== Configuration Manager ====================
class ConfigManager {
  private static db: any = null;
  private static initialized = false;

  private static async init(): Promise<void> {
    if (this.initialized) return;

    try {
      // 确保目录存在
      const configDir = path.dirname(CONFIG.PATHS.CONFIG);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // 文件不存在时以扁平结构初始化
      const defaultData: Record<string, any> = { ...DEFAULT_CONFIG };

      this.db = await JSONFilePreset<LegacyConfigData>(
        CONFIG.PATHS.CONFIG,
        defaultData
      );
      this.initialized = true;
      // console.log("[music] 配置管理器初始化成功 (lowdb)");
    } catch (error) {
      console.error("[music] 初始化配置失败:", error);
    }
  }

  static async get(key: string, defaultValue?: string): Promise<string> {
    await this.init();
    if (!this.db) {
      return defaultValue || DEFAULT_CONFIG[key] || "";
    }

    // 优先读取顶级键
    if (
      Object.prototype.hasOwnProperty.call(this.db.data, key) &&
      typeof this.db.data[key] !== "undefined"
    ) {
      return this.db.data[key] ?? defaultValue ?? DEFAULT_CONFIG[key] ?? "";
    }

    // 兼容历史结构
    try {
      const legacy = this.db.data as LegacyConfigData;
      if (legacy.settings && typeof legacy.settings[key] !== "undefined") {
        return (
          legacy.settings[key] ?? defaultValue ?? DEFAULT_CONFIG[key] ?? ""
        );
      }
      if (key === CONFIG.KEYS.API && legacy.apiKeys) {
        return legacy.apiKeys[key] ?? defaultValue ?? "";
      }
      if (key === CONFIG.KEYS.COOKIE && legacy.cookies) {
        return legacy.cookies[key] ?? defaultValue ?? "";
      }
      // 历史遗留别名
      if (key === CONFIG.KEYS.API && legacy.settings?.apikey) {
        return legacy.settings.apikey ?? defaultValue ?? "";
      }
    } catch (e) { /* noop */ }

    return defaultValue || DEFAULT_CONFIG[key] || "";
  }

  static async set(key: string, value: string): Promise<boolean> {
    await this.init();
    if (!this.db) return false;

    try {
      // 统一以顶级键存储（不迁移历史数据，仅写入新键）
      this.db.data[key] = value;

      await this.db.write(); // 自动保存
      return true;
    } catch (error) {
      console.error(`[music] 设置配置失败 ${key}:`, error);
      return false;
    }
  }

  static async remove(key: string): Promise<boolean> {
    await this.init();
    if (!this.db) return false;

    try {
      if (Object.prototype.hasOwnProperty.call(this.db.data, key)) {
        delete this.db.data[key];
      }
      await this.db.write();
      return true;
    } catch (error) {
      console.error(`[Music] Failed to remove ${key}:`, error);
      return false;
    }
  }

  static async getAll(): Promise<Record<string, any>> {
    await this.init();
    if (!this.db) return {};
    // 导出所有配置键，优先顶级，其次兼容历史结构
    const keys = [
      CONFIG.KEYS.BASE_URL,
      CONFIG.KEYS.MODEL,
      CONFIG.KEYS.COOKIE,
      CONFIG.KEYS.API,
      CONFIG.KEYS.PROXY,
      CONFIG.KEYS.AUDIO_QUALITY,
      CONFIG.KEYS.TEMPERATURE,
      CONFIG.KEYS.TOP_P,
      CONFIG.KEYS.TOP_K,
      CONFIG.KEYS.COOKIE_BROWSER,
    ];
    const result: Record<string, any> = {};
    for (const k of keys) {
      result[k] = await this.get(k, DEFAULT_CONFIG[k] ?? "");
    }
    return result;
  }

  static async delete(key: string): Promise<boolean> {
    await this.init();
    if (!this.db) return false;

    try {
      if (Object.prototype.hasOwnProperty.call(this.db.data, key)) {
        delete this.db.data[key];
      }

      await this.db.write(); // 自动保存
      return true;
    } catch (error) {
      console.error(`[music] 删除配置失败 ${key}:`, error);
      return false;
    }
  }

  static cleanup(): void {
    this.db = null;
    this.initialized = false;
  }
}

// ==================== HTTP Client ====================
class HttpClient {
  static cleanResponseText(text: string): string {
    if (!text) return text;
    return text
      .replace(/^\uFEFF/, "")
      .replace(/\uFFFD/g, "")
      .replace(/[\uFFFC\uFFFF\uFFFE]/g, "")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .replace(/[\uDC00-\uDFFF]/g, "")
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
      .normalize("NFKC");
  }

  static async makeRequest(url: string, options: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const { method = "GET", headers = {}, data, timeout = 60000 } = options;  // Increased default timeout
      const isHttps = url.startsWith("https:");
      const client = isHttps ? https : http;

      const req = client.request(
        url,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "TeleBox/1.0",
            ...headers,
          },
          timeout,
        },
        (res: any) => {
          res.setEncoding("utf8");
          let body = "";
          let dataLength = 0;
          const maxResponseSize = 10 * 1024 * 1024;

          res.on("data", (chunk: string) => {
            dataLength += chunk.length;
            if (dataLength > maxResponseSize) {
              req.destroy();
              reject(new Error("响应数据过大"));
              return;
            }
            body += chunk;
          });

          res.on("end", () => {
            try {
              const cleanBody = HttpClient.cleanResponseText(body);
              const parsedData = cleanBody ? JSON.parse(cleanBody) : {};
              resolve({
                status: res.statusCode || 0,
                data: parsedData,
                headers: res.headers,
              });
            } catch (error) {
              resolve({
                status: res.statusCode || 0,
                data: HttpClient.cleanResponseText(body),
                headers: res.headers,
              });
            }
          });
        }
      );

      req.on("error", (error: any) => {
        reject(new Error(`网络请求失败: ${error.message}`));
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("请求超时"));
      });

      if (data) {
        if (typeof data === "object") {
          const jsonData = JSON.stringify(data);
          req.write(jsonData);
        } else if (typeof data === "string") {
          req.write(data);
        }
      }

      req.end();
    });
  }
}

// ==================== Gemini Client ====================
class GeminiClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string | null) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? DEFAULT_CONFIG[CONFIG.KEYS.BASE_URL];
  }

  async searchMusic(query: string, retryCount: number = 0): Promise<string> {
    const model = await ConfigManager.get(CONFIG.KEYS.MODEL);
    const url = `${this.baseUrl}/v1beta/models/${model}:generateContent`;
    
    // 获取准确率调节参数
    const temperature = parseFloat(await ConfigManager.get(CONFIG.KEYS.TEMPERATURE, "0.1"));
    const topP = parseFloat(await ConfigManager.get(CONFIG.KEYS.TOP_P, "0.5"));
    const topK = parseInt(await ConfigManager.get(CONFIG.KEYS.TOP_K, "5"), 10);
    
    console.log(`[Music] Gemini参数: temperature=${temperature}, topP=${topP}, topK=${topK}`);

    const systemPrompt = `只输出以下3行，且不要任何其他内容。若未知则留空：

歌曲名: 
歌手: 
专辑: `;

    const userPrompt = `精准识别这个查询的歌曲信息："${query}"
要求：
1. 自动纠正拼写错误和识别拼音繁体
2. 返回最广为人知的版本
3. 歌手必须是最准确的演唱者，不能有任何错误
4. 只填写确定的信息，如果没有找到歌曲则用用户输入作为歌曲名
5. 歌手名和歌曲名必须转换为繁体中文输出`;

    const headers: Record<string, string> = {
      "x-goog-api-key": this.apiKey,
    };

    const requestData = {
      contents: [
        {
          role: "user",
          parts: [{ text: userPrompt }],
        },
      ],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        temperature: temperature,
        topP: topP,
        topK: topK,
        maxOutputTokens: 200,
      },
      tools: [{ googleSearch: {} }],
      safetySettings: [
        "HARM_CATEGORY_HATE_SPEECH",
        "HARM_CATEGORY_DANGEROUS_CONTENT",
        "HARM_CATEGORY_HARASSMENT",
        "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        "HARM_CATEGORY_CIVIC_INTEGRITY",
      ].map((category) => ({ category, threshold: "BLOCK_NONE" })),
    };

    try {
      const response = await HttpClient.makeRequest(url, {
        method: "POST",
        headers,
        data: requestData,
        timeout: CONFIG.DEFAULTS.TIMEOUT,
      });

      if (response.status !== 200 || response.data?.error) {
        const errorMessage =
          response.data?.error?.message ||
          response.data?.error ||
          `HTTP错误: ${response.status}`;
        throw new Error(errorMessage);
      }

      const rawText =
        response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return HttpClient.cleanResponseText(rawText);
    } catch (error: any) {
      // Retry mechanism for timeout and network errors
      if (retryCount < CONFIG.DEFAULTS.MAX_RETRIES && 
          (error.message.includes('超时') || error.message.includes('timeout') || 
           error.message.includes('网络') || error.message.includes('ECONNRESET'))) {
        console.log(`[music] AI请求失败，重试 ${retryCount + 1}/${CONFIG.DEFAULTS.MAX_RETRIES}: ${error.message}`);
        await lifecycleDelay(2000 * (retryCount + 1), "music:gemini-retry"); // Exponential backoff
        return this.searchMusic(query, retryCount + 1);
      }
      throw error;
    }

  }
}

// ==================== Cookie Converter ====================
class CookieConverter {
  // 检测并转换各种格式的 Cookie 为 Netscape 格式
  static convertToNetscape(input: string): string {
    // 清理输入
    input = input.trim();

    // 1. 如果已经是 Netscape 格式（包含制表符分隔的7个字段）
    if (this.isNetscapeFormat(input)) {
      return input;
    }

    // 2. JSON 格式的 Cookie（从浏览器开发者工具导出）
    if (this.isJsonFormat(input)) {
      return this.convertJsonToNetscape(input);
    }

    // 3. 浏览器 Cookie 字符串格式（key=value; key2=value2）
    if (this.isBrowserStringFormat(input)) {
      return this.convertBrowserStringToNetscape(input);
    }

    // 4. EditThisCookie 扩展格式
    if (this.isEditThisCookieFormat(input)) {
      return this.convertEditThisCookieToNetscape(input);
    }

    // 5. 简单的 key=value 对（每行一个）
    if (this.isSimpleKeyValueFormat(input)) {
      return this.convertSimpleKeyValueToNetscape(input);
    }

    // 如果无法识别格式，尝试作为 Netscape 格式返回
    return input;
  }

  private static isNetscapeFormat(input: string): boolean {
    const lines = input
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"));
    if (lines.length === 0) return false;

    // Netscape 格式每行应该有 7 个制表符分隔的字段
    return lines.every((line) => {
      const fields = line.split("\t");
      return fields.length === 7;
    });
  }

  private static isJsonFormat(input: string): boolean {
    try {
      const parsed = JSON.parse(input);
      return (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed[0].hasOwnProperty("name") &&
        parsed[0].hasOwnProperty("value")
      );
    } catch (e) {
      return false;
    }
  }

  private static convertJsonToNetscape(input: string): string {
    try {
      const cookies = JSON.parse(input);
      const netscapeLines: string[] = [
        "# Netscape HTTP Cookie File",
        "# This file was generated by TeleBox Music Plugin",
        "",
      ];

      for (const cookie of cookies) {
        const domain = cookie.domain || ".youtube.com";
        const flag = domain.startsWith(".") ? "TRUE" : "FALSE";
        const path = cookie.path || "/";
        const secure = cookie.secure ? "TRUE" : "FALSE";
        const expiry =
          cookie.expirationDate ||
          cookie.expires ||
          Math.floor(Date.now() / 1000) + 31536000; // 1 year from now
        const name = cookie.name || "";
        const value = cookie.value || "";

        if (name && value) {
          netscapeLines.push(
            `${domain}\t${flag}\t${path}\t${secure}\t${expiry}\t${name}\t${value}`
          );
        }
      }

      return netscapeLines.join("\n");
    } catch (error) {
      console.error("Failed to convert JSON to Netscape:", error);
      return input;
    }
  }

  private static isBrowserStringFormat(input: string): boolean {
    // 检查是否包含 key=value; 格式
    return input.includes("=") && (input.includes(";") || input.includes("="));
  }

  private static convertBrowserStringToNetscape(input: string): string {
    const netscapeLines: string[] = [
      "# Netscape HTTP Cookie File",
      "# This file was generated by TeleBox Music Plugin",
      "",
    ];

    // 分割 cookie 字符串
    const cookies = input.split(/;\s*/).filter((c) => c.includes("="));

    for (const cookie of cookies) {
      const [name, ...valueParts] = cookie.split("=");
      const value = valueParts.join("="); // 处理值中包含 = 的情况

      if (name && value) {
        // YouTube cookies 默认设置
        const domain = ".youtube.com";
        const flag = "TRUE";
        const path = "/";
        const secure = "TRUE";
        const expiry = Math.floor(Date.now() / 1000) + 31536000; // 1 year

        netscapeLines.push(
          `${domain}\t${flag}\t${path}\t${secure}\t${expiry}\t${name.trim()}\t${value.trim()}`
        );
      }
    }

    return netscapeLines.join("\n");
  }

  private static isEditThisCookieFormat(input: string): boolean {
    // EditThisCookie 通常导出为带特定字段的 JSON
    try {
      const parsed = JSON.parse(input);
      return (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        (parsed[0].hasOwnProperty("storeId") ||
          parsed[0].hasOwnProperty("sameSite"))
      );
    } catch (e) {
      return false;
    }
  }

  private static convertEditThisCookieToNetscape(input: string): string {
    // 使用相同的 JSON 转换逻辑
    return this.convertJsonToNetscape(input);
  }

  private static isSimpleKeyValueFormat(input: string): boolean {
    const lines = input.split("\n").filter((line) => line.trim());
    return (
      lines.length > 0 &&
      lines.every((line) => {
        return line.includes("=") && !line.includes("\t");
      })
    );
  }

  private static convertSimpleKeyValueToNetscape(input: string): string {
    const netscapeLines: string[] = [
      "# Netscape HTTP Cookie File",
      "# This file was generated by TeleBox Music Plugin",
      "",
    ];

    const lines = input.split("\n").filter((line) => line.trim());

    for (const line of lines) {
      const [name, ...valueParts] = line.split("=");
      const value = valueParts.join("=");

      if (name && value) {
        const domain = ".youtube.com";
        const flag = "TRUE";
        const path = "/";
        const secure = "TRUE";
        const expiry = Math.floor(Date.now() / 1000) + 31536000;

        netscapeLines.push(
          `${domain}\t${flag}\t${path}\t${secure}\t${expiry}\t${name.trim()}\t${value.trim()}`
        );
      }
    }

    return netscapeLines.join("\n");
  }
}

// ==================== Helper Functions ====================
async function extractSongInfo(
  geminiResponse: string,
  userInput: string
): Promise<{
  title: string;
  artist: string;
  album?: string;
  duration?: number;
}> {
  const lines = geminiResponse.split("\n").map((line) => line.trim());
  let title = "";
  let artist = "";
  let album = "";
  let durationSec: number | undefined;

  for (const line of lines) {
    if (line.startsWith("歌曲名:") || line.startsWith("歌曲名：")) {
      title = line.replace(/歌曲名[:：]\s*/, "").trim();
    } else if (line.startsWith("歌手:") || line.startsWith("歌手：")) {
      artist = line.replace(/歌手[:：]\s*/, "").trim();
    } else if (line.startsWith("专辑:") || line.startsWith("专辑：")) {
      album = line.replace(/专辑[:：]\s*/, "").trim();
    }
  }

  // 返回结果，空值不返回
  return {
    title: title || userInput, // 如果没有识别到歌曲名，使用用户输入
    artist: artist || "Youtube Music", // 如果没有识别到歌手，使用 Youtube Music
    album: album || undefined,
    duration: durationSec,
  };
}

// ==================== Downloader ====================
class Downloader {
  private tempDir: string;

  constructor() {
    this.tempDir = CONFIG.PATHS.TEMP;
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  async checkDependencies(): Promise<{ ytdlp: boolean; ffmpeg: boolean }> {
    const result = { ytdlp: false, ffmpeg: false };

    // Check yt-dlp with multiple methods
    const ytdlpCommands = [
      "yt-dlp --version",
      "python3 -m yt_dlp --version",
      "python -m yt_dlp --version",
    ];

    for (const cmd of ytdlpCommands) {
      try {
        const { stdout } = await execAsync(cmd);
        result.ytdlp = true;
        // 检查版本并提示更新
        const versionMatch = stdout.match(/(\d{4}\.\d{2}\.\d{2})/);  
        if (versionMatch) {
          const version = versionMatch[1];
          const versionDate = new Date(version.replace(/\./g, '-'));
          const thirtyDaysAgo = new Date();
          thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
          if (versionDate < thirtyDaysAgo) {
            console.log(`[Music] yt-dlp版本较旧 (${version})，建议更新: yt-dlp -U 或 pip install -U yt-dlp`);
          }
        }
        console.log(`[Music] Found yt-dlp via: ${cmd.split(" ")[0]}`);
        break;
      } catch (e) { /* noop */ }
    }

    // Check FFmpeg
    try {
      await execAsync("ffmpeg -version");
      result.ffmpeg = true;
      // 静默检查，不输出日志
    } catch (e) {
      console.log("[Music] FFmpeg 未找到，音频处理功能受限");
    }

    return result;
  }

  async search(query: string, minDurationSec?: number): Promise<string | null> {
    try {
      const cookie = await ConfigManager.get(CONFIG.KEYS.COOKIE);
      const proxy = await ConfigManager.get(CONFIG.KEYS.PROXY);
      const cookieBrowser = await ConfigManager.get(CONFIG.KEYS.COOKIE_BROWSER);

      // 使用AI识别歌手和歌曲名，构建最终搜索词
      let finalQuery = query;
      try {
        const apiKey = await ConfigManager.get(CONFIG.KEYS.API);
        if (apiKey && apiKey.trim()) {
          const baseUrl = await ConfigManager.get(CONFIG.KEYS.BASE_URL);
          const gemini = new GeminiClient(apiKey, baseUrl);
          const aiResponse = await gemini.searchMusic(query);
          const songInfo = await extractSongInfo(aiResponse, query);
          
          // 构建搜索词：歌手 + 歌曲名 + Lyrics
          if (songInfo.artist && songInfo.title) {
            finalQuery = `${songInfo.artist} ${songInfo.title} Lyrics`;
            console.log(`[Music] AI构建搜索词: ${finalQuery}`);
          }
        }
      } catch (error) {
        console.log(`[Music] AI识别失败，使用原始搜索词: ${error}`);
      }

      // The query will be passed as an argument, so no shell escaping is needed.
      const safeQuery = finalQuery;

      // 构建命令选项 - 添加更多兼容性参数和客户端选择
      const commandConfigs: { command: string; args: string[] }[] = [];
      const baseSearchArg = `ytsearch1:${safeQuery}`;
      const commonArgs = [
        '--no-warnings', 
        '--no-check-certificates', 
        '--geo-bypass',
        '--ignore-errors',  // Continue on download errors
        '--no-playlist',    // Download only single video
      ];
      
      // 添加Android客户端参数以避开SABR限制
      const clientArgs = ['--extractor-args', 'youtube:player_client=android,ios'];

      const getIdArgs = [baseSearchArg, '--get-id', ...commonArgs, ...clientArgs];
      const getInfoArgs = [baseSearchArg, '--dump-single-json', '--skip-download', ...commonArgs, ...clientArgs];

      const authArgs: string[] = [];
      if (cookieBrowser && cookieBrowser.trim()) {
        authArgs.push('--cookies-from-browser', cookieBrowser);
      } else if (cookie && cookie.trim()) {
        const cookieFile = path.join(this.tempDir, "cookies.txt");
        await fs.promises.writeFile(cookieFile, this.convertCookie(cookie));
        authArgs.push('--cookies', cookieFile);
      }

      const proxyArgs: string[] = [];
      if (proxy) {
        proxyArgs.push('--proxy', proxy);
      }

      // 策略1: 无认证
      commandConfigs.push({ command: 'yt-dlp', args: getIdArgs });
      commandConfigs.push({ command: 'yt-dlp', args: getInfoArgs });

      // 策略2: 仅Cookie
      if (authArgs.length > 0) {
        commandConfigs.push({ command: 'yt-dlp', args: [...getIdArgs, ...authArgs] });
        commandConfigs.push({ command: 'yt-dlp', args: [...getInfoArgs, ...authArgs] });
      }

      // 策略3: 仅Proxy
      if (proxyArgs.length > 0) {
        commandConfigs.push({ command: 'yt-dlp', args: [...getIdArgs, ...proxyArgs] });
        commandConfigs.push({ command: 'yt-dlp', args: [...getInfoArgs, ...proxyArgs] });
      }

      // 策略4: Cookie + Proxy
      if (authArgs.length > 0 && proxyArgs.length > 0) {
        commandConfigs.push({ command: 'yt-dlp', args: [...getInfoArgs, ...authArgs, ...proxyArgs] });
      }

      // Python 备用
      commandConfigs.push({ command: 'python3', args: ['-m', 'yt_dlp', ...getIdArgs] });
      commandConfigs.push({ command: 'python3', args: ['-m', 'yt_dlp', ...getInfoArgs] });

      let stdout = "";

      for (const config of commandConfigs) {
        try {
          stdout = await runTrackedProcess(
            config.command,
            config.args,
            "music:yt-dlp-search"
          );

          if (stdout) {
            console.log(`[Music] Search successful with: ${config.command}`);
            break;
          }
        } catch (error) {
          console.log(`[Music] Search failed with: ${config.command}. Error:`, error);
        }
      }

      if (!stdout.trim()) return null;

      // 检查是否是纯ID
      if (!stdout.includes('{')) {
        const firstId = stdout.split('\n')[0].trim();
        if (firstId) {
          console.log(`[Music] 选中第一个结果 (ID): ${firstId}`);
          return `https://www.youtube.com/watch?v=${firstId}`;
        }
      }

      // 尝试解析JSON
      try {
        const result = JSON.parse(stdout);
        const firstEntry = result.entries ? result.entries[0] : result;

        if (firstEntry && firstEntry.id) {
          console.log(`[Music] 选中第一个结果 (JSON): ${firstEntry.title}`);
          return `https://www.youtube.com/watch?v=${firstEntry.id}`;
        }
      } catch (e) {
        console.error('[Music] Failed to parse JSON, returning null.', e);
      }

      return null;
    } catch (error) {
      console.error("[Music] Search error:", error);
      return null;
    }
  }

  private convertCookie(cookie: string): string {
    // 1. 如果已经包含制表符，直接返回（格式正确）
    if (cookie.includes("\t")) {
      return cookie;
    }

    // 2. 检测并修复空格分隔的 Netscape 格式 cookie
    const lines = cookie.split("\n").filter((line) => line.trim());
    const fixedLines: string[] = ["# Netscape HTTP Cookie File", ""];

    for (const line of lines) {
      // 跳过注释行
      if (line.startsWith("#")) continue;

      // 检测是否是 Netscape 格式（包含多个空格分隔的字段）
      const fields = line.split(/\s+/);
      if (fields.length === 7) {
        // 这是空格分隔的 Netscape 格式，转换为制表符分隔
        fixedLines.push(fields.join("\t"));
        continue;
      }
    }

    // 如果成功转换了至少一个 cookie 条目，返回修复后的结果
    if (fixedLines.length > 2) {
      return fixedLines.join("\n");
    }

    // 3. 否则，尝试从 key=value 格式转换
    const resultLines = ["# Netscape HTTP Cookie File", ""];
    const pairs = cookie.split(/;\s*/).filter((p) => p.includes("="));

    for (const pair of pairs) {
      const [name, value] = pair.split("=");
      if (name && value) {
        // YouTube cookie defaults
        resultLines.push(
          `.youtube.com\tTRUE\t/\tTRUE\t${
            Math.floor(Date.now() / 1000) + 31536000
          }\t${name.trim()}\t${value.trim()}`
        );
      }
    }

    return resultLines.join("\n");
  }

  // 使用 gdstudio 音乐 API 获取专辑封面，保存到 destPath
  // 元数据优先使用 AI 解析结果（artist/title/album）
  private async fetchAlbumCoverUsingAPI(
    metadata: SongInfo | undefined,
    destPath: string
  ): Promise<boolean> {
    try {
      if (!metadata || !metadata.title) return false;
      const COVER_SOURCES = [
        "tencent",
        "kuwo",
        "kugou",
        "migu",
        "netease",
        "ytmusic",
      ];
      const BASE = "https://music-api.gdstudio.xyz/api.php";

      const hasArtist = !!metadata.artist && metadata.artist !== "Unknown Artist";
      const query = hasArtist
        ? `${metadata.artist} ${metadata.title}`
        : `${metadata.title}`;

      for (const source of COVER_SOURCES) {
        try {
          const searchUrl = `${BASE}?types=search&source=${source}&name=${encodeURIComponent(
            query
          )}&count=10&pages=1`;
          const res = await HttpClient.makeRequest(searchUrl, { method: "GET" });
          if (res.status !== 200 || !res.data) continue;

          let list: any[] = [];
          if (Array.isArray(res.data)) list = res.data;
          else if (Array.isArray(res.data.result)) list = res.data.result;
          else if (Array.isArray(res.data.data)) list = res.data.data;
          if (!list.length) continue;

          const lowerTitle = String(metadata.title).toLowerCase();
          const lowerArtist = String(metadata.artist || "").toLowerCase();
          let best: any = null;
          if (hasArtist) {
            best = list.find(
              (it: any) =>
                String(it?.name || "").toLowerCase().includes(lowerTitle) &&
                String(it?.artist || "").toLowerCase().includes(lowerArtist)
            );
          } else {
            best = list.find((it: any) =>
              String(it?.name || "").toLowerCase().includes(lowerTitle)
            );
          }
          best = best || list[0];
          const picId = String(best?.pic_id || "");
          if (!picId) continue;

          // 获取封面URL
          const picUrlApi = `${BASE}?types=pic&source=${encodeURIComponent(
            source
          )}&id=${encodeURIComponent(picId)}&size=500`;
          const picRes = await HttpClient.makeRequest(picUrlApi, { method: "GET" });
          if (picRes.status !== 200 || !picRes.data) continue;
          let picUrl = "";
          if (typeof picRes.data === "string") {
            picUrl = picRes.data;
          } else if (
            picRes.data &&
            (picRes.data.url || picRes.data.pic || picRes.data.image)
          ) {
            picUrl = picRes.data.url || picRes.data.pic || picRes.data.image;
          }
          if (!picUrl) continue;

          const ok = await this.downloadImageToFile(picUrl, destPath);
          if (ok) {
            console.log(`[Music] 已从API获取专辑封面: ${source}`);
            return true;
          }
        } catch (e) {
          // 尝试下一个源
          continue;
        }
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  private async downloadImageToFile(url: string, destPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const isHttps = url.startsWith("https:");
        const client = isHttps ? https : http;
        const req = client.get(url, (res: any) => {
          if ((res.statusCode || 0) >= 300 && res.headers.location) {
            // 处理重定向
            this.downloadImageToFile(res.headers.location as string, destPath)
              .then(resolve)
              .catch(() => resolve(false));
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", async () => {
            try {
              const buf = Buffer.concat(chunks);
              if (!buf || buf.length === 0) return resolve(false);
              await fs.promises.writeFile(destPath, buf);
              resolve(true);
            } catch (e) {
              resolve(false);
            }
          });
        });
        req.on("error", () => resolve(false));
        req.end();
      } catch (e) {
        resolve(false);
      }
    });
  }

  async download(
    url: string,
    metadata?: SongInfo
  ): Promise<{ audioPath: string | null; thumbnailPath?: string }> {
    try {
      const filename = metadata
        ? `${Utils.sanitizeFilename(metadata.artist)}_${Utils.sanitizeFilename(
            metadata.title
          )}`
        : `download_${Date.now()}`;

      // 每次下载到临时目录，确保全新下载
      const timestamp = Date.now();
      const outputPath = path.join(
        this.tempDir,
        `${filename}_${timestamp}.%(ext)s`
      );
      const thumbnailPath = path.join(
        this.tempDir,
        `${filename}_${timestamp}_thumb.jpg`
      );
      const cookie = await ConfigManager.get(CONFIG.KEYS.COOKIE);
      const proxy = await ConfigManager.get(CONFIG.KEYS.PROXY);

      // Prepare authentication
      let authParams = "";
      if (cookie && cookie.trim()) {
        const cookieFile = path.join(this.tempDir, "cookies.txt");
        await fs.promises.writeFile(cookieFile, this.convertCookie(cookie));
        authParams += ` --cookies "${cookieFile}"`;
      }
      if (proxy) authParams += ` --proxy "${proxy}"`;

      // 先尝试通过 API 获取专辑封面；失败再回退到视频缩略图
      let hasThumbnail = false;
      let videoInfo: any = null;

      try {
        const ok = await this.fetchAlbumCoverUsingAPI(metadata, thumbnailPath);
        if (ok) hasThumbnail = true;
      } catch (e) { /* noop */ }

      // 获取视频元数据
      try {
        const infoCmd = `yt-dlp --dump-json --no-warnings${authParams} "${url}"`;
        const { stdout } = await execAsync(infoCmd);
        videoInfo = JSON.parse(stdout);

        // 从视频信息中补充元数据（不覆盖已有的）
        if (videoInfo) {
          // 如果没有传入元数据，从视频信息创建
          if (!metadata) {
            metadata = {
              title: videoInfo.title || videoInfo.track || "Unknown",
              artist:
                videoInfo.artist ||
                videoInfo.uploader ||
                videoInfo.channel ||
                "Unknown Artist",
              album: videoInfo.album || undefined,
            };
          } else {
            // 如果已有元数据（比如从AI获取的），只补充缺失的字段
            if (!metadata.title && videoInfo.title) {
              metadata.title = videoInfo.title;
            }
            if (metadata.artist === "Unknown Artist" && videoInfo.artist) {
              metadata.artist = videoInfo.artist;
            }
            if (!metadata.album && videoInfo.album) {
              metadata.album = videoInfo.album;
            }
          }
          console.log(
            `[music] 元数据: ${metadata.artist} - ${metadata.title}${
              metadata.album ? " - " + metadata.album : ""
            }`
          );
        }
      } catch (error) {
        console.log("[music] 无法获取视频信息，使用已有元数据");
      }

      // 若 API 未获取到封面，则回退到视频缩略图
      if (!hasThumbnail) {
        try {
          const thumbCmd = `yt-dlp --write-thumbnail --skip-download -o "${thumbnailPath.replace(
            ".jpg",
            ""
          )}"${authParams} "${url}"`;
          await execAsync(thumbCmd);

          // 检查各种可能的缩略图格式
          const possibleExts = [".jpg", ".jpeg", ".png", ".webp"];
          for (const ext of possibleExts) {
            const possiblePath = thumbnailPath.replace(".jpg", ext);
            if (fs.existsSync(possiblePath)) {
              // 如果不是jpg，转换为jpg
              if (ext !== ".jpg") {
                await execAsync(
                  `ffmpeg -i "${possiblePath}" -vf "scale=500:500:force_original_aspect_ratio=increase,crop=500:500" "${thumbnailPath}" -y`
                );
                fs.unlinkSync(possiblePath);
              } else {
                // 调整大小为正方形
                await execAsync(
                  `ffmpeg -i "${possiblePath}" -vf "scale=500:500:force_original_aspect_ratio=increase,crop=500:500" "${thumbnailPath}_temp.jpg" -y`
                );
                fs.renameSync(`${thumbnailPath}_temp.jpg`, thumbnailPath);
              }
              hasThumbnail = true;
              console.log(`[music] 缩略图已下载: ${thumbnailPath}`);
              break;
            }
          }
        } catch (error) {
          console.log("[music] 缩略图下载失败，继续下载音频");
        }
      }

      // 读取用户配置的音频质量（可为空）
      const configuredQuality = await ConfigManager.get(
        CONFIG.KEYS.AUDIO_QUALITY
      );
      const qualityArg = configuredQuality
        ? ` --audio-quality ${configuredQuality}`
        : "";
      // 用户显式设置音质时，使用 mp3 以确保质量参数生效；否则保持最佳可用格式
      const audioFormat = configuredQuality ? "mp3" : "best";

      // Build command list with fallbacks - 优化音频格式选择和兼容性
      const commands = [
        // 策略1: 使用Android客户端（避开SABR限制）
        `yt-dlp --extractor-args "youtube:player_client=android,ios" -x --audio-format ${audioFormat}${qualityArg} --extract-audio --embed-metadata --add-metadata -o "${outputPath}" --no-check-certificates --ignore-errors --no-playlist${authParams} "${url}"`,
        // 策略2: 使用iOS客户端
        `yt-dlp --extractor-args "youtube:player_client=ios" -x --audio-format ${audioFormat}${qualityArg} --extract-audio --embed-metadata --add-metadata -o "${outputPath}" --no-check-certificates --ignore-errors${authParams} "${url}"`,
        // 策略3: 使用TV客户端
        `yt-dlp --extractor-args "youtube:player_client=tv_embedded" -x --audio-format ${audioFormat}${qualityArg} --extract-audio --embed-metadata --add-metadata -o "${outputPath}" --no-check-certificates --ignore-errors${authParams} "${url}"`,
        // 策略4: 使用mediaconnect客户端
        `yt-dlp --extractor-args "youtube:player_client=mediaconnect" -x --audio-format ${audioFormat}${qualityArg} --extract-audio --embed-metadata --add-metadata -o "${outputPath}" --no-check-certificates${authParams} "${url}"`,
        // 策略5: 强制使用特定格式ID（通用音频格式）
        `yt-dlp -f "140/251/250/249" -x --audio-format ${audioFormat}${qualityArg} --extract-audio --embed-metadata --add-metadata -o "${outputPath}" --no-check-certificates --ignore-errors${authParams} "${url}"`,
        // 策略6: 使用format选择器（绕过signature问题）
        `yt-dlp -f "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio" -x --audio-format ${audioFormat}${qualityArg} --extract-audio --embed-metadata --add-metadata -o "${outputPath}" --no-check-certificates --ignore-errors${authParams} "${url}"`,
        // 策略7: 标准下载（添加更多兼容性参数）
        `yt-dlp -x --audio-format ${audioFormat}${qualityArg} --extract-audio --embed-metadata --add-metadata -o "${outputPath}" --no-check-certificates --ignore-errors --no-playlist --geo-bypass${authParams} "${url}"`,
        // 策略8: Python 模块方式
        `python3 -m yt_dlp --extractor-args "youtube:player_client=android" -x --audio-format ${audioFormat}${qualityArg} --extract-audio --embed-metadata --add-metadata -o "${outputPath}" --no-check-certificates --ignore-errors${authParams} "${url}"`,
      ];

      // 尝试多种下载策略
      let success = false;
      let lastError: any = null;

      for (const cmd of commands) {
        try {
          console.log(`[music] 尝试下载命令: ${cmd.split(" ")[0]}`);
          const { stdout, stderr } = await execAsync(cmd);
          console.log(`[music] 下载成功`);
          success = true;
          break;
        } catch (error: any) {
          lastError = error;
          console.log(`[music] 下载失败: ${error.message}`);
          continue;
        }
      }

      if (!success) {
        console.error("[music] 所有下载策略失败:", lastError?.message);
        return { audioPath: null };
      }

      // 查找下载的文件（按音质优先级排序）
      const files = await fs.promises.readdir(this.tempDir);
      const audioExtensions = [
        ".flac",
        ".wav",
        ".m4a",
        ".opus",
        ".aac",
        ".mp3",
        ".ogg",
        ".webm",
      ];

      // 按优先级查找文件
      for (const ext of audioExtensions) {
        const audioFile = files.find((f) => {
          const hasFilename = f.startsWith(filename);
          const hasExt = f.toLowerCase().endsWith(ext);
          return hasFilename && hasExt;
        });

        if (audioFile) {
          const filePath = path.join(this.tempDir, audioFile);
          const stats = await fs.promises.stat(filePath);
          const formatInfo = this.getFormatInfo(ext);
          console.log(
            `[music] 下载完成: ${audioFile} (${Utils.formatSize(
              stats.size
            )}, ${formatInfo})`
          );

          // 嵌入元数据和封面
          const finalPath = await this.embedMetadata(
            filePath,
            metadata,
            hasThumbnail ? thumbnailPath : undefined
          );

          return {
            audioPath: finalPath,
            thumbnailPath: hasThumbnail ? thumbnailPath : undefined,
          };
        }
      }

      return { audioPath: null };
    } catch (error) {
      console.error("[music] 下载失败:", error);
      return { audioPath: null };
    }
  }

  private getFormatInfo(ext: string): string {
    const formatMap: Record<string, string> = {
      ".flac": "FLAC无损",
      ".wav": "WAV无损",
      ".m4a": "M4A高质量",
      ".opus": "OPUS高效",
      ".aac": "AAC高质量",
      ".mp3": "MP3兼容",
      ".ogg": "OGG开源",
      ".webm": "WebM",
    };
    return formatMap[ext] || ext.toUpperCase();
  }

  private async embedMetadata(
    audioPath: string,
    metadata?: SongInfo,
    thumbnailPath?: string
  ): Promise<string> {
    // 如果没有元数据和封面，直接返回原文件
    if (!metadata && !thumbnailPath) {
      console.log("[music] 没有元数据和封面，跳过嵌入");
      return audioPath;
    }

    // 打印要嵌入的元数据
    if (metadata) {
      console.log("[music] 准备嵌入元数据:");
      console.log(`  - 标题: ${metadata.title || "无"}`);
      console.log(`  - 艺术家: ${metadata.artist || "无"}`);
      console.log(`  - 专辑: ${metadata.album || "无"}`);
    }

    // OPUS 格式特殊处理 - 转换为 MP3 以确保兼容性
    const ext = path.extname(audioPath).toLowerCase();
    if (ext === ".opus") {
      console.log("[music] OPUS 格式：转换为 MP3 以确保 Telegram 兼容性");
      const mp3Path = await this.embedMetadataOnly(audioPath, metadata);

      // 如果有缩略图，为 MP3 嵌入封面
      if (
        thumbnailPath &&
        fs.existsSync(thumbnailPath) &&
        mp3Path.endsWith(".mp3")
      ) {
        return this.embedCoverToMp3(mp3Path, metadata, thumbnailPath);
      }
      return mp3Path;
    }

    try {
      const ext = path.extname(audioPath).toLowerCase();
      const outputPath = audioPath.replace(ext, `_tagged${ext}`);

      // 构建FFmpeg命令 - 添加静默模式
      let ffmpegCmd = `ffmpeg -loglevel error -i "${audioPath}"`;

      // 添加封面（如果有）
      if (thumbnailPath && fs.existsSync(thumbnailPath)) {
        ffmpegCmd += ` -i "${thumbnailPath}"`;
      }

      // 复制音频流 - 保持原始编码
      ffmpegCmd += " -c:a copy";

      // 添加元数据
      if (metadata) {
        if (metadata.title && metadata.title !== "Unknown") {
          ffmpegCmd += ` -metadata title="${metadata.title.replace(
            /"/g,
            '\\"'
          )}"`;
          console.log(`[music] 添加标题: ${metadata.title}`);
        }
        if (metadata.artist && metadata.artist !== "Unknown Artist") {
          ffmpegCmd += ` -metadata artist="${metadata.artist.replace(
            /"/g,
            '\\"'
          )}"`;
          console.log(`[music] 添加艺术家: ${metadata.artist}`);
        }
        if (metadata.album) {
          ffmpegCmd += ` -metadata album="${metadata.album.replace(
            /"/g,
            '\\"'
          )}"`;
          console.log(`[music] 添加专辑: ${metadata.album}`);
        }
        // 添加更多元数据
        ffmpegCmd += ` -metadata comment="Downloaded by TeleBox Music Plugin"`;
        ffmpegCmd += ` -metadata date="${new Date().getFullYear()}"`;
      }

      // 嵌入封面
      if (thumbnailPath && fs.existsSync(thumbnailPath)) {
        // 对于不同格式使用不同的封面嵌入方法
        if (ext === ".mp3") {
          ffmpegCmd +=
            " -map 0:a -map 1:v -c:v mjpeg -disposition:v attached_pic";
        } else if (ext === ".m4a" || ext === ".mp4" || ext === ".aac") {
          ffmpegCmd +=
            " -map 0:a -map 1:v -c:v copy -disposition:v attached_pic";
        } else if (ext === ".flac") {
          ffmpegCmd +=
            " -map 0:a -map 1:v -c:v png -disposition:v attached_pic";
        } else if (ext === ".opus") {
          // OPUS 格式保持原始格式，不嵌入封面避免格式转换
          ffmpegCmd += " -map 0:a -c:a copy";
          // OPUS 格式的封面需要特殊处理，暂时跳过
          console.log("[music] OPUS 格式暂不支持封面嵌入，保持原始格式");
        } else if (ext === ".ogg") {
          // OGG Vorbis 格式
          ffmpegCmd += " -map 0:a";
        } else {
          // 其他格式尝试标准方法
          ffmpegCmd += " -map 0:a";
          if (thumbnailPath) {
            ffmpegCmd += " -map 1:v -c:v copy -disposition:v attached_pic";
          }
        }
      } else {
        // 没有封面时只映射音频流
        ffmpegCmd += " -map 0:a";
      }

      // 输出文件 - 让 FFmpeg 根据扩展名自动选择容器
      // 这里不再强制使用 `-f auto`（无效），仅在特殊需要时才指定格式。
      ffmpegCmd += ` -y "${outputPath}"`;

      console.log("[music] 正在嵌入元数据和封面...");
      const { stderr } = await execAsync(ffmpegCmd);

      // 检查输出文件是否创建成功
      if (!fs.existsSync(outputPath)) {
        console.error("[music] FFmpeg 输出文件未创建");
        if (stderr) console.error("[music] FFmpeg 错误:", stderr);
        return audioPath;
      }

      // 检查新文件大小
      const newSize = fs.statSync(outputPath).size;
      if (newSize === 0) {
        console.error("[music] FFmpeg 输出文件为空");
        fs.unlinkSync(outputPath);
        return audioPath;
      }

      // 删除原文件，重命名新文件
      fs.unlinkSync(audioPath);
      fs.renameSync(outputPath, audioPath);

      console.log("[music] 元数据和封面嵌入成功");
      return audioPath;
    } catch (error) {
      console.error("[music] 元数据嵌入失败:", error);
      // 如果失败，返回原文件
      return audioPath;
    }
  }

  private async embedMetadataOnly(
    audioPath: string,
    metadata?: SongInfo
  ): Promise<string> {
    // OPUS 格式转换为 MP3 以确保 Telegram 兼容性
    if (!metadata) {
      console.log("[music] OPUS: 没有元数据，跳过嵌入");
      return audioPath;
    }

    console.log("[music] OPUS 转换为 MP3 并嵌入元数据...");

    try {
      const ext = path.extname(audioPath).toLowerCase();
      // 转换为 MP3 格式
      const outputPath = audioPath.replace(ext, "_converted.mp3");

      // 使用 FFmpeg 转换为 MP3 并嵌入元数据
      let ffmpegCmd = `ffmpeg -loglevel error -i "${audioPath}"`;

      // 设置 MP3 编码参数 - 高质量
      ffmpegCmd += " -c:a libmp3lame -b:a 320k";

      // 添加元数据
      if (metadata.title && metadata.title !== "Unknown") {
        ffmpegCmd += ` -metadata title="${metadata.title.replace(
          /"/g,
          '\\"'
        )}"`;
        console.log(`[music] 添加标题: ${metadata.title}`);
      }
      if (metadata.artist && metadata.artist !== "Unknown Artist") {
        ffmpegCmd += ` -metadata artist="${metadata.artist.replace(
          /"/g,
          '\\"'
        )}"`;
        console.log(`[music] 添加艺术家: ${metadata.artist}`);
      }
      if (metadata.album) {
        ffmpegCmd += ` -metadata album="${metadata.album.replace(
          /"/g,
          '\\"'
        )}"`;
        console.log(`[music] 添加专辑: ${metadata.album}`);
      }

      // 添加 ID3v2 标签版本
      ffmpegCmd += " -id3v2_version 3";

      // 输出文件
      ffmpegCmd += ` -y "${outputPath}"`;

      console.log("[music] 执行 FFmpeg 转换命令...");
      const { stderr } = await execAsync(ffmpegCmd);
      if (stderr) {
        console.log("[music] FFmpeg 输出:", stderr);
      }

      // 验证输出文件
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        console.error("[music] 转换失败");
        return audioPath;
      }

      // 删除原 OPUS 文件
      fs.unlinkSync(audioPath);

      const newSize = fs.statSync(outputPath).size;
      console.log(`[music] OPUS 转 MP3 成功 (${Utils.formatSize(newSize)})`);
      return outputPath;
    } catch (error) {
      console.error("[music] OPUS 转换错误:", error);
      return audioPath;
    }
  }

  private async embedCoverToMp3(
    mp3Path: string,
    metadata?: SongInfo,
    thumbnailPath?: string
  ): Promise<string> {
    // 为 MP3 文件嵌入封面
    if (!thumbnailPath || !fs.existsSync(thumbnailPath)) {
      return mp3Path;
    }

    try {
      const outputPath = mp3Path.replace(".mp3", "_final.mp3");

      // 使用 FFmpeg 嵌入封面
      let ffmpegCmd = `ffmpeg -loglevel error -i "${mp3Path}" -i "${thumbnailPath}"`;
      ffmpegCmd += " -map 0:a -map 1:v";
      ffmpegCmd += " -c:a copy -c:v mjpeg";
      ffmpegCmd += " -disposition:v attached_pic";

      // 保留元数据
      if (metadata) {
        if (metadata.title) {
          ffmpegCmd += ` -metadata title="${metadata.title.replace(
            /"/g,
            '\\"'
          )}"`;
        }
        if (metadata.artist) {
          ffmpegCmd += ` -metadata artist="${metadata.artist.replace(
            /"/g,
            '\\"'
          )}"`;
        }
        if (metadata.album) {
          ffmpegCmd += ` -metadata album="${metadata.album.replace(
            /"/g,
            '\\"'
          )}"`;
        }
      }

      ffmpegCmd += " -id3v2_version 3";
      ffmpegCmd += ` -y "${outputPath}"`;

      console.log("[music] 嵌入封面到 MP3...");
      await execAsync(ffmpegCmd);

      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(mp3Path);
        console.log("[music] MP3 封面嵌入成功");
        return outputPath;
      }

      return mp3Path;
    } catch (error) {
      console.error("[music] MP3 封面嵌入失败:", error);
      return mp3Path;
    }
  }

  async cleanCache(hours: number = 24): Promise<void> {
    // 清理临时文件，而不是缓存
    const now = Date.now();
    const maxAge = hours * 60 * 60 * 1000;

    try {
      const files = await fs.promises.readdir(this.tempDir);
      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        const stats = await fs.promises.stat(filePath);
        if (now - stats.mtimeMs > maxAge) {
          await fs.promises.unlink(filePath);
          console.log(`[music] Cleaned old temp file: ${file}`);
        }
      }
    } catch (error) {
      console.error("[music] Clean temp files error:", error);
    }
  }
}

// ==================== Main Plugin ====================
class MusicPlugin extends Plugin {
  cleanup(): void {
    for (const timer of pendingCleanupTimers) {
      clearTimeout(timer);
    }
    pendingCleanupTimers.clear();
    ConfigManager.cleanup();
    MusicPlugin.initialized = false;
  }

  async setup(): Promise<void> {
    await this.initialize();
  }

  private static initialized = false;
  private downloader: Downloader;

  async initialize(): Promise<void> {
    if (MusicPlugin.initialized) return;

    console.log("[music] 初始化 Music Plugin...");

    // 检查并安装依赖
    const depsInstalled = await DependencyManager.checkAndInstallDependencies();
    if (!depsInstalled) {
      console.error("[music] 依赖安装失败");
    }

    // 检查 yt-dlp
    const ytdlpAvailable = await DependencyManager.checkYtDlp();
    if (!ytdlpAvailable) {
      console.warn("[music] yt-dlp 未安装，请手动安装: sudo pip install --upgrade --force-reinstall yt-dlp --break-system-packages");
    } else {
      // 尝试自动更新yt-dlp到最新版本
      try {
        console.log("[music] 正在检查yt-dlp更新...");
        const { stdout } = await execAsync("yt-dlp -U");
        if (stdout.includes("up to date")) {
          console.log("[music] yt-dlp已是最新版本");
        } else if (stdout.includes("Updated")) {
          console.log("[music] yt-dlp已更新到最新版本");
        }
      } catch (error) {
        console.log("[music] 无法自动更新yt-dlp，请手动更新: yt-dlp -U");
      }
    }

    const ffmpegInstalled = await DependencyManager.checkFfmpeg();
    if (!ffmpegInstalled) {
      console.warn("[music] ffmpeg 未安装，音频转换功能受限");
    }

    MusicPlugin.initialized = true;
  }

  public name = "music";
  public description: string;
  public cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>>;

  constructor() {
    super();
    this.description = `🎵 <b>音乐下载助手</b>

<b>使用方法：</b>
<code>${commandName} 周杰伦 晴天</code> - 搜索下载
<code>${commandName} https://...</code> - 链接下载

<b>配置管理：</b>
<code>${commandName} config</code> - 查看当前配置
<code>${commandName} set cookie [值]</code> - 设置YouTube Cookie
<code>${commandName} set proxy [地址]</code> - 设置代理服务器
<code>${commandName} set api_key [密钥]</code> - 设置Gemini API Key
<code>${commandName} set base_url [地址]</code> - 设置Gemini Base URL
<code>${commandName} set model [模型]</code> - 设置Gemini模型
<code>${commandName} set quality [音质]</code> - 自定义音频质量 (如: 320k / 192k / 0..10)
<code>${commandName} clear</code> - 清理临时文件

<b>配置说明：</b>
• <code>cookie</code> - 绕过地区限制，提升下载成功率
• <code>proxy</code> - 网络代理地址 (如: socks5://127.0.0.1:1080)
• <code>quality</code> - 音质：支持 <code>320k/256k/192k/128k</code> 等比特率，或 <code>0..10</code> (VBR，数字越小越好)

<b>解决YouTube访问问题：</b>

🚀 <b>方案1 - WARP+ (推荐)：</b>
<pre>wget -N https://gitlab.com/fscarmen/warp/-/raw/main/menu.sh && bash menu.sh e</pre>

🔧 <b>方案2 - WireProxy：</b>
<pre># 安装 WireProxy
wget -N https://gitlab.com/fscarmen/warp/-/raw/main/menu.sh && bash menu.sh w

# 配置代理（WireProxy 默认端口 40000）
${commandName} set proxy socks5://127.0.0.1:40000</pre>

💡 <i>直接输入歌名即可快速搜索下载</i>`;

    this.downloader = new Downloader();
    this.downloader.cleanCache().catch(() => {});

    // 注册命令处理器
    this.cmdHandlers = {
      music: this.execute.bind(this),
    };
  }

  async execute(msg: MessageContext): Promise<void> {
    const args = msg.text?.split(" ").slice(1) || [];

    if (!args.length || args[0] === "help") {
      // 编辑原消息而不是回复
      await msg.edit({ text: html(this.description) });
      return;
    }

    const command = args[0].toLowerCase();

    switch (command) {
      case "config":
        await this.handleConfig(msg);
        break;

      case "set":
        await this.handleSet(msg, args.slice(1));
        break;

      case "clear":
        await this.handleClear(msg);
        break;

      default:
        await this.handleDownload(msg, args.join(" "));
    }
  }

  private async handleConfig(msg: MessageContext): Promise<void> {
    const cookie = await ConfigManager.get(CONFIG.KEYS.COOKIE);
    const proxy = await ConfigManager.get(CONFIG.KEYS.PROXY);
    const apiKey = await ConfigManager.get(CONFIG.KEYS.API);
    const baseUrl = await ConfigManager.get(CONFIG.KEYS.BASE_URL);
    const model = await ConfigManager.get(CONFIG.KEYS.MODEL);
    const quality = await ConfigManager.get(CONFIG.KEYS.AUDIO_QUALITY);

    const status = `⚙️ <b>当前配置</b>

${cookie ? "✅" : "⚪"} <b>Cookie:</b> ${cookie ? "已设置" : "未设置"}
${proxy ? "✅" : "⚪"} <b>代理:</b> ${proxy ? Utils.escape(proxy) : "未配置"}
${apiKey ? "✅" : "⚪"} <b>AI搜索:</b> ${apiKey ? "已启用" : "未配置"}
🎚️ <b>音频质量:</b> <code>${Utils.escape(quality || "自动(最佳可用)")}</code>
🔧 <b>Gemini Base URL:</b> <code>${Utils.escape(baseUrl || "")}</code>
🧠 <b>Gemini Model:</b> <code>${Utils.escape(model || "")}</code>

💡 <i>使用 <code>${commandName} set [配置项] [值]</code> 修改配置</i>`;

    // 编辑原消息而不是回复
    await msg.edit({ text: html(status) });
  }

  private async handleSet(msg: MessageContext, args: string[]): Promise<void> {
    if (args.length < 2) {
      // 编辑原消息而不是回复
      await msg.edit({
        text: html`❌ <b>参数不足</b><br><br>
<br><br>
<b>正确格式：</b><br><br>
<code>${commandName} set cookie [YouTube Cookie]</code><br>
<code>${commandName} set proxy [代理地址]</code><br>
<code>${commandName} set api_key [Gemini API密钥]</code><br>
<code>${commandName} set base_url [Gemini Base URL]</code><br>
<code>${commandName} set model [Gemini 模型]</code><br>
<code>${commandName} set quality [音质]</code><br>
<br>
<b>代理配置示例：</b><br>
<code>${commandName} set proxy socks5://127.0.0.1:1080</code><br>
<code>${commandName} set proxy http://127.0.0.1:8080</code><br>
<code>${commandName} set proxy socks5://127.0.0.1:40000</code> (WireProxy)<br>
<code>${commandName} set proxy none</code> (清空代理)<br>
<br>
<b>音质示例：</b><br>
<code>${commandName} set quality 320k</code><br>
<code>${commandName} set quality 192k</code><br>
<code>${commandName} set quality 0</code> (VBR 最高质量)`,
      });
      return;
    }

    const [rawKey, ...valueParts] = args;
    let value = valueParts.join(" ");

    // 支持 none/clear/空 来清空配置
    const clearKeywords = ["none", "clear", "空", "取消"];
    if (clearKeywords.includes(value.toLowerCase().trim())) {
      value = "";
    }

    // 将用户友好键映射为内部存储键
    const keyMap: Record<string, string> = {
      cookie: CONFIG.KEYS.COOKIE,
      proxy: CONFIG.KEYS.PROXY,
      api_key: CONFIG.KEYS.API,
      base_url: CONFIG.KEYS.BASE_URL,
      baseurl: CONFIG.KEYS.BASE_URL,
      model: CONFIG.KEYS.MODEL,
      quality: CONFIG.KEYS.AUDIO_QUALITY,
    };
    const normalized = keyMap[rawKey.toLowerCase()] || rawKey;

    // 针对音质做输入规范化与校验
    let finalValue = value;
    if (normalized === CONFIG.KEYS.AUDIO_QUALITY) {
      const v = value.trim().toLowerCase();
      // 接受 0..10 或 Xk / Xkbps / Xkb
      const vbrMatch = /^(?:[0-9]|10)$/.test(v);
      const kbpsMatch = /^(\d{2,3})\s*(k|kb|kbps)?$/.exec(v);
      if (vbrMatch) {
        finalValue = v; // VBR 等级
      } else if (kbpsMatch) {
        // 规范化为 128k 格式
        const kb = parseInt(kbpsMatch[1], 10);
        if ([64, 96, 128, 160, 192, 256, 320].includes(kb)) {
          finalValue = `${kb}k`;
        } else {
          await msg.edit({
            text: html`❌ <b>音质无效</b><br><br>支持 <code>0..10</code> 或 <code>128k/192k/256k/320k</code>`,
          });
          return;
        }
      } else if (v === "" || v === "auto" || v === "best") {
        // 清空 = 自动(最佳可用)
        finalValue = "";
      } else {
        await msg.edit({
          text: html`❌ <b>音质无效</b><br><br>支持 <code>0..10</code> 或 <code>128k/192k/256k/320k</code>`,
        });
        return;
      }
    }

    const success = await ConfigManager.set(normalized, finalValue);

    if (success) {
      // 根据不同的配置项给出友好提示
      let successMsg = `✅ <b>配置已更新</b>\n\n`;

      switch (rawKey.toLowerCase()) {
        case "cookie":
          successMsg += `🍪 YouTube Cookie 已设置\n现在可以绕过地区限制了`;
          break;
        case "proxy":
          if (finalValue) {
            successMsg += `🌐 代理服务器已配置\n地址: <code>${Utils.escape(
              finalValue
            )}</code>`;
          } else {
            successMsg += `🌐 代理已清空\n现在将直连下载`;
          }
          break;
        case "api_key":
          successMsg += `🤖 AI 搜索功能已启用\n可以更智能地搜索音乐了`;
          break;
        case "base_url":
        case "baseurl":
          successMsg += `🔧 Gemini Base URL 已设置\n地址: <code>${Utils.escape(
            value
          )}</code>`;
          break;
        case "model":
          successMsg += `🧠 Gemini 模型已设置\n模型: <code>${Utils.escape(
            value
          )}</code>`;
          break;
        case "quality":
          successMsg += `🎚️ 音质已设置\n当前: <code>${Utils.escape(
            finalValue || "自动(最佳可用)"
          )}</code>`;
          break;
        default:
          successMsg += `<code>${Utils.escape(rawKey)}</code> 已成功设置`;
      }

      await msg.edit({
        text: html(successMsg),
      });
    } else {
      await msg.edit({
        text: html`❌ <b>配置失败</b><br><br>无法设置 <code>${rawKey}</code>`,
      });
    }
  }

  private async handleClear(msg: MessageContext): Promise<void> {
    // 编辑原消息而不是回复
    await msg.edit({
      text: html`🧹 <b>正在清理...</b>`,
    });

    await this.downloader.cleanCache(0);

    await msg.edit({
      text: html`✨ <b>清理完成</b><br><br>临时文件已全部删除`,
    });
  }

  private async handleDownload(msg: MessageContext, query: string): Promise<void> {
    // 确保插件已初始化
    await this.initialize();

    const client = await getGlobalClient();
    if (!client) {
      // 编辑原消息而不是回复
      await msg.edit({ text: html`❌ <b>客户端未初始化</b>` });
      return;
    }

    // 检查 yt-dlp 是否可用
    const ytdlpAvailable = await DependencyManager.checkYtDlp();
    if (!ytdlpAvailable) {
      await msg.edit({
        text: html`❌ <b>缺少必要组件</b><br><br>
<br><br>
🛠️ <b>解决方案：</b><br><br>
<code>sudo pip install --upgrade --force-reinstall yt-dlp --break-system-packages</code><br><br>
<br><br>
🚀 <b>网络问题？试试 WARP：</b><br><br>
<code>wget -N https://gitlab.com/fscarmen/warp/-/raw/main/menu.sh && bash menu.sh e</code><br><br>
<br><br>
💡 <b>提示：</b>配置 Gemini API 可提升搜索准确率<br><br>
<code>${commandName} set api_key [你的Gemini密钥]</code>`,
      });
      return;
    }

    // Check dependencies
    const deps = await this.downloader.checkDependencies();
    if (!deps.ytdlp) {
      await msg.edit({
        text: html`❌ <b>缺少下载器</b><br><br>
<br><br>
🛠️ <b>安装 yt-dlp：</b><br><br>
<code>sudo pip install --upgrade --force-reinstall yt-dlp --break-system-packages</code><br><br>
<br><br>
🌐 <b>网络受限？配置代理：</b><br><br>
<code>${commandName} set proxy socks5://127.0.0.1:1080</code><br>
<br>
🍪 <b>或设置 Cookie 绕过限制：</b><br>
<code>${commandName} set cookie [YouTube Cookie]</code>`,
      });
      return;
    }

    // 先编辑原消息显示处理中
    await msg.edit({
      text: html`🎵 <b>处理中...</b>`,
    });

    // 创建一个状态消息用于后续更新
    const statusMsg = msg;

    try {
      let url: string | null = null;
      let metadata: SongInfo | undefined;

      // Check if input is URL
      if (query.includes("youtube.com") || query.includes("youtu.be")) {
        url = query;
      } else {
        // 解析查询获取元数据（可能使用 AI）
        metadata = await this.parseQuery(query);
        console.log(
          `[music] 查询解析结果: ${metadata.artist} - ${metadata.title}`
        );

        // 显示AI识别结果
        const recognitionText = metadata.album
          ? `${metadata.artist} - ${metadata.title} - ${metadata.album}`
          : `${metadata.artist} - ${metadata.title}`;

        await statusMsg.edit({
          text: html`🤖 <b>AI 识别结果:</b> ${recognitionText}`,
        });

        // 使用 yt-dlp 搜索，加入"動態歌詞"关键词
        const searchQuery = `${recognitionText} lyrics`;
        url = await this.downloader.search(searchQuery, metadata.duration);
      }

      if (!url) {
        await statusMsg.edit({
          text: html`😔 <b>未找到相关音乐</b><br><br>
<br><br>
🔍 <b>建议尝试：</b><br><br>
• 更换搜索关键词<br><br>
• 配置 Cookie 绕过地区限制<br><br>
• 使用 WARP 改善网络连接<br><br>
<br><br>
⚙️ <b>快速配置：</b><br><br>
<code>${commandName} set cookie [Cookie]</code><br>
<code>${commandName} set api_key [Gemini密钥]</code>`,
        });
        return;
      }

      // Download
      await statusMsg.edit({
        text: html`⬇️ <b>下载中...</b>`,
      });

      // 传递元数据给下载器
      console.log(
        `[music] 开始下载，元数据: ${metadata?.artist || "无"} - ${
          metadata?.title || "无"
        }`
      );
      const downloadResult = await this.downloader.download(url, metadata);

      if (!downloadResult.audioPath) {
        await statusMsg.edit({
          text: html`❌ <b>下载失败</b><br><br>
<br><br>
🛠️ <b>解决方案：</b><br><br>
• 配置 YouTube Cookie 绕过限制<br><br>
• 设置网络代理或使用 WARP<br><br>
• 检查网络连接状态<br><br>
<br><br>
⚙️ <b>快速配置：</b><br><br>
<code>${commandName} set cookie [Cookie]</code><br>
<code>${commandName} set proxy [代理地址]</code><br>
<br>
🚀 <b>WARP 安装：</b><br>
<code>wget -N https://gitlab.com/fscarmen/warp/-/raw/main/menu.sh && bash menu.sh e</code>`,
        });
        return;
      }

      // Upload
      await statusMsg.edit({
        text: html`📤 <b>上传中...</b>`,
      });

      const stats = await fs.promises.stat(downloadResult.audioPath);

      // 准备发送参数
      const fileName = path.basename(downloadResult.audioPath);
      const sendParams: any = {
        type: "audio",
        file: downloadResult.audioPath,
        fileName: fileName,
        duration: metadata?.duration
          ? Math.max(0, Math.floor(metadata.duration))
          : 0,
        title: metadata?.title || "Audio",
        performer: metadata?.artist || "Unknown Artist",
      };

      // 如果有缩略图，添加到发送参数中
      if (
        downloadResult.thumbnailPath &&
        fs.existsSync(downloadResult.thumbnailPath)
      ) {
        sendParams.thumb = downloadResult.thumbnailPath;
      }

      // 发送音频文件，元数据和缩略图已嵌入
      await client.sendMedia(msg.chat.id, sendParams);

      // 删除状态消息
      await statusMsg.delete();

      const lifecycle = tryGetCurrentGenerationContext();
      const timer = lifecycle
        ? lifecycle.setTimeout(cleanupDownloadedFiles, 5000, { label: "music:download-cleanup" })
        : setTimeout(cleanupDownloadedFiles, 5000);
      function cleanupDownloadedFiles(): void {
        pendingCleanupTimers.delete(timer);
        try {
          if (
            downloadResult.audioPath &&
            fs.existsSync(downloadResult.audioPath)
          ) {
            fs.unlinkSync(downloadResult.audioPath);
          }
          if (
            downloadResult.thumbnailPath &&
            fs.existsSync(downloadResult.thumbnailPath)
          ) {
            fs.unlinkSync(downloadResult.thumbnailPath);
          }
        } catch (error) {
          console.log("[music] 清理临时文件失败:", error);
        }
      }
      pendingCleanupTimers.add(timer);
      if (timer.unref) timer.unref();
    } catch (error: any) {
      if (statusMsg) {
        await statusMsg.edit({
          text: html`❌ <b>Error:</b> ${error.message || "Unknown error"}`,
        });
      }
    }
  }

  private async parseQuery(query: string): Promise<SongInfo> {
    // 改进的查询解析，支持多种格式
    // 格式1: "歌手 - 歌名"
    // 格式2: "歌名 歌手"
    // 格式3: "歌名"

    // 尝试解析 "歌手 - 歌名" 格式
    if (query.includes(" - ")) {
      const parts = query.split(" - ");
      return {
        artist: parts[0].trim(),
        title: parts[1].trim(),
        album: parts[2]?.trim(), // 支持 "歌手 - 歌名 - 专辑" 格式
      };
    }

    // 尝试使用 AI 解析（如果配置了 API key）
    const apiKey = await ConfigManager.get(CONFIG.KEYS.API);
    if (apiKey) {
      try {
        console.log("[music] 使用 AI 解析歌曲信息...");
        const baseUrl = await ConfigManager.get(CONFIG.KEYS.BASE_URL);
        const gemini = new GeminiClient(apiKey, baseUrl);
        const aiResponse = await gemini.searchMusic(query);
        const songInfo = await extractSongInfo(aiResponse, query);
        console.log(
          `[music] AI 识别结果: ${songInfo.artist} - ${songInfo.title}${
            songInfo.album ? " - " + songInfo.album : ""
          }`
        );
        return songInfo;
      } catch (error) {
        console.log("[music] AI 解析失败，使用默认解析:", error);
      }
    } else {
      console.log("[music] 未配置 Gemini API，使用默认解析");
    }

    // 默认解析
    return {
      title: query,
      artist: "Unknown Artist",
    };
  }
}

export default new MusicPlugin();
