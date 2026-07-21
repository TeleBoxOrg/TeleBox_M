/**
 * Channel gap recovery circuit breaker.
 *
 * When channel gap recovery encounters persistent PTS desync errors
 * (PERSISTENT_TIMESTAMP_OUTDATED / HISTORY_GET_FAILED / channelDifferenceTooLong)
 * it may retry indefinitely — wasting API calls and dropping live messages.
 *
 * This module hooks into the Logger's existing downgrade interceptor and
 * tracks per-channel failure counts. Once a channel exceeds the failure
 * threshold within the tracking window, we clear its PTS state from the
 * TelegramClient so that subsequent update dispatches can re-seed pts
 * instead of looping on a hopeless GetChannelDifference.
 *
 * Supports:
 *   - teleproto layouts (updateManager / legacy flat maps)
 *   - mtcute UpdatesManager (`client.updates.cpts` + storage `updates_channel:`)
 *
 * Does NOT modify node_modules.
 *
 * Note: logger is imported lazily to avoid circular dependency with logger.ts
 * which imports this module for recordChannelGapFailure/isChannelCircuitBroken.
 */

function getLogger() {
  // Lazy require to break circular dependency with logger.ts
  return require("./logger").logger;
}

/** Shape of the internal client properties we access for gap breaking. */
interface GapBreakerClient {
  updateManager?: {
    channels?: Map<string, {
      pts?: { current?: () => number | string; clearSkippedUpdates?: () => void; setRequesting?: (v: boolean) => void };
      timer?: ReturnType<typeof setTimeout>;
    }>;
    channelFailRetryTimers?: Map<string, ReturnType<typeof setTimeout>>;
    channelFailTimeoutS?: Map<string, unknown> & { has?: (key: string) => boolean };
  };
  /** mtcute: high-level client.updates = UpdatesManager */
  updates?: {
    cpts?: Map<number | string, number>;
    cptsMod?: Map<number | string, number>;
    channelDiffTimeouts?: Map<number | string, ReturnType<typeof setTimeout>>;
    inaccessibleChannels?: Set<number | string>;
    channelsOpened?: Map<number | string, number> | Set<number | string>;
  };
  _updates?: GapBreakerClient["updates"];
  storage?: {
    updates?: {
      getChannelPts?: (channelId: number) => Promise<number | null>;
      setChannelPts?: (channelId: number, pts: number) => Promise<void>;
      /** some builds expose kv delete via provider; optional best-effort */
      _kv?: { delete?: (key: string) => Promise<void> | void };
    };
  };
  _channelPts?: Map<string, number | string>;
  _pendingChannelUpdates?: Map<string, unknown> & { has?: (key: string) => boolean };
  _fetchingChannelDifference?: Map<string, unknown> & { has?: (key: string) => boolean };
}

function parseChannelIdNum(channelId: string): number | null {
  const n = Number(channelId);
  return Number.isFinite(n) ? n : null;
}

/**
 * mtcute UpdatesManager keeps channel pts in memory (cpts/cptsMod) AND
 * sqlite storage key `updates_channel:<id>`. teleproto-only clear paths
 * are no-ops here — GitHubBot chats then stay on PERSISTENT_TIMESTAMP_OUTDATED
 * forever and never deliver newMessages to Dispatcher (auto-update silent death).
 */
function clearMtcuteChannelState(
  client: GapBreakerClient,
  channelId: string,
): { cleared: boolean; oldPts: number | string | null } {
  const updates = client.updates ?? client._updates;
  const idNum = parseChannelIdNum(channelId);
  let cleared = false;
  let oldPts: number | string | null = null;

  if (updates) {
    const keys: Array<number | string> = idNum != null ? [idNum, channelId, String(idNum)] : [channelId];
    for (const key of keys) {
      if (updates.cpts?.has?.(key)) {
        if (oldPts == null) oldPts = updates.cpts.get(key) ?? null;
        updates.cpts.delete(key);
        cleared = true;
      }
      if (updates.cptsMod?.has?.(key)) {
        updates.cptsMod.delete(key);
        cleared = true;
      }
      if (updates.channelDiffTimeouts?.has?.(key)) {
        const t = updates.channelDiffTimeouts.get(key);
        if (t) clearTimeout(t);
        updates.channelDiffTimeouts.delete(key);
        cleared = true;
      }
      if (updates.inaccessibleChannels?.has?.(key)) {
        updates.inaccessibleChannels.delete(key);
        cleared = true;
      }
      // channelsOpened: Map or Set depending on mtcute build
      const opened = updates.channelsOpened as
        | (Map<number | string, number> & { delete: (k: number | string) => boolean })
        | (Set<number | string> & { delete: (k: number | string) => boolean })
        | undefined;
      if (opened && typeof opened.delete === "function" && opened.has?.(key)) {
        opened.delete(key);
        cleared = true;
      }
    }
  }

  // Drop persisted pts so the next gap fill cannot reload the same stale value.
  // mtcute only resets pts on PERSISTENT_TIMESTAMP_INVALID (not OUTDATED) —
  // without storage clear, catch-up reloads the dead pts forever.
  if (idNum != null && client.storage?.updates) {
    const svc = client.storage.updates as {
      getChannelPts?: (channelId: number) => Promise<number | null>;
      setChannelPts?: (channelId: number, pts: number) => Promise<void>;
      _kv?: {
        delete?: (key: string) => Promise<void> | void;
        set?: (key: string, val: Uint8Array) => Promise<void> | void;
      };
    };
    void (async () => {
      try {
        if (typeof svc.getChannelPts === "function" && oldPts == null) {
          const stored = await svc.getChannelPts(idNum);
          if (stored != null) oldPts = stored;
        }
        const key = `updates_channel:${idNum}`;
        if (svc._kv && typeof svc._kv.delete === "function") {
          await svc._kv.delete(key);
        } else if (typeof svc.setChannelPts === "function") {
          // 0 → manager treats as missing-ish / re-seed; better than rejected pts
          await svc.setChannelPts(idNum, 0);
        }
        getLogger().info(
          `[channelGapBreaker] mtcute storage pts cleared channel=${idNum} oldPts=${oldPts ?? "?"}`,
        );
      } catch (e: unknown) {
        getLogger().error("[channelGapBreaker] mtcute storage pts clear failed:", e);
      }
    })();
    cleared = true;
  }

  return { cleared, oldPts };
}

// Note: this module intentionally does NOT import getGlobalClient — it needs
// SYNC access to the active runtime's client (see tryGetClient() below), and
// getGlobalClient() is async. We grab the client via a lazy require() of
// runtimeManager.tryGetCurrentRuntime() instead.

// --- Configuration -----------------------------------------------------------

/** How many consecutive PTS failures before we circuit-break the channel. */
const FAILURE_THRESHOLD = 2;

/** Immediate circuit-break on fatal unrecoverable errors (no retry possible). */
const FATAL_ERRORS = [
  'difference too long',
  'channelDifferenceTooLong',
  'Could not find a matching Constructor',
];

/**
 * Sliding window in ms. Failures older than this are forgotten.
 * Set to 30 minutes so that transient issues self-heal.
 */
const FAILURE_WINDOW_MS = 30 * 60 * 1000;

/**
 * Base cooldown in ms after circuit-breaking a channel before we allow it to
 * accumulate failures again. This prevents the breaker from firing on
 * every single update when a broken channel is still receiving messages.
 *
 * For channels that repeatedly circuit-break, the cooldown grows exponentially
 * (base × 2^(repeatCount-1)), capped at MAX_COOLDOWN_MS. A permanently
 * desynced channel (e.g. 1680975844) would go: 6h → 12h → 24h → 48h → 72h,
 * drastically reducing API waste and log noise.
 */
const BASE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_COOLDOWN_MS = 72 * 60 * 60 * 1000; // 72 hours (3 days)

/**
 * Maximum number of channel records to track. If exceeded, oldest inactive
 * records are evicted to prevent unbounded memory growth over long uptimes.
 */
const MAX_TRACKED_CHANNELS = 500;

/**
 * Minimum idle age (ms) before a record with no active failures can be evicted.
 * Only entries that have been idle for at least this long are candidates.
 */
const EVICTION_MIN_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

// --- Types -------------------------------------------------------------------

interface FailureRecord {
  timestamps: number[];
  brokenAt: number | null; // timestamp when circuit-breaker was triggered
  breakCount: number;     // how many times this channel has been circuit-broken
}

// --- State -------------------------------------------------------------------

const channelFailures = new Map<string, FailureRecord>();

// --- Public API --------------------------------------------------------------

/**
 * Called by the Logger's downgrade interceptor each time a
 * PERSISTENT_TIMESTAMP_OUTDATED or HISTORY_GET_FAILED error is detected
 * for a channel.
 *
 * @param channelId - The Telegram channel/group ID as a string (e.g. "1680975844")
 * @param errorMsg - Optional full error message to detect fatal unrecoverable errors
 */
export function recordChannelGapFailure(channelId: string, errorMsg?: string): void {
  const now = Date.now();

  // Evict stale entries if the map grows too large. Proactive eviction
  // bounds memory even under very high channel counts (long-running bots
  // subscribed to many chats) instead of waiting for an external cron.
  if (channelFailures.size >= MAX_TRACKED_CHANNELS) {
    evictStaleRecords(now);
  }

  let record = channelFailures.get(channelId);
  if (!record) {
    record = { timestamps: [], brokenAt: null, breakCount: 0 };
    channelFailures.set(channelId, record);
  }

  // Check for fatal unrecoverable errors that should trigger immediate circuit break
  const isFatalError = errorMsg && FATAL_ERRORS.some(fatal => errorMsg.includes(fatal));

  // Compute the effective cooldown for this channel based on its repeat break count
  const effectiveCooldown = getEffectiveCooldown(record.breakCount);

  // If we recently broke this channel, skip *counting* during cooldown but
  // still aggressively clear any new pts that teleproto re-set after the
  // last break. Without this, every new update for the channel re-establishes
  // pts -> gap detected -> GetChannelDifference retry -> PTS warn, even
  // though we're "broken". Silent re-clear keeps the breaker effective for
  // the full cooldown window.
  if (record.brokenAt && now - record.brokenAt < effectiveCooldown) {
    silentlyClearChannelPts(channelId);
    return;
  }

  // For fatal errors, trigger immediate circuit break
  if (isFatalError) {
    circuitBreakChannel(channelId);
    return;
  }

  // Prune timestamps outside the sliding window
  record.timestamps = record.timestamps.filter((t) => now - t < FAILURE_WINDOW_MS);
  record.timestamps.push(now);

  if (record.timestamps.length >= FAILURE_THRESHOLD) {
    circuitBreakChannel(channelId);
  }
}

/**
 * Check whether a channel has been circuit-broken and should be skipped.
 * This can be used to avoid logging redundant warnings.
 */
export function isChannelCircuitBroken(channelId: string): boolean {
  const record = channelFailures.get(channelId);
  if (!record || !record.brokenAt) return false;
  const now = Date.now();
  const effectiveCooldown = getEffectiveCooldown(record.breakCount);
  if (now - record.brokenAt >= effectiveCooldown) {
    // Cooldown expired — allow the channel to recover naturally
    // Don't delete the record; keep breakCount so that the next break
    // uses the escalated cooldown.
    record.brokenAt = null;
    record.timestamps = [];
    return false;
  }
  return true;
}

/**
 * Evict stale channel records to bound memory usage. Removes entries that
 * have no active failures and have been idle for EVICTION_MIN_AGE_MS.
 * Records with active circuit-breaks or recent failures are never evicted,
 * preserving both the failure history and any escalated (exponential) cooldown.
 */
function evictStaleRecords(now: number): void {
  for (const [channelId, record] of channelFailures) {
    const hasActiveFailures = record.timestamps.some((t) => now - t < FAILURE_WINDOW_MS);
    const isCircuitBroken =
      record.brokenAt !== null && now - record.brokenAt < getEffectiveCooldown(record.breakCount);

    // Determine last activity: prefer brokenAt, then latest timestamp.
    // If no failures ever recorded (brand-new record), lastActivity = 0 → not stale.
    const lastActivity = record.brokenAt
      ? record.brokenAt
      : (record.timestamps[record.timestamps.length - 1] ?? 0);

    // Only evict if the record has seen at least one failure in its lifetime
    // and has been idle for the minimum age.
    const isStale = lastActivity > 0 && now - lastActivity >= EVICTION_MIN_AGE_MS;

    if (!hasActiveFailures && !isCircuitBroken && isStale) {
      channelFailures.delete(channelId);
    }
  }
}

// --- Internal ----------------------------------------------------------------

/**
 * Compute the effective cooldown for a channel based on how many times it has
 * been circuit-broken. Uses exponential backoff:
 *   1st break: BASE_COOLDOWN_MS (6h)
 *   2nd break: BASE_COOLDOWN_MS × 2 (12h)
 *   3rd break: BASE_COOLDOWN_MS × 4 (24h)
 *   4th break: BASE_COOLDOWN_MS × 8 (48h)
 *   5th+ break: MAX_COOLDOWN_MS (72h)
 */
function getEffectiveCooldown(breakCount: number): number {
  if (breakCount <= 0) return BASE_COOLDOWN_MS;
  const multiplier = Math.pow(2, breakCount - 1);
  return Math.min(BASE_COOLDOWN_MS * multiplier, MAX_COOLDOWN_MS);
}

/**
 * Format a millisecond duration as a human-readable string for logging.
 */
function formatCooldown(ms: number): string {
  const hours = Math.round(ms / 3600000);
  if (hours >= 24) {
    const days = Math.round(hours / 24);
    return `${days}d`;
  }
  return `${hours}h`;
}

/**
 * Clear the channel's PTS state from the TelegramClient so that
 * gap recovery (fetchChannelDifference) stops retrying.
 *
 * Supports two teleproto layouts:
 *   - teleproto 1.224 and earlier: client._channelPts / _pendingChannelUpdates /
 *     _fetchingChannelDifference (flat Maps on the client).
 *   - teleproto 1.225+: client.updateManager.channels (Map<id, {pts: PtsWaiter,
 *     timer, inputChannel}>) plus client.updateManager.channelFailRetryTimers
 *     and client.updateManager.channelFailTimeoutS.
 *
 * After this, incoming updates for the channel re-init pts from the server
 * and gap detection effectively restarts from a clean slate.
 */
function circuitBreakChannel(channelId: string): void {
  const now = Date.now();
  const record = channelFailures.get(channelId);
  if (!record) return;

  record.breakCount++;
  record.brokenAt = now;

  const effectiveCooldown = getEffectiveCooldown(record.breakCount);

  try {
    const client = tryGetClient();
    if (!client) return;

    const summary = clearChannelStateOnClient(client, channelId);
    if (summary.cleared) {
      getLogger().info(
        `[CircuitBreaker] Cleared pts=${summary.oldPts ?? "?"} for channel ${channelId} — ` +
        `${record.timestamps.length} PTS failures within ${Math.round(FAILURE_WINDOW_MS / 60000)}min window. ` +
        `Cooldown: ${formatCooldown(effectiveCooldown)} (repeat #${record.breakCount}) ` +
        `[layout=${summary.layout}]`
      );
    }

    // Reset failure counter after breaking
    record.timestamps = [];
  } catch (e: unknown) {
    getLogger().error("[channelGapBreaker] operation failed:", e);
  }
}

/**
 * Silently clear the channel's pts state during cooldown. No log output,
 * no failure-counter changes — just defang teleproto's gap recovery so
 * the next update for this channel applies directly.
 */
function silentlyClearChannelPts(channelId: string): void {
  try {
    const client = tryGetClient();
    if (!client) return;
    clearChannelStateOnClient(client, channelId);
  } catch (e: unknown) {
    getLogger().error("[channelGapBreaker] operation failed:", e);
  }
}

/**
 * Probe both teleproto layouts and clear whichever one is in use. Returns
 * a summary so the caller can log the resolved layout for diagnostics.
 */
function clearChannelStateOnClient(
  client: GapBreakerClient,
  channelId: string,
): { cleared: boolean; oldPts: number | string | null; layout: string } {
  let cleared = false;
  let oldPts: number | string | null = null;
  let layout: string = "none";

  // mtcute first (Next): client.updates = UpdatesManager — must run even when
  // teleproto-shaped fields are absent. Previously layout stayed "none" forever.
  if (client.updates || client._updates || client.storage?.updates) {
    const mt = clearMtcuteChannelState(client, channelId);
    if (mt.cleared) {
      layout = "mtcute";
      cleared = true;
      if (mt.oldPts != null) oldPts = mt.oldPts;
    }
  }

  // teleproto 1.225+ layout: client.updateManager.{channels, channelFailRetryTimers, channelFailTimeoutS}
  const um = client.updateManager;
  if (um && um.channels && typeof um.channels.get === "function") {
    layout = cleared ? `${layout}+updateManager` : "updateManager";
    const tracker = um.channels.get(channelId);
    if (tracker) {
      try {
        if (tracker.pts && typeof tracker.pts.current === "function") {
          oldPts = tracker.pts.current();
        }
      } catch (e: unknown) {
        getLogger().error("[channelGapBreaker] operation failed:", e);
      }
      try {
        if (tracker.timer) {
          clearTimeout(tracker.timer);
          tracker.timer = undefined;
        }
        if (tracker.pts && typeof tracker.pts.clearSkippedUpdates === "function") {
          tracker.pts.clearSkippedUpdates();
        }
        if (tracker.pts && typeof tracker.pts.setRequesting === "function") {
          tracker.pts.setRequesting(false);
        }
      } catch (e: unknown) {
        getLogger().error("[channelGapBreaker] operation failed:", e);
      }
      um.channels.delete(channelId);
      cleared = true;
    }
    if (um.channelFailRetryTimers && typeof um.channelFailRetryTimers.get === "function") {
      const t = um.channelFailRetryTimers.get(channelId);
      if (t) {
        clearTimeout(t);
        um.channelFailRetryTimers.delete(channelId);
        cleared = true;
      }
    }
    if (um.channelFailTimeoutS && typeof um.channelFailTimeoutS.delete === "function") {
      if (um.channelFailTimeoutS.has?.(channelId)) {
        um.channelFailTimeoutS.delete(channelId);
        cleared = true;
      }
    }
  }

  // teleproto 1.224 and earlier: flat maps on the client
  if (client._channelPts && typeof client._channelPts.get === "function" && client._channelPts.has(channelId)) {
    layout = cleared && layout !== "none" ? `${layout}+legacy` : "legacy";
    if (oldPts == null) oldPts = client._channelPts.get(channelId) ?? null;
    client._channelPts.delete(channelId);
    cleared = true;
  }
  if (client._pendingChannelUpdates && typeof client._pendingChannelUpdates.delete === "function") {
    if (client._pendingChannelUpdates.has?.(channelId)) {
      layout = layout === "none" ? "legacy" : layout;
      client._pendingChannelUpdates.delete(channelId);
      cleared = true;
    }
  }
  if (client._fetchingChannelDifference && typeof client._fetchingChannelDifference.delete === "function") {
    if (client._fetchingChannelDifference.has?.(channelId)) {
      layout = layout === "none" ? "legacy" : layout;
      client._fetchingChannelDifference.delete(channelId);
      cleared = true;
    }
  }

  return { cleared, oldPts, layout };
}

/**
 * Safely get the TelegramClient without throwing.
 * The client has _channelPts, _pendingChannelUpdates, and
 * _fetchingChannelDifference as internal Maps/Sets.
 */
function tryGetClient(): unknown {
  try {
    // Sync access required; getGlobalClient() is async and unsuitable here.
    // tryGetCurrentRuntime returns the live runtime synchronously when set.
    const { tryGetCurrentRuntime } = require("./runtimeAccess") as typeof import("./runtimeAccess");
    const runtime = tryGetCurrentRuntime();
    if (runtime?.client) {
      return runtime.client;
    }
  } catch (e: unknown) {
    getLogger().error("[channelGapBreaker] operation failed:", e);
  }
  return null;
}

/**
 * Reset the circuit breaker state. Called during runtime reload to
 * start fresh.
 *
 * IMPORTANT: breakCount is preserved across reloads. If a channel has been
 * circuit-broken repeatedly (e.g. a permanently desynced channel), resetting
 * breakCount would cause the exponential backoff to start over at 6h every
 * reload — defeating the escalation (6h→12h→24h→48h→72h). By keeping
 * breakCount, the cooldown stays at the escalated level, keeping log noise
 * and wasted API calls to a minimum for chronically broken channels.
 */
export function resetCircuitBreaker(): void {
  for (const [channelId, record] of channelFailures) {
    record.timestamps = [];
    record.brokenAt = null;
    // breakCount is intentionally preserved
    // If a channel's breakCount is stale (channel recovered), it only
    // matters if the channel starts failing again after reload — at which
    // point the escalated cooldown is correct behavior (the channel has
    // a history of repeated breaks).
  }
}

/**
 * Clean up stale channel failure records to prevent memory leaks.
 * Removes entries for channels that:
 * - Have no active cooldown (brokenAt is null)
 * - Have no recent failure timestamps (older than CLEANUP_WINDOW_MS)
 * - Have never been circuit-broken (breakCount === 0)
 *
 * Called periodically (e.g., via cron) to bound the map size.
 */
export function cleanupStaleChannels(): number {
  const now = Date.now();
  // 7 days - channels that haven't failed in a week and were never circuit-broken
  const CLEANUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [channelId, record] of channelFailures) {
    if (record.breakCount === 0 && record.brokenAt === null && record.timestamps.length === 0) {
      // This shouldn't happen, but defensive check
      channelFailures.delete(channelId);
      removed++;
    } else if (record.breakCount === 0 && record.brokenAt === null && record.timestamps.length > 0) {
      // Check if all timestamps are old
      const allOld = record.timestamps.every((t) => now - t >= CLEANUP_WINDOW_MS);
      if (allOld) {
        channelFailures.delete(channelId);
        removed++;
      }
    }
    // Note: channels with breakCount > 0 are NEVER removed to preserve escalation history
  }
  return removed;
}