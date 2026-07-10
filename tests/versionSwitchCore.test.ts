import { describe, expect, it } from "vitest";
import {
  buildCompatibilityReport,
  chooseSessionSource,
  extractTelegramLoginCode,
  matchPlugins,
  mergeJsonConfig,
  planPluginDataMigration,
  planSwitch,
  verifyTargetIdentity,
} from "../src/utils/versionSwitchCore";

describe("extractTelegramLoginCode", () => {
  it("extracts a five digit code from Telegram service messages", () => {
    expect(
      extractTelegramLoginCode(
        "Login code: 12345. Do not give this code to anyone.",
      ),
    ).toBe("12345");
  });

  it("supports localized messages and spaced codes", () => {
    expect(extractTelegramLoginCode("登录验证码：1 2 3 4 5。请勿转发。"))
      .toBe("12345");
  });

  it("does not accept arbitrary messages without login-code context", () => {
    expect(extractTelegramLoginCode("订单号 12345 已处理")).toBeNull();
  });
});

describe("chooseSessionSource", () => {
  it("keeps the native session untouched by default", () => {
    expect(chooseSessionSource(undefined, "/native/session.db")).toEqual({
      kind: "native",
      path: "/native/session.db",
    });
  });

  it("uses an external session only when explicitly configured", () => {
    expect(
      chooseSessionSource("/switch/mtcute/session.db", "/native/session.db"),
    ).toEqual({ kind: "external", path: "/switch/mtcute/session.db" });
  });
});

describe("verifyTargetIdentity", () => {
  it("rejects a session logged in as a different Telegram account", () => {
    expect(() => verifyTargetIdentity("7041948142", "1000000000"))
      .toThrow(/identity mismatch/i);
  });

  it("accepts the same Telegram account", () => {
    expect(verifyTargetIdentity("7041948142", "7041948142")).toBeUndefined();
  });
});

describe("buildCompatibilityReport", () => {
  it("lists version-specific plugins without treating them as interchangeable", () => {
    expect(
      buildCompatibilityReport(
        ["agent.ts", "nodeseek.ts", "say.ts"],
        ["agent.ts", "mtcute_only.ts"],
      ),
    ).toEqual({
      common: ["agent.ts"],
      teleprotoOnly: ["nodeseek.ts", "say.ts"],
      mtcuteOnly: ["mtcute_only.ts"],
    });
  });
});

describe("matchPlugins", () => {
  it("installs only target-native plugins present in the target repository", () => {
    expect(
      matchPlugins(
        ["ai.ts", "uai.ts", "nodeseek.ts", "local-only.ts.backup"],
        {
          ai: { url: "https://example/teleproto/ai.ts" },
          uai: { url: "https://example/teleproto/uai.ts" },
          nodeseek: { url: "https://example/teleproto/nodeseek.ts" },
        },
        {
          ai: { url: "https://example/mtcute/ai.ts" },
          uai: { url: "https://example/mtcute/uai.ts" },
          mtcute_only: { url: "https://example/mtcute/only.ts" },
        },
      ),
    ).toEqual({
      install: [
        { name: "ai", url: "https://example/mtcute/ai.ts" },
        { name: "uai", url: "https://example/mtcute/uai.ts" },
      ],
      unavailable: ["nodeseek"],
    });
  });
});

describe("mergeJsonConfig", () => {
  it("preserves target-only defaults while source runtime data wins", () => {
    expect(
      mergeJsonConfig(
        {
          configs: { mimo: { key: "source-key", model: "new-model" } },
          currentChatTag: "mimo",
          conversations: { chat1: ["new"] },
        },
        {
          configs: {
            mimo: { key: "old-key", type: "openai" },
            targetOnly: { key: "keep" },
          },
          targetSchemaVersion: 2,
          conversations: { old: ["keep"] },
        },
      ),
    ).toEqual({
      configs: {
        mimo: { key: "source-key", model: "new-model", type: "openai" },
        targetOnly: { key: "keep" },
      },
      currentChatTag: "mimo",
      targetSchemaVersion: 2,
      conversations: { chat1: ["new"], old: ["keep"] },
    });
  });
});

describe("planPluginDataMigration", () => {
  it("plans recursive assets migration only for matched plugins and backs up target first", () => {
    expect(
      planPluginDataMigration({
        plugins: ["ai", "uai"],
        sourceAssetsRoot: "/teleproto/assets",
        targetAssetsRoot: "/mtcute/assets",
        backupRoot: "/switch/backups/tx-1/assets",
      }),
    ).toEqual([
      {
        kind: "backup",
        plugin: "ai",
        from: "/mtcute/assets/ai",
        to: "/switch/backups/tx-1/assets/ai",
      },
      {
        kind: "merge-tree",
        plugin: "ai",
        from: "/teleproto/assets/ai",
        to: "/mtcute/assets/ai",
      },
      {
        kind: "backup",
        plugin: "uai",
        from: "/mtcute/assets/uai",
        to: "/switch/backups/tx-1/assets/uai",
      },
      {
        kind: "merge-tree",
        plugin: "uai",
        from: "/teleproto/assets/uai",
        to: "/mtcute/assets/uai",
      },
    ]);
  });
});

describe("planSwitch", () => {
  it("stops the source only after the target session is ready and schedules rollback", () => {
    expect(
      planSwitch({
        source: "teleproto",
        target: "mtcute",
        targetSessionReady: true,
        timeoutMs: 60_000,
      }),
    ).toEqual([
      { kind: "stop", version: "teleproto" },
      { kind: "start", version: "mtcute" },
      { kind: "wait-ready", version: "mtcute", timeoutMs: 60_000 },
      { kind: "rollback-on-failure", version: "teleproto" },
    ]);
  });

  it("refuses to stop the source when target session is not ready", () => {
    expect(() =>
      planSwitch({
        source: "teleproto",
        target: "mtcute",
        targetSessionReady: false,
        timeoutMs: 60_000,
      }),
    ).toThrow(/target session is not ready/i);
  });
});
