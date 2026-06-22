import { TelegramClient } from "@mtcute/node";
import type { User } from "@mtcute/node";

export function isAuthKeyUnregisteredError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("AUTH_KEY_UNREGISTERED");
}

/**
 * Safely fetch the current user. mtcute's `getMe()` returns a `User` directly
 * (gramjs returned `Api.User | Api.UserEmpty`), so we only need to guard the
 * AUTH_KEY_UNREGISTERED case where the session was invalidated server-side.
 */
export async function safeGetMe(client: TelegramClient): Promise<User | undefined> {
  try {
    return await client.getMe();
  } catch (error: unknown) {
    if (isAuthKeyUnregisteredError(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Check whether the client has a valid authorized session.
 *
 * mtcute has no `checkAuthorization()` method; a successful `getMe()` implies
 * the session is authorized, while AUTH_KEY_UNREGISTERED means it is not.
 */
export async function safeCheckAuthorization(client: TelegramClient): Promise<boolean> {
  try {
    await client.getMe();
    return true;
  } catch (error: unknown) {
    if (isAuthKeyUnregisteredError(error)) {
      return false;
    }
    throw error;
  }
}
