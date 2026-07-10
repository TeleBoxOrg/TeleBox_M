/**
 * mtcute login helper for version switching.
 *
 * Creates a temporary TelegramClient pointed at a fresh session.db in the
 * switch directory, logs in using staged secrets from ~/.telebox-switch,
 * and registers the resulting session as an external session. Called by
 * the switch controller in a subprocess.
 */
import { TelegramClient } from "@mtcute/node";
import { getApiConfig } from "./apiConfig";
import { readAppName } from "./teleboxInfoHelper";
import {
  consumeSecret,
  loadSwitchState,
  saveSwitchState,
  DEFAULT_SWITCH_HOME,
  type PendingLogin,
} from "./versionSwitchState";
import path from "path";
import fs from "fs";

async function resolveSecret(statePath: string | undefined): Promise<string | null> {
  if (!statePath) return null;
  return consumeSecret(statePath);
}

export async function loginForSwitch(): Promise<void> {
  const state = loadSwitchState(DEFAULT_SWITCH_HOME);
  const pending: PendingLogin | null = state.pendingLogin;

  if (!pending) {
    throw new Error("No pending login in switch state");
  }
  if (pending.target !== "mtcute") {
    throw new Error(
      `Pending login targets ${pending.target}, but this is the mtcute helper`,
    );
  }
  if (pending.expiresAt < Date.now()) {
    throw new Error("Pending login has expired");
  }

  const phone = pending.phone;
  const code = await resolveSecret(state.stagedSecrets.code);
  const password = await resolveSecret(state.stagedSecrets.password);

  if (!code) {
    throw new Error("No verification code staged — wait for the Telegram code and try again");
  }

  const api = await getApiConfig();
  if (!api.api_id || !api.api_hash) {
    throw new Error("Missing api_id / api_hash in config.json");
  }

  const sessionDir = path.join(DEFAULT_SWITCH_HOME, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const sessionDb = path.join(sessionDir, "mtcute.db");

  // Remove any previous failed session to start fresh.
  try {
    fs.rmSync(sessionDb, { force: true });
  } catch {
    // ok
  }

  const client = new TelegramClient({
    apiId: api.api_id,
    apiHash: api.api_hash,
    storage: sessionDb,
    initConnectionOptions: {
      deviceModel: readAppName(),
    },
  });

  try {
    const me = await client.start({
      phone,
      code: async () => code,
      password: password ?? undefined,
      invalidCodeCallback: (type: "code" | "password") => {
        console.error(`[switch:mtcute] Invalid ${type}, will retry with next staged value`);
      },
    });

    const userId = me.id ? String(me.id) : undefined;
    if (!userId) {
      throw new Error("Login succeeded but user ID is missing");
    }

    if (userId !== pending.expectedUserId) {
      throw new Error(
        `Identity mismatch: expected ${pending.expectedUserId}, got ${userId}`,
      );
    }

    console.log(`[switch:mtcute] Logged in as ${me.displayName} (${userId})`);

    // Register the external session.
    const updated = loadSwitchState(DEFAULT_SWITCH_HOME);
    updated.sessions.mtcute = {
      kind: "external",
      path: sessionDb,
      userId,
    };
    updated.pendingLogin = null;
    updated.stagedSecrets = {};
    saveSwitchState(updated, DEFAULT_SWITCH_HOME);
    console.log(`[switch:mtcute] External session registered for user ${userId}`);
  } finally {
    try {
      await client.destroy();
    } catch {
      // best effort
    }
  }
}

// Run directly when executed as a standalone script.
loginForSwitch().catch((err: Error) => {
  console.error("[switch:mtcute] Fatal:", err.message);
  process.exit(1);
});
