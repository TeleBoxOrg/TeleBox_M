import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  consumeSecret,
  createDefaultSwitchState,
  loadSwitchState,
  resolveExternalSessionPath,
  saveSwitchState,
  writeSecret,
} from "../src/utils/versionSwitchState";

const roots: string[] = [];
function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-state-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  roots.splice(0).forEach((value) => fs.rmSync(value, { recursive: true, force: true }));
});

describe("switch state", () => {
  it("defaults both versions to their untouched native sessions", () => {
    const value = createDefaultSwitchState();
    expect(value.sessions.teleproto).toEqual({ kind: "native" });
    expect(value.sessions.mtcute).toEqual({ kind: "native" });
    expect(value.pendingLogin).toBeNull();
    expect(value.stagedSecrets).toEqual({});
  });

  it("saves atomically and resolves explicit external sessions", () => {
    const home = root();
    const value = createDefaultSwitchState();
    value.sessions.mtcute = {
      kind: "external",
      path: path.join(home, "sessions", "mtcute.db"),
      userId: "42",
    };
    saveSwitchState(value, home);
    expect(loadSwitchState(home)).toEqual(value);
    expect(resolveExternalSessionPath("mtcute", home))
      .toBe(path.join(home, "sessions", "mtcute.db"));
    expect(resolveExternalSessionPath("teleproto", home)).toBeNull();
  });
});

describe("ephemeral secrets", () => {
  it("stores a secret as mode 0600 and consumes it exactly once", () => {
    const home = root();
    const file = writeSecret("2fa-value", 60_000, home);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(consumeSecret(file)).toBe("2fa-value");
    expect(fs.existsSync(file)).toBe(false);
    expect(consumeSecret(file)).toBeNull();
  });

  it("rejects and deletes expired secrets", () => {
    const home = root();
    const file = writeSecret("expired", -1, home);
    expect(consumeSecret(file)).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });
});
