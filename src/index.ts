import "dotenv/config";

import axios from "axios";
import { startRuntime } from "@utils/runtimeManager";
import { initPluginBaseConfig } from "@utils/pluginBase";

import "./hook/patches/telegram.patch";
import { logger } from "@utils/logger";

initPluginBaseConfig();

// 配置全局 HTTP 代理 - 让所有 axios 请求走代理
// 支持环境变量：HTTP_PROXY, HTTPS_PROXY, NO_PROXY
const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const noProxy = process.env.NO_PROXY || process.env.no_proxy;

if (httpProxy || httpsProxy) {
  logger.info(
    `[PROXY] HTTP_PROXY: ${httpProxy || "not set"} | HTTPS_PROXY: ${httpsProxy || "not set"} | NO_PROXY: ${noProxy || "not set"}`
  );

  // 解析代理 URL
  const parseProxy = (proxyUrl: string) => {
    const url = new URL(proxyUrl);
    return {
      host: url.hostname,
      port: parseInt(url.port, 10),
      protocol: url.protocol.replace(":", ""),
      auth: url.username
        ? {
            username: url.username,
            password: url.password || "",
          }
        : undefined,
    };
  };

  if (httpsProxy) {
    axios.defaults.proxy = parseProxy(httpsProxy);
  } else if (httpProxy) {
    axios.defaults.proxy = parseProxy(httpProxy);
  }

  logger.info("[PROXY] 全局代理配置已应用");
} else {
  logger.info("[PROXY] 未检测到代理环境变量，使用直连");
}

// Global error handlers to prevent unhandled rejections and exceptions
// from crashing the process silently. These log the error for debugging.
// Note: We intentionally do NOT call process.exit() here — exiting on every
// unhandled rejection is too aggressive for a production bot with many plugins
// where a single missing .catch() would crash the entire process. PM2's own
// restart strategy handles actual fatal crashes.
process.on("unhandledRejection", (reason: unknown) => {
  const message =
    reason instanceof Error ? reason.stack || reason.message : String(reason);
  logger.error(`[FATAL] Unhandled promise rejection: ${message}`);
});

process.on("uncaughtException", (error: Error) => {
  logger.error(`[FATAL] Uncaught exception: ${error.stack || error.message}`);
});

async function run() {
  await startRuntime();
}

run();
