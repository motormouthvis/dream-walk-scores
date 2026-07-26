/**
 * The request-path entry point for scoring.
 *
 * `scorePoint` in `lib/score.ts` always computes from source. This module wraps it in the
 * cache hierarchy that makes the service fast and cheap enough to sit on a property
 * listing page:
 *
 *   1. Process memory, keyed to a ~25 m grid cell.
 *   2. Postgres `score_cache`, shared across dynos.
 *   3. Full computation, which then populates both.
 *
 * The grid quantisation is the important part. Two units in the same building, or two
 * listings on the same block, resolve to one cell and therefore one computation. In a
 * metro that has been through `pipeline/precompute_grid.py` almost every lookup is a hit.
 */

import { TtlCache, SingleFlight } from "@/lib/cache";
import { hasDatabase, query, tableExists } from "@/lib/db";
import { snapToGrid } from "@/lib/geo";
import { scorePoint, type ScoreOptions } from "@/lib/score";
import type { ScoreResult } from "@/lib/types";

/**
 * Cache cell size.
 *
 * 25 m is roughly the footprint of a single-family lot: fine enough that two genuinely
 * different addresses never share a score, coarse enough that repeated lookups of the
 * same property always hit.
 */
const CELL_METERS = Number(process.env.SCORE_CELL_METERS ?? 25);

const MEMORY_TTL_MS = Number(process.env.SCORE_MEMORY_TTL_MS ?? 6 * 60 * 60 * 1000);
const DB_TTL_DAYS = Number(process.env.SCORE_DB_TTL_DAYS ?? 30);

const memory = new TtlCache<ScoreResult>(Number(process.env.SCORE_MEMORY_ENTRIES ?? 5000), MEMORY_TTL_MS);
const flight = new SingleFlight<ScoreResult>();

export const scoreStats = {
  memoryHits: 0,
  dbHits: 0,
  computed: 0,
  dbWriteFailures: 0,
};

function cellKey(lat: number, lon: number): string {
  const cell = snapToGrid(lat, lon, CELL_METERS);
  return `${cell.lat.toFixed(6)},${cell.lon.toFixed(6)}`;
}

async function readFromDatabase(key: string): Promise<ScoreResult | null> {
  if (!hasDatabase() || !(await tableExists("score_cache"))) return null;

  try {
    const rows = await query<{ payload: ScoreResult; computed_at: Date }>(
      `select payload, computed_at
         from score_cache
        where cell_key = $1
          and computed_at > now() - ($2 || ' days')::interval
        limit 1`,
      [key, String(DB_TTL_DAYS)]
    );
    return rows[0]?.payload ?? null;
  } catch {
    return null;
  }
}

async function writeToDatabase(key: string, lat: number, lon: number, result: ScoreResult): Promise<void> {
  if (!hasDatabase() || !(await tableExists("score_cache"))) return;

  try {
    await query(
      `insert into score_cache (cell_key, geom, walk_score, bike_score, transit_score, payload, computed_at)
       values ($1, st_setsrid(st_point($2, $3), 4326), $4, $5, $6, $7, now())
       on conflict (cell_key) do update
         set walk_score    = excluded.walk_score,
             bike_score    = excluded.bike_score,
             transit_score = excluded.transit_score,
             payload       = excluded.payload,
             computed_at   = excluded.computed_at`,
      [key, lon, lat, result.walk.score, result.bike.score, result.transit.score, JSON.stringify(result)]
    );
  } catch (error) {
    // A cache write failing must never fail the request that produced the value.
    scoreStats.dbWriteFailures += 1;
    console.error("[scoreService] cache write failed", error instanceof Error ? error.message : error);
  }
}

/** Re-stamp a cached payload so the caller sees where the answer actually came from. */
function withProvenance(result: ScoreResult, source: ScoreResult["provenance"]["source"], startedAt: number): ScoreResult {
  return {
    ...result,
    provenance: { ...result.provenance, source, computeMs: Date.now() - startedAt },
  };
}

export interface GetScoreOptions extends ScoreOptions {
  /** Skip every cache layer and recompute. */
  fresh?: boolean;
}

export async function getScore(lat: number, lon: number, options: GetScoreOptions = {}): Promise<ScoreResult> {
  const started = Date.now();
  const key = cellKey(lat, lon);

  // The AI summary is a different product for the same coordinate, so it gets its own
  // cache namespace rather than serving a template summary to an `ai=1` caller.
  const namespaced = options.ai ? `${key}:ai` : key;

  if (!options.fresh) {
    const hit = memory.get(namespaced);
    if (hit) {
      scoreStats.memoryHits += 1;
      return withProvenance(hit, "cache", started);
    }
  }

  return flight.run(namespaced, async () => {
    if (!options.fresh) {
      const raced = memory.get(namespaced);
      if (raced) {
        scoreStats.memoryHits += 1;
        return withProvenance(raced, "cache", started);
      }

      const stored = await readFromDatabase(namespaced);
      if (stored) {
        scoreStats.dbHits += 1;
        memory.set(namespaced, stored);
        // A row written by `precompute_grid.py` is a grid hit; one written by a previous
        // live request is an ordinary cache hit.
        const source = stored.provenance.source === "precomputed-grid" ? "precomputed-grid" : "cache";
        return withProvenance(stored, source, started);
      }
    }

    const computed = await scorePoint(lat, lon, options);
    scoreStats.computed += 1;

    memory.set(namespaced, computed);
    void writeToDatabase(namespaced, lat, lon, computed);

    return computed;
  });
}

export function scoreCacheSize(): number {
  return memory.size;
}

export function clearScoreCache(): void {
  memory.clear();
}
