/**
 * GET /api/admin/stats
 *
 * Everything the operations dashboard needs in one call: score coverage, data freshness,
 * cache effectiveness and what we are spending.
 *
 * The cost panel is the reason this product exists — it should be immediately obvious
 * whether the open-data pipeline is still cheaper than the API it replaced — so the
 * numbers are reported per thousand scores rather than as opaque totals.
 */

import { NextResponse } from "next/server";
import { isAdmin, adminConfigured } from "@/lib/api/adminAuth";
import { hasDatabase, query, tableExists } from "@/lib/db";
import { aiStats, explainCacheSize } from "@/lib/explain";
import { elevationStats } from "@/lib/elevation";
import { geocodeStats } from "@/lib/geocode";
import { overpassCacheSizes, overpassStats } from "@/lib/osm/overpass";
import { rateLimitStats } from "@/lib/api/rateLimit";
import { scoreCacheSize, scoreStats } from "@/lib/scoreService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface FreshnessRow {
  source: string;
  last_run_at: Date | null;
  last_success_at: Date | null;
  status: string | null;
  detail: string | null;
  record_count: string | null;
}

export async function GET(request: Request): Promise<Response> {
  if (!adminConfigured()) {
    return NextResponse.json(
      { error: "The admin dashboard is disabled. Set ADMIN_PASSWORD to enable it." },
      { status: 503 }
    );
  }
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const totalLookups = scoreStats.memoryHits + scoreStats.dbHits + scoreStats.computed;
  const cacheHitRate = totalLookups > 0 ? (scoreStats.memoryHits + scoreStats.dbHits) / totalLookups : null;

  const stats: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),

    scoring: {
      ...scoreStats,
      totalLookups,
      cacheHitRate: cacheHitRate === null ? null : Number(cacheHitRate.toFixed(4)),
      memoryCacheEntries: scoreCacheSize(),
    },

    upstream: {
      overpass: {
        requests: overpassStats.requests,
        cacheHits: overpassStats.cacheHits,
        failures: overpassStats.failures,
        averageMs:
          overpassStats.requests > 0 ? Math.round(overpassStats.totalMs / overpassStats.requests) : null,
        cacheEntries: overpassCacheSizes(),
      },
      geocoder: geocodeStats,
      elevation: elevationStats,
    },

    ai: {
      enabled: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.AI_EXPLAIN_MODEL ?? "gpt-4o-mini",
      calls: aiStats.calls,
      cacheHits: aiStats.cacheHits,
      failures: aiStats.failures,
      promptTokens: aiStats.promptTokens,
      completionTokens: aiStats.completionTokens,
      estimatedCostUsd: Number(aiStats.estimatedCostUsd.toFixed(4)),
      cacheEntries: explainCacheSize(),
    },

    /**
     * The whole point, stated plainly. Every upstream source we use is free, so marginal
     * cost per score is dyno time plus whatever AI explanations were requested.
     */
    cost: {
      marginalUsdPerThousandScores:
        totalLookups > 0 ? Number(((aiStats.estimatedCostUsd / totalLookups) * 1000).toFixed(4)) : 0,
      paidUpstreamCalls: 0,
      note: "OpenStreetMap, GTFS, AWS terrain tiles and the Census geocoder are all free. The only variable cost is optional AI explanations.",
    },

    rateLimiting: rateLimitStats(),
    database: { configured: hasDatabase(), reachable: false },
  };

  if (hasDatabase()) {
    try {
      await query("select 1");
      (stats.database as Record<string, unknown>).reachable = true;

      if (await tableExists("score_cache")) {
        const rows = await query<{
          total: string;
          fresh_7d: string;
          precomputed: string;
          avg_walk: string | null;
          oldest: Date | null;
        }>(
          `select count(*)::text                                              as total,
                  count(*) filter (where computed_at > now() - interval '7 days')::text as fresh_7d,
                  count(*) filter (where payload->'provenance'->>'source' = 'precomputed-grid')::text as precomputed,
                  round(avg(walk_score))::text                                as avg_walk,
                  min(computed_at)                                            as oldest
             from score_cache`
        );
        stats.scoreCache = rows[0] ?? null;
      }

      if (await tableExists("gtfs_feed")) {
        const feeds = await query<{
          feeds: string;
          stops: string;
          routes: string;
          stale: string;
          oldest_fetch: Date | null;
        }>(
          `select (select count(*) from gtfs_feed)::text  as feeds,
                  (select count(*) from gtfs_stop)::text  as stops,
                  (select count(*) from gtfs_route)::text as routes,
                  (select count(*) from gtfs_feed where valid_to is not null and valid_to < current_date)::text as stale,
                  (select min(fetched_at) from gtfs_feed) as oldest_fetch`
        );
        stats.gtfs = feeds[0] ?? null;
      }

      if (await tableExists("data_refresh")) {
        const rows = await query<FreshnessRow>(
          "select source, last_run_at, last_success_at, status, detail, record_count::text from data_refresh order by source"
        );
        stats.freshness = rows;
      }

      if (await tableExists("precompute_region")) {
        stats.precomputeRegions = await query(
          `select name, cell_meters, cells_total, cells_done, status, started_at, completed_at
             from precompute_region order by name`
        );
      }

      if (await tableExists("api_key")) {
        stats.apiKeys = await query(
          `select label, key_prefix, request_count, created_at, last_used_at, revoked_at is not null as revoked
             from api_key order by request_count desc limit 50`
        );
      }
    } catch (error) {
      (stats.database as Record<string, unknown>).error =
        error instanceof Error ? error.message : String(error);
    }
  }

  return NextResponse.json(stats, { headers: { "Cache-Control": "no-store" } });
}
