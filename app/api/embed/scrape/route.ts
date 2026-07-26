/**
 * POST /api/embed/scrape
 *
 * The SDK posts what it could see on the partner's page; we work out the address and
 * geocode it. Doing the parsing server-side keeps `embed.js` small and means the
 * heuristics can be improved without every partner re-copying a script tag.
 */

import { NextResponse } from "next/server";
import { CORS_HEADERS, preflight } from "@/lib/api/respond";
import { extractAddress, type ExtractInput } from "@/lib/embed/addressExtract";
import { resolveEmbedConfig } from "@/lib/embed/config";
import { geocode } from "@/lib/geocode";
import { isInUnitedStates } from "@/lib/geo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Cap the payload so a hostile page cannot make us parse a megabyte of text. */
const MAX_CANDIDATES = 25;
const MAX_STRING = 2000;

export function OPTIONS(): Response {
  return preflight();
}

function truncate(value: unknown): string | null {
  return typeof value === "string" ? value.slice(0, MAX_STRING) : null;
}

export async function POST(request: Request): Promise<Response> {
  let body: ExtractInput & { host?: string };
  try {
    body = (await request.json()) as ExtractInput & { host?: string };
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400, headers: CORS_HEADERS });
  }

  const input: ExtractInput = {
    pageUrl: truncate(body.pageUrl),
    pageTitle: truncate(body.pageTitle),
    jsonLd: (body.jsonLd ?? []).slice(0, 10).map((b) => String(b).slice(0, 20_000)),
    meta: body.meta ?? {},
    candidates: (body.candidates ?? []).slice(0, MAX_CANDIDATES).map((c) => String(c).slice(0, 300)),
  };

  const extracted = extractAddress(input);

  // Nothing on the page: fall back to whatever the partner configured as their default,
  // which for a single-office realtor is usually exactly right.
  if (!extracted) {
    const config = await resolveEmbedConfig(body.host ?? input.pageUrl ?? "");
    if (config.defaultLat !== null && config.defaultLng !== null) {
      return json({
        found: true,
        address: config.defaultAddress,
        lat: config.defaultLat,
        lng: config.defaultLng,
        source: "partner-default",
      });
    }
    if (config.defaultAddress) {
      const hit = await geocode(config.defaultAddress);
      if (hit) {
        return json({
          found: true,
          address: hit.displayName,
          lat: hit.lat,
          lng: hit.lon,
          source: "partner-default",
        });
      }
    }
    return json({ found: false, address: null, lat: null, lng: null, source: null });
  }

  const hit = await geocode(extracted.address);
  if (!hit || !isInUnitedStates(hit.lat, hit.lon)) {
    return json({ found: false, address: extracted.address, lat: null, lng: null, source: extracted.source });
  }

  return json({
    found: true,
    address: hit.displayName,
    lat: hit.lat,
    lng: hit.lon,
    source: extracted.source,
    confidence: extracted.confidence,
  });
}

function json(body: unknown): NextResponse {
  return NextResponse.json(body, {
    headers: { ...CORS_HEADERS, "Cache-Control": "no-store" },
  });
}
