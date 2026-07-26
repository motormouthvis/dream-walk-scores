/**
 * API key authentication.
 *
 * Keys are optional by default so that local development, review apps and the sibling
 * Dream products can call the service with no ceremony. Set `REQUIRE_API_KEY=1` to lock
 * a deployment down.
 *
 * The header format matches the existing Dream Neighborhood public API
 * (`Authorization: Api-Key <key>`) so a caller that already integrates with that service
 * needs no new client code.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { hasDatabase, query, tableExists } from "@/lib/db";
import { TtlCache } from "@/lib/cache";

export interface ApiCaller {
  /** Stable identifier used for rate limiting and usage attribution. */
  id: string;
  label: string;
  /** True when the caller was not authenticated because keys are not required. */
  anonymous: boolean;
  rateLimitPerMinute: number;
}

const DEFAULT_ANON_RATE = Number(process.env.ANON_RATE_LIMIT_PER_MINUTE ?? 60);
const DEFAULT_KEY_RATE = Number(process.env.KEY_RATE_LIMIT_PER_MINUTE ?? 600);

const keyCache = new TtlCache<ApiCaller | null>(500, 60_000);

function requireApiKey(): boolean {
  return process.env.REQUIRE_API_KEY === "1";
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Constant-time comparison that tolerates length differences without leaking them. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(hashKey(a), "hex");
  const bb = Buffer.from(hashKey(b), "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function extractKey(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header) {
    const match = /^Api-Key\s+(.+)$/i.exec(header) ?? /^Bearer\s+(.+)$/i.exec(header);
    if (match) return match[1].trim();
  }
  const alt = request.headers.get("x-api-key");
  if (alt) return alt.trim();

  // Query parameter is supported for the embed surface, where a header cannot be set.
  const url = new URL(request.url);
  return url.searchParams.get("api_key");
}

interface KeyRow {
  id: string;
  label: string;
  rate_limit_per_minute: number | null;
  revoked_at: Date | null;
}

async function lookupKey(key: string): Promise<ApiCaller | null> {
  // A single static key can be configured without a database, which is all a small
  // deployment or a review app needs.
  const staticKey = process.env.STATIC_API_KEY;
  if (staticKey && safeEqual(key, staticKey)) {
    return { id: "static", label: "Static key", anonymous: false, rateLimitPerMinute: DEFAULT_KEY_RATE };
  }

  if (!hasDatabase() || !(await tableExists("api_key"))) return null;

  const rows = await query<KeyRow>(
    `select id::text, label, rate_limit_per_minute, revoked_at
       from api_key
      where key_hash = $1
      limit 1`,
    [hashKey(key)]
  );

  const row = rows[0];
  if (!row || row.revoked_at) return null;

  // Fire-and-forget: usage accounting must never slow down or fail a scoring request.
  void query("update api_key set last_used_at = now(), request_count = request_count + 1 where id = $1", [
    row.id,
  ]).catch(() => undefined);

  return {
    id: row.id,
    label: row.label,
    anonymous: false,
    rateLimitPerMinute: row.rate_limit_per_minute ?? DEFAULT_KEY_RATE,
  };
}

export interface AuthResult {
  caller: ApiCaller | null;
  /** Populated when the request must be rejected. */
  error: { status: number; message: string } | null;
}

export async function authenticate(request: Request): Promise<AuthResult> {
  const key = extractKey(request);

  if (!key) {
    if (requireApiKey()) {
      return {
        caller: null,
        error: { status: 401, message: "An API key is required. Send `Authorization: Api-Key <key>`." },
      };
    }
    // Anonymous callers are rate limited by IP.
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      request.headers.get("x-real-ip") ??
      "unknown";
    return {
      caller: { id: `anon:${ip}`, label: "Anonymous", anonymous: true, rateLimitPerMinute: DEFAULT_ANON_RATE },
      error: null,
    };
  }

  const cached = keyCache.get(key);
  if (cached !== undefined) {
    return cached
      ? { caller: cached, error: null }
      : { caller: null, error: { status: 401, message: "Invalid API key." } };
  }

  const caller = await lookupKey(key).catch(() => null);
  keyCache.set(key, caller);

  return caller
    ? { caller, error: null }
    : { caller: null, error: { status: 401, message: "Invalid API key." } };
}
