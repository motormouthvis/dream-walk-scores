/**
 * Canonical types for Dream Walk Scores.
 *
 * The public API response is assembled in one place (`lib/buildResult.ts`) so that
 * every surface — REST, GraphQL, batch, the embed iframe and the Walk Score
 * compatibility shim — returns an identical shape.
 */

export type ScoreKind = "walk" | "bike" | "transit";

/**
 * The nine amenity categories that feed the Walk Score calculation. These mirror the
 * categories published by Walk Score so that our numbers are comparable to the product
 * we are replacing. See `docs/METHODOLOGY.md`.
 */
export type AmenityCategory =
  | "grocery"
  | "restaurants"
  | "shopping"
  | "coffee"
  | "banks"
  | "parks"
  | "schools"
  | "books"
  | "entertainment";

export const AMENITY_CATEGORIES: AmenityCategory[] = [
  "grocery",
  "restaurants",
  "shopping",
  "coffee",
  "banks",
  "parks",
  "schools",
  "books",
  "entertainment",
];

export const CATEGORY_LABELS: Record<AmenityCategory, string> = {
  grocery: "Grocery",
  restaurants: "Restaurants",
  shopping: "Shopping",
  coffee: "Coffee",
  banks: "Errands & banking",
  parks: "Parks",
  schools: "Schools",
  books: "Books & libraries",
  entertainment: "Entertainment",
};

/** A single POI that contributed points to a score. */
export interface AmenityHit {
  /** Stable id, `osm:node/12345` or `dws:<uuid>` for enriched records. */
  id: string;
  name: string;
  category: AmenityCategory;
  lat: number;
  lon: number;
  /** Straight-line distance in metres. */
  crowMeters: number;
  /** Walking distance in metres — network distance when available, else circuity-adjusted. */
  walkMeters: number;
  /** Distance-decay weight in [0,1]. */
  decay: number;
  /** Points contributed to the raw 15-point total. */
  points: number;
  /** True when `walkMeters` came from real network routing rather than an estimate. */
  routed: boolean;
}

export interface CategoryBreakdown {
  category: AmenityCategory;
  label: string;
  /** Maximum points this category can contribute. */
  maxPoints: number;
  /** Points actually earned. */
  points: number;
  /** Distance to the closest amenity in this category, metres. Null when none found. */
  nearestMeters: number | null;
  hits: AmenityHit[];
}

/** Pedestrian-friendliness adjustment derived from street-network shape. */
export interface PedestrianShape {
  /** Intersections per square kilometre within the analysis radius. */
  intersectionDensity: number | null;
  /** Mean block length in metres. */
  avgBlockLengthMeters: number | null;
  /** Multiplier applied to the raw score, in [0.90, 1.0]. */
  penaltyFactor: number;
}

export interface WalkScoreDetail {
  score: number | null;
  description: string | null;
  explanation: string | null;
  /** Sum of earned category points, out of `maxPoints`. */
  rawPoints: number;
  maxPoints: number;
  categories: CategoryBreakdown[];
  pedestrianShape: PedestrianShape;
}

export interface BikeInfrastructure {
  /** Metres of dedicated/protected bike lane within the radius. */
  protectedLaneMeters: number;
  /** Metres of painted lane or shoulder. */
  paintedLaneMeters: number;
  /** Metres of shared/low-stress residential street. */
  lowStressMeters: number;
  /** Total road+path metres considered. */
  totalWayMeters: number;
}

export interface HillMetrics {
  /** Mean absolute grade across sampled segments, as a percentage. */
  meanGradePct: number | null;
  /** 85th-percentile grade, the metric riders actually feel. */
  steepGradePct: number | null;
  /** Elevation range across the sample, metres. */
  reliefMeters: number | null;
}

export interface BikeScoreDetail {
  score: number | null;
  description: string | null;
  explanation: string | null;
  components: {
    /** 0-100 sub-scores. */
    infrastructure: number | null;
    hills: number | null;
    destinations: number | null;
    connectivity: number | null;
  };
  infrastructure: BikeInfrastructure;
  hills: HillMetrics;
}

export type TransitMode = "rail" | "subway" | "tram" | "ferry" | "cable" | "bus" | "unknown";

export interface TransitRouteHit {
  routeId: string;
  shortName: string | null;
  longName: string | null;
  agency: string | null;
  mode: TransitMode;
  /** Walking distance to the nearest stop served by this route, metres. */
  walkMeters: number;
  /** Scheduled trips per weekday across all stops of this route near the point. */
  tripsPerDay: number | null;
  /** Points contributed to the raw transit total. */
  points: number;
}

export interface TransitScoreDetail {
  score: number | null;
  description: string | null;
  explanation: string | null;
  rawPoints: number;
  stopCount: number;
  routeCount: number;
  routes: TransitRouteHit[];
  /** Null when we have no GTFS coverage for this area — distinct from "no transit here". */
  hasCoverage: boolean;
}

/**
 * How much we trust the result. Driven by data coverage, not by the score itself.
 * A genuinely car-dependent place gets a `high` confidence score of 8.
 */
export type Confidence = "high" | "medium" | "low";

export interface DataProvenance {
  /** ISO timestamp of the OSM extract backing this answer. */
  osmSnapshot: string | null;
  /** ISO timestamp of the newest GTFS feed consulted. */
  gtfsSnapshot: string | null;
  /** Which distance model produced the amenity distances. */
  distanceModel: "network" | "circuity-estimate";
  /** Where the answer came from. */
  source: "precomputed-grid" | "cache" | "live";
  /** Milliseconds spent computing (excludes network egress when cached). */
  computeMs: number;
}

export interface Location {
  lat: number;
  lon: number;
  /** The address we resolved, when the request was made by address. */
  address: string | null;
  /** Point snapped to the nearest walkable street, which is what we actually score. */
  snappedLat: number | null;
  snappedLon: number | null;
}

/** The single canonical response object. */
export interface ScoreResult {
  location: Location;
  walk: WalkScoreDetail;
  bike: BikeScoreDetail;
  transit: TransitScoreDetail;
  confidence: Confidence;
  /** Reasons the confidence is not `high`. Empty when it is. */
  confidenceNotes: string[];
  /** Natural-language "why this score" text. Deterministic template unless AI is enabled. */
  summary: string | null;
  /** True when `summary` was written by the LLM rather than the template engine. */
  summaryFromAi: boolean;
  provenance: DataProvenance;
}

export interface GeocodeResult {
  lat: number;
  lon: number;
  displayName: string;
  /** Confidence reported by the geocoder, 0-1. */
  score: number;
  source: "census" | "nominatim" | "photon" | "cache";
}
