import { TelegramClient, User } from "@mtcute/node";
import { createInterface, Interface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import qr from "qrcode-terminal";
import type { GenerationContext } from "./generationContext";
import { logger } from "@utils/logger";
import type { ClientInternals } from "./clientInternals";

/** Installs a process SIGINT guard that exits cleanly during interactive login.
 *  readline.createInterface captures stdin in raw mode and intercepts SIGINT
 *  as a line-editing event; without this handler ctrl+c does nothing. */
function installLoginSigintGuard(): () => void {
  const handler = () => {
    logger.warn("\n⏹ Login aborted (SIGINT).");
    process.exit(130);
  };
  process.on("SIGINT", handler);
  return () => process.removeListener("SIGINT", handler);
}

/**
 * Native mtcute login manager.
 *
 * mtcute persists session state in its SQLite storage (session.db), so there
 * is NO StringSession concept and no manual session save/load — the storage
 * handles auth keys / DC / peer cache transparently. mtcute's `client.start()`
 * also bundles the entire interactive login flow (phone + code + 2FA + QR),
 * which replaces the hand-rolled gramjs QR polling loop.
 *
 * The legacy `config.json.session` (a gramjs/teleproto StringSession) is
 * offline-convertible via `@mtcute/convert` during `.switch go`
 * (`versionSwitchSessionConvert.ts`). Interactive `client.start()` remains
 * for first-run when no session exists at all.
 */

let rl: Interface | null = null;

function getReadlineInterface(): Interface {
  if (!rl) {
    rl = createInterface({ input, output });
    // readline in raw mode intercepts SIGINT; listen and exit cleanly
    rl.on("SIGINT", () => {
      logger.warn("\n⏹ Login aborted (SIGINT).");
      rl?.close();
      process.exit(130);
    });
  }
  return rl;
}

function closeReadlineInterface(): void {
  if (rl) {
    rl.close();
    rl = null;
  }
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string") return new Error(reason);
  return new Error("Login operation aborted");
}

function throwIfAborted(lifecycle?: GenerationContext): void {
  if (lifecycle?.signal.aborted) {
    throw abortError(lifecycle.signal.reason);
  }
}

async function getUserInput(prompt: string, lifecycle?: GenerationContext): Promise<string> {
  throwIfAborted(lifecycle);
  const readline = getReadlineInterface();
  if (!lifecycle) {
    return await readline.question(prompt);
  }

  return await lifecycle.runTask(async (signal) => {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const dispose = lifecycle.trackDisposable(() => closeReadlineInterface(), {
        label: "login:readline-question",
      });

      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        void Promise.resolve(dispose()).catch((error) => {
          logger.error("[LOGIN] Readline cleanup failed:", error);
        });
        callback();
      };

      const onAbort = (): void => {
        finish(() => reject(abortError(signal.reason)));
      };

      signal.addEventListener("abort", onAbort, { once: true });
      readline.question(prompt).then(
        (answer) => finish(() => resolve(answer)),
        (error: unknown) => finish(() => reject(error))
      );

      if (signal.aborted) {
        onAbort();
      }
    });
  }, { label: "login:readline-question" });
}

/**
 * Initialize / authorize the mtcute client.
 *
 * mtcute's `client.start()` is idempotent: if session.db already holds a valid
 * authorization it returns the existing user without prompting. Otherwise it
 * drives the interactive login flow (QR first if the user opts in, else phone).
 */
export async function initializeClientSession(
  client: TelegramClient,
  lifecycle?: GenerationContext
): Promise<{ meId?: string }> {
  logger.info("Connecting to Telegram...");
  throwIfAborted(lifecycle);

  // Fast path: if storage already has a valid session, start() will reuse it
  // and start the updates loop automatically (no interactive prompts).
  try {
    const me = await client.start();
    if (me) {
      logger.info(`✅ Existing session detected. Logged in as ${me.displayName}.`);
      closeReadlineInterface();
      return { meId: me.id ? String(me.id) : undefined };
    }
  } catch (e: unknown) {
    logger.error("[loginManager] operation failed:", e);
  }

  throwIfAborted(lifecycle);
  const useQr = await getUserInput("Use QR code login? [y/N]: ", lifecycle);
  const wantQr = useQr.trim().toLowerCase() === "y";

  let me: User;

  // mtcute client.start() creates its own readline internally which also
  // captures SIGINT. Install a process-level guard so ctrl+c always exits.
  const removeSigintGuard = installLoginSigintGuard();
  try {
    if (wantQr) {
      // mtcute start() drives QR login when qrCodeHandler is provided and phone
      // is omitted. It still accepts a password callback for 2FA after scan.
      me = await client.start({
        qrCodeHandler: (url: string, expires: Date) => {
          logger.info("\nScan this QR code using Telegram:");
          logger.info("Settings → Devices → Link Desktop Device\n");
          qr.generate(url, { small: true });
          const remaining = Math.max(0, Math.ceil((expires.getTime() - Date.now()) / 1000));
          logger.info(`(QR expires in ~${remaining}s, will refresh automatically)`);
        },
        password: async () => await getUserInput("Enter 2FA password (if any): ", lifecycle),
      });
    } else {
      logger.info("Phone login...");
      me = await client.start({
        phone: async () => await getUserInput("Enter phone number (+86...): ", lifecycle),
        code: async () => await getUserInput("Enter the verification code: ", lifecycle),
        password: async () => await getUserInput("Enter 2FA password (if any): ", lifecycle),
        invalidCodeCallback: (type) => {
          logger.warn(`❌ Invalid ${type}, please try again.`);
        },
      });
    }
  } finally {
    removeSigintGuard();
  }

  throwIfAborted(lifecycle);
  logger.info(`✅ Login completed as ${me.displayName}. Session saved to storage.`);
  closeReadlineInterface();
  return { meId: me.id ? String(me.id) : undefined };
}

export async function login(): Promise<void> {
  const { startRuntime } = require("./runtimeAccess") as typeof import("./runtimeAccess");
  await startRuntime();
}
