/**
 * Transit Score calculation.
 *
 * What makes transit useful is not how many stops are nearby but how much *service*
 * those stops receive and how far it can take you. A bus shelter served twice a day is
 * scenery. So each nearby route contributes value proportional to its mode, its
 * frequency, and how far you have to walk to catch it.
 */

import {
  TRANSIT_BANDS,
  TRANSIT_FULL_WEIGHT_METERS,
  TRANSIT_MAX_WALK_METERS,
  TRANSIT_MODE_WEIGHTS,
  TRANSIT_SATURATION_POINTS,
} from "@/lib/scoring/constants";
import { band } from "@/lib/scoring/decay";
import type { TransitMode, TransitRouteHit, TransitScoreDetail } from "@/lib/types";

/** A route observed near the query point, assembled by the GTFS or OSM data layer. */
export interface ScorableRoute {
  routeId: string;
  shortName: string | null;
  longName: string | null;
  agency: string | null;
  mode: TransitMode;
  /** Walking distance to the nearest stop on this route, metres. */
  walkMeters: number;
  /** Scheduled weekday trips. Null when the feed has no frequency information. */
  tripsPerDay: number | null;
}

export interface TransitScoreInput {
  routes: ScorableRoute[];
  stopCount: number;
  /** False when we simply have no transit data for this region, which is not the same as
   *  the region having no transit. */
  hasCoverage: boolean;
}

/**
 * Walking-distance decay for transit.
 *
 * Distinct from the amenity curve: people will walk considerably further for a train than
 * for a sandwich. Full value out to 400 m, then falling linearly to nothing at three
 * quarters of a mile.
 */
export function transitDecay(meters: number): number {
  if (meters <= TRANSIT_FULL_WEIGHT_METERS) return 1;
  if (meters >= TRANSIT_MAX_WALK_METERS) return 0;
  return (
    1 - (meters - TRANSIT_FULL_WEIGHT_METERS) / (TRANSIT_MAX_WALK_METERS - TRANSIT_FULL_WEIGHT_METERS)
  );
}

/**
 * Diminishing returns on frequency. Doubling service from every 30 to every 15 minutes
 * transforms a route; doubling from every 5 to every 2.5 minutes barely registers.
 *
 * Anchored so that an hourly route (~18 weekday trips) lands near 0.55 and a
 * turn-up-and-go subway line (200+ trips) approaches the cap.
 */
export function frequencyFactor(tripsPerDay: number | null): number {
  // No schedule data: assume a modest baseline rather than discarding the route.
  if (tripsPerDay === null || !Number.isFinite(tripsPerDay)) return 0.6;
  if (tripsPerDay <= 0) return 0;
  return Math.min(2.0, Math.sqrt(tripsPerDay / 60));
}

export function calculateTransitScore(input: TransitScoreInput): TransitScoreDetail {
  if (!input.hasCoverage) {
    return {
      score: null,
      description: null,
      explanation: null,
      rawPoints: 0,
      stopCount: 0,
      routeCount: 0,
      routes: [],
      hasCoverage: false,
    };
  }

  const hits: TransitRouteHit[] = [];
  let rawPoints = 0;

  for (const route of input.routes) {
    const decay = transitDecay(route.walkMeters);
    if (decay <= 0) continue;

    const modeWeight = TRANSIT_MODE_WEIGHTS[route.mode] ?? TRANSIT_MODE_WEIGHTS.unknown;
    const points = modeWeight * frequencyFactor(route.tripsPerDay) * decay;
    if (points <= 0) continue;

    rawPoints += points;
    hits.push({
      routeId: route.routeId,
      shortName: route.shortName,
      longName: route.longName,
      agency: route.agency,
      mode: route.mode,
      walkMeters: Math.round(route.walkMeters),
      tripsPerDay: route.tripsPerDay,
      points: Number(points.toFixed(4)),
    });
  }

  /**
   * Concave normalisation. A linear map would give a neighbourhood with one hourly bus a
   * score of 1, which is indistinguishable from having nothing at all — but having one
   * bus is meaningfully different from having none. The square root spreads the low end
   * out where the real-world distinctions are.
   */
  const ratio = Math.min(1, rawPoints / TRANSIT_SATURATION_POINTS);
  const score = Math.max(0, Math.min(100, Math.round(100 * Math.sqrt(ratio))));
  const { label, explanation } = band(TRANSIT_BANDS, score);

  return {
    score,
    description: label,
    explanation,
    rawPoints: Number(rawPoints.toFixed(3)),
    stopCount: input.stopCount,
    routeCount: hits.length,
    routes: hits.sort((a, b) => b.points - a.points).slice(0, 40),
    hasCoverage: true,
  };
}

/** Map a GTFS `route_type` integer to our coarse mode taxonomy. */
export function gtfsRouteTypeToMode(routeType: number): TransitMode {
  // Base GTFS types.
  switch (routeType) {
    case 0:
      return "tram";
    case 1:
      return "subway";
    case 2:
      return "rail";
    case 3:
      return "bus";
    case 4:
      return "ferry";
    case 5:
      return "cable";
    case 6:
      return "cable"; // aerial lift
    case 7:
      return "rail"; // funicular
    case 11:
      return "bus"; // trolleybus
    case 12:
      return "rail"; // monorail
    default:
      break;
  }
  // Extended GTFS route types are grouped in hundreds.
  if (routeType >= 100 && routeType < 200) return "rail";
  if (routeType >= 200 && routeType < 300) return "bus";
  if (routeType >= 400 && routeType < 500) return "subway";
  if (routeType >= 700 && routeType < 800) return "bus";
  if (routeType >= 900 && routeType < 1000) return "tram";
  if (routeType >= 1000 && routeType < 1100) return "ferry";
  if (routeType >= 1200 && routeType < 1300) return "ferry";
  if (routeType >= 1300 && routeType < 1400) return "cable";
  return "unknown";
}
