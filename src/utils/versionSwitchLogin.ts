#!/usr/bin/env npx tsx
/**
 * mtcute login helper for version switching — polling mode.
 *
 * Spawned by `.switch login` immediately. It:
 *   1. Reads pendingLogin from ~/.telebox-switch/state.json
 *   2. Creates a temporary mtcute TelegramClient (fresh session.db)
 *   3. Calls client.start() which triggers auth.sendCode → Telegram sends code
 *   4. The code callback POLLS ~/.telebox-switch/secrets/ until a code arrives
 *   5. signIn completes → saves session to ~/.telebox-switch/sessions/mtcute.db
 *   6. Updates state.sessions.mtcute to external → exits
 *
 * The listenMessageHandler in the switch plugin writes codes to secrets/;
 * this helper picks them up via polling.
 */
import { TelegramClient } from "@mtcute/node";
import { getApiConfig } from "./apiConfig";
import {
  loadSwitchState,
  saveSwitchState,
  DEFAULT_SWITCH_HOME,
} from "./versionSwitchState";
import path from "path";
import fs from "fs";

const SECRETS_DIR = path.join(DEFAULT_SWITCH_HOME, "secrets");
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_MS = 5 * 60_000; // 5 minutes

/** Poll the secrets directory until a file appears, then consume it. */
async function pollForSecret(kind: "code" | "password", phone: string): Promise<string> {
  const deadline = Date.now() + MAX_POLL_MS;
  const seen = new Set<string>();

  while (Date.now() < deadline) {
    // Only scan if directory exists
    if (!fs.existsSync(SECRETS_DIR)) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const files = fs.readdirSync(SECRETS_DIR).filter((f) => f.endsWith(".json"));

    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);

      const fullPath = path.join(SECRETS_DIR, file);
      try {
        const raw = fs.readFileSync(fullPath, "utf8");
        const parsed = JSON.parse(raw) as { expiresAt?: number; value?: string };

        if (!parsed.value || typeof parsed.expiresAt !== "number") {
          // Malformed — skip
          continue;
        }

        if (parsed.expiresAt < Date.now()) {
          // Expired — clean up
          fs.rmSync(fullPath, { force: true });
          continue;
        }

        // Found a valid secret
        const value = parsed.value;
        fs.rmSync(fullPath, { force: true });
        console.error(`[switch:mtcute] Consumed ${kind} secret from ${file}`);
        return value;
      } catch {
        // File may have been deleted by another process — skip
        continue;
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for ${kind} (${MAX_POLL_MS / 1000}s)`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function loginForSwitch(): Promise<void> {
  const state = loadSwitchState(DEFAULT_SWITCH_HOME);
  const pending = state.pendingLogin;

  if (!pending) throw new Error("No pending login in switch state");
  if (pending.target !== "mtcute") {
    throw new Error(`Pending login targets ${pending.target}, but this is the mtcute helper`);
  }
  if (pending.expiresAt < Date.now()) throw new Error("Pending login has expired");

  const phone = pending.phone;
  console.error(`[switch:mtcute] Starting login for ${phone} → target mtcute`);

  const api = await getApiConfig();
  if (!api.api_id || !api.api_hash) throw new Error("Missing api_id / api_hash");

  const sessionDir = path.join(DEFAULT_SWITCH_HOME, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const sessionDb = path.join(sessionDir, "mtcute.db");

  // Remove any previous failed session
  try { fs.rmSync(sessionDb, { force: true }); } catch { /* ok */ }

  const client = new TelegramClient({
    apiId: api.api_id,
    apiHash: api.api_hash,
    storage: sessionDb,
  });

  try {
    console.error("[switch:mtcute] Connecting and requesting auth code (auth.sendCode)...");
    const me = await client.start({
      phone: async () => phone,
      code: async () => pollForSecret("code", phone),
      password: async () => {
        console.error("[switch:mtcute] 2FA requested, polling for password...");
        return pollForSecret("password", phone);
      },
      invalidCodeCallback: (type) => {
        console.error(`[switch:mtcute] Invalid ${type}, will poll for a new value`);
      },
    });

    const userId = me.id ? String(me.id) : undefined;
    if (!userId) throw new Error("Login succeeded but user ID is missing");
    if (userId !== pending.expectedUserId) {
      throw new Error(`Identity mismatch: expected ${pending.expectedUserId}, got ${userId}`);
    }

    console.error(`[switch:mtcute] ✅ Logged in as ${me.displayName} (${userId})`);

    const updated = loadSwitchState(DEFAULT_SWITCH_HOME);
    updated.sessions.mtcute = { kind: "external", path: sessionDb, userId };
    updated.pendingLogin = null;
    updated.stagedSecrets = {};
    saveSwitchState(updated, DEFAULT_SWITCH_HOME);
    console.error(`[switch:mtcute] ✅ External session registered. Ready for .switch go.`);
  } catch (err) {
    console.error("[switch:mtcute] Login failed:", (err as Error).message);

    // Clean up stale state
    try {
      const failState = loadSwitchState(DEFAULT_SWITCH_HOME);
      failState.pendingLogin = null;
      failState.stagedSecrets = {};
      saveSwitchState(failState, DEFAULT_SWITCH_HOME);
    } catch { /* best effort */ }

    process.exit(1);
  } finally {
    try { await client.destroy(); } catch { /* ok */ }
  }
}

loginForSwitch().catch((err: Error) => {
  console.error("[switch:mtcute] Fatal:", err.message);
  process.exit(1);
});
