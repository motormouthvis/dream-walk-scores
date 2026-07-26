/**
 * POST /api/graphql — GraphQL endpoint.
 * GET  /api/graphql — the SDL, so clients can introspect without a POST.
 *
 * Auth and rate limiting are shared with REST. There is no GraphiQL UI: the schema is
 * small enough to read, and shipping an interactive console on a public endpoint invites
 * exactly the unbounded queries this service should not be running.
 */

import { NextResponse } from "next/server";
import { executeGraphQL, typeDefs, type GraphQLRequest } from "@/lib/api/graphql";
import { authenticate } from "@/lib/api/auth";
import { checkRateLimit } from "@/lib/api/rateLimit";
import { CORS_HEADERS, ERROR_CODES, errorResponse, preflight } from "@/lib/api/respond";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function OPTIONS(): Response {
  return preflight();
}

export function GET(): Response {
  return new NextResponse(typeDefs, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

function withCors(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(CORS_HEADERS)) response.headers.set(key, value);
  return response;
}

export async function POST(request: Request): Promise<Response> {
  const { caller, error } = await authenticate(request);
  if (error || !caller) {
    return withCors(errorResponse(error?.status ?? 401, ERROR_CODES.unauthorized, error?.message ?? "Unauthorized"));
  }

  const limit = checkRateLimit(caller.id, caller.rateLimitPerMinute);
  if (!limit.allowed) {
    const response = errorResponse(429, ERROR_CODES.rateLimited, `Rate limit of ${limit.limit} requests per minute exceeded.`);
    response.headers.set("Retry-After", String(limit.retryAfter));
    return withCors(response);
  }

  let body: GraphQLRequest;
  try {
    body = (await request.json()) as GraphQLRequest;
  } catch {
    return withCors(errorResponse(400, ERROR_CODES.badRequest, "Request body must be JSON."));
  }

  if (!body?.query || typeof body.query !== "string") {
    return withCors(errorResponse(400, ERROR_CODES.badRequest, "`query` is required."));
  }

  const result = await executeGraphQL(body);

  // GraphQL reports errors in the body with a 200, which is the convention clients expect.
  const response = NextResponse.json(result);
  response.headers.set("X-RateLimit-Limit", String(limit.limit));
  response.headers.set("X-RateLimit-Remaining", String(limit.remaining));
  return withCors(response);
}
