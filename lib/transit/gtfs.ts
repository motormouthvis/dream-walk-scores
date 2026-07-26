/**
 * Transit routes from loaded GTFS feeds.
 *
 * GTFS is the authoritative source because it carries schedules, and frequency is most of
 * what makes transit valuable. Feeds are ingested by `pipeline/load_gtfs.py`, which
 * flattens `trips` + `stop_times` into a `trips_per_day` figure per route/stop pair so the
 * request path is a single spatial join rather than a timetable computation.
 */

import { hasDatabase, query, tableExists } from "@/lib/db";
import { TRANSIT_MAX_WALK_METERS } from "@/lib/scoring/constants";
import type { ScorableRoute, TransitScoreInput } from "@/lib/scoring/transit";
import type { TransitMode } from "@/lib/types";

export interface GtfsLookup extends TransitScoreInput {
  /** Timestamp of the newest feed consulted, for the provenance block. */
  snapshot: string | null;
}

const EMPTY: GtfsLookup = { routes: [], stopCount: 0, hasCoverage: false, snapshot: null };

interface RouteRow {
  route_key: string;
  short_name: string | null;
  long_name: string | null;
  agency_name: string | null;
  mode: string;
  crow_meters: number;
  stop_lat: number;
  stop_lon: number;
  trips_per_day: string | null;
  fetched_at: Date | null;
}

/**
 * Routes with a stop within walking distance.
 *
 * `walkDistance` converts the straight-line distance returned by PostGIS into a walking
 * distance using the caller's routing graph, so a stop across an unbridged highway is
 * correctly treated as far away.
 */
export async function routesNearPoint(
  lat: number,
  lon: number,
  walkDistance?: (pLat: number, pLon: number, crow: number) => number
): Promise<GtfsLookup> {
  if (!hasDatabase()) return EMPTY;
  if (!(await tableExists("gtfs_route_stop"))) return EMPTY;

  // Whether any feed claims to cover this point. Distinguishes "no transit here" from
  // "we have not loaded a feed for this metro", which the API reports differently.
  const coverage = await query<{ covered: boolean }>(
    `select exists (
       select 1 from gtfs_feed
       where bbox is not null
         and st_intersects(bbox, st_setsrid(st_point($1, $2), 4326))
     ) as covered`,
    [lon, lat]
  );
  if (!coverage[0]?.covered) return EMPTY;

  // Search a padded radius because the caller may inflate crow distance into a longer
  // walking distance, and we would rather filter in TypeScript than miss a stop.
  const searchMeters = TRANSIT_MAX_WALK_METERS * 1.6;

  const rows = await query<RouteRow>(
    `with nearby_stops as (
       select s.id,
              st_y(s.geom) as stop_lat,
              st_x(s.geom) as stop_lon,
              st_distance(s.geom::geography, st_setsrid(st_point($1, $2), 4326)::geography) as crow_meters
       from gtfs_stop s
       where st_dwithin(s.geom::geography, st_setsrid(st_point($1, $2), 4326)::geography, $3)
     ),
     route_stops as (
       select r.feed_id || ':' || r.route_id as route_key,
              r.short_name,
              r.long_name,
              r.agency_name,
              r.mode,
              ns.crow_meters,
              ns.stop_lat,
              ns.stop_lon,
              rs.trips_per_day,
              f.fetched_at
       from nearby_stops ns
       join gtfs_route_stop rs on rs.stop_pk = ns.id
       join gtfs_route r       on r.id = rs.route_pk
       join gtfs_feed f        on f.id = r.feed_id
     )
     select route_key,
            max(short_name)  as short_name,
            max(long_name)   as long_name,
            max(agency_name) as agency_name,
            max(mode)        as mode,
            min(crow_meters) as crow_meters,
            -- Coordinates of this route's closest stop, so the caller can route to it.
            (array_agg(stop_lat order by crow_meters))[1] as stop_lat,
            (array_agg(stop_lon order by crow_meters))[1] as stop_lon,
            sum(trips_per_day) as trips_per_day,
            max(fetched_at)    as fetched_at
     from route_stops
     group by route_key
     order by min(crow_meters) asc
     limit 300`,
    [lon, lat, searchMeters]
  );

  const stopCountRow = await query<{ n: string }>(
    `select count(*)::text as n
       from gtfs_stop s
      where st_dwithin(s.geom::geography, st_setsrid(st_point($1, $2), 4326)::geography, $3)`,
    [lon, lat, TRANSIT_MAX_WALK_METERS]
  );

  let snapshot: string | null = null;
  const routes: ScorableRoute[] = [];

  for (const row of rows) {
    const crow = Number(row.crow_meters);
    const meters = walkDistance ? walkDistance(Number(row.stop_lat), Number(row.stop_lon), crow) : crow;
    if (meters > TRANSIT_MAX_WALK_METERS) continue;

    if (row.fetched_at) {
      const iso = new Date(row.fetched_at).toISOString();
      if (!snapshot || iso > snapshot) snapshot = iso;
    }

    routes.push({
      routeId: row.route_key,
      shortName: row.short_name,
      longName: row.long_name,
      agency: row.agency_name,
      mode: row.mode as TransitMode,
      walkMeters: meters,
      tripsPerDay: row.trips_per_day === null ? null : Number(row.trips_per_day),
    });
  }

  return {
    routes,
    stopCount: Number(stopCountRow[0]?.n ?? 0),
    hasCoverage: true,
    snapshot,
  };
}
