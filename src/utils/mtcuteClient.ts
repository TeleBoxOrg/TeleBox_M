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

function buildTransport(
  proxy: LegacyProxyConfig | undefined
): SocksProxyTcpTransport | HttpProxyTcpTransport | MtProxyTcpTransport | undefined {
  if (!proxy) return undefined;

  // Legacy gramjs proxy shape: { socksType?: 4|5, ip, port, username?, password? }
  // or { MTProxy: true, ip, port, secret }
  const host = proxy.ip ?? proxy.host ?? proxy.hostname;
  if (!host) {
    logger.warn("[CLIENT] 代理配置缺少 host，回退到直连");
    return undefined;
  }

  try {
    if (proxy.MTProxy || proxy.secret) {
      return new MtProxyTcpTransport({
        host,
        port: Number(proxy.port),
        secret: proxy.secret ?? "",
      });
    }

    const port = Number(proxy.port);

    // HTTP proxy
    if (proxy.type === "http" || proxy.http) {
      return new HttpProxyTcpTransport({
        host,
        port,
        user: proxy.username ?? proxy.user ?? "",
        password: proxy.password ?? "",
      });
    }

    // Default: SOCKS proxy (gramjs socksType 4/5)
    return new SocksProxyTcpTransport({
      host,
      port,
      user: proxy.username ?? proxy.user ?? "",
      password: proxy.password ?? "",
      version: proxy.socksType === 4 ? 4 : 5,
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
 * Gracefully tear down an mtcute client. mtcute exposes `destroy()` (Node layer)
 * which closes the connection and the underlying storage.
 */
export async function destroyMtcuteClient(client: TelegramClient): Promise<void> {
  await client.destroy();
}

export { SESSION_DB_PATH };
