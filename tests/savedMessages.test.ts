import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for the saved-messages detection fix in pluginManager.
 *
 * The core logic under test:
 *   const meId = tryGetCurrentRuntime()?.meId;
 *   const isSavedMessage = meId != null && String(msg.chat.id) === meId;
 *
 * We test the pure boolean expression, not the full dealCommandPlugin
 * (which has heavy mtcute/Dispatcher dependencies).
 */

// ── Mock the runtime module ────────────────────────────────────────────────
vi.mock("@/utils/runtimeManager", () => ({
  tryGetCurrentRuntime: vi.fn(),
}));

import { tryGetCurrentRuntime } from "@/utils/runtimeManager";

const mockTryGetCurrentRuntime = vi.mocked(tryGetCurrentRuntime);

// ── Helper: build a fake msg with the properties the logic reads ────────────
interface FakeMsg {
  chat: { id: number | bigint };
  isOutgoing: boolean;
}

function fakeMsg(chatId: number | bigint, isOutgoing: boolean): FakeMsg {
  return { chat: { id: chatId }, isOutgoing };
}

// ── The predicate under test, extracted verbatim from pluginManager ────────
function isSavedMessage(msg: FakeMsg): boolean {
  const meId = tryGetCurrentRuntime()?.meId;
  return meId != null && String(msg.chat.id) === meId;
}

// ── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("saved-messages detection (meId + chat.id)", () => {
  it("returns true when msg.chat.id matches the cached self id (number)", () => {
    mockTryGetCurrentRuntime.mockReturnValue({ meId: "123456789" });
    expect(isSavedMessage(fakeMsg(123456789, false))).toBe(true);
  });

  it("returns true when msg.chat.id matches the cached self id (bigint)", () => {
    mockTryGetCurrentRuntime.mockReturnValue({ meId: "9876543210" });
    expect(isSavedMessage(fakeMsg(BigInt("9876543210"), false))).toBe(true);
  });

  it("returns false when msg.chat.id differs from the self id", () => {
    mockTryGetCurrentRuntime.mockReturnValue({ meId: "123456789" });
    expect(isSavedMessage(fakeMsg(999888777, false))).toBe(false);
  });

  it("returns false when runtime has no meId (not yet logged in)", () => {
    mockTryGetCurrentRuntime.mockReturnValue({ meId: undefined });
    expect(isSavedMessage(fakeMsg(123456789, false))).toBe(false);
  });

  it("returns false when runtime itself is null (pre-init edge)", () => {
    mockTryGetCurrentRuntime.mockReturnValue(null);
    expect(isSavedMessage(fakeMsg(123456789, false))).toBe(false);
  });

  it("does NOT rely on savedPeerId (which is always undefined in mtcute)", () => {
    mockTryGetCurrentRuntime.mockReturnValue({ meId: "123456789" });
    const msg = fakeMsg(123456789, false);
    // Explicitly set savedPeerId to undefined (as it would be in mtcute)
    (msg as unknown as { savedPeerId?: undefined }).savedPeerId = undefined;
    // The logic should still correctly detect saved messages via chat.id
    expect(isSavedMessage(msg)).toBe(true);
  });
});

describe("command dispatch guard (isOutgoing || isSavedMessage)", () => {
  it("triggers for outgoing messages in any chat", () => {
    mockTryGetCurrentRuntime.mockReturnValue({ meId: "123456789" });
    const msg = fakeMsg(999888777, true); // outgoing, different chat
    expect(msg.isOutgoing || isSavedMessage(msg)).toBe(true);
  });

  it("triggers for non-outgoing messages in Saved Messages", () => {
    mockTryGetCurrentRuntime.mockReturnValue({ meId: "123456789" });
    const msg = fakeMsg(123456789, false); // incoming-looking, but saved
    expect(msg.isOutgoing || isSavedMessage(msg)).toBe(true);
  });

  it("does NOT trigger for incoming messages in other chats", () => {
    mockTryGetCurrentRuntime.mockReturnValue({ meId: "123456789" });
    const msg = fakeMsg(999888777, false);
    expect(msg.isOutgoing || isSavedMessage(msg)).toBe(false);
  });

  it("falls back to isOutgoing-only when meId is unavailable", () => {
    mockTryGetCurrentRuntime.mockReturnValue(null);
    const outgoingOther = fakeMsg(999888777, true);
    const incomingOther = fakeMsg(999888777, false);
    const incomingSaved = fakeMsg(123456789, false);
    // Without meId, isSavedMessage is always false; only isOutgoing works
    expect(outgoingOther.isOutgoing || isSavedMessage(outgoingOther)).toBe(true);
    expect(incomingOther.isOutgoing || isSavedMessage(incomingOther)).toBe(false);
    // This would be a false-negative (saved messages not detected),
    // but it only happens before login completes, which is acceptable.
    expect(incomingSaved.isOutgoing || isSavedMessage(incomingSaved)).toBe(false);
  });
});
