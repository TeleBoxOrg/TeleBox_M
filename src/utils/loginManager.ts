import { TelegramClient, User } from "@mtcute/node";
import { createInterface, Interface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import qr from "qrcode-terminal";
import type { GenerationContext } from "./generationContext";

/**
 * Native mtcute login manager.
 *
 * mtcute persists session state in its SQLite storage (session.db), so there
 * is NO StringSession concept and no manual session save/load — the storage
 * handles auth keys / DC / peer cache transparently. mtcute's `client.start()`
 * also bundles the entire interactive login flow (phone + code + 2FA + QR),
 * which replaces the hand-rolled gramjs QR polling loop.
 *
 * The legacy `config.json.session` (a gramjs StringSession) is NOT compatible
 * with mtcute's session format and cannot be imported — first run requires a
 * fresh interactive login that writes auth keys into session.db.
 */

let rl: Interface | null = null;

function getReadlineInterface(): Interface {
  if (!rl) {
    rl = createInterface({ input, output });
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
          console.error("[LOGIN] Readline cleanup failed:", error);
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
  console.log("Connecting to Telegram...");
  throwIfAborted(lifecycle);

  // Fast path: if storage already has a valid session, getMe() succeeds without
  // any interactive prompt.
  try {
    const me = await client.getMe();
    if (me) {
      console.log(`✅ Existing session detected. Logged in as ${me.displayName}.`);
      // CRITICAL: client.start() bundles startUpdatesLoop() for fresh logins,
      // but the fast-path here only calls getMe() which connects but does NOT
      // start the updates loop. Without it, Dispatcher.for(client) silently
      // receives ZERO updates — commands never trigger. Explicitly start it.
      try {
        await (client as any).startUpdatesLoop?.();
      } catch (e) {
        console.warn("[LOGIN] startUpdatesLoop failed (updates may be inactive):", e);
      }
      closeReadlineInterface();
      return { meId: me.id ? String(me.id) : undefined };
    }
  } catch {
    // No valid session yet — fall through to interactive login.
  }

  throwIfAborted(lifecycle);
  const useQr = await getUserInput("Use QR code login? [y/N]: ", lifecycle);
  const wantQr = useQr.trim().toLowerCase() === "y";

  let me: User;

  if (wantQr) {
    // mtcute start() drives QR login when qrCodeHandler is provided and phone
    // is omitted. It still accepts a password callback for 2FA after scan.
    me = await client.start({
      qrCodeHandler: (url: string, expires: Date) => {
        console.log("\nScan this QR code using Telegram:");
        console.log("Settings → Devices → Link Desktop Device\n");
        qr.generate(url, { small: true });
        const remaining = Math.max(0, Math.ceil((expires.getTime() - Date.now()) / 1000));
        console.log(`(QR expires in ~${remaining}s, will refresh automatically)`);
      },
      password: async () => await getUserInput("Enter 2FA password (if any): ", lifecycle),
    });
  } else {
    console.log("Phone login...");
    me = await client.start({
      phone: async () => await getUserInput("Enter phone number (+86...): ", lifecycle),
      code: async () => await getUserInput("Enter the verification code: ", lifecycle),
      password: async () => await getUserInput("Enter 2FA password (if any): ", lifecycle),
      invalidCodeCallback: (type) => {
        console.warn(`❌ Invalid ${type}, please try again.`);
      },
    });
  }

  throwIfAborted(lifecycle);
  console.log(`✅ Login completed as ${me.displayName}. Session saved to storage.`);
  closeReadlineInterface();
  return { meId: me.id ? String(me.id) : undefined };
}

export async function login(): Promise<void> {
  const { startRuntime }: typeof import("./runtimeManager") = require("./runtimeManager");
  await startRuntime();
}
