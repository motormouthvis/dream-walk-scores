/**
 * GET /api/embed/config?host=example.com
 *
 * Resolves the widget configuration for a partner host. Called by `public/embed.js`
 * before it renders anything, so it must be fast, cacheable and never fail.
 */

import { NextResponse } from "next/server";
import { CORS_HEADERS, preflight } from "@/lib/api/respond";
import { recordEmbedView, resolveEmbedConfig } from "@/lib/embed/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function OPTIONS(): Response {
  return preflight();
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // Prefer the explicit parameter, fall back to the Referer so a misconfigured snippet
  // still resolves.
  const host =
    url.searchParams.get("host") ??
    (request.headers.get("referer") ? new URL(request.headers.get("referer") as string).hostname : "");

  const config = await resolveEmbedConfig(host);
  if (config.registered) recordEmbedView(config.host);

  return NextResponse.json(config, {
    headers: {
      ...CORS_HEADERS,
      "Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
    },
  });
}
