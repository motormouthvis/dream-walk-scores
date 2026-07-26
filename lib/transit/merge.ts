/**
 * Combine GTFS and OpenStreetMap transit into one route list.
 *
 * The naive approach — use GTFS when a feed covers the point, otherwise fall back to OSM
 * — produces a worse answer than either source alone whenever coverage is partial, which
 * in practice is most large metros. New York is the clearest example: MTA publishes the
 * subway, each borough's buses, the express buses, Long Island Rail Road and Metro-North
 * as separate feeds. Load only some of them and a point in Midtown "has GTFS coverage",
 * so the subway lines that OSM knew about are discarded in favour of a handful of express
 * bus routes, and Times Square scores 50.
 *
 * Merging instead means GTFS wins wherever it exists — it is the only source with real
 * frequencies — while OSM fills the gaps, and adding a feed can only ever improve the
 * result.
 */

import type { ScorableRoute, TransitScoreInput } from "@/lib/scoring/transit";

/**
 * Identify a route across sources.
 *
 * Route names are the only thing the two datasets reliably share, so a match needs the
 * same mode and the same normalised designation. Without a designation there is nothing
 * to match on and the route is always kept, which risks a duplicate — the right way to be
 * wrong here, since dropping a real route understates the score and a duplicate barely
 * moves it.
 */
function identity(route: ScorableRoute): string | null {
  const name = route.shortName ?? route.longName;
  if (!name) return null;
  const normalised = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalised.length === 0 ? null : `${route.mode}:${normalised}`;
}

/**
 * Collapse routes that are the same real-world service.
 *
 * Needed within GTFS as well as across sources: large agencies publish overlapping feeds,
 * and the MTA in particular ships the same subway lines in several of them, so a
 * de-duplication pass that only compares GTFS against OSM leaves the N, Q, R and W
 * counted three times each.
 *
 * Where two records describe one route, keep the closest stop and the higher trip count —
 * each feed only knows about the stops it publishes, so both figures are lower bounds.
 */
function dedupeRoutes(routes: ScorableRoute[]): ScorableRoute[] {
  const byIdentity = new Map<string, ScorableRoute>();
  const unnamed: ScorableRoute[] = [];

  for (const route of routes) {
    const key = identity(route);
    if (!key) {
      unnamed.push(route);
      continue;
    }

    const existing = byIdentity.get(key);
    if (!existing) {
      byIdentity.set(key, { ...route });
      continue;
    }

    existing.walkMeters = Math.min(existing.walkMeters, route.walkMeters);
    if (route.tripsPerDay !== null) {
      existing.tripsPerDay = Math.max(existing.tripsPerDay ?? 0, route.tripsPerDay);
    }
    existing.longName ??= route.longName;
    existing.agency ??= route.agency;
  }

  return [...byIdentity.values(), ...unnamed];
}

export function mergeTransitSources(
  gtfs: TransitScoreInput | null,
  osm: TransitScoreInput
): TransitScoreInput {
  if (!gtfs || !gtfs.hasCoverage || gtfs.routes.length === 0) {
    return { ...osm, routes: dedupeRoutes(osm.routes) };
  }

  // GTFS first so that where both sources know a route, the GTFS record — the one with a
  // real trip count — is the survivor that the OSM copy merges into.
  const named = new Set<string>();
  for (const route of gtfs.routes) {
    const key = identity(route);
    if (key) named.add(key);
  }

  // An unnamed OSM route cannot be matched against GTFS, and OSM route relations are
  // patchy enough that keeping them all would double-count busy corridors.
  const osmAdditions = osm.routes.filter((route) => {
    const key = identity(route);
    return key !== null && !named.has(key);
  });

  return {
    routes: dedupeRoutes([...gtfs.routes, ...osmAdditions]),
    // Stop counts come from different universes and cannot be summed meaningfully; report
    // the larger, which is the better estimate of what is actually nearby.
    stopCount: Math.max(gtfs.stopCount, osm.stopCount),
    hasCoverage: true,
  };
}
