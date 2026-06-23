import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/globalClient";
import { html } from "@mtcute/html-parser";
import type { MessageContext } from "@mtcute/dispatcher";
import { exec } from "child_process";
import { promisify } from "util";
import { createConnection } from "net";
import * as dns from "dns";

import { safeGetMe } from "../utils/authGuards";
import { logger } from "@utils/logger";
import { getErrorMessage, getErrorCode } from "@utils/errorHelpers";
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];


const execAsync = promisify(exec);

// 数据中心IP地址映射 (参考PagerMaid-Modify)
const DCs = {
  1: "149.154.175.53", // DC1 Miami
  2: "149.154.167.51", // DC2 Amsterdam
  3: "149.154.175.100", // DC3 Miami
  4: "149.154.167.91", // DC4 Amsterdam
  5: "91.108.56.130", // DC5 Singapore (PagerMaid IP)
};

// HTML转义函数
function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * TCP连接测试(Telegram 网络栈测试)。
 *
 * 旧版用 gramjs 的 PromisedNetSockets 走 Telegram 网络栈;mtcute 不暴露该底层
 * socket,这里改用 Node 原生 TCP 连接(与 tcpPing 等价)。
 */
async function telegramTcpPing(
  hostname: string,
  port: number = 80,
  timeout: number = 3000
): Promise<number> {
  const net = await import('net');
  return new Promise((resolve) => {
    const start = performance.now();
    const socket = net.createConnection(port, hostname, () => {
      const end = performance.now();
      socket.destroy();
      resolve(Math.round(end - start));
    });
    socket.setTimeout(timeout);
    socket.on('timeout', () => { socket.destroy(); resolve(-1); });
    socket.on('error', () => { socket.destroy(); resolve(-1); });
  });
}

/**
 * 传统TCP连接测试 - 备用方法
 */
async function tcpPing(
  hostname: string,
  port: number = 80,
  timeout: number = 3000
): Promise<number> {
  return new Promise((resolve) => {
    const start = performance.now();
    const socket = createConnection(port, hostname);

    socket.setTimeout(timeout);

    socket.on("connect", () => {
      const end = performance.now();
      socket.end();
      resolve(Math.round(end - start));
    });

    function handleError() {
      socket.destroy();
      resolve(-1);
    }

    socket.on("timeout", handleError);
    socket.on("error", handleError);
  });
}

/**
 * HTTP请求延迟测试 - 模拟ping
 */
async function httpPing(
  hostname: string,
  useHttps: boolean = false
): Promise<number> {
  return new Promise((resolve) => {
    const start = performance.now();
    const protocol = useHttps ? require("https") : require("http");
    const port = useHttps ? 443 : 80;

    const req = protocol.request(
      {
        hostname,
        port,
        path: "/",
        method: "HEAD",
        timeout: 5000,
        headers: {
          "User-Agent": "TeleBox-Ping/1.0",
        },
      },
      (res: { statusCode?: number; headers?: Record<string, string> }) => {
        const end = performance.now();
        req.destroy();
        resolve(Math.round(end - start));
      }
    );

    req.on("error", () => {
      resolve(-1);
    });

    req.on("timeout", () => {
      req.destroy();
      resolve(-1);
    });

    req.end();
  });
}

/**
 * DNS解析延迟测试
 */
async function dnsLookupTime(
  hostname: string
): Promise<{ time: number; ip: string }> {
  return new Promise((resolve) => {
    const start = performance.now();
    dns.lookup(hostname, (err, address) => {
      const end = performance.now();
      if (err) {
        resolve({ time: -1, ip: "" });
      } else {
        resolve({ time: Math.round(end - start), ip: address });
      }
    });
  });
}

/**
 * 系统ICMP ping命令 (Linux)
 */
async function systemPing(
  target: string,
  count: number = 3
): Promise<{ avg: number; loss: number; output: string }> {
  try {
    const pingCmd = `ping -c ${count} -W 5 ${target}`;
    const { stdout, stderr } = await execAsync(pingCmd, { timeout: 10000 });

    logger.info(stdout);

    // 解析Linux ping结果
    let avgTime = -1;
    let packetLoss = 100;

    const avgMatch = stdout.match(/avg\/[^=]+=\s*?([0-9.]+)/);
    const lossMatch = stdout.match(/(\d+)% packet loss/);

    if (avgMatch) {
      avgTime = Math.round(parseFloat(avgMatch[1]));
    }
    if (lossMatch) {
      packetLoss = parseInt(lossMatch[1]);
    }

    return {
      avg: avgTime,
      loss: packetLoss,
      output: stdout,
    };
  } catch (error: unknown) {
    const errCode = getErrorCode(error);
    if (errCode === "ETIMEDOUT") {
      throw new Error("执行超时");
    } else if (error !== null && error !== undefined && typeof error === "object" && "killed" in error && (error as { killed: unknown }).killed) {
      throw new Error("命令被终止");
    } else {
      throw new Error(`Ping失败: ${getErrorMessage(error)}`);
    }
  }
}

/**
 * 测试所有数据中心延迟 (Linux)
 */
async function pingDataCenters(): Promise<string[]> {
  const dcLocations: Record<number, string> = {
    1: "Miami",
    2: "Amsterdam",
    3: "Miami",
    4: "Amsterdam",
    5: "Singapore",
  };

  const pingOne = async (dc: number): Promise<string> => {
    const ip = DCs[dc as keyof typeof DCs];
    const location = dcLocations[dc];
    try {
      const { stdout } = await execAsync(
        `ping -c 1 ${ip} | awk -F 'time=' '/time=/ {print $2}' | awk '{print $1}'`
      );
      let pingTime = "0";
      try {
        pingTime = String(Math.round(parseFloat(stdout.trim())));
      } catch {
        // ping 输出解析失败时回退到 "0"
        pingTime = "0";
      }
      return `🌐 <b>DC${dc} (${location}):</b> <code>${pingTime}ms</code>`;
    } catch {
      // ping 命令执行失败（超时/不可达）时返回超时提示
      return `🌐 <b>DC${dc} (${location}):</b> <code>超时</code>`;
    }
  };

  // 并行 ping 所有数据中心，减少总等待时间
  return Promise.all([1, 2, 3, 4, 5].map(pingOne));
}

/**
 * 解析ping目标
 */
function parseTarget(input: string): {
  type: "ip" | "domain" | "dc";
  value: string;
} {
  // 检查是否为数据中心
  if (/^dc[1-5]$/i.test(input)) {
    const dcNum = parseInt(input.slice(2)) as keyof typeof DCs;
    return { type: "dc", value: DCs[dcNum] };
  }

  // 检查是否为IP地址
  const ipRegex =
    /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  if (ipRegex.test(input)) {
    return { type: "ip", value: input };
  }

  // 默认为域名
  return { type: "domain", value: input };
}

class PingPlugin extends Plugin {

  description: string = `🏓 网络延迟测试工具\n\n• ${mainPrefix}ping - Telegram API延迟\n• ${mainPrefix}ping &lt;IP/域名&gt; - ICMP ping测试\n• ${mainPrefix}ping dc1-dc5 - 数据中心延迟\n• ${mainPrefix}ping all - 所有数据中心延迟`;
  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    ping: async (msg) => {
      const client = await getGlobalClient();

      if (!client) {
        await msg.edit({
          text: "❌ 客户端未初始化",
        });
        return;
      }

      try {
        const args = (msg.text || "").split(" ").slice(1);
        const target = args[0]?.toLowerCase();

        // 无参数 - 基础Telegram延迟测试
        if (!target) {
          // 测量 Telegram API 延迟
          const apiStart = Date.now();
          await safeGetMe(client);
          const apiEnd = Date.now();
          const apiLatency = apiEnd - apiStart;

          // 测量消息编辑延迟
          const msgStart = Date.now();
          await msg.edit({
            text: "🏓 Pong!",
          });
          const msgEnd = Date.now();
          const msgLatency = msgEnd - msgStart;

          // 显示结果
          await msg.edit({
            text: html(`🏓 <b>Pong!</b>

📡 <b>API延迟:</b> <code>${apiLatency}ms</code>
✏️ <b>消息延迟:</b> <code>${msgLatency}ms</code>

⏰ <i>${new Date().toLocaleString("zh-CN")}</i>`),
          });
          return;
        }

        // 所有数据中心测试
        if (target === "all" || target === "dc") {
          await msg.edit({
            text: "🔍 正在测试所有数据中心延迟...",
          });

          const dcResults = await pingDataCenters();

          await msg.edit({
            text: html(`🌐 <b>Telegram数据中心延迟</b><br><br>${dcResults.join(
              "<br>"
            )}\n\n⏰ <i>${new Date().toLocaleString("zh-CN")}</i>`),
          });
          return;
        }

        // 帮助信息
        if (target === "help" || target === "h") {
          await msg.edit({
            text: html(`🏓 <b>Ping工具使用说明</b><br><br><b>基础用法:</b><br>• <code>${mainPrefix}ping</code> - Telegram延迟测试<br>• <code>${mainPrefix}ping all</code> - 所有数据中心延迟<br><br><b>网络测试:</b><br>• <code>${mainPrefix}ping 8.8.8.8</code> - IP地址ping<br>• <code>${mainPrefix}ping google.com</code> - 域名ping<br>• <code>${mainPrefix}ping dc1</code> - 指定数据中心<br><br><b>数据中心:</b><br>• DC1-DC5: 分别对应不同地区服务器<br><br>💡 <i>支持ICMP和TCP连接测试</i>`),
          });
          return;
        }

        // 网络目标测试
        await msg.edit({
          text: html(`🔍 正在测试 <code>${htmlEscape(target)}</code>...`),
        });

        const parsed = parseTarget(target);
        const testTarget = parsed.value;

        // 执行多种测试
        const results: string[] = [];

        // DNS解析测试
        const dnsResult = await dnsLookupTime(testTarget);
        if (dnsResult.time > 0) {
          results.push(
            `🔍 <b>DNS解析:</b> <code>${dnsResult.time}ms</code> → <code>${dnsResult.ip}</code>`
          );
        }

        // ICMP Ping测试（尝试但可能失败）
        try {
          const pingResult = await systemPing(testTarget, 3);
          if (pingResult.avg >= 0 && pingResult.loss < 100) {
            const avgText =
              pingResult.avg === 0 ? "<1" : pingResult.avg.toString();
            results.push(
              `🏓 <b>ICMP Ping:</b> <code>${avgText}ms</code> (丢包: ${pingResult.loss}%)`
            );
          } else {
            // ICMP失败，使用HTTP ping作为替代
            const httpResult = await httpPing(testTarget, false);
            if (httpResult > 0) {
              results.push(
                `🏓 <b>HTTP Ping:</b> <code>${httpResult}ms</code> (ICMP不可用)`
              );
            } else {
              results.push(`🏓 <b>ICMP Ping:</b> <code>不可用</code>`);
            }
          }
        } catch (error: unknown) {
          // ICMP失败，尝试HTTP ping
          const httpResult = await httpPing(testTarget, false);
          if (httpResult > 0) {
            results.push(
              `🏓 <b>HTTP Ping:</b> <code>${httpResult}ms</code> (ICMP受限)`
            );
          } else {
            results.push(`🏓 <b>网络测试:</b> <code>ICMP/HTTP均不可用</code>`);
          }
        }

        // 使用Telegram网络栈测试TCP连接
        const [telegramTcp80, telegramTcp443] = await Promise.all([
          telegramTcpPing(testTarget, 80, 5000),
          telegramTcpPing(testTarget, 443, 5000)
        ]);

        // 如果Telegram网络栈失败，回退到传统方法
        const tcp80 =
          telegramTcp80 > 0
            ? telegramTcp80
            : await tcpPing(testTarget, 80, 5000);
        const tcp443 =
          telegramTcp443 > 0
            ? telegramTcp443
            : await tcpPing(testTarget, 443, 5000);

        if (tcp80 > 0) {
          const method = telegramTcp80 > 0 ? "TG" : "TCP";
          results.push(`🌐 <b>${method}连接 (80):</b> <code>${tcp80}ms</code>`);
        }

        if (tcp443 > 0) {
          const method = telegramTcp443 > 0 ? "TG" : "TCP";
          results.push(
            `🔒 <b>${method}连接 (443):</b> <code>${tcp443}ms</code>`
          );
        }

        // HTTPS请求测试（应用层延迟）
        const httpsResult = await httpPing(testTarget, true);
        if (httpsResult > 0) {
          results.push(`📡 <b>HTTPS请求:</b> <code>${httpsResult}ms</code>`);
        }

        if (results.length === 0) {
          results.push(`❌ 所有测试均失败，目标可能不可达`);
        }

        const targetType =
          parsed.type === "dc"
            ? "数据中心"
            : parsed.type === "ip"
            ? "IP地址"
            : "域名";

        // 构建显示文本，避免重复显示相同内容
        let displayText = `🎯 <b>${targetType}延迟测试</b>\n`;

        if (target === testTarget) {
          // 输入和目标相同时，只显示一次
          displayText += `<code>${htmlEscape(target)}</code>\n\n`;
        } else {
          // 输入和目标不同时（如dc1 → IP），显示映射关系
          displayText += `<code>${htmlEscape(
            target
          )}</code> → <code>${htmlEscape(testTarget)}</code>\n\n`;
        }

        await msg.edit({
          text: html(`${displayText}${results.join(
            "<br>"
          )}\n\n⏰ <i>${new Date().toLocaleString("zh-CN")}</i>`),
        });
      } catch (error: unknown) {
        await msg.edit({
          text: html(`❌ 测试失败: ${htmlEscape(getErrorMessage(error))}`),
        });
      }
    },
  };
}

export default new PingPlugin();
