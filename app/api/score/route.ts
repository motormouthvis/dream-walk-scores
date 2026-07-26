/**
 * GET /api/score
 *
 * The primary endpoint. Returns Walk, Bike and Transit scores with the full breakdown
 * that produced them.
 *
 *   /api/score?lat=40.758&lng=-73.9855
 *   /api/score?address=1500 N 23rd St, Fort Pierce, FL
 *   /api/score?lat=…&lng=…&ai=1        — LLM-written summary
 *   /api/score?lat=…&lng=…&detail=0    — scores only, no amenity lists
 */

import { handle, parseBoolean, preflight } from "@/lib/api/respond";
import { resolvePoint } from "@/lib/api/resolve";
import { getScore } from "@/lib/scoreService";
import type { ScoreResult } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function OPTIONS(): Response {
  return preflight();
}

/** Strip the per-amenity detail for callers that only want the headline numbers. */
function summarise(result: ScoreResult): unknown {
  return {
    location: result.location,
    walk: {
      score: result.walk.score,
      description: result.walk.description,
      explanation: result.walk.explanation,
    },
    bike: {
      score: result.bike.score,
      description: result.bike.description,
      explanation: result.bike.explanation,
    },
    transit: {
      score: result.transit.score,
      description: result.transit.description,
      explanation: result.transit.explanation,
      hasCoverage: result.transit.hasCoverage,
    },
    confidence: result.confidence,
    summary: result.summary,
    provenance: result.provenance,
  };
}

export async function GET(request: Request): Promise<Response> {
  return handle(
    request,
    async ({ url }) => {
      const point = await resolvePoint(url);
      const result = await getScore(point.lat, point.lon, {
        address: point.address,
        ai: parseBoolean(url, "ai"),
        fresh: parseBoolean(url, "fresh"),
      });

      return parseBoolean(url, "detail", true) ? result : summarise(result);
    },
    // Scores change on the timescale that neighbourhoods change. An hour at the edge is
    // conservative and takes almost all repeat traffic off the origin.
    { cacheSeconds: 3600 }
  );
}
