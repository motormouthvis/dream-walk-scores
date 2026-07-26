/**
 * GET /api/walkscore — Walk Score API compatibility shim.
 *
 * Returns the exact response shape of `api.walkscore.com/score`, including its status
 * codes, so that an existing integration can be moved onto Dream Walk Scores by changing
 * a base URL and nothing else.
 *
 * In `dreamneighborhood` the entire migration is one line in
 * `apps/widget/utils/get_walk_score_utils.py`:
 *
 *     base_url = "https://<this-service>/api/walkscore"
 *
 * The `wsapikey`, `format`, `transit` and `bike` parameters are accepted and ignored so
 * that callers do not have to change their parameter construction either. See
 * `docs/INTEGRATION.md`.
 */

import { NextResponse } from "next/server";
import { CORS_HEADERS, preflight } from "@/lib/api/respond";
import { isInUnitedStates, isValidLatLon } from "@/lib/geo";
import { getScore } from "@/lib/scoreService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Walk Score's documented status codes, which callers already branch on. */
const STATUS_OK = 1;
const STATUS_UNAVAILABLE = 2;
const STATUS_INVALID_COORDS = 30;
const STATUS_INTERNAL_ERROR = 31;

export function OPTIONS(): Response {
  return preflight();
}

function respond(body: Record<string, unknown>): NextResponse {
  const response = NextResponse.json(body);
  for (const [key, value] of Object.entries(CORS_HEADERS)) response.headers.set(key, value);
  response.headers.set("Cache-Control", "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400");
  return response;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon") ?? url.searchParams.get("lng"));

  if (!isValidLatLon(lat, lon)) {
    return respond({ status: STATUS_INVALID_COORDS, status_text: "Invalid latitude and longitude." });
  }
  if (!isInUnitedStates(lat, lon)) {
    return respond({ status: STATUS_UNAVAILABLE, status_text: "Score is unavailable for this location." });
  }

  const publicBase = process.env.PUBLIC_BASE_URL ?? url.origin;

  try {
    const result = await getScore(lat, lon, { ai: false });

    if (result.walk.score === null) {
      return respond({ status: STATUS_UNAVAILABLE, status_text: "Score is unavailable for this location." });
    }

    const body: Record<string, unknown> = {
      status: STATUS_OK,
      walkscore: result.walk.score,
      description: result.walk.description,
      updated: result.provenance.osmSnapshot ?? new Date().toISOString(),
      logo_url: `${publicBase}/badge/logo.svg`,
      more_info_icon: `${publicBase}/badge/info.svg`,
      more_info_link: `${publicBase}/methodology`,
      ws_link: `${publicBase}/score?lat=${lat}&lng=${lon}`,
      help_link: `${publicBase}/methodology`,
      snapped_lat: result.location.snappedLat ?? lat,
      snapped_lon: result.location.snappedLon ?? lon,

      // Fields beyond the original contract. Additive only, so existing parsers ignore
      // them, but they let callers adopt our extras without a second request.
      dws: {
        provider: "dream-walk-scores",
        confidence: result.confidence,
        confidence_notes: result.confidenceNotes,
        summary: result.summary,
        walk_explanation: result.walk.explanation,
        source: result.provenance.source,
      },
    };

    // Walk Score omits these keys entirely when unavailable rather than sending nulls,
    // and callers check for key presence. Match that exactly.
    if (result.bike.score !== null) {
      body.bike = { score: result.bike.score, description: result.bike.description };
    }
    if (result.transit.score !== null) {
      body.transit = {
        score: result.transit.score,
        description: result.transit.description,
        summary: transitSummary(result.transit.routeCount, result.transit.stopCount),
      };
    }

    return respond(body);
  } catch (error) {
    console.error("[walkscore-compat] failed", error);
    return respond({ status: STATUS_INTERNAL_ERROR, status_text: "Internal error computing score." });
  }
}

/** Mirrors the free-text `transit.summary` field Walk Score returns. */
function transitSummary(routeCount: number, stopCount: number): string {
  if (routeCount === 0) return "No transit routes within walking distance.";
  const routes = `${routeCount} route${routeCount === 1 ? "" : "s"}`;
  const stops = `${stopCount} stop${stopCount === 1 ? "" : "s"}`;
  return `${routes} at ${stops} within a half-mile walk.`;
}
