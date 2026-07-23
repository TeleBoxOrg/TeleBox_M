import { TelegramClient } from "@mtcute/node";
import {
  SocksProxyTcpTransport,
  HttpProxyTcpTransport,
  MtProxyTcpTransport,
} from "@mtcute/node";
import { getApiConfig } from "./apiConfig";
import { readAppName } from "./teleboxInfoHelper";
import { logger } from "@utils/logger";
import { patchTelegramClientHtmlCompat } from "../hook/patches/telegram.patch";
import path from "path";
import fs from "fs";

/**
 * Native mtcute client factory.
 *
 * Replaces the legacy gramjs `new TelegramClient(new StringSession(...), ...)`
 * construction. mtcute persists session state in an SQLite file (the `storage`
 * option), so there is no StringSession concept — we pass a file path and let
 * mtcute manage auth keys / DC state / peer cache in `session.db`.
 *
 * The legacy `config.json.session` (a gramjs/teleproto StringSession) can be
 * converted offline via `@mtcute/convert` + `versionSwitchSessionConvert.ts`
 * during `.switch go`. Runtime still uses SQLite (`session.db` or
 * `config.json._switchSessionPath` for switch-injected external sessions).
 */

const SESSION_DB_PATH = (() => {
  // Support external session from version switch controller
  try {
    const configPath = path.join(process.cwd(), "config.json");
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      if (typeof config._switchSessionPath === "string" && config._switchSessionPath) {
        const switchPath = config._switchSessionPath;
        if (fs.existsSync(switchPath)) return switchPath;
      }
    }
  } catch { /* ignore parse errors, use default */ }
  return path.join(process.cwd(), "session.db");
})();

/**
 * Build an mtcute transport instance from the legacy proxy config shape.
 * Returns undefined when no proxy is configured (mtcute then uses its default
 * platform-specific TcpTransport).
 *
 * mtcute's `transport` option expects a TelegramTransport instance, not a
 * factory.
 */
export interface LegacyProxyConfig {
  ip?: string;
  host?: string;
  hostname?: string;
  port?: number | string;
  username?: string;
  user?: string;
  password?: string;
  socksType?: 4 | 5;
  type?: string;
  http?: boolean;
  MTProxy?: boolean;
  secret?: string;
}

/**
 * Read proxy configuration from environment variables.
 * Supports standard proxy env vars: HTTP_PROXY, HTTPS_PROXY, ALL_PROXY,
 * and socks5:// or socks4:// URLs.
 */
function getProxyFromEnv(): LegacyProxyConfig | undefined {
  // Check standard env vars (case-insensitive)
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const allProxy = process.env.ALL_PROXY || process.env.all_proxy;
  const socksProxy = process.env.SOCKS_PROXY || process.env.socks_proxy;

  // Prefer https_proxy > http_proxy > all_proxy > socks_proxy for HTTP/HTTPS
  const proxyUrl = httpsProxy || httpProxy || allProxy || socksProxy;
  if (!proxyUrl) return undefined;

  try {
    const url = new URL(proxyUrl);
    const host = url.hostname;
    const port = Number(url.port);
    const username = url.username ? decodeURIComponent(url.username) : undefined;
    const password = url.password ? decodeURIComponent(url.password) : undefined;

    if (!host || !port) {
      logger.warn("[CLIENT] 环境变量代理 URL 格式无效，缺少 host 或 port:", proxyUrl);
      return undefined;
    }

    const protocol = url.protocol.toLowerCase();

    if (protocol === "socks5:") {
      return {
        host,
        port,
        username,
        password,
        socksType: 5,
      };
    }

    if (protocol === "socks4:") {
      return {
        host,
        port,
        username,
        password,
        socksType: 4,
      };
    }

    if (protocol === "http:" || protocol === "https:") {
      return {
        host,
        port,
        username,
        password,
        type: "http",
        http: true,
      };
    }

    logger.warn("[CLIENT] 不支持的代理协议:", protocol);
    return undefined;
  } catch (e: unknown) {
    logger.warn("[CLIENT] 解析环境变量代理失败:", e);
    return undefined;
  }
}

function buildTransport(
  proxy: LegacyProxyConfig | undefined
): SocksProxyTcpTransport | HttpProxyTcpTransport | MtProxyTcpTransport | undefined {
  // Merge config proxy with env proxy: config takes precedence, env as fallback
  const envProxy = getProxyFromEnv();
  const effectiveProxy = proxy ?? envProxy;

  if (!effectiveProxy) return undefined;

  // Legacy gramjs proxy shape: { socksType?: 4|5, ip, port, username?, password? }
  // or { MTProxy: true, ip, port, secret }
  const host = effectiveProxy.ip ?? effectiveProxy.host ?? effectiveProxy.hostname;
  if (!host) {
    logger.warn("[CLIENT] 代理配置缺少 host，回退到直连");
    return undefined;
  }

  try {
    if (effectiveProxy.MTProxy || effectiveProxy.secret) {
      return new MtProxyTcpTransport({
        host,
        port: Number(effectiveProxy.port),
        secret: effectiveProxy.secret ?? "",
      });
    }

    const port = Number(effectiveProxy.port);

    // HTTP proxy
    if (effectiveProxy.type === "http" || effectiveProxy.http) {
      return new HttpProxyTcpTransport({
        host,
        port,
        user: effectiveProxy.username ?? effectiveProxy.user ?? "",
        password: effectiveProxy.password ?? "",
      });
    }

    // Default: SOCKS proxy (gramjs socksType 4/5)
    return new SocksProxyTcpTransport({
      host,
      port,
      user: effectiveProxy.username ?? effectiveProxy.user ?? "",
      password: effectiveProxy.password ?? "",
      version: effectiveProxy.socksType === 4 ? 4 : 5,
    });
  } catch (e: unknown) {
    logger.warn("[CLIENT] 代理配置解析失败，回退到直连:", e);
    return undefined;
  }
}

/**
 * Create a native mtcute TelegramClient using the project's apiConfig.
 * The returned client is NOT yet started/connected — call client.start()
 * (handled in loginManager) before use.
 */
export async function createMtcuteClient(): Promise<TelegramClient> {
  const api = await getApiConfig();

  if (!api.api_id || !api.api_hash) {
    throw new Error("[CLIENT] api_id / api_hash 缺失，无法创建 mtcute 客户端");
  }

  const proxy = api.proxy;
  if (proxy) {
    logger.info("[CLIENT] 使用代理连接 Telegram:", proxy.ip ?? proxy.host);
  }

  const transport = buildTransport(proxy);

  const client = new TelegramClient({
    apiId: api.api_id,
    apiHash: api.api_hash,
    storage: SESSION_DB_PATH,
    initConnectionOptions: {
      deviceModel: readAppName(),
    },
    // 启动时 catch-up：否则超活频道（GitHubBot 群）pts 脱节后 live update 永不投递
    updates: {
      catchUp: true,
    },
    ...(transport ? { transport } : {}),
  });

  // Bridge mtcute internal logging into TeleBox-Next logger when supported.
  // mtcute's client.log is a Logger instance; level lives on its mgr (LogManager).
  try {
    const lvl = logger.getGramJSLogLevel?.();
    const clientLog = client.log;
    if (typeof lvl === "string" && clientLog) {
      const levelMap: Record<string, number> = {
        debug: 4, // LogManager.VERBOSE
        info: 3,  // LogManager.INFO
        warn: 2,  // LogManager.WARN
        error: 1, // LogManager.ERROR
        none: 0,  // LogManager.OFF
      };
      clientLog.mgr.level = levelMap[lvl] ?? 3;
    }
  } catch (e: unknown) {
    logger.error("[mtcuteClient] failed to bridge log level:", e);
  }

  // Central HTML + sendFile(gramjs) compatibility for all plugins
  try {
    patchTelegramClientHtmlCompat(client as never);
  } catch (e: unknown) {
    logger.error("[mtcuteClient] html-compat patch failed:", e);
  }

  return client;
}

/**
 * Gracefully tear down an mtcute client.
 *
 * 根因（生产 error log）:
 *   destroy() 置 #destroyed=true 后，UpdatesManager._loop 仍可能在跑
 *   `_fetchDifference` → client.call → "Client is destroyed" 未捕获 rejection。
 * 顺序：先 stopLoop，再 destroy，压住竞态。
 */
export async function destroyMtcuteClient(client: TelegramClient): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyClient = client as any;
    const updates = anyClient.updates ?? anyClient._updates ?? anyClient.mt?.updates;
    if (updates && typeof updates.stopLoop === "function") {
      try {
        updates.stopLoop();
      } catch {
        /* ignore */
      }
    }
    if (typeof anyClient.disconnect === "function") {
      try {
        await anyClient.disconnect();
      } catch {
        /* ignore — destroy will close remaining resources */
      }
    }
  } catch {
    /* ignore pre-destroy best-effort cleanup */
  }
  try {
    await client.destroy();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/Client is destroyed|already destroyed|destroyed/i.test(msg)) {
      throw e;
    }
  }
}

export { SESSION_DB_PATH };
