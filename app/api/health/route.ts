/**
 * GET /api/health
 *
 * Reports what the service can actually do right now rather than just returning "ok".
 * A deployment with no GTFS loaded still works, but its Transit Scores are estimates, and
 * that is the sort of thing a health check should say out loud.
 */

import { NextResponse } from "next/server";
import { hasDatabase, query, tableExists } from "@/lib/db";
import { CORS_HEADERS } from "@/lib/api/respond";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Health {
  status: "ok" | "degraded";
  version: string;
  database: { configured: boolean; reachable: boolean; error?: string };
  capabilities: {
    precomputedGrid: boolean;
    gtfsSchedules: boolean;
    aiExplanations: boolean;
    apiKeysEnforced: boolean;
  };
  data: {
    gtfsFeeds: number | null;
    gtfsStops: number | null;
    cachedScores: number | null;
  };
}

export async function GET(): Promise<Response> {
  const health: Health = {
    status: "ok",
    version: process.env.HEROKU_SLUG_COMMIT?.slice(0, 7) ?? "dev",
    database: { configured: hasDatabase(), reachable: false },
    capabilities: {
      precomputedGrid: false,
      gtfsSchedules: false,
      aiExplanations: Boolean(process.env.OPENAI_API_KEY),
      apiKeysEnforced: process.env.REQUIRE_API_KEY === "1",
    },
    data: { gtfsFeeds: null, gtfsStops: null, cachedScores: null },
  };

  if (hasDatabase()) {
    try {
      await query("select 1");
      health.database.reachable = true;

      if (await tableExists("gtfs_feed")) {
        const rows = await query<{ feeds: string; stops: string }>(
          `select (select count(*) from gtfs_feed)::text as feeds,
                  (select count(*) from gtfs_stop)::text as stops`
        );
        health.data.gtfsFeeds = Number(rows[0]?.feeds ?? 0);
        health.data.gtfsStops = Number(rows[0]?.stops ?? 0);
        health.capabilities.gtfsSchedules = health.data.gtfsFeeds > 0;
      }

      if (await tableExists("score_cache")) {
        const rows = await query<{ n: string }>("select count(*)::text as n from score_cache");
        health.data.cachedScores = Number(rows[0]?.n ?? 0);
        health.capabilities.precomputedGrid = health.data.cachedScores > 0;
      }
    } catch (error) {
      health.database.error = error instanceof Error ? error.message : String(error);
      health.status = "degraded";
    }
  }

  // A configured-but-unreachable database is a real problem. Having no database at all is
  // a valid, supported configuration, so it is not an error.
  const httpStatus = health.database.configured && !health.database.reachable ? 503 : 200;

  return NextResponse.json(health, {
    status: httpStatus,
    headers: { ...CORS_HEADERS, "Cache-Control": "no-store" },
  });
}
