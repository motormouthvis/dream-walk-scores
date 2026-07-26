/**
 * POST /api/score/batch
 *
 * Score many points in one request. Built for the case that actually matters: a search
 * results page or an MLS sync that needs scores for a page of listings without issuing a
 * hundred HTTP round trips.
 *
 *   {
 *     "points": [
 *       { "id": "mls-123", "lat": 40.758, "lng": -73.9855 },
 *       { "id": "mls-124", "address": "1500 N 23rd St, Fort Pierce FL" }
 *     ],
 *     "detail": false
 *   }
 *
 * Individual failures do not fail the batch: each entry carries either a `score` or an
 * `error`, so one bad address cannot cost the caller the other ninety-nine results.
 */

import { ApiFailure, ERROR_CODES, handle, preflight } from "@/lib/api/respond";
import { assertInCoverage } from "@/lib/api/resolve";
import { geocode } from "@/lib/geocode";
import { getScore } from "@/lib/scoreService";
import type { ScoreResult } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Hard ceiling on batch size. Chosen so that a worst-case batch of complete cache misses
 * still finishes inside a Heroku router timeout; larger jobs belong in the pipeline.
 */
const MAX_POINTS = Number(process.env.BATCH_MAX_POINTS ?? 100);

/**
 * How many points to score simultaneously.
 *
 * Cache hits are effectively free, so this only bounds concurrent Overpass work. Kept low
 * deliberately: hammering a free community API with parallel requests is how you get
 * blocked, and a large batch of cold points is a sign the area should be precomputed.
 */
const CONCURRENCY = Number(process.env.BATCH_CONCURRENCY ?? 4);

interface BatchPoint {
  id?: string;
  lat?: number;
  lng?: number;
  lon?: number;
  address?: string;
}

interface BatchRequest {
  points?: BatchPoint[];
  detail?: boolean;
  ai?: boolean;
}

interface BatchEntry {
  id: string;
  score?: unknown;
  error?: { message: string; code: string };
}

export function OPTIONS(): Response {
  return preflight();
}

function compact(result: ScoreResult): unknown {
  return {
    location: result.location,
    walk: { score: result.walk.score, description: result.walk.description },
    bike: { score: result.bike.score, description: result.bike.description },
    transit: {
      score: result.transit.score,
      description: result.transit.description,
      hasCoverage: result.transit.hasCoverage,
    },
    confidence: result.confidence,
    summary: result.summary,
  };
}

async function scoreOne(point: BatchPoint, index: number, detail: boolean, ai: boolean): Promise<BatchEntry> {
  const id = point.id ?? String(index);

  try {
    let lat = point.lat;
    let lon = point.lng ?? point.lon;
    let address: string | null = point.address ?? null;

    if (lat === undefined || lon === undefined) {
      if (!point.address) {
        throw new ApiFailure(400, ERROR_CODES.badRequest, "Each point needs `lat`+`lng` or an `address`.");
      }
      const geocoded = await geocode(point.address);
      if (!geocoded) {
        throw new ApiFailure(404, ERROR_CODES.notFound, `Could not geocode "${point.address}".`);
      }
      lat = geocoded.lat;
      lon = geocoded.lon;
      address = geocoded.displayName;
    }

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new ApiFailure(400, ERROR_CODES.badRequest, "`lat` and `lng` must be numbers.");
    }
    assertInCoverage(lat as number, lon as number);

    const result = await getScore(lat as number, lon as number, { address, ai });
    return { id, score: detail ? result : compact(result) };
  } catch (error) {
    if (error instanceof ApiFailure) {
      return { id, error: { message: error.message, code: error.code } };
    }
    return {
      id,
      error: {
        message: error instanceof Error ? error.message : "Failed to score this point.",
        code: ERROR_CODES.internal,
      },
    };
  }
}

/** Run `tasks` with bounded concurrency, preserving input order in the output. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function POST(request: Request): Promise<Response> {
  return handle(request, async () => {
    let body: BatchRequest;
    try {
      body = (await request.json()) as BatchRequest;
    } catch {
      throw new ApiFailure(400, ERROR_CODES.badRequest, "Request body must be JSON.");
    }

    const points = body.points;
    if (!Array.isArray(points) || points.length === 0) {
      throw new ApiFailure(400, ERROR_CODES.badRequest, "`points` must be a non-empty array.");
    }
    if (points.length > MAX_POINTS) {
      throw new ApiFailure(
        400,
        ERROR_CODES.badRequest,
        `A batch may contain at most ${MAX_POINTS} points; received ${points.length}.`
      );
    }

    const started = Date.now();
    const detail = body.detail === true;
    const ai = body.ai === true;

    const results = await mapLimit(points, CONCURRENCY, (point, index) => scoreOne(point, index, detail, ai));

    return {
      count: results.length,
      succeeded: results.filter((r) => r.score !== undefined).length,
      failed: results.filter((r) => r.error !== undefined).length,
      elapsedMs: Date.now() - started,
      results,
    };
  });
}
