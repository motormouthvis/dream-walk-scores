/**
 * The scoring orchestrator.
 *
 * One entry point — `scorePoint` — turns a coordinate into a complete `ScoreResult`.
 * Everything upstream (REST, GraphQL, batch, the embed iframe, the Walk Score
 * compatibility shim) goes through here, so all surfaces are guaranteed to agree.
 */

import { haversineMeters } from "@/lib/geo";
import { sampleElevations } from "@/lib/elevation";
import { buildGraph, dijkstra, NodeIndex, networkShape, snapToNetwork, type Graph } from "@/lib/network";
import { elementPoint, fetchAmenities, fetchTransit, fetchWalkNetwork } from "@/lib/osm/overpass";
import { classify, displayName } from "@/lib/osm/tags";
import { ANALYSIS_RADIUS_METERS, MAX_WALK_METERS } from "@/lib/scoring/constants";
import { bikeDecayWeight, circuityFactor } from "@/lib/scoring/decay";
import { calculateBikeScore } from "@/lib/scoring/bike";
import { calculateTransitScore } from "@/lib/scoring/transit";
import { calculateWalkScore, categoryPointsRatio, type ScorableAmenity } from "@/lib/scoring/walk";
import { routesNearPoint } from "@/lib/transit/gtfs";
import { mergeTransitSources } from "@/lib/transit/merge";
import { osmRoutesNearPoint } from "@/lib/transit/osm";
import { buildSummary } from "@/lib/explain";
import type {
  BikeInfrastructure,
  Confidence,
  HillMetrics,
  ScoreResult,
} from "@/lib/types";

export interface ScoreOptions {
  /** Resolved address to echo back, when the caller looked up by address. */
  address?: string | null;
  /** Generate the "why this score" text with the LLM. Falls back to the template on failure. */
  ai?: boolean;
  /** Skip all caches and recompute from source. */
  fresh?: boolean;
}

/**
 * Below this many graph nodes we do not trust the extract enough to route on it, and fall
 * back to circuity-adjusted straight lines. Genuinely rural places do produce small
 * graphs, hence this is a confidence signal rather than an error.
 */
const MIN_NODES_FOR_ROUTING = 40;

/** Amenity count below which we suspect thin OSM coverage rather than a real amenity desert. */
const SPARSE_AMENITY_THRESHOLD = 4;

export async function scorePoint(lat: number, lon: number, options: ScoreOptions = {}): Promise<ScoreResult> {
  const started = Date.now();

  // Three independent fetches: run them together so the request costs one round trip of
  // wall time rather than three.
  const [networkResult, amenityResult, transitResult] = await Promise.all([
    fetchWalkNetwork(lat, lon, ANALYSIS_RADIUS_METERS).catch(() => null),
    fetchAmenities(lat, lon, ANALYSIS_RADIUS_METERS),
    fetchTransit(lat, lon, ANALYSIS_RADIUS_METERS).catch(() => null),
  ]);

  const graph: Graph = networkResult ? buildGraph(networkResult.elements) : { nodes: [], edges: [] };
  const canRoute = graph.nodes.length >= MIN_NODES_FOR_ROUTING;

  const shape = canRoute
    ? networkShape(graph, lat, lon, ANALYSIS_RADIUS_METERS)
    : { intersectionDensity: null, avgBlockLengthMeters: null, intersectionCount: 0, wayMeters: 0 };

  // ---- Distances -----------------------------------------------------------
  const snap = canRoute ? snapToNetwork(graph, lat, lon) : null;
  const distances = snap ? dijkstra(graph, snap.seeds, MAX_WALK_METERS * 1.3) : null;
  const nodeIndex = canRoute ? new NodeIndex(graph) : null;
  const fallbackCircuity = circuityFactor(shape.intersectionDensity);

  /**
   * Walking distance to a point.
   *
   * With a usable network we route properly, then add the short hop from the nearest
   * graph node to the door. Without one we inflate the straight line by a circuity factor
   * chosen from the local street pattern, which is a far better estimate than the raw
   * crow-flies distance that naive implementations use.
   */
  const walkDistance = (
    pLat: number,
    pLon: number,
    crow: number
  ): { meters: number; routed: boolean } => {
    if (distances && nodeIndex) {
      const nearest = nodeIndex.nearest(pLat, pLon);
      if (nearest && Number.isFinite(distances[nearest.node])) {
        const routed = distances[nearest.node] + nearest.meters;
        // A routed distance shorter than the straight line means we snapped to the wrong
        // side of something; trust the geometry instead.
        if (routed >= crow) return { meters: routed, routed: true };
      }
    }
    return { meters: crow * fallbackCircuity, routed: false };
  };

  // ---- Amenities -----------------------------------------------------------
  const amenities: ScorableAmenity[] = [];
  const seen = new Set<string>();

  for (const el of amenityResult.elements) {
    const rule = classify(el.tags);
    if (!rule) continue;
    const point = elementPoint(el);
    if (!point) continue;

    // The same real-world place is often tagged as both a node and an enclosing way.
    const id = `osm:${el.type}/${el.id}`;
    const dedupeKey = `${rule.category}:${displayName(el.tags, rule.category)}:${point.lat.toFixed(4)},${point.lon.toFixed(4)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const crow = haversineMeters(lat, lon, point.lat, point.lon);
    if (crow > MAX_WALK_METERS) continue;

    const { meters, routed } = walkDistance(point.lat, point.lon, crow);
    amenities.push({
      id,
      name: displayName(el.tags, rule.category),
      category: rule.category,
      lat: point.lat,
      lon: point.lon,
      crowMeters: crow,
      walkMeters: meters,
      quality: rule.quality,
      routed,
    });
  }

  const walk = calculateWalkScore({
    amenities,
    intersectionDensity: shape.intersectionDensity,
    avgBlockLengthMeters: shape.avgBlockLengthMeters,
  });

  // ---- Transit -------------------------------------------------------------
  // GTFS is authoritative where it exists because it carries schedules; OSM fills the
  // gaps left by partial feed coverage. See `lib/transit/merge.ts`.
  const gtfs = await routesNearPoint(lat, lon, (pLat, pLon, crow) => walkDistance(pLat, pLon, crow).meters).catch(
    () => null
  );

  const osmTransit = osmRoutesNearPoint(
    transitResult?.elements ?? [],
    lat,
    lon,
    (pLat, pLon, crow) => walkDistance(pLat, pLon, crow).meters
  );

  const transit = calculateTransitScore(mergeTransitSources(gtfs, osmTransit));

  // ---- Bike ----------------------------------------------------------------
  const infrastructure = bikeInfrastructureFromGraph(graph, lat, lon, ANALYSIS_RADIUS_METERS);
  const hills = await hillsFromGraph(graph, lat, lon).catch(
    (): HillMetrics => ({ meanGradePct: null, steepGradePct: null, reliefMeters: null })
  );

  const bike = calculateBikeScore({
    infrastructure,
    hills,
    destinationRatio: categoryPointsRatio(amenities, bikeDecayWeight),
    intersectionDensity: shape.intersectionDensity,
  });

  // ---- Confidence ----------------------------------------------------------
  const confidenceNotes: string[] = [];
  if (!networkResult) confidenceNotes.push("Street network data was unavailable; distances are estimated.");
  else if (!canRoute) confidenceNotes.push("The street network here is too sparse to route on; distances are estimated.");
  if (amenities.length < SPARSE_AMENITY_THRESHOLD) {
    confidenceNotes.push("Very few mapped amenities nearby — OpenStreetMap coverage may be incomplete here.");
  }
  if (!transit.hasCoverage) confidenceNotes.push("No transit schedule data covers this area.");
  else if (!gtfs?.hasCoverage) confidenceNotes.push("Transit routes came from OpenStreetMap without schedules, so frequency is estimated.");
  if (hills.meanGradePct === null) confidenceNotes.push("Elevation data was unavailable, so the hills component was omitted.");

  const confidence: Confidence =
    confidenceNotes.length === 0 ? "high" : confidenceNotes.length <= 2 ? "medium" : "low";

  const location = {
    lat,
    lon,
    address: options.address ?? null,
    snappedLat: snap?.lat ?? null,
    snappedLon: snap?.lon ?? null,
  };

  const partial: Omit<ScoreResult, "summary" | "summaryFromAi"> = {
    location,
    walk,
    bike,
    transit,
    confidence,
    confidenceNotes,
    provenance: {
      osmSnapshot: amenityResult.fetchedAt,
      gtfsSnapshot: gtfs?.snapshot ?? null,
      distanceModel: canRoute ? "network" : "circuity-estimate",
      source: "live",
      computeMs: Date.now() - started,
    },
  };

  const { text, fromAi } = await buildSummary(partial, { ai: options.ai ?? false });

  return { ...partial, summary: text, summaryFromAi: fromAi, provenance: { ...partial.provenance, computeMs: Date.now() - started } };
}

// ---------------------------------------------------------------------------
// Bike helpers
// ---------------------------------------------------------------------------

function bikeInfrastructureFromGraph(
  graph: Graph,
  lat: number,
  lon: number,
  radiusMeters: number
): BikeInfrastructure {
  const infra: BikeInfrastructure = {
    protectedLaneMeters: 0,
    paintedLaneMeters: 0,
    lowStressMeters: 0,
    totalWayMeters: 0,
  };

  for (const edge of graph.edges) {
    const a = graph.nodes[edge.a];
    const inRange =
      haversineMeters(lat, lon, a.lat, a.lon) <= radiusMeters ||
      haversineMeters(lat, lon, graph.nodes[edge.b].lat, graph.nodes[edge.b].lon) <= radiusMeters;
    if (!inRange) continue;

    // Each undirected edge is stored once, so no halving is needed here.
    infra.totalWayMeters += edge.meters;
    if (edge.stress === "protected") infra.protectedLaneMeters += edge.meters;
    else if (edge.stress === "painted") infra.paintedLaneMeters += edge.meters;
    else if (edge.stress === "lowStress") infra.lowStressMeters += edge.meters;
  }

  return {
    protectedLaneMeters: Math.round(infra.protectedLaneMeters),
    paintedLaneMeters: Math.round(infra.paintedLaneMeters),
    lowStressMeters: Math.round(infra.lowStressMeters),
    totalWayMeters: Math.round(infra.totalWayMeters),
  };
}

/** How many street segments to sample for grade. Enough to be representative, few enough
 *  to fit in one or two terrain tiles' worth of lookups. */
const HILL_SAMPLE_EDGES = 220;

async function hillsFromGraph(graph: Graph, lat: number, lon: number): Promise<HillMetrics> {
  if (graph.edges.length === 0) {
    return { meanGradePct: null, steepGradePct: null, reliefMeters: null };
  }

  // Sample the longest nearby edges: short geometry-smoothing segments produce noisy
  // grades because the elevation raster is coarser than they are.
  const candidates = graph.edges
    .map((e, i) => ({
      i,
      meters: e.meters,
      dist: haversineMeters(lat, lon, graph.nodes[e.a].lat, graph.nodes[e.a].lon),
    }))
    .filter((c) => c.meters >= 30 && c.dist <= ANALYSIS_RADIUS_METERS)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, HILL_SAMPLE_EDGES);

  if (candidates.length === 0) {
    return { meanGradePct: null, steepGradePct: null, reliefMeters: null };
  }

  const points: { lat: number; lon: number }[] = [];
  for (const c of candidates) {
    const e = graph.edges[c.i];
    points.push({ lat: graph.nodes[e.a].lat, lon: graph.nodes[e.a].lon });
    points.push({ lat: graph.nodes[e.b].lat, lon: graph.nodes[e.b].lon });
  }

  const elevations = await sampleElevations(points);

  const grades: { grade: number; meters: number }[] = [];
  const seen: number[] = [];

  candidates.forEach((c, idx) => {
    const a = elevations[idx * 2];
    const b = elevations[idx * 2 + 1];
    if (a === null || b === null) return;
    seen.push(a, b);
    const rise = Math.abs(b - a);
    const grade = (rise / c.meters) * 100;
    // Grades above 25% are essentially always raster noise on a road segment.
    if (grade <= 25) grades.push({ grade, meters: c.meters });
  });

  if (grades.length === 0) {
    return { meanGradePct: null, steepGradePct: null, reliefMeters: null };
  }

  // Length-weight the mean so a long climb counts for more than a short driveway.
  const totalMeters = grades.reduce((sum, g) => sum + g.meters, 0);
  const meanGradePct = grades.reduce((sum, g) => sum + g.grade * g.meters, 0) / totalMeters;

  const sorted = grades.map((g) => g.grade).sort((a, b) => a - b);
  const steepGradePct = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.85))];

  return {
    meanGradePct: Number(meanGradePct.toFixed(2)),
    steepGradePct: Number(steepGradePct.toFixed(2)),
    reliefMeters: Math.max(...seen) - Math.min(...seen),
  };
}
