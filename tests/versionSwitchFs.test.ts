import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  installMatchedPlugins,
  restoreInstalledPlugins,
  executePluginDataMigration,
  restorePluginDataMigration,
} from "../src/utils/versionSwitchFs";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-switch-"));
  roots.push(root);
  return root;
}

function write(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("installMatchedPlugins", () => {
  it("copies target-native implementations atomically without copying source code", async () => {
    const root = tempRoot();
    const targetRepo = path.join(root, "target-repo");
    const targetPlugins = path.join(root, "target-runtime", "plugins");
    write(path.join(targetRepo, "ai", "ai.ts"), "// mtcute native ai");
    write(path.join(targetRepo, "uai", "uai.ts"), "// mtcute native uai");
    write(path.join(targetPlugins, "ai.ts"), "// old target ai");

    const journal = await installMatchedPlugins({
      matches: [
        { name: "ai", url: "https://unused/ai.ts" },
        { name: "uai", url: "https://unused/uai.ts" },
      ],
      targetPluginRepo: targetRepo,
      targetPluginsDir: targetPlugins,
      backupRoot: path.join(root, "plugin-backup"),
    });

    expect(fs.readFileSync(path.join(targetPlugins, "ai.ts"), "utf8"))
      .toBe("// mtcute native ai");
    expect(fs.readFileSync(path.join(targetPlugins, "uai.ts"), "utf8"))
      .toBe("// mtcute native uai");

    restoreInstalledPlugins(journal);
    expect(fs.readFileSync(path.join(targetPlugins, "ai.ts"), "utf8"))
      .toBe("// old target ai");
    expect(fs.existsSync(path.join(targetPlugins, "uai.ts"))).toBe(false);
  });
});

describe("plugin data transaction", () => {
  it("deep-merges JSON, copies binary databases, and restores the exact target tree", () => {
    const root = tempRoot();
    const sourceAssets = path.join(root, "source", "assets");
    const targetAssets = path.join(root, "target", "assets");
    const backup = path.join(root, "backup");

    write(
      path.join(sourceAssets, "ai", "config.json"),
      JSON.stringify({ configs: { mimo: { key: "new", model: "m" } }, active: "mimo" }),
    );
    write(path.join(sourceAssets, "ai", "history.db"), Buffer.from("source-db"));
    write(
      path.join(targetAssets, "ai", "config.json"),
      JSON.stringify({ configs: { mimo: { key: "old", type: "openai" } }, targetOnly: 1 }),
    );
    write(path.join(targetAssets, "ai", "history.db"), Buffer.from("target-db"));
    const originalConfig = fs.readFileSync(path.join(targetAssets, "ai", "config.json"));
    const originalDb = fs.readFileSync(path.join(targetAssets, "ai", "history.db"));

    const journal = executePluginDataMigration({
      plugins: ["ai"],
      sourceAssetsRoot: sourceAssets,
      targetAssetsRoot: targetAssets,
      backupRoot: backup,
    });

    expect(JSON.parse(fs.readFileSync(path.join(targetAssets, "ai", "config.json"), "utf8")))
      .toEqual({
        configs: { mimo: { key: "new", model: "m", type: "openai" } },
        active: "mimo",
        targetOnly: 1,
      });
    expect(fs.readFileSync(path.join(targetAssets, "ai", "history.db"), "utf8"))
      .toBe("source-db");

    restorePluginDataMigration(journal);
    expect(fs.readFileSync(path.join(targetAssets, "ai", "config.json")))
      .toEqual(originalConfig);
    expect(fs.readFileSync(path.join(targetAssets, "ai", "history.db")))
      .toEqual(originalDb);
  });

  it("removes target directories created by a failed migration", () => {
    const root = tempRoot();
    const sourceAssets = path.join(root, "source", "assets");
    const targetAssets = path.join(root, "target", "assets");
    const backup = path.join(root, "backup");
    write(path.join(sourceAssets, "uai", "config.json"), "{}");

    const journal = executePluginDataMigration({
      plugins: ["uai"],
      sourceAssetsRoot: sourceAssets,
      targetAssetsRoot: targetAssets,
      backupRoot: backup,
    });
    expect(fs.existsSync(path.join(targetAssets, "uai"))).toBe(true);

    restorePluginDataMigration(journal);
    expect(fs.existsSync(path.join(targetAssets, "uai"))).toBe(false);
  });
});
