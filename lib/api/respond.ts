/**
 * Shared request handling for the REST surface.
 *
 * Every public route runs through `handle`, so authentication, rate limiting, CORS, error
 * shape and cache headers are decided once rather than re-implemented per endpoint.
 */

import { NextResponse } from "next/server";
import { authenticate, type ApiCaller } from "@/lib/api/auth";
import { checkRateLimit } from "@/lib/api/rateLimit";

export interface ApiError {
  error: string;
  /** Machine-readable code so callers can branch without string matching. */
  code: string;
  details?: unknown;
}

export const ERROR_CODES = {
  badRequest: "bad_request",
  unauthorized: "unauthorized",
  rateLimited: "rate_limited",
  notFound: "not_found",
  outOfCoverage: "out_of_coverage",
  upstreamUnavailable: "upstream_unavailable",
  internal: "internal_error",
} as const;

export function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: unknown
): NextResponse<ApiError> {
  return NextResponse.json({ error: message, code, ...(details === undefined ? {} : { details }) }, { status });
}

/** Permissive CORS: the API is read-only and intended to be called from partner pages. */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
  "Access-Control-Max-Age": "86400",
};

export function preflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export interface HandlerContext {
  caller: ApiCaller;
  request: Request;
  url: URL;
}

export interface HandleOptions {
  /** `s-maxage` for the CDN, in seconds. Omit for no caching. */
  cacheSeconds?: number;
}

/**
 * Wrap a route handler with auth, rate limiting, CORS and error normalisation.
 *
 * Handlers return plain data; this decides the status code and headers. Throwing an
 * `ApiFailure` produces a structured error, and anything else becomes a 500 with the
 * detail logged but not leaked.
 */
export async function handle<T>(
  request: Request,
  fn: (ctx: HandlerContext) => Promise<T>,
  options: HandleOptions = {}
): Promise<NextResponse> {
  const { caller, error } = await authenticate(request);
  if (error || !caller) {
    return withCors(errorResponse(error?.status ?? 401, ERROR_CODES.unauthorized, error?.message ?? "Unauthorized"));
  }

  const limit = checkRateLimit(caller.id, caller.rateLimitPerMinute);
  if (!limit.allowed) {
    const response = errorResponse(
      429,
      ERROR_CODES.rateLimited,
      `Rate limit of ${limit.limit} requests per minute exceeded.`
    );
    response.headers.set("Retry-After", String(limit.retryAfter));
    return withCors(withRateHeaders(response, limit.limit, limit.remaining));
  }

  try {
    const data = await fn({ caller, request, url: new URL(request.url) });
    const response = NextResponse.json(data);
    if (options.cacheSeconds) {
      response.headers.set(
        "Cache-Control",
        `public, max-age=0, s-maxage=${options.cacheSeconds}, stale-while-revalidate=${options.cacheSeconds * 10}`
      );
    }
    return withCors(withRateHeaders(response, limit.limit, limit.remaining));
  } catch (thrown) {
    if (thrown instanceof ApiFailure) {
      return withCors(errorResponse(thrown.status, thrown.code, thrown.message, thrown.details));
    }
    console.error("[api] unhandled error", thrown);
    return withCors(
      errorResponse(500, ERROR_CODES.internal, "Something went wrong computing this score. Please retry.")
    );
  }
}

function withCors(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(CORS_HEADERS)) response.headers.set(key, value);
  return response;
}

function withRateHeaders(response: NextResponse, limit: number, remaining: number): NextResponse {
  response.headers.set("X-RateLimit-Limit", String(limit));
  response.headers.set("X-RateLimit-Remaining", String(remaining));
  return response;
}

/** Throw from a handler to produce a specific error response. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

// ---------------------------------------------------------------------------
// Parameter parsing
// ---------------------------------------------------------------------------

/**
 * Resolve a coordinate from `lat`/`lng` (or `lon`) query parameters.
 * Returns null when neither pair is present, so the caller can try `address` instead.
 */
export function parseLatLng(url: URL): { lat: number; lon: number } | null {
  const latRaw = url.searchParams.get("lat");
  const lonRaw = url.searchParams.get("lng") ?? url.searchParams.get("lon");
  if (latRaw === null || lonRaw === null) return null;

  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new ApiFailure(400, ERROR_CODES.badRequest, "`lat` and `lng` must be numbers.");
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new ApiFailure(400, ERROR_CODES.badRequest, "`lat` must be in [-90,90] and `lng` in [-180,180].");
  }
  return { lat, lon };
}

export function parseBoolean(url: URL, name: string, fallback = false): boolean {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
}
