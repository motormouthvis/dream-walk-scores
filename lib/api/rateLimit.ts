/**
 * Per-caller rate limiting.
 *
 * A sliding-window counter held in process memory. On a single dyno this is exact; across
 * several dynos each holds its own window, so the effective limit is the configured value
 * times the dyno count. That is a deliberate trade: the alternative is a Redis round trip
 * on every request, and the limit exists to stop runaway loops rather than to meter
 * billing. If we ever charge by request, accounting moves to Postgres where it belongs.
 */

interface Window {
  /** Request timestamps within the current window, oldest first. */
  hits: number[];
}

const windows = new Map<string, Window>();
const WINDOW_MS = 60_000;

/** Stop the map growing without bound when many distinct IPs hit an open deployment. */
const MAX_TRACKED = 10_000;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the caller may retry. Only meaningful when `allowed` is false. */
  retryAfter: number;
}

export function checkRateLimit(callerId: string, limitPerMinute: number): RateLimitResult {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  if (windows.size > MAX_TRACKED) {
    // Drop everything rather than scanning: the windows are only a minute long, so the
    // worst case is one minute of under-enforcement after a flood of unique callers.
    windows.clear();
  }

  let window = windows.get(callerId);
  if (!window) {
    window = { hits: [] };
    windows.set(callerId, window);
  }

  // Expire from the front; the array is append-ordered so this is O(expired).
  let drop = 0;
  while (drop < window.hits.length && window.hits[drop] <= cutoff) drop += 1;
  if (drop > 0) window.hits.splice(0, drop);

  if (window.hits.length >= limitPerMinute) {
    const oldest = window.hits[0];
    return {
      allowed: false,
      limit: limitPerMinute,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)),
    };
  }

  window.hits.push(now);
  return {
    allowed: true,
    limit: limitPerMinute,
    remaining: limitPerMinute - window.hits.length,
    retryAfter: 0,
  };
}

export function rateLimitStats(): { trackedCallers: number } {
  return { trackedCallers: windows.size };
}
