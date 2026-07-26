/**
 * Transit routes derived from OpenStreetMap.
 *
 * The fallback for areas with no loaded GTFS feed. OSM route relations tell us which
 * routes call at which stops and what mode they are, but carry no timetable, so
 * frequency is unknown and the scorer applies a conservative default. Results are marked
 * so the API response can say so rather than implying schedule-grade accuracy.
 */

import { haversineMeters } from "@/lib/geo";
import type { OsmElement } from "@/lib/osm/overpass";
import { TRANSIT_MAX_WALK_METERS } from "@/lib/scoring/constants";
import type { ScorableRoute, TransitScoreInput } from "@/lib/scoring/transit";
import type { TransitMode } from "@/lib/types";

function osmRouteMode(routeTag: string | undefined): TransitMode {
  switch (routeTag) {
    case "subway":
      return "subway";
    case "light_rail":
    case "tram":
      return "tram";
    case "train":
      return "rail";
    case "monorail":
      return "rail";
    case "ferry":
      return "ferry";
    case "bus":
    case "trolleybus":
      return "bus";
    default:
      return "unknown";
  }
}

function isStop(tags: Record<string, string> | undefined): boolean {
  if (!tags) return false;
  return (
    tags["highway"] === "bus_stop" ||
    tags["railway"] === "station" ||
    tags["railway"] === "halt" ||
    tags["railway"] === "tram_stop" ||
    tags["public_transport"] === "platform" ||
    tags["public_transport"] === "stop_position" ||
    tags["public_transport"] === "station"
  );
}

export function osmRoutesNearPoint(
  elements: OsmElement[],
  lat: number,
  lon: number,
  walkDistance: (pLat: number, pLon: number, crow: number) => number
): TransitScoreInput {
  const stops = new Map<number, { lat: number; lon: number; walkMeters: number }>();

  for (const el of elements) {
    if (el.type !== "node" || !isStop(el.tags)) continue;
    if (typeof el.lat !== "number" || typeof el.lon !== "number") continue;

    const crow = haversineMeters(lat, lon, el.lat, el.lon);
    if (crow > TRANSIT_MAX_WALK_METERS) continue;

    const meters = walkDistance(el.lat, el.lon, crow);
    if (meters > TRANSIT_MAX_WALK_METERS) continue;

    stops.set(el.id, { lat: el.lat, lon: el.lon, walkMeters: meters });
  }

  if (stops.size === 0) {
    // No stops within walking distance is a real answer, not missing data — provided we
    // got a response at all. An empty element list means the query failed upstream.
    return { routes: [], stopCount: 0, hasCoverage: elements.length > 0 };
  }

  const routes = new Map<string, ScorableRoute>();

  for (const el of elements) {
    if (el.type !== "relation" || !el.tags?.["route"]) continue;

    // Relation members come back on `el.members` in the Overpass JSON, which our narrow
    // element type does not model; read it defensively.
    const members = (el as unknown as { members?: { type: string; ref: number }[] }).members ?? [];

    let nearest = Infinity;
    for (const member of members) {
      if (member.type !== "node") continue;
      const stop = stops.get(member.ref);
      if (stop && stop.walkMeters < nearest) nearest = stop.walkMeters;
    }
    if (!Number.isFinite(nearest)) continue;

    const routeId = `osm:relation/${el.id}`;
    const existing = routes.get(routeId);
    if (existing && existing.walkMeters <= nearest) continue;

    routes.set(routeId, {
      routeId,
      shortName: el.tags["ref"] ?? null,
      longName: el.tags["name"] ?? null,
      agency: el.tags["operator"] ?? null,
      mode: osmRouteMode(el.tags["route"]),
      walkMeters: nearest,
      // No schedule in OSM. The scorer substitutes a conservative frequency.
      tripsPerDay: null,
    });
  }

  return { routes: [...routes.values()], stopCount: stops.size, hasCoverage: true };
}
